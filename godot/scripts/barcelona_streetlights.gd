class_name BarcelonaStreetlights
extends Node3D
## Streetlight poles along the real Barcelona streets (asset:
## assets/props/streetlight.glb — a SketchUp export in centimetres with a
## few hundred metres of offset; normalised here to mast-at-origin, ground
## y = 0, arm pointing +Z).
##
## The 36 solid meshes (~41k tris) merge into ONE two-surface ArrayMesh
## (metal + luminaire glass) drawn as a MultiMesh, so the whole pole field
## costs two draw calls. Poles walk the OSM ways around the car, alternating
## sides, arm toward the carriageway; a pool of warm omnis lights the road
## from the nearest lamp heads, and the glass glows with the time of day.

const SPACING := 34.0        # metres between poles along a way
const SIDE_OFFSET := 3.6     # metres right/left of the way centreline
const RADIUS := 170.0
const RESCAN_DIST := 60.0
const POOL := 20
const LIGHT_REFRESH := 0.4
const SCALE := 0.01          # the glb is authored in centimetres

var intensity := 0.35

var _sn: StreetNames
var _mm: MultiMesh
var _mm_inst: MultiMeshInstance3D
var _lamp_mat: StandardMaterial3D
var _head_local := Vector3(0, 4.6, 1.2)
var _heads := PackedVector3Array()
var _pool: Array[OmniLight3D] = []
var _scan := Vector2(INF, INF)
var _light_accum := 0.0
var _graph_seen := false
var _pole_bodies: Array[StaticBody3D] = []
var _pole_shape: CylinderShape3D


func _init(sn: StreetNames) -> void:
	_sn = sn
	_lamp_mat = StandardMaterial3D.new()
	_lamp_mat.albedo_color = Color(0.9, 0.87, 0.8)
	_lamp_mat.emission_enabled = true
	_lamp_mat.emission = Color(1.0, 0.82, 0.55)
	_lamp_mat.emission_energy_multiplier = 0.0
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


func set_intensity(v: float) -> void:
	intensity = v
	_lamp_mat.emission_energy_multiplier = v * 3.5
	_light_accum = LIGHT_REFRESH


func update(dt: float, car_x: float, car_z: float) -> void:
	if not _sn.is_ready():
		return
	if not _graph_seen and TrafficManager.graph.ready:
		_graph_seen = true
		_scan = Vector2(INF, INF)   # re-place poles now that lane widths exist
	if Vector2(car_x - _scan.x, car_z - _scan.y).length() > RESCAN_DIST:
		_scan = Vector2(car_x, car_z)
		_rescan(car_x, car_z)
	_light_accum += dt
	if _light_accum >= LIGHT_REFRESH:
		_light_accum = 0.0
		_assign_lights(car_x, car_z)


func _rescan(cx: float, cz: float) -> void:
	var space := get_world_3d().direct_space_state
	var transforms: Array[Transform3D] = []
	_heads = PackedVector3Array()
	var done_ways: Dictionary = {}
	# the previous poles' own colliders must not catch the placement rays
	# (that planted poles on top of their predecessors, floating mid-air)
	var excludes: Array[RID] = []
	for b in _pole_bodies:
		excludes.append(b.get_rid())
	for si in _sn.segments_near(cx, cz, RADIUS):
		var wi := _sn.seg_way(si)
		if done_ways.has(wi):
			continue
		done_ways[wi] = true
		# poles stand just past the carriageway edge, measured from the
		# traffic lane graph (the road tiles are flat — no kerb to raycast)
		var wa := _sn.seg_a(si)
		var wb := _sn.seg_b(si)
		var wdir := (wb - wa).normalized()
		var pole_off := _carriageway_half_width((wa + wb) * 0.5, wdir) + 1.4
		pole_off = clampf(pole_off, SIDE_OFFSET, 15.0)
		# walk the whole way, dropping poles every SPACING metres
		var acc := SPACING * 0.5
		var side := 1.0
		for s in range(_sn.way_first_seg(wi), _sn.way_last_seg(wi) + 1):
			var a := _sn.seg_a(s)
			var b := _sn.seg_b(s)
			var seg_len := a.distance_to(b)
			if seg_len < 0.05:
				continue
			var fwd := (b - a) / seg_len
			var walked := 0.0
			while acc <= seg_len - walked:
				walked += acc
				acc = SPACING
				side = -side
				var p := a + fwd * walked
				if Vector2(p.x - cx, p.y - cz).length() > RADIUS:
					continue
				var right := Vector2(-fwd.y, fwd.x) * side
				# fall back inward when the wide offset lands inside a building
				var pp := Vector2.ZERO
				var hit := {}
				for offset in [pole_off, SIDE_OFFSET, 2.4]:
					pp = p + right * offset
					var q := PhysicsRayQueryParameters3D.create(
						Vector3(pp.x, 20.0, pp.y), Vector3(pp.x, -8.0, pp.y))
					q.exclude = excludes
					hit = space.intersect_ray(q)
					# flat city: real ground sits near 0 — anything higher is
					# a roof, a car top or another pole
					if not hit.is_empty() and hit.normal.y > 0.9 and hit.position.y < 1.0:
						break
					hit = {}
				if hit.is_empty():
					continue   # inside a building or on a roof — skip
				# arm points back toward the carriageway
				var arm := -right
				var yaw := atan2(arm.x, arm.y)
				var xf := Transform3D(Basis(Vector3.UP, yaw), Vector3(pp.x, hit.position.y, pp.y))
				transforms.append(xf)
				_heads.append(xf * _head_local)
			acc -= seg_len - walked
	_mm.instance_count = transforms.size()
	for i in transforms.size():
		_mm.set_instance_transform(i, transforms[i])
	# collision: a slim static cylinder per pole so the hero car can hit them
	for b in _pole_bodies:
		b.queue_free()
	_pole_bodies.clear()
	if _pole_shape == null:
		_pole_shape = CylinderShape3D.new()
		_pole_shape.radius = 0.14
		_pole_shape.height = 5.0
	for xf in transforms:
		var body := StaticBody3D.new()
		var cs := CollisionShape3D.new()
		cs.shape = _pole_shape
		cs.position = Vector3(0, 2.5, 0)
		body.add_child(cs)
		body.transform = xf
		add_child(body)
		_pole_bodies.append(body)


