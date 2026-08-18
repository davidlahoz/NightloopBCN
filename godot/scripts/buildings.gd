class_name Buildings
extends Node3D
## Streamed city blocks — perimeter parcels of simple prism buildings whose
## facades get procedural windows from shaders/facade.gdshader.
##
## Milestone-1 simplification of src/city/buildings.js (885 lines of facade
## detail, fire escapes and neon): districts still drive height/character and
## every parcel is seeded from the plan, but geometry is extruded prisms.
## Corners are warped through grid_to_world so frontages follow the street
## curves. The car's building-line collider is analytic (car.gd), so no
## physics bodies are needed.

const RADIUS := 320.0
const DROP := 370.0
const RESCAN_DIST := 24.0

var material: ShaderMaterial
var _blocks: Dictionary = {}   # Vector2i(ix, jz) -> MeshInstance3D
var _ctx: CityPlan.PlanCtx
var _scan_x := INF
var _scan_z := INF
var generation := 0


func _init(ctx: CityPlan.PlanCtx, mat: ShaderMaterial) -> void:
	_ctx = ctx
	material = mat


func update(_dt: float, car_x: float, car_z: float) -> void:
	if Vector2(car_x - _scan_x, car_z - _scan_z).length() > RESCAN_DIST:
		_rescan(car_x, car_z)


func prewarm(car_x: float, car_z: float) -> void:
	_rescan(car_x, car_z)


func _rescan(cx: float, cz: float) -> void:
	_scan_x = cx
	_scan_z = cz
	# region in grid space (warp offset bound keeps the margin honest)
	var m := RADIUS + CityPlan.WARP_MAX
	for b in CityPlan.blocks_in_region(cx - m, cx + m, cz - m, cz + m, _ctx):
		var key := Vector2i(b.ix, b.jz)
		if _blocks.has(key):
			continue
		var mi := _build_block(b)
		if mi != null:
			add_child(mi)
		_blocks[key] = mi
		generation += 1
	# evict far blocks
	for key: Vector2i in _blocks.keys():
		var gx := (key.x + 0.5) * CityPlan.PERIOD_X
		var gz := (key.y + 0.5) * CityPlan.PERIOD_Z
		if Vector2(gx - cx, gz - cz).length() > DROP + CityPlan.PERIOD_X:
			var mi = _blocks[key]
			if mi != null:
				mi.queue_free()
			_blocks.erase(key)
			generation += 1


func _build_block(b: Dictionary) -> MeshInstance3D:
	var district := CityPlan.district_of(b.ix, b.jz)
	if district == CityPlan.DISTRICT_COUNTRYSIDE:
		return null   # open fields; the roads run on through

	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	var x0: float = b.x0
	var x1: float = b.x1
	var z0: float = b.z0
	var z1: float = b.z1
	if x1 - x0 < 14.0 or z1 - z0 < 14.0:
		return null

	# perimeter parcels along each edge; corners overlap harmlessly
	var salt := 0
	var edges := [
		[Vector2(x0, z0), Vector2(x1, z0), Vector2(0, 1)],    # south edge, faces -Z street
		[Vector2(x1, z1), Vector2(x0, z1), Vector2(0, -1)],   # north edge
		[Vector2(x0, z1), Vector2(x0, z0), Vector2(1, 0)],    # west edge
		[Vector2(x1, z0), Vector2(x1, z1), Vector2(-1, 0)],   # east edge
	]
	var count := 0
	for edge in edges:
		var a: Vector2 = edge[0]
		var c: Vector2 = edge[1]
		var inward: Vector2 = edge[2]
		var edge_len := (c - a).length()
		var along := (c - a) / edge_len
		var u := 0.0
		while u < edge_len - 8.0:
			salt += 1
			var r1 := CityPlan.cell_seed(b.ix * 41 + salt, b.jz * 17, 101)
			var r2 := CityPlan.cell_seed(b.ix * 41 + salt, b.jz * 17, 202)
			var r3 := CityPlan.cell_seed(b.ix * 41 + salt, b.jz * 17, 303)
			var width := _parcel_width(district, r1)
			width = minf(width, edge_len - u)
			if width < 7.0:
				break
			# alley gap chance
			if r2 < 0.10:
				u += width * 0.5
				continue
			var depth := _parcel_depth(district, r3)
			depth = minf(depth, minf(x1 - x0, z1 - z0) * 0.45)
			var h := _parcel_height(district, b.ix, b.jz, r1)
			var p0 := a + along * u
			var p1 := a + along * (u + width)
			_emit_prism(st, p0, p1, inward, depth, h, district, r1)
			count += 1
			u += width

	# downtown cores get an interior tower on the skyline
	if district == CityPlan.DISTRICT_DOWNTOWN and (x1 - x0) > 60.0 and (z1 - z0) > 60.0:
		var cxg := (x0 + x1) * 0.5
		var czg := (z0 + z1) * 0.5
		var tw := 24.0 + 14.0 * CityPlan.cell_seed(b.ix, b.jz, 404)
		var th := 55.0 + 70.0 * CityPlan.district_height_bias(b.ix, b.jz)
		_emit_prism(st, Vector2(cxg - tw / 2.0, czg - tw / 2.0), Vector2(cxg + tw / 2.0, czg - tw / 2.0), Vector2(0, 1), tw, th, district, CityPlan.cell_seed(b.ix, b.jz, 505))
		count += 1

	if count == 0:
		return null
	st.generate_normals()
	var mesh := st.commit()
	for si in mesh.get_surface_count():
		mesh.surface_set_material(si, material)
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	return mi


