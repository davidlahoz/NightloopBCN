class_name BarcelonaStreamer
extends Node3D
## Streams the Barcelona city tiles (res://barcelona/) around the car.
##
## Coordinate contract: every glb's vertices are already world-space metres
## sharing one origin at the city centre (X = east, Y = up, Z = -north;
## bridges at y +6, tunnels at y -6), so tiles are ALWAYS instantiated at
## Transform3D.IDENTITY — never positioned by grid index. The 500 m grid is
## only used to decide WHICH tiles to load: tile = floor(world_pos / 500).
##
## Collision ships inside the glbs: mesh nodes carry the "-col" suffix, so the
## importer generates StaticBody3D + concave shapes at import time. Roads are
## drivable and buildings solid the moment a tile scene enters the tree.
##
## Loading is threaded (ResourceLoader.load_threaded_*), a bounded number of
## requests in flight and at most one instantiation per frame, so streaming
## never hitches. Tiles free beyond DROP (> RADIUS, hysteresis) so boundaries
## don't thrash. The full set is ~2,270 tiles / 11M+ triangles — never load
## everything at once.

const MANIFEST_PATH := "res://barcelona/manifest.json"
const BASE_DIR := "res://barcelona/"
const TILE := 500.0
const RADIUS := 3          # keep tiles within this Chebyshev grid distance (~1.5 km)
const DROP := 4            # free tiles beyond this (hysteresis)
const MAX_REQUESTS := 8    # threaded loads in flight
const MAX_INSTANTIATE_PER_FRAME := 1

## ODbL attribution from the manifest — MUST be shown in the game's credits
## (license condition, surfaced in the HUD by main.gd).
var attribution := ""

var _tiles: Dictionary = {}     # Vector2i -> Array[String] (file paths)
var _live: Dictionary = {}      # Vector2i -> Node3D holder (scenes parent here)
var _loading: Dictionary = {}   # path -> Vector2i
var _pending: Array = []        # [Vector2i, path], nearest-first
var _cur_tile := Vector2i(1 << 20, 1 << 20)


static func available() -> bool:
	return FileAccess.file_exists(MANIFEST_PATH)


func _init() -> void:
	_build_materials()
	var f := FileAccess.open(MANIFEST_PATH, FileAccess.READ)
	if f == null:
		push_error("[NIGHTLOOP] barcelona manifest missing")
		return
	var m: Dictionary = JSON.parse_string(f.get_as_text())
	attribution = m.get("attribution", "© OpenStreetMap contributors")
	for t in m.tiles:
		var files: Array[String] = []
		if t.roads_file != null:
			files.append(BASE_DIR + String(t.roads_file))
		if t.buildings_file != null:
			files.append(BASE_DIR + String(t.buildings_file))
		if not files.is_empty():
			_tiles[Vector2i(int(t.tile_x), int(t.tile_z))] = files
	print("[NIGHTLOOP] barcelona manifest: %d tiles (%s)" % [_tiles.size(), attribution])


func update(_dt: float, car_x: float, car_z: float) -> void:
	var ct := Vector2i(floori(car_x / TILE), floori(car_z / TILE))
	if ct != _cur_tile:
		_cur_tile = ct
		_rescan()
		_update_mask_grid()
	_poll_loads()
	_start_loads()


## Blocking load of the immediate ring (boot): the car needs ground under it
## before the first physics query. Everything further streams in threaded.
func prewarm(car_x: float, car_z: float) -> void:
	_cur_tile = Vector2i(floori(car_x / TILE), floori(car_z / TILE))
	for dx in range(-1, 2):
		for dz in range(-1, 2):
			var key := _cur_tile + Vector2i(dx, dz)
			if not _tiles.has(key) or _live.has(key):
				continue
			var holder := _make_holder(key)
			for path in _tiles[key]:
				var scene: PackedScene = ResourceLoader.load(path)
				if scene != null:
					_add_scene(holder, scene, key)
	_rescan()
	_update_mask_grid()


func _make_holder(key: Vector2i) -> Node3D:
	var holder := Node3D.new()
	holder.name = "tile_%d_%d" % [key.x, key.y]
	add_child(holder)
	_live[key] = holder
	_add_ground_plane(holder, key)
	return holder


## The tile drop ships sidewalk ribbons and buildings but NO carriageway or
## plaza polygons — the streets were literally holes (sky showed through,
## physics rays missed, promoted traffic fell). Each tile gets a generated
## ground plane at kerb depth (sidewalk ribbons sit 12 cm above it) running
## the classifying ground shader, plus collision.
const GROUND_Y := -0.12

