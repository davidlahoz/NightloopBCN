class_name GroundChunks
extends Node3D
## Endless streamed ground heightfield around the car.
##
## Design change vs the web demo: the JS build meshed only the carriageway
## (curbs/sidewalks/blocks were separate modules). Here the WHOLE ground —
## asphalt, curb step, sidewalk, block plateau — is one heightfield sampled
## from RoadProfile.ground_height, and the ground shader colours zones
## analytically per-pixel. Three concentric LOD layers of square tiles;
## coarser layers are dropped a few cm so the finer layer always wins where
## they overlap (no cracks, no z-fighting, no skirts needed).
##
## Tiles bake on WorkerThreadPool threads (each build owns its PlanCtx —
## CityPlan's thinning memo is not shareable across threads); meshes are
## committed on the main thread.

const RESCAN_DIST := 16.0
const MAX_INFLIGHT := 6

# layer: tile size, grid step, stream radius, drop radius, vertical offset
const LAYERS := [
	{"tile": 24.0, "step": 0.25, "radius": 64.0, "drop": 88.0, "y_off": 0.0},
	{"tile": 48.0, "step": 0.75, "radius": 176.0, "drop": 210.0, "y_off": -0.035},
	{"tile": 96.0, "step": 3.0, "radius": 430.0, "drop": 470.0, "y_off": -0.12},
]

var material: ShaderMaterial

var _tiles: Array[Dictionary] = [{}, {}, {}]  # per-layer: Vector2i -> MeshInstance3D or true (pending)
var _queue: Array = []          # [layer, Vector2i, priority_dist]
var _inflight: Array = []       # {id, layer, key}
var _results: Array = []
var _results_mutex := Mutex.new()
var _scan_x := INF
var _scan_z := INF
var generation := 0


func _init(mat: ShaderMaterial) -> void:
	material = mat


func _exit_tree() -> void:
	# drain in-flight bakes so worker tasks never touch a freed object
	for rec in _inflight:
		WorkerThreadPool.wait_for_task_completion(rec.id)
	_inflight.clear()


func update(_dt: float, car_x: float, car_z: float) -> void:
	if Vector2(car_x - _scan_x, car_z - _scan_z).length() > RESCAN_DIST:
		_rescan(car_x, car_z)
	_poll_inflight()
	_commit_results()
	_pump_queue(car_x, car_z)


## Build the near layers synchronously (boot / district jump); far streams in.
func prewarm(car_x: float, car_z: float) -> void:
	_rescan(car_x, car_z)
	for layer in 2:
		for entry in _queue.duplicate():
			if entry[0] != layer:
				continue
			var key: Vector2i = entry[1]
			if _tiles[layer].get(key) is MeshInstance3D:
				continue
			var res := _build_tile(layer, key)
			_add_mesh(res)
		_queue = _queue.filter(func(e): return e[0] != layer)
	generation += 1


func _rescan(cx: float, cz: float) -> void:
	_scan_x = cx
	_scan_z = cz
	var queued: Dictionary = {}
	for e in _queue:
		queued[[e[0], e[1]]] = true
	for layer in LAYERS.size():
		var L: Dictionary = LAYERS[layer]
		var t: float = L.tile
		var r: float = L.radius
		var i0 := floori((cx - r) / t)
		var i1 := floori((cx + r) / t)
		var j0 := floori((cz - r) / t)
		var j1 := floori((cz + r) / t)
		for i in range(i0, i1 + 1):
			for j in range(j0, j1 + 1):
				var key := Vector2i(i, j)
				if _tiles[layer].has(key) or queued.has([layer, key]):
					continue
				var d := _tile_dist(layer, key, cx, cz)
				if d > r:
					continue
				_queue.append([layer, key, d])
		# evict tiles far outside the ring
		var drop: float = L.drop
		for key in _tiles[layer].keys():
			if _tile_dist(layer, key, cx, cz) > drop:
				var v = _tiles[layer][key]
				if v is MeshInstance3D:
					v.queue_free()
					_tiles[layer].erase(key)
					generation += 1


func _tile_dist(layer: int, key: Vector2i, cx: float, cz: float) -> float:
	var t: float = LAYERS[layer].tile
	var mx := (key.x + 0.5) * t
	var mz := (key.y + 0.5) * t
	var dx := maxf(0.0, absf(cx - mx) - t * 0.5)
	var dz := maxf(0.0, absf(cz - mz) - t * 0.5)
	return Vector2(dx, dz).length()


