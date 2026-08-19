class_name StreetNames
extends RefCounted
## Real OSM street names for the Barcelona world.
##
## Loads the baked res://barcelona/street_names.json (see
## tools/bake_street_names.py — data © OpenStreetMap contributors, ODbL)
## into flat segment arrays plus a 128 m spatial grid, built on a worker
## thread so boot never blocks. query() returns the name of the nearest
## named street within reach of a world position.

const DATA_PATH := "res://barcelona/street_names.json"
const CELL := 128.0
const REACH := 24.0    # max distance (m) from a street to still show its name

var _ready := false
var _names := PackedStringArray()      # per way
var _seg_way := PackedInt32Array()     # per segment: way index
var _seg := PackedFloat32Array()       # per segment: x0, z0, x1, z1
var _way_start := PackedInt32Array()   # per way: first segment index
var _grid: Dictionary = {}             # Vector2i cell -> PackedInt32Array of segment indices
var _endpoints: Dictionary = {}        # quantized endpoint -> PackedInt32Array of way indices
var _task_id := -1


## --- road-network accessors (traffic reuses the same data) ---

func is_ready() -> bool:
	if not _ready and _task_id >= 0 and WorkerThreadPool.is_task_completed(_task_id):
		WorkerThreadPool.wait_for_task_completion(_task_id)
		_task_id = -1
	return _ready


func seg_count() -> int:
	return _seg_way.size()


func seg_a(i: int) -> Vector2:
	return Vector2(_seg[i * 4], _seg[i * 4 + 1])


func seg_b(i: int) -> Vector2:
	return Vector2(_seg[i * 4 + 2], _seg[i * 4 + 3])


func seg_way(i: int) -> int:
	return _seg_way[i]


func way_name(wi: int) -> String:
	return _names[wi]


func way_first_seg(wi: int) -> int:
	return _way_start[wi]


func way_last_seg(wi: int) -> int:
	return (_way_start[wi + 1] if wi + 1 < _way_start.size() else seg_count()) - 1


static func _endpoint_key(p: Vector2) -> Vector2i:
	return Vector2i(roundi(p.x * 2.0), roundi(p.y * 2.0))   # 0.5 m quantization


## Ways whose start or end touches point p (intersection connectivity).
func ways_at_point(p: Vector2) -> PackedInt32Array:
	return _endpoints.get(_endpoint_key(p), PackedInt32Array())


func way_start_point(wi: int) -> Vector2:
	return seg_a(way_first_seg(wi))


func way_end_point(wi: int) -> Vector2:
	return seg_b(way_last_seg(wi))


## Segment indices registered in cells within `radius` of (x, z).
func segments_near(x: float, z: float, radius: float) -> PackedInt32Array:
	var out := PackedInt32Array()
	var r := ceili(radius / CELL)
	var cx := floori(x / CELL)
	var cz := floori(z / CELL)
	for dx in range(-r, r + 1):
		for dz in range(-r, r + 1):
			out.append_array(_grid.get(Vector2i(cx + dx, cz + dz), PackedInt32Array()))
	return out


static func available() -> bool:
	return FileAccess.file_exists(DATA_PATH)


func _init() -> void:
	_task_id = WorkerThreadPool.add_task(_build, false, "nl_street_names")


func _build() -> void:
	var f := FileAccess.open(DATA_PATH, FileAccess.READ)
	if f == null:
		return
	var data: Dictionary = JSON.parse_string(f.get_as_text())
	if data == null:
		return
	var streets: Array = data.streets
	var seg_count := 0
	for s in streets:
		seg_count += (s[1].size() >> 1) - 1
	_seg_way.resize(seg_count)
	_seg.resize(seg_count * 4)
	_names.resize(streets.size())
	_way_start.resize(streets.size())
	var w := 0
	for wi in streets.size():
		var s: Array = streets[wi]
		_names[wi] = s[0]
		_way_start[wi] = w
		var c: Array = s[1]
		for i in range((c.size() >> 1) - 1):
			var x0: float = c[i * 2]
			var z0: float = c[i * 2 + 1]
			var x1: float = c[i * 2 + 2]
			var z1: float = c[i * 2 + 3]
			_seg_way[w] = wi
			_seg[w * 4] = x0
			_seg[w * 4 + 1] = z0
			_seg[w * 4 + 2] = x1
			_seg[w * 4 + 3] = z1
			# register in the cells of both endpoints and the midpoint
			for p in [Vector2(x0, z0), Vector2((x0 + x1) * 0.5, (z0 + z1) * 0.5), Vector2(x1, z1)]:
				var key := Vector2i(floori(p.x / CELL), floori(p.y / CELL))
				if not _grid.has(key):
					_grid[key] = PackedInt32Array()
				var arr: PackedInt32Array = _grid[key]
				if arr.is_empty() or arr[arr.size() - 1] != w:
					arr.append(w)
					_grid[key] = arr
			w += 1
	# intersection connectivity: which ways meet at each endpoint
	for wi in _names.size():
		for p in [way_start_point(wi), way_end_point(wi)]:
			var key := _endpoint_key(p)
			if not _endpoints.has(key):
				_endpoints[key] = PackedInt32Array()
			var arr: PackedInt32Array = _endpoints[key]
			arr.append(wi)
			_endpoints[key] = arr
	_ready = true


## Name of the nearest named street within REACH of (x, z), or "".
func query(x: float, z: float) -> String:
	if not _ready:
		if _task_id >= 0 and WorkerThreadPool.is_task_completed(_task_id):
			WorkerThreadPool.wait_for_task_completion(_task_id)
			_task_id = -1
		return ""
	var cx := floori(x / CELL)
	var cz := floori(z / CELL)
	var best_d2 := REACH * REACH
	var best_way := -1
	for dx in range(-1, 2):
		for dz in range(-1, 2):
			var arr: PackedInt32Array = _grid.get(Vector2i(cx + dx, cz + dz), PackedInt32Array())
			for i in arr:
				var ax := _seg[i * 4]
				var az := _seg[i * 4 + 1]
				var bx := _seg[i * 4 + 2]
				var bz := _seg[i * 4 + 3]
				var abx := bx - ax
				var abz := bz - az
				var l2 := abx * abx + abz * abz
				var t := 0.0
				if l2 > 1e-6:
					t = clampf(((x - ax) * abx + (z - az) * abz) / l2, 0.0, 1.0)
				var px := ax + abx * t - x
				var pz := az + abz * t - z
				var d2 := px * px + pz * pz
				if d2 < best_d2:
					best_d2 = d2
					best_way = _seg_way[i]
	return _names[best_way] if best_way >= 0 else ""