func _parcel_width(district: int, r: float) -> float:
	match district:
		CityPlan.DISTRICT_DOWNTOWN: return 18.0 + r * 16.0
		CityPlan.DISTRICT_INDUSTRIAL: return 26.0 + r * 26.0
		CityPlan.DISTRICT_RESIDENTIAL: return 9.0 + r * 7.0
		_: return 11.0 + r * 11.0


func _parcel_depth(district: int, r: float) -> float:
	match district:
		CityPlan.DISTRICT_INDUSTRIAL: return 22.0 + r * 18.0
		CityPlan.DISTRICT_DOWNTOWN: return 18.0 + r * 12.0
		_: return 11.0 + r * 6.0


func _parcel_height(district: int, ix: int, jz: int, r: float) -> float:
	var bias := CityPlan.district_height_bias(ix, jz)
	match district:
		CityPlan.DISTRICT_DOWNTOWN: return 24.0 + bias * 60.0 + r * 18.0
		CityPlan.DISTRICT_COMMERCIAL: return 10.0 + bias * 16.0 + r * 8.0
		CityPlan.DISTRICT_RESIDENTIAL: return 7.0 + bias * 4.0 + r * 3.0
		CityPlan.DISTRICT_INDUSTRIAL: return 5.0 + bias * 4.0 + r * 3.0
		_: return 8.0


## One building prism: grid-space frontage p0→p1, extruded `depth` inward and
## `h` up. Corners go through grid_to_world so frontages follow the curves.
func _emit_prism(st: SurfaceTool, p0: Vector2, p1: Vector2, inward: Vector2, depth: float, h: float, district: int, bseed: float) -> void:
	var q0 := p0 + inward * depth
	var q1 := p1 + inward * depth
	var base_y := RoadProfile.BLOCK_H - 0.3
	var top_y := base_y + h
	# grid → world (warped) footprint
	var w0 := CityPlan.grid_to_world(p0.x, p0.y)
	var w1 := CityPlan.grid_to_world(p1.x, p1.y)
	var w2 := CityPlan.grid_to_world(q1.x, q1.y)
	var w3 := CityPlan.grid_to_world(q0.x, q0.y)
	var col := Color(bseed, float(district) / 8.0, clampf(h / 150.0, 0.0, 1.0))
	var corners := [w0, w1, w2, w3]
	for f in 4:
		var a: Vector2 = corners[f]
		var c: Vector2 = corners[(f + 1) % 4]
		var flen := (c - a).length()
		_quad(st,
			Vector3(a.x, base_y, a.y), Vector3(c.x, base_y, c.y),
			Vector3(c.x, top_y, c.y), Vector3(a.x, top_y, a.y),
			flen, h, col)
	# roof
	st.set_color(col)
	st.set_uv(Vector2(0.5, 0.5))
	var r0 := Vector3(w0.x, top_y, w0.y)
	var r1 := Vector3(w1.x, top_y, w1.y)
	var r2 := Vector3(w2.x, top_y, w2.y)
	var r3 := Vector3(w3.x, top_y, w3.y)
	st.add_vertex(r0); st.add_vertex(r1); st.add_vertex(r2)
	st.add_vertex(r0); st.add_vertex(r2); st.add_vertex(r3)


func _quad(st: SurfaceTool, bl: Vector3, br: Vector3, tr: Vector3, tl: Vector3, w: float, h: float, col: Color) -> void:
	st.set_color(col)
	# UV in facade metres: u along, v up (windows are cut from these).
	# Godot front faces wind clockwise seen from outside the building.
	st.set_uv(Vector2(0, 0)); st.add_vertex(bl)
	st.set_uv(Vector2(w, h)); st.add_vertex(tr)
	st.set_uv(Vector2(0, h)); st.add_vertex(tl)
	st.set_uv(Vector2(0, 0)); st.add_vertex(bl)
	st.set_uv(Vector2(w, 0)); st.add_vertex(br)
	st.set_uv(Vector2(w, h)); st.add_vertex(tr)