func _pump_queue(cx: float, cz: float) -> void:
	if _queue.is_empty() or _inflight.size() >= MAX_INFLIGHT:
		return
	# nearest first, finest layer first on ties
	_queue.sort_custom(func(a, b):
		var da := _tile_dist(a[0], a[1], cx, cz)
		var db := _tile_dist(b[0], b[1], cx, cz)
		return da < db if not is_equal_approx(da, db) else a[0] < b[0])
	while _inflight.size() < MAX_INFLIGHT and not _queue.is_empty():
		var entry = _queue.pop_front()
		var layer: int = entry[0]
		var key: Vector2i = entry[1]
		if _tiles[layer].has(key):
			continue
		_tiles[layer][key] = true  # pending
		var id := WorkerThreadPool.add_task(_task.bind(layer, key), false, "nl_ground_tile")
		_inflight.append({"id": id, "layer": layer, "key": key})


func _task(layer: int, key: Vector2i) -> void:
	var res := _build_tile(layer, key)
	_results_mutex.lock()
	_results.append(res)
	_results_mutex.unlock()


func _poll_inflight() -> void:
	for n in range(_inflight.size() - 1, -1, -1):
		var rec: Dictionary = _inflight[n]
		if WorkerThreadPool.is_task_completed(rec.id):
			WorkerThreadPool.wait_for_task_completion(rec.id)
			_inflight.remove_at(n)


func _commit_results() -> void:
	_results_mutex.lock()
	var ready := _results
	_results = []
	_results_mutex.unlock()
	for res in ready:
		_add_mesh(res)
	if not ready.is_empty():
		generation += 1


func _add_mesh(res: Dictionary) -> void:
	var layer: int = res.layer
	var key: Vector2i = res.key
	var existing = _tiles[layer].get(key)
	if existing is MeshInstance3D:
		return
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = res.positions
	arrays[Mesh.ARRAY_NORMAL] = res.normals
	arrays[Mesh.ARRAY_INDEX] = res.indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, material)
	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)
	_tiles[layer][key] = mi


## Bake one tile. Thread-safe: owns its PlanCtx; all math is pure/static.
static func _build_tile(layer: int, key: Vector2i) -> Dictionary:
	var L: Dictionary = LAYERS[layer]
	var t: float = L.tile
	var step: float = L.step
	var y_off: float = L.y_off
	var x0 := key.x * t
	var z0 := key.y * t
	var n := int(round(t / step)) + 1     # verts per side
	var ns := n + 2                       # sample grid incl. 1-ring for normals
	var ctx := CityPlan.PlanCtx.new()

	var h := PackedFloat64Array()
	h.resize(ns * ns)
	for j in ns:
		var z := z0 + (j - 1) * step
		var row := j * ns
		for i in ns:
			h[row + i] = RoadProfile.ground_height(x0 + (i - 1) * step, z, ctx)

	var positions := PackedVector3Array()
	positions.resize(n * n)
	var normals := PackedVector3Array()
	normals.resize(n * n)
	var inv2s := 1.0 / (2.0 * step)
	for j in n:
		var z := z0 + j * step
		for i in n:
			var hb := (j + 1) * ns + (i + 1)
			var y := h[hb]
			var nx := -(h[hb + 1] - h[hb - 1]) * inv2s
			var nz := -(h[hb + ns] - h[hb - ns]) * inv2s
			var vi := j * n + i
			positions[vi] = Vector3(x0 + i * step, y + y_off, z)
			normals[vi] = Vector3(nx, 1.0, nz).normalized()

	var indices := PackedInt32Array()
	indices.resize((n - 1) * (n - 1) * 6)
	var wq := 0
	for j in n - 1:
		for i in n - 1:
			var a := j * n + i
			var b := a + 1
			var c := a + n
			var d := c + 1
			# Godot front faces: cross(v1-v0, v2-v0) points opposite the normal
			indices[wq] = a; indices[wq + 1] = b; indices[wq + 2] = c
			indices[wq + 3] = b; indices[wq + 4] = d; indices[wq + 5] = c
			wq += 6

	return {"layer": layer, "key": key, "positions": positions, "normals": normals, "indices": indices}
