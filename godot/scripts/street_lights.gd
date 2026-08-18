class_name StreetLights
extends Node3D
## Streamed streetlights — pole meshes in a MultiMesh, plus a pool of real
## OmniLight3D nodes assigned to the heads nearest the car.
##
## Milestone-1 simplification of src/city/props.js: the web demo fed 96 light
## positions into the road shader; here Godot's clustered Forward+ renderer
## lights the wet road directly, so only the nearest ~24 heads get real
## lights and the rest read as emissive heads + fog glow.

const RADIUS := 260.0
const RESCAN_DIST := 26.0
const SPACING := 26.0
const POLE_H := 5.4
const POOL := 24
const LIGHT_REFRESH := 0.3

var _ctx: CityPlan.PlanCtx
var _mm_inst: MultiMeshInstance3D
var _mm: MultiMesh
var _head_mat: StandardMaterial3D
var _heads: PackedVector3Array = []   # world head positions
var _pool: Array[OmniLight3D] = []
var _scan_x := INF
var _scan_z := INF
var _light_accum := 0.0
var intensity := 1.35


func _init(ctx: CityPlan.PlanCtx) -> void:
	_ctx = ctx
	_head_mat = StandardMaterial3D.new()
	_head_mat.albedo_color = Color(0.9, 0.85, 0.7)
	_head_mat.emission_enabled = true
	_head_mat.emission = Color(1.0, 0.82, 0.55)
	_head_mat.emission_energy_multiplier = 5.0
	_mm = MultiMesh.new()
	_mm.transform_format = MultiMesh.TRANSFORM_3D
	_mm.mesh = _build_pole_mesh()
	_mm_inst = MultiMeshInstance3D.new()
	_mm_inst.multimesh = _mm
	_mm_inst.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_mm_inst)
	for i in POOL:
		var l := OmniLight3D.new()
		l.light_color = Color(1.0, 0.83, 0.6)
		l.omni_range = 26.0
		l.omni_attenuation = 1.4
		l.light_energy = 0.0
		l.shadow_enabled = false
		add_child(l)
		_pool.append(l)


func _build_pole_mesh() -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	_box(st, Vector3(-0.06, 0.0, -0.06), Vector3(0.06, POLE_H, 0.06))          # mast
	_box(st, Vector3(-0.05, POLE_H - 0.22, 0.0), Vector3(0.05, POLE_H - 0.10, 1.55))  # arm
	st.generate_normals()
	var mesh := st.commit()
	var metal := StandardMaterial3D.new()
	metal.albedo_color = Color(0.09, 0.095, 0.10)
	metal.metallic = 0.6
	metal.roughness = 0.6
	mesh.surface_set_material(0, metal)
	# head (separate surface, emissive)
	var st2 := SurfaceTool.new()
	st2.begin(Mesh.PRIMITIVE_TRIANGLES)
	_box(st2, Vector3(-0.14, POLE_H - 0.30, 1.15), Vector3(0.14, POLE_H - 0.16, 1.85))
	st2.generate_normals()
	var head := st2.commit()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, head.surface_get_arrays(0))
	mesh.surface_set_material(1, _head_mat)
	return mesh


func _box(st: SurfaceTool, lo: Vector3, hi: Vector3) -> void:
	var v := [
		Vector3(lo.x, lo.y, lo.z), Vector3(hi.x, lo.y, lo.z),
		Vector3(hi.x, hi.y, lo.z), Vector3(lo.x, hi.y, lo.z),
		Vector3(lo.x, lo.y, hi.z), Vector3(hi.x, lo.y, hi.z),
		Vector3(hi.x, hi.y, hi.z), Vector3(lo.x, hi.y, hi.z),
	]
	# clockwise-front quads (seen from outside)
	var faces := [
		[0, 1, 2, 3],   # -Z
		[4, 7, 6, 5],   # +Z
		[0, 3, 7, 4],   # -X
		[1, 5, 6, 2],   # +X
		[3, 2, 6, 7],   # +Y
		[0, 4, 5, 1],   # -Y
	]
	for f in faces:
		st.add_vertex(v[f[0]]); st.add_vertex(v[f[1]]); st.add_vertex(v[f[2]])
		st.add_vertex(v[f[0]]); st.add_vertex(v[f[2]]); st.add_vertex(v[f[3]])


