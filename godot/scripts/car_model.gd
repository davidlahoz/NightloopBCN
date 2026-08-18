class_name CarModel
## Vendored hero car — "Classic Muscle car" by Lexyc16 (Sketchfab, CC-BY 4.0,
## see ASSETS.md). Port of src/vehicle/carModel.js.
##
## Loads the GLB, normalises orientation/scale to the physics frame (forward
## +Z, up +Y, length ≈ 4.9 m, wheels resting at y = 0), carves the four
## baked-in-place wheel groups out into steer/spin pivots, and replaces the
## glTF materials with our own night-city set.
##
## Returns {} on any failure so the procedural placeholder stays as fallback.

const TARGET_LENGTH := 4.9
const SCENE_PATH := "res://assets/car/classic-muscle-car.glb"


## Hierarchy bounds of `node` in the space of `root` (meshes only).
static func _bounds_of(node: Node3D, root: Node3D) -> AABB:
	var result := AABB()
	var first := true
	var stack: Array[Node] = [node]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		for c in n.get_children():
			stack.append(c)
		if n is MeshInstance3D and n.mesh != null:
			var xf := _relative_transform(n, root)
			var ab: AABB = xf * (n.mesh.get_aabb())
			if first:
				result = ab
				first = false
			else:
				result = result.merge(ab)
	return result


static func _relative_transform(node: Node3D, root: Node3D) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var n: Node = node
	while n != null and n != root:
		if n is Node3D:
			xf = n.transform * xf
		n = n.get_parent()
	return xf