func _add_ground_plane(holder: Node3D, key: Vector2i) -> void:
	var ground := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(TILE, TILE)
	ground.mesh = pm
	ground.material_override = _road_mat
	ground.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	ground.position = Vector3((key.x + 0.5) * TILE, GROUND_Y, (key.y + 0.5) * TILE)
	holder.add_child(ground)
	var sb := StaticBody3D.new()
	var cs := CollisionShape3D.new()
	var bx := BoxShape3D.new()
	bx.size = Vector3(TILE, 0.3, TILE)
	cs.shape = bx
	cs.position = Vector3(0, -0.15, 0)   # box top flush with the plane
	sb.add_child(cs)
	ground.add_child(sb)


func _add_scene(holder: Node3D, scene: PackedScene, key: Vector2i) -> void:
	var inst := scene.instantiate()
	# world-space vertices: identity transform, per the data contract
	holder.add_child(inst)
	_apply_material_overrides(inst, key)


## HOOK — the glbs ship placeholder-colored materials named mat_road,
## mat_roof, mat_wall_residential, mat_wall_commercial, mat_wall_industrial.
## They're swapped for NightLoop shaders: procedural windows on the walls
## (world-space — the meshes have no UVs) and the wetness-aware asphalt.
## Replace entries in _build_materials() to change the look further.
var _mat_overrides: Dictionary = {}
var _wall_mats: Array[ShaderMaterial] = []
var _road_mat: ShaderMaterial


func _build_materials() -> void:
	var facade_shader: Shader = load("res://shaders/barcelona_facade.gdshader")
	# ground: classified per pixel from the baked masks (asphalt / paving /
	# grass / bike lane); one base material, duplicated per tile with that
	# tile's mask + origin
	_road_mat = ShaderMaterial.new()
	_road_mat.shader = load("res://shaders/barcelona_ground.gdshader")
	for pair in [["asphalt", "Road007"], ["paving", "PavingStones099"],
			["grass", "Grass001"]]:
		_road_mat.set_shader_parameter(pair[0] + "_alb",
			load("res://assets/textures/ground/%s_color.jpg" % pair[1]))
		_road_mat.set_shader_parameter(pair[0] + "_nrm",
			load("res://assets/textures/ground/%s_normal.jpg" % pair[1]))
		_road_mat.set_shader_parameter(pair[0] + "_rgh",
			load("res://assets/textures/ground/%s_rough.jpg" % pair[1]))
	var wall := func(tint: Color) -> ShaderMaterial:
		var m := ShaderMaterial.new()
		m.shader = facade_shader
		m.set_shader_parameter("wall_tint", Vector3(tint.r, tint.g, tint.b))
		_wall_mats.append(m)
		return m
	var roof := StandardMaterial3D.new()
	roof.albedo_color = Color(0.17, 0.14, 0.12)
	roof.roughness = 0.95
	_mat_overrides = {
		"mat_road": _road_mat,
		"mat_roof": roof,
		"mat_wall_residential": wall.call(Color(0.55, 0.42, 0.31)),
		"mat_wall_commercial": wall.call(Color(0.47, 0.45, 0.42)),
		"mat_wall_industrial": wall.call(Color(0.38, 0.38, 0.37)),
	}


## Time-of-day push (window lighting), from main's env hook. Street lamps
## live in BarcelonaStreetlights.
func apply_environment(params: Dictionary) -> void:
	for m in _wall_mats:
		m.set_shader_parameter("window_lit_fraction", params.window_lit_fraction)
		m.set_shader_parameter("window_glow", 0.7 + params.neon_intensity * 1.2)


## Per-frame physical surface state.
func set_wetness(wet: float, pud: float) -> void:
	_road_mat.set_shader_parameter("wetness", wet)
	_road_mat.set_shader_parameter("puddle_level", pud)
	_road_mat.set_shader_parameter("debug_classes",
		OS.get_cmdline_user_args().has("--ground-debug"))


## Class-mask grid: tile meshes overhang their nominal bounds by up to a
## full tile, so ONE global material samples a Texture2DArray of the masks
## for the grid_n x grid_n tiles around the player, picked per fragment by
## world position. Rebuilt when the player crosses a tile border.
const MASK_GRID := 9
var _mask_cache: Dictionary = {}    # tile key -> Image (black when missing)
var _mask_blank: Image
var _mask_center := Vector2i(0x7FFFFFFF, 0x7FFFFFFF)


