class_name TrafficFleet
## Variant extraction from the "Generic passenger car pack" (Comrade1280,
## CC-BY 4.0 — ASSETS.md). The pack is a showroom: each car is a "* Body"
## group with wheels as sibling nodes. Every variant is normalised to
## footprint-centre origin, ground y = 0, forward +Z (long axis of the wheel
## rectangle) and a realistic ~2.7 m wheelbase.
##
## Produces per variant: a merged multi-surface ArrayMesh (for MultiMesh
## Tier-1 rendering) plus a node template and wheel definitions (for Tier-0
## promoted physics bodies).

const PACK_PATH := "res://assets/car/generic_passenger_car_pack.glb"

## Visually calibrated via the C3 orientation test (--orient-one=N shots):
## body types whose cabin is NOT rear-of-centre, so the glass heuristic
## picks the wrong end. Keyed by exact node name in the vendored pack.
const NOSE_FLIP := {
	"Sport body": true,    # mid-engine — cabin forward of body centre
	"Pickup Body": true,   # long bed — cab forward
	"Compact Body": true,  # cabin is the whole car; glass offset ~3 cm = noise
}


static func build_variants() -> Array:
	var out: Array = []
	if not ResourceLoader.exists(PACK_PATH):
		push_warning("[traffic] car pack missing: " + PACK_PATH)
		return out
	var packed: PackedScene = load(PACK_PATH)
	var root: Node3D = packed.instantiate()

	var bodies: Array = []
	var wheels: Array = []
	var stack: Array = [[root, Transform3D.IDENTITY]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D:
			xf = xf * n.transform
		var lname := String(n.name).to_lower()
		if lname.ends_with("body") or lname.ends_with("body2"):
			bodies.append({"name": String(n.name), "node": n, "xf": xf})
			continue
		if lname.begins_with("wheel"):
			var ab := _subtree_aabb(n, xf)
			wheels.append({"node": n, "xf": xf, "center": ab.get_center(),
				"radius": maxf(ab.size.y, 0.4) / 2.0})
			continue
		for ch in n.get_children():
			stack.append([ch, xf])

	# exclusive wheel->body assignment: the showroom parks cars close enough
	# that "nearest 4 wheels" steals a neighbour's wheels (which then wrecks
	# the centroid, the PCA yaw and the scale). Globally sort every
	# (body, wheel) pair by distance and assign greedily, each wheel used
	# once, each body capped at 4.
	var pairs: Array = []
	for bi in bodies.size():
		var bb0: AABB = _subtree_aabb(bodies[bi].node, bodies[bi].xf)
		bodies[bi]["aabb"] = bb0
		var bc0 := bb0.get_center()
		for wi in wheels.size():
			var w0: Dictionary = wheels[wi]
			pairs.append([Vector2(w0.center.x - bc0.x, w0.center.z - bc0.z).length(), bi, wi])
	pairs.sort_custom(func(p, q): return p[0] < q[0])
	var wheel_taken := {}
	var body_wheels: Array = []
	for bi in bodies.size():
		body_wheels.append([])
	for p in pairs:
		if wheel_taken.has(p[2]) or body_wheels[p[1]].size() >= 4:
			continue
		wheel_taken[p[2]] = true
		body_wheels[p[1]].append([p[0], wheels[p[2]]])

	for bi in bodies.size():
		var bdef: Dictionary = bodies[bi]
		var bb: AABB = bdef.aabb
		var mine: Array = body_wheels[bi]
		if mine.size() < 4:
			continue
		var centroid := Vector2.ZERO
		for m in mine:
			centroid += Vector2(m[1].center.x, m[1].center.z)
		centroid /= 4.0
		var cxx := 0.0
		var czz := 0.0
		var cxz := 0.0
		for m in mine:
			var dx: float = m[1].center.x - centroid.x
			var dz: float = m[1].center.z - centroid.y
			cxx += dx * dx
			czz += dz * dz
			cxz += dx * dz
		var yaw := PI / 2.0 - 0.5 * atan2(2.0 * cxz, cxx - czz)
		# the PCA axis is direction-ambiguous (±180°). Disambiguate with the
		# glass: a car's cabin sits on the REAR half of the forward axis, so
		# forward must point away from the glass-centre offset.
		var glass_c := Vector2.ZERO
		var has_glass := false
		for ch in bdef.node.get_children():
			if String(ch.name).containsn("glass"):
				var gxf: Transform3D = bdef.xf
				if ch is Node3D:
					gxf = gxf * (ch as Node3D).transform
				var ga := _subtree_aabb(ch, gxf)
				glass_c = Vector2(ga.get_center().x, ga.get_center().z)
				has_glass = true
				break
		if has_glass:
			var fwd_probe := Vector2(sin(yaw), cos(yaw))
			if fwd_probe.dot(glass_c - centroid) > 0.0:
				yaw += PI
		if NOSE_FLIP.get(String(bdef.name), false):
			yaw += PI
		var frame := Transform3D(Basis(Vector3.UP, yaw), Vector3(centroid.x, 0.0, centroid.y))
		var inv := frame.affine_inverse()
		# normalise by BODY LENGTH along the forward axis (projection of the
		# body AABB onto fwd) so every variant reads the same size class as
		# the ~4.9 m hero car
		# body length measured in the car's own frame (+Z forward); the world
		# AABB overestimates diagonally-parked showroom cars badly
		var fbb := _subtree_aabb(bdef.node, inv * bdef.xf)
		var body_len: float = fbb.size.z
		var s := clampf(4.65 / maxf(body_len, 1.5), 0.6, 2.2)
		print("[traffic] variant %-14s yaw=%6.1f  len=%.2fm  scale=%.2f  glass=%s" % [
			bdef.name, rad_to_deg(wrapf(yaw, -PI, PI)), body_len, s,
			"y" if has_glass else "MISSING"])

		# template node (promoted visuals) + surface records (merged mesh)
		var tpl := Node3D.new()
		tpl.name = String(bdef.name).replace(" ", "_")
		tpl.scale = Vector3.ONE * s
		var surfaces: Array = []
		var wheel_defs: Array = []
		_collect(bdef.node, bdef.xf, inv, tpl, surfaces)
		for m in mine:
			var pivot := Node3D.new()
			pivot.name = "wheel_pivot"
			var wp: Vector3 = inv * m[1].center
			pivot.position = wp
			tpl.add_child(pivot)
			var winv := Transform3D(Basis.IDENTITY, m[1].center).affine_inverse()
			_collect(m[1].node, m[1].xf, winv, pivot, null)
			wheel_defs.append(Vector3(wp.x * s, wp.y * s, wp.z * s))
			# re-express wheel surfaces into the template frame for the merged mesh
			_collect(m[1].node, m[1].xf, inv, null, surfaces)

		var mesh := _merge(surfaces, s)
		out.append({
			"mesh": mesh,
			"template": tpl,
			"wheel_r": mine[0][1].radius * s,
			"wheels": wheel_defs,
		})
	root.free()
	print("[traffic] fleet: %d variants" % out.size())
	return out


## Walk `from`; duplicate MeshInstances into `into` (if given) and/or record
## (mesh, surface, xf) tuples into `surfaces` (if given).
static func _collect(from: Node, from_xf: Transform3D, inv: Transform3D,
		into: Node3D, surfaces) -> void:
	var stack: Array = [[from, from_xf]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D and n != from:
			xf = xf * n.transform
		if n is MeshInstance3D and n.mesh != null:
			var local := inv * xf
			if into != null:
				var mi := MeshInstance3D.new()
				mi.mesh = n.mesh
				for si in n.mesh.get_surface_count():
					var m: Material = n.get_surface_override_material(si)
					if m != null:
						mi.set_surface_override_material(si, m)
				mi.transform = local
				into.add_child(mi)
			if surfaces != null:
				for si in n.mesh.get_surface_count():
					var mat: Material = n.get_surface_override_material(si)
					if mat == null:
						mat = n.mesh.surface_get_material(si)
					surfaces.append([n.mesh, si, local, mat])
		for ch in n.get_children():
			stack.append([ch, xf])


## Merge surface records into one ArrayMesh, grouped by material, with the
## wheelbase-normalising scale baked in.
static func _merge(surfaces: Array, s: float) -> ArrayMesh:
	var by_mat: Dictionary = {}
	for rec in surfaces:
		var key = rec[3]
		if not by_mat.has(key):
			by_mat[key] = []
		by_mat[key].append(rec)
	var mesh := ArrayMesh.new()
	var scale_xf := Transform3D(Basis.from_scale(Vector3.ONE * s))
	for mat in by_mat:
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		for rec in by_mat[mat]:
			st.append_from(rec[0], rec[1], scale_xf * rec[2])
		var part := st.commit()
		if part.get_surface_count() > 0:
			mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,
				part.surface_get_arrays(0))
			mesh.surface_set_material(mesh.get_surface_count() - 1, mat)
	return mesh


## Near-car signal quads: tail/brake lights, indicators, headlights in ONE
## surface. Quad group is encoded in UV.x (0 tail, 1 left ind, 2 right ind,
## 3 headlight); per-instance INSTANCE_CUSTOM drives intensity:
## r = brake, g = blink left, b = blink right, a = headlights on.
static func build_signal_quads() -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	# [group, x, y, z, half_w, half_h] — model frame, nose = +Z
	var defs := [
		[0.0, -0.55, 0.68, -2.16, 0.15, 0.07], [0.0, 0.55, 0.68, -2.16, 0.15, 0.07],
		[1.0, -0.62, 0.62, 2.12, 0.09, 0.06], [1.0, -0.62, 0.62, -2.14, 0.09, 0.06],
		[2.0, 0.62, 0.62, 2.12, 0.09, 0.06], [2.0, 0.62, 0.62, -2.14, 0.09, 0.06],
		[3.0, -0.55, 0.66, 2.16, 0.14, 0.08], [3.0, 0.55, 0.66, 2.16, 0.14, 0.08],
	]
	for q in defs:
		var g: float = q[0]
		var c := Vector3(q[1], q[2], q[3])
		var w: float = q[4]
		var h: float = q[5]
		var fwd := 1.0 if c.z > 0.0 else -1.0
		var quad := [
			c + Vector3(-w, -h, 0), c + Vector3(w, -h, 0),
			c + Vector3(w, h, 0), c + Vector3(-w, h, 0)]
		var order := [0, 2, 1, 0, 3, 2] if fwd > 0.0 else [0, 1, 2, 0, 2, 3]
		for k in order:
			st.set_uv(Vector2(g, 0.0))
			st.add_vertex(quad[k])
	var part := st.commit()
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, part.surface_get_arrays(0))
	var mat := ShaderMaterial.new()
	mat.shader = load("res://shaders/traffic_signals.gdshader")
	mesh.surface_set_material(0, mat)
	return mesh