static func build() -> Dictionary:
	if not ResourceLoader.exists(SCENE_PATH):
		return {}
	var packed: PackedScene = load(SCENE_PATH)
	if packed == null:
		return {}
	var glb_root: Node3D = packed.instantiate()

	var orient := Node3D.new()
	orient.name = "MuscleOrient"
	orient.add_child(glb_root)
	var norm := Node3D.new()
	norm.name = "MuscleNorm"
	norm.add_child(orient)

	# ---- orientation: up = smallest span, length runs along +Z ----
	var bb := _bounds_of(glb_root, norm)
	var span := bb.size
	if span.z < span.y and span.z < span.x:
		orient.rotation.x = -PI / 2.0    # z-up source
		bb = _bounds_of(glb_root, norm)
		span = bb.size
	if span.x > span.z:
		orient.rotation.y += PI / 2.0    # length x → z
		bb = _bounds_of(glb_root, norm)
		span = bb.size

	# ---- scale + centre ----
	var s := TARGET_LENGTH / maxf(span.x, span.z)
	orient.scale = Vector3.ONE * s
	bb = _bounds_of(glb_root, norm)
	orient.position = Vector3(
		-(bb.position.x + bb.end.x) / 2.0,
		-bb.position.y,
		-(bb.position.z + bb.end.z) / 2.0)

	# ---- wheel groups → steer/spin pivots, inside the original chain ----
	# Wheels are the 'Cube.NNN'/'Cube_NNN' transform groups ('Cube_0' is the body).
	var wheel_groups: Array[Node3D] = []
	var rx := RegEx.create_from_string("^Cube[._]\\d\\d+")
	var stack: Array[Node] = [glb_root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		for c in n.get_children():
			stack.append(c)
		if n is Node3D and not (n is MeshInstance3D) and rx.search(n.name) != null:
			wheel_groups.append(n)

	var wheels: Array = []
	if wheel_groups.size() == 4:
		for g in wheel_groups:
			var parent := g.get_parent() as Node3D
			var p_xf := _relative_transform(parent, norm)     # parent → car frame
			var inv_p := p_xf.affine_inverse()

			var wb := _bounds_of(g, norm)                     # car-frame bounds
			var center_w := wb.get_center()
			var radius := wb.size.y / 2.0

			# car-frame axle/up axes expressed in the parent's local space
			var axle_l := (inv_p.basis * Vector3.RIGHT).normalized()
			var up_l := (inv_p.basis * Vector3.UP).normalized()
			var w_per_l := (p_xf.basis * up_l).length()        # car metres per local unit

			var center_p := inv_p * center_w
			var pivot := Node3D.new()
			pivot.name = String(g.name) + "_pivot"
			parent.add_child(pivot)
			pivot.position = center_p
			var spin := Node3D.new()
			spin.name = String(g.name) + "_spin"
			pivot.add_child(spin)
			# keep g's own placement, shifted by the pivot offset so the net
			# transform is unchanged at rest
			var g_xf: Transform3D = g.transform
			var own_stack: Array[Node] = [g]
			while not own_stack.is_empty():
				var on: Node = own_stack.pop_back()
				on.owner = null
				for oc in on.get_children():
					own_stack.append(oc)
			g.get_parent().remove_child(g)
			spin.add_child(g)
			g.transform = g_xf
			g.position -= center_p

			wheels.append({
				"pivot": pivot, "spin": spin,
				"center_p": center_p, "axle_l": axle_l, "up_l": up_l,
				"inv_w_per_l": 1.0 / w_per_l if w_per_l > 1e-6 else 1.0,
				"radius": radius,
				"front": center_w.z > 0.0,
				"left": center_w.x < 0.0,
			})
		# order FL, FR, RL, RR (geometric: index 0 = -X side, matching physics)
		var ordered: Array = []
		for want in [[true, true], [true, false], [false, true], [false, false]]:
			for w in wheels:
				if w.front == want[0] and w.left == want[1]:
					ordered.append(w)
					break
		if ordered.size() == 4:
			wheels = ordered
		else:
			push_warning("[NIGHTLOOP] car model wheel layout unexpected, wheels stay static")
			wheels = []
	else:
		push_warning("[NIGHTLOOP] expected 4 wheel groups, found %d — wheels stay static" % wheel_groups.size())

	# ---- replace loader materials with our own night-city set ----
	var mk := func(albedo: Color, metallic: float, roughness: float) -> StandardMaterial3D:
		var m := StandardMaterial3D.new()
		m.albedo_color = albedo
		m.metallic = metallic
		m.roughness = roughness
		return m
	var paint: StandardMaterial3D = mk.call(Color(0.8, 0.214, 0.0), 0.35, 0.42)
	paint.clearcoat_enabled = true
	paint.clearcoat = 0.6
	paint.clearcoat_roughness = 0.12
	var chrome: StandardMaterial3D = mk.call(Color(0.75, 0.77, 0.8), 0.6, 0.3)
	var glass: StandardMaterial3D = mk.call(Color(0.5, 0.56, 0.62, 0.6), 0.1, 0.08)
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	var black_trim: StandardMaterial3D = mk.call(Color(0.02, 0.02, 0.022), 0.1, 0.55)
	var rubber: StandardMaterial3D = mk.call(Color(0.015, 0.015, 0.016), 0.0, 0.92)
	var white: StandardMaterial3D = mk.call(Color(0.75, 0.75, 0.73), 0.2, 0.5)
	var tail: StandardMaterial3D = mk.call(Color(0.6, 0.02, 0.01), 0.0, 0.4)
	tail.emission_enabled = true
	tail.emission = Color(1.0, 0.08, 0.03)
	tail.emission_energy_multiplier = 1.2

	var by_name := {
		"Material": paint,
		"Material.001": chrome, "Material_001": chrome,
		"Material.003": glass, "Material_003": glass,
		"Material.004": tail, "Material_004": tail,
		"Material.005": white, "Material_005": white,
		"Material.006": black_trim, "Material_006": black_trim,
		"Material.007": black_trim, "Material_007": black_trim,
		"Material.008": tail, "Material_008": tail,
		"Material.002": rubber, "Material_002": rubber,
	}
	stack = [glb_root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		for c in n.get_children():
			stack.append(c)
		if n is MeshInstance3D and n.mesh != null:
			for si in n.mesh.get_surface_count():
				var mat: Material = n.mesh.surface_get_material(si)
				var mat_name: String = mat.resource_name if mat != null else ""
				n.set_surface_override_material(si, by_name.get(mat_name, black_trim))

	return {"visual": norm, "wheels": wheels, "tail_mats": [tail]}