func set_intensity(v: float) -> void:
	intensity = v
	_head_mat.emission_energy_multiplier = 1.0 + v * 4.0
	_light_accum = LIGHT_REFRESH  # re-push energies next update


func update(dt: float, car_x: float, car_z: float) -> void:
	if Vector2(car_x - _scan_x, car_z - _scan_z).length() > RESCAN_DIST:
		_rescan(car_x, car_z)
	_light_accum += dt
	if _light_accum >= LIGHT_REFRESH:
		_light_accum = 0.0
		_assign_lights(car_x, car_z)


func prewarm(car_x: float, car_z: float) -> void:
	_rescan(car_x, car_z)
	_assign_lights(car_x, car_z)


func _rescan(cx: float, cz: float) -> void:
	_scan_x = cx
	_scan_z = cz
	var m := RADIUS + CityPlan.WARP_MAX
	var transforms: Array[Transform3D] = []
	_heads = PackedVector3Array()
	for seg in CityPlan.segments_in_region(cx - m, cx + m, cz - m, cz + m, _ctx):
		var face: float = CityPlan.MWAY_FACE if seg.mway else CityPlan.CURB_FACE
		var offset: float = face + 0.75
		var s: float = seg.s0 + 13.0
		var idx := 0
		while s < seg.s1 - 6.0:
			# alternate sides on normal streets, both sides on motorways
			var sides: Array = [1.0, -1.0] if seg.mway else [1.0 if idx % 2 == 0 else -1.0]
			for side in sides:
				var gx: float
				var gz: float
				if seg.axis == 0:
					gx = seg.center + side * offset
					gz = s
				else:
					gx = s
					gz = seg.center + side * offset
				# unlit lanes in the countryside
				var bx := floori(gx / CityPlan.PERIOD_X)
				var bz := floori(gz / CityPlan.PERIOD_Z)
				if CityPlan.district_of(bx, bz) == CityPlan.DISTRICT_COUNTRYSIDE:
					continue
				var wpos := CityPlan.grid_to_world(gx, gz)
				var gy := RoadProfile.ground_height(wpos.x, wpos.y, _ctx)
				# arm faces the street (its own axis + curve-following delta)
				var yaw: float
				if seg.axis == 0:
					yaw = (-PI / 2.0 if side > 0.0 else PI / 2.0) + CityPlan.street_yaw_delta(0, seg.line, s)
				else:
					yaw = (PI if side > 0.0 else 0.0) + CityPlan.street_yaw_delta(1, seg.line, s)
				var xf := Transform3D(Basis(Vector3.UP, yaw), Vector3(wpos.x, gy, wpos.y))
				transforms.append(xf)
				_heads.append(Vector3(wpos.x, gy + POLE_H - 0.25, wpos.y) + xf.basis * Vector3(0, 0, 1.5))
			s += SPACING
			idx += 1
	_mm.instance_count = transforms.size()
	for i in transforms.size():
		_mm.set_instance_transform(i, transforms[i])


func _assign_lights(cx: float, cz: float) -> void:
	var order: Array = []
	for i in _heads.size():
		var h := _heads[i]
		order.append([Vector2(h.x - cx, h.z - cz).length_squared(), i])
	order.sort()
	for p in POOL:
		var l := _pool[p]
		if p < order.size() and intensity > 0.01:
			var h := _heads[order[p][1]]
			l.position = h - Vector3(0, 0.3, 0)
			l.light_energy = intensity * 6.5
		else:
			l.light_energy = 0.0
