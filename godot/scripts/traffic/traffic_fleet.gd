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

	for bdef in bodies:
		var bb := _subtree_aabb(bdef.node, bdef.xf)
		var bc := bb.get_center()
		var mine: Array = []
		for w in wheels:
			var d: float = Vector2(w.center.x - bc.x, w.center.z - bc.z).length()
			if d < 4.0:
				mine.append([d, w])
		mine.sort_custom(func(p, q): return p[0] < q[0])
		mine = mine.slice(0, 4)
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
		var frame := Transform3D(Basis(Vector3.UP, yaw), Vector3(centroid.x, 0.0, centroid.y))
		var inv := frame.affine_inverse()
		# normalise by BODY LENGTH along the forward axis (projection of the
		# body AABB onto fwd) so every variant reads the same size class as
		# the ~4.9 m hero car
		var fwd2 := Vector2(sin(yaw), cos(yaw))
		var body_len: float = absf(bb.size.x * fwd2.x) + absf(bb.size.z * fwd2.y)
		var s := clampf(4.65 / maxf(body_len, 1.5), 0.6, 2.2)

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