func _mask_image(key: Vector2i) -> Image:
	if _mask_cache.has(key):
		return _mask_cache[key]
	var img: Image = null
	# read through FileAccess so it also works from inside an exported pck
	var mp := "res://barcelona/masks/tile_%d_%d.png" % [key.x, key.y]
	if FileAccess.file_exists(mp):
		var buf := FileAccess.get_file_as_bytes(mp)
		if not buf.is_empty():
			img = Image.new()
			if img.load_png_from_buffer(buf) != OK:
				img = null
			elif img.get_format() != Image.FORMAT_RGB8:
				img.convert(Image.FORMAT_RGB8)
	if img == null:
		if _mask_blank == null:
			_mask_blank = Image.create(512, 512, false, Image.FORMAT_RGB8)
			_mask_blank.fill(Color(0, 0, 0))
		img = _mask_blank
	_mask_cache[key] = img
	return img


func _update_mask_grid() -> void:
	if _cur_tile == _mask_center:
		return
	_mask_center = _cur_tile
	var half := MASK_GRID / 2
	var corner := _cur_tile - Vector2i(half, half)
	var images: Array[Image] = []
	for dz in MASK_GRID:
		for dx in MASK_GRID:
			images.append(_mask_image(corner + Vector2i(dx, dz)))
	var ta := Texture2DArray.new()
	ta.create_from_images(images)
	_road_mat.set_shader_parameter("class_masks", ta)
	_road_mat.set_shader_parameter("grid_origin",
		Vector2(corner.x * TILE, corner.y * TILE))
	_road_mat.set_shader_parameter("grid_n", MASK_GRID)
	# drop far cache entries so the Image cache doesn't grow unbounded
	for key in _mask_cache.keys():
		if maxi(absi(key.x - _cur_tile.x), absi(key.y - _cur_tile.y)) > half + 2:
			_mask_cache.erase(key)


func _apply_material_overrides(inst: Node, _key: Vector2i) -> void:
	var stack: Array[Node] = [inst]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		for c in n.get_children():
			stack.append(c)
		if n is MeshInstance3D and n.mesh != null:
			for si in n.mesh.get_surface_count():
				var mat: Material = n.mesh.surface_get_material(si)
				if mat != null and _mat_overrides.has(mat.resource_name):
					n.set_surface_override_material(si, _mat_overrides[mat.resource_name])


func _rescan() -> void:
	# wanted set straight from grid math around the car — never scan the dir
	var wanted: Dictionary = {}
	for dx in range(-RADIUS, RADIUS + 1):
		for dz in range(-RADIUS, RADIUS + 1):
			var key := _cur_tile + Vector2i(dx, dz)
			if _tiles.has(key):
				wanted[key] = true
	# queue missing tiles (skip ones already live or queued)
	var queued: Dictionary = {}
	for e in _pending:
		queued[e[0]] = true
	for path in _loading:
		queued[_loading[path]] = true
	for key in wanted:
		if _live.has(key) or queued.has(key):
			continue
		for path in _tiles[key]:
			_pending.append([key, path])
	_pending.sort_custom(func(a, b):
		return _grid_dist(a[0]) < _grid_dist(b[0]))
	# free tiles beyond the drop ring; drop dead queue entries
	for key in _live.keys():
		if _grid_dist(key) > DROP:
			_live[key].queue_free()
			_live.erase(key)
	_pending = _pending.filter(func(e): return _grid_dist(e[0]) <= RADIUS)


func _grid_dist(key: Vector2i) -> int:
	return maxi(absi(key.x - _cur_tile.x), absi(key.y - _cur_tile.y))


func _start_loads() -> void:
	while _loading.size() < MAX_REQUESTS and not _pending.is_empty():
		var e: Array = _pending.pop_front()
		var key: Vector2i = e[0]
		var path: String = e[1]
		if _grid_dist(key) > RADIUS:
			continue
		ResourceLoader.load_threaded_request(path)
		_loading[path] = key


func _poll_loads() -> void:
	var budget := MAX_INSTANTIATE_PER_FRAME
	for path in _loading.keys():
		var status := ResourceLoader.load_threaded_get_status(path)
		if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			continue
		if status != ResourceLoader.THREAD_LOAD_LOADED:
			push_warning("[NIGHTLOOP] barcelona tile failed to load: " + path)
			_loading.erase(path)
			continue
		if budget <= 0:
			return
		var key: Vector2i = _loading[path]
		var scene: PackedScene = ResourceLoader.load_threaded_get(path)
		_loading.erase(path)
		if _grid_dist(key) > DROP:
			continue   # streamed past this tile while it loaded
		budget -= 1
		var holder: Node3D = _live.get(key)
		if holder == null:
			holder = _make_holder(key)
		if scene != null:
			_add_scene(holder, scene, key)