## Half-width of the carriageway around point p (way direction wdir):
## the farthest parallel traffic lane's perpendicular offset from the way
## centreline, plus half a lane. Falls back to the classic narrow offset
## when the lane graph has nothing there (paths, stairs, private roads).
func _carriageway_half_width(p: Vector2, wdir: Vector2) -> float:
	var g: LaneGraph = TrafficManager.graph
	if g == null or not g.ready:
		return SIDE_OFFSET - 1.4
	var best := -1.0
	var cell := Vector2i(floori(p.x / LaneGraph.GRID), floori(p.y / LaneGraph.GRID))
	for dx in range(-1, 2):
		for dz in range(-1, 2):
			var key := Vector2i(cell.x + dx, cell.y + dz)
			if not g.spawn_grid.has(key):
				continue
			for lane in g.spawn_grid[key]:
				var sp := g.lane_pos(lane, 0.0)
				if Vector2(sp.x - p.x, sp.z - p.y).length() > 170.0:
					continue
				var L: float = g.lane_length[lane]
				for f in [0.0, 0.33, 0.66, 1.0]:
					var q := g.lane_pos(lane, L * f)
					if Vector2(q.x - p.x, q.z - p.y).length() > 14.0:
						continue
					var t := g.lane_tangent(lane, L * f)
					if absf(t.x * wdir.x + t.z * wdir.y) < 0.8:
						continue   # crossing street, not this carriageway
					var perp := absf((q.x - p.x) * -wdir.y + (q.z - p.y) * wdir.x)
					best = maxf(best, perp)
	return (best + 1.6) if best >= 0.0 else (SIDE_OFFSET - 1.4)


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
			l.position = h - Vector3(0, 0.4, 0)
			l.light_energy = intensity * 5.0
		else:
			l.light_energy = 0.0


## Merge the glb's solid meshes into one two-surface ArrayMesh, normalised.
func _build_pole_mesh() -> ArrayMesh:
	var packed: PackedScene = load("res://assets/props/streetlight.glb")
	var root: Node3D = packed.instantiate()
	var solids: Array = []    # [mesh, si, xf, is_glass]
	var base_min := Vector3.INF
	var base_max := -Vector3.INF
	var glass_min := Vector3.INF
	var glass_max := -Vector3.INF
	var stack: Array = [[root, Transform3D.IDENTITY]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D:
			xf = xf * n.transform
		if n is MeshInstance3D and n.mesh != null:
			for si in n.mesh.get_surface_count():
				var m: Material = n.mesh.surface_get_material(si)
				var mname := m.resource_name if m != null else ""
				if mname.begins_with("edge_"):
					continue   # SketchUp wireframe edges
				var glass := mname.begins_with("Translucent")
				solids.append([n.mesh, si, xf, glass])
				var ab: AABB = xf * n.mesh.get_aabb()
				if glass:
					glass_min = glass_min.min(ab.position)
					glass_max = glass_max.max(ab.end)
				elif ab.position.y * SCALE < 0.3:   # touches the ground: mast
					base_min = base_min.min(ab.position)
					base_max = base_max.max(ab.end)
		for c in n.get_children():
			stack.append([c, xf])

	var base := (base_min + base_max) / 2.0 * SCALE
	var head := (glass_min + glass_max) / 2.0 * SCALE
	_head_local = Vector3(0.0, head.y, Vector2(head.x - base.x, head.z - base.z).length())
	var arm := Vector2(head.x - base.x, head.z - base.z)
	var yaw_fix := -atan2(arm.x, arm.y)
	var norm := Transform3D(Basis(Vector3.UP, yaw_fix)) \
		* Transform3D(Basis.IDENTITY, Vector3(-base.x, 0.0, -base.z)) \
		* Transform3D(Basis.from_scale(Vector3.ONE * SCALE))

	var mesh := ArrayMesh.new()
	for pass_glass in [false, true]:
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		for rec in solids:
			if rec[3] != pass_glass:
				continue
			st.append_from(rec[0], rec[1], norm * rec[2])
		st.index()
		var part := st.commit()
		if part.get_surface_count() > 0:
			mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, part.surface_get_arrays(0))
	var metal := StandardMaterial3D.new()
	metal.albedo_color = Color(0.16, 0.165, 0.17)
	metal.metallic = 0.55
	metal.roughness = 0.55
	if mesh.get_surface_count() > 0:
		mesh.surface_set_material(0, metal)
	if mesh.get_surface_count() > 1:
		mesh.surface_set_material(1, _lamp_mat)
	root.free()
	return mesh