const TRUCK_PATH := "res://assets/car/truck-minipack.glb"
## Vehicles picked from the truck minipack showroom (visual pass): no
## trailers, no flatbed-recovery, no chassis-cab, no police, no ambulance.
const TRUCK_INCLUDE := [
	"van_001", "van_003", "van_004", "van_005", "van_007", "van_009",
	"van_010", "van_012", "van_013", "van_014", "van_015", "van_017",
	"van_019", "van_020", "van_021", "van_022", "van_024", "van_025",
]
const TRUCK_SPAWN_WEIGHT := 0.22   # trucks are rarer than cars


## Truck/van variants. Simpler showroom than the car pack: each "van_NNN"
## group holds its body mesh directly plus "w_*" wheel groups, everything
## axis-aligned nose = +Z, real-world metres — no PCA, no rescale.
static func build_truck_variants() -> Array:
	var out: Array = []
	if not ResourceLoader.exists(TRUCK_PATH):
		return out
	var packed: PackedScene = load(TRUCK_PATH)
	var root: Node3D = packed.instantiate()
	var groups: Array = []
	var stack: Array = [[root, Transform3D.IDENTITY]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D:
			xf = xf * n.transform
		if TRUCK_INCLUDE.has(String(n.name)):
			groups.append({"name": String(n.name), "node": n, "xf": xf})
			continue
		for ch in n.get_children():
			stack.append([ch, xf])

	for gdef in groups:
		var wheels: Array = []
		var body_nodes: Array = []
		for ch in gdef.node.get_children():
			var cxf: Transform3D = gdef.xf
			if ch is Node3D:
				cxf = cxf * (ch as Node3D).transform
			if String(ch.name).begins_with("w_") or String(ch.name) == "w":
				var ab := _subtree_aabb(ch, cxf)
				wheels.append({"node": ch, "xf": cxf, "center": ab.get_center(),
					"radius": maxf(ab.size.y, 0.4) / 2.0})
			elif ch is MeshInstance3D:
				body_nodes.append([ch, cxf])
		if wheels.size() < 4 or body_nodes.is_empty():
			continue
		var centroid := Vector2.ZERO
		var gy := 1e9
		for w in wheels:
			centroid += Vector2(w.center.x, w.center.z)
			gy = minf(gy, w.center.y - w.radius)
		centroid /= wheels.size()
		# showroom is axis-aligned, nose +Z (verified visually)
		var frame := Transform3D(Basis.IDENTITY, Vector3(centroid.x, gy, centroid.y))
		var inv := frame.affine_inverse()

		var tpl := Node3D.new()
		tpl.name = String(gdef.name)
		var surfaces: Array = []
		var wheel_defs: Array = []
		for bn in body_nodes:
			_collect(bn[0], bn[1], inv, tpl, surfaces)
		for w in wheels:
			var pivot := Node3D.new()
			pivot.name = "wheel_pivot"
			var wp: Vector3 = inv * w.center
			pivot.position = wp
			tpl.add_child(pivot)
			var winv := Transform3D(Basis.IDENTITY, w.center).affine_inverse()
			_collect(w.node, w.xf, winv, pivot, null)
			wheel_defs.append(wp)
			_collect(w.node, w.xf, inv, null, surfaces)
		var fbb := _subtree_aabb(gdef.node, inv * gdef.xf)
		print("[traffic] truck   %-10s len=%.2fm wheels=%d" % [
			gdef.name, fbb.size.z, wheels.size()])
		out.append({
			"mesh": _merge(surfaces, 1.0),
			"template": tpl,
			"wheel_r": wheels[0].radius,
			"wheels": wheel_defs,
			"spawn_weight": TRUCK_SPAWN_WEIGHT,
		})
	root.free()
	print("[traffic] truck fleet: %d variants" % out.size())
	return out


## Night-LOD imposter: two emissive quad pairs (white forward, red back).
static func build_light_quads() -> ArrayMesh:
	var mesh := ArrayMesh.new()
	var defs := [
		[Color(1.0, 0.95, 0.85), 2.15, 8.0],    # headlights, +Z model forward
		[Color(1.0, 0.1, 0.05), -2.2, 4.0],     # tail lights
	]
	for d in defs:
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		var z: float = d[1]
		var fwd := 1.0 if z > 0.0 else -1.0
		for side in [-0.55, 0.55]:
			var c := Vector3(side, 0.68, z)
			var w := 0.14
			var h := 0.07
			var quad := [
				c + Vector3(-w, -h, 0), c + Vector3(w, -h, 0),
				c + Vector3(w, h, 0), c + Vector3(-w, h, 0)]
			# wind so the face points along the lamp's direction
			if fwd > 0.0:
				st.add_vertex(quad[0]); st.add_vertex(quad[2]); st.add_vertex(quad[1])
				st.add_vertex(quad[0]); st.add_vertex(quad[3]); st.add_vertex(quad[2])
			else:
				st.add_vertex(quad[0]); st.add_vertex(quad[1]); st.add_vertex(quad[2])
				st.add_vertex(quad[0]); st.add_vertex(quad[2]); st.add_vertex(quad[3])
		var part := st.commit()
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.albedo_color = Color(0, 0, 0)
		mat.emission_enabled = true
		mat.emission = d[0]
		mat.emission_energy_multiplier = d[2]
		mat.cull_mode = BaseMaterial3D.CULL_BACK
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,
			part.surface_get_arrays(0))
		mesh.surface_set_material(mesh.get_surface_count() - 1, mat)
	return mesh


static func _subtree_aabb(node: Node, xf: Transform3D) -> AABB:
	var result := AABB()
	var first := true
	var stack: Array = [[node, xf]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var nxf: Transform3D = e[1]
		if n is Node3D and n != node:
			nxf = nxf * n.transform
		if n is MeshInstance3D and n.mesh != null:
			var ab: AABB = nxf * n.mesh.get_aabb()
			if first:
				result = ab
				first = false
			else:
				result = result.merge(ab)
		for ch in n.get_children():
			stack.append([ch, nxf])
	return result
