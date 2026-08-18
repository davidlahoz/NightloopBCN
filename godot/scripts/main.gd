extends Node3D
## NIGHTLOOP — bootstrap + main loop. Port of src/main.js.
##
## Command-line user args (after `--`):
##   --world=NAME      "barcelona" (real OSM tiles, default when the data is
##                     present) or "procedural" (the endless NightLoop city)
##   --seed=N          pin a city (equivalent of ?seed=N)
##   --state=N         boot time-of-day 1 day / 2 afternoon / 3 night
##   --screenshot=PATH save a frame then quit (capture tooling)
##   --shot-frame=N    frame to capture (default 45)
##   --drive=N         hold throttle for the first N frames (capture tooling)
##   --steer=N         hold right steer from frame N (capture tooling)
##   --jump=K          simulate district-jump key K (6..9) on frame 5

const SPAWN_X := 0.0
const SPAWN_Z := -40.0
const MAX_STEP := 1.0 / 30.0

const JUMP_DISTRICTS := {
	6: CityPlan.DISTRICT_DOWNTOWN,
	7: CityPlan.DISTRICT_RESIDENTIAL,
	8: CityPlan.DISTRICT_INDUSTRIAL,
	9: CityPlan.DISTRICT_COUNTRYSIDE,
}
const DISTRICT_NAMES := ["downtown", "commercial", "residential", "industrial", "countryside"]

var ctx := CityPlan.PlanCtx.new()
var input := InputState.new()
var car: Car
var cam: ChaseCamera
var ground: GroundChunks
var buildings: Buildings
var street_lights: StreetLights
var barcelona: BarcelonaStreamer
var env_ctrl: EnvironmentCtrl
var audio: EngineAudio
var ground_mat: ShaderMaterial
var facade_mat: ShaderMaterial
var hud: Label
var speedo: Speedo
var street_names: StreetNames
var street_plaque: StreetPlaque
var bcn_lights: BarcelonaStreetlights
var _street_accum := 0.0
var _trip_m := 0.0
var _space: PhysicsDirectSpaceState3D
var _spawn_heading_pending := false

var _frame := 0
var _screenshot_path := ""
var _shot_frame := 45
var _drive_frames := 0
var _steer_from := -1
var _jump_sim := 0
var _orbit_deg := NAN
var _hide_car := false
var _no_beams := false
var _fps_accum := 0.0
var _fps_frames := 0
var _fps := 0.0


func _ready() -> void:
	# ---- args + world seed ----
	var boot_state := 0
	var seed_arg := -1
	var world_arg := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--world="):
			world_arg = a.substr(8)
		elif a.begins_with("--seed="):
			seed_arg = int(a.substr(7))
		elif a.begins_with("--state="):
			boot_state = clampi(int(a.substr(8)), 1, 3)
		elif a.begins_with("--screenshot="):
			_screenshot_path = a.substr(13)
		elif a.begins_with("--shot-frame="):
			_shot_frame = int(a.substr(13))
		elif a.begins_with("--drive="):
			_drive_frames = int(a.substr(8))
		elif a.begins_with("--steer="):
			_steer_from = int(a.substr(8))
		elif a.begins_with("--jump="):
			_jump_sim = int(a.substr(7))
		elif a.begins_with("--orbit="):
			_orbit_deg = float(a.substr(8))
		elif a == "--hide-car":
			_hide_car = true
		elif a == "--no-beams":
			_no_beams = true
	CityPlan.world_seed = (seed_arg if seed_arg >= 0 else randi()) & 0xFFFFFFFF
	print("[NIGHTLOOP] world seed %d — revisit this city with --seed=%d" % [CityPlan.world_seed, CityPlan.world_seed])

	# world mode: Barcelona OSM tiles when the data ships, else procedural.
	# Barcelona has no streetlights yet, so it boots at golden hour by default.
	var use_barcelona := world_arg == "barcelona" or (world_arg.is_empty() and BarcelonaStreamer.available())
	if boot_state == 0:
		boot_state = 2 if use_barcelona else 3
	print("[NIGHTLOOP] world: %s" % ("barcelona" if use_barcelona else "procedural"))

	var t0 := Time.get_ticks_msec()

	# ---- materials ----
	ground_mat = ShaderMaterial.new()
	ground_mat.shader = load("res://shaders/ground.gdshader")
	ground_mat.set_shader_parameter("world_seed", CityPlan.world_seed)
	facade_mat = ShaderMaterial.new()
	facade_mat.shader = load("res://shaders/facade.gdshader")

	# ---- world systems ----
	env_ctrl = EnvironmentCtrl.new()
	env_ctrl.apply_hook = _on_env_push
	add_child(env_ctrl)
	if use_barcelona:
		barcelona = BarcelonaStreamer.new()
		add_child(barcelona)
	else:
		ground = GroundChunks.new(ground_mat)
		add_child(ground)
		buildings = Buildings.new(ctx, facade_mat)
		add_child(buildings)
		street_lights = StreetLights.new(ctx)
		add_child(street_lights)

	# ---- vehicle + camera + audio ----
	car = Car.new(ctx)
	# central Barcelona has roads straight through the origin
	car.pos = Vector3(0.0, 0.5, 0.0) if use_barcelona else Vector3(SPAWN_X, 0.0, SPAWN_Z)
	add_child(car)
	cam = ChaseCamera.new(ctx)
	add_child(cam)
	if use_barcelona:
		# mesh world: heights and walls come from the tile collision geometry
		car.use_plan_colliders = false
		car.ground_fn = _bcn_ground
		cam.ground_fn = _bcn_ground
		# face down the street once tile bodies are in the physics space
		_spawn_heading_pending = true
	audio = EngineAudio.new()
	add_child(audio)

	# ---- HUD ----
	var canvas := CanvasLayer.new()
	add_child(canvas)
	hud = Label.new()
	hud.position = Vector2(14, 10)
	hud.add_theme_font_size_override("font_size", 15)
	hud.add_theme_color_override("font_color", Color(0.85, 0.88, 0.95, 0.85))
	canvas.add_child(hud)
	speedo = Speedo.new()
	canvas.add_child(speedo)
	if use_barcelona and StreetNames.available():
		street_names = StreetNames.new()
		street_plaque = StreetPlaque.new()
		canvas.add_child(street_plaque)
		bcn_lights = BarcelonaStreetlights.new(street_names)
		add_child(bcn_lights)
		TrafficManager.setup(car)

	# ---- prewarm the streamers around the spawn ----
	if barcelona != null:
		barcelona.prewarm(car.pos.x, car.pos.z)
	else:
		buildings.prewarm(SPAWN_X, SPAWN_Z)
		street_lights.prewarm(SPAWN_X, SPAWN_Z)
		ground.prewarm(SPAWN_X, SPAWN_Z)
	env_ctrl.jump_to(boot_state)
	print("[NIGHTLOOP] prewarm %d ms" % (Time.get_ticks_msec() - t0))

	# mouse starts free (so the window stays draggable); clicking the game
	# captures it, Esc or losing focus releases it
	if not _screenshot_path.is_empty():
		input.mouse_enabled = false
		input.capture_mode = true
		# capture runs: vsync off; in movie-maker mode frames render at full
		# speed even occluded, so keep the window out of the user's way there
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
		if not OS.has_feature("movie"):
			DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_ALWAYS_ON_TOP, true)


func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		return
	if event is InputEventMouseButton and event.pressed \
			and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED and input.mouse_enabled:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	input.handle_event(event)


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


func _process(raw_dt: float) -> void:
	var dt := minf(raw_dt, MAX_STEP)
	_space = get_world_3d().direct_space_state
	car.space = _space
	if _spawn_heading_pending:
		_try_spawn_heading()
	# scripted-capture hooks (bypass the real keyboard entirely)
	if _drive_frames > 0:
		input.script_throttle = 1.0 if _frame < _drive_frames else 0.0
	if _steer_from >= 0 and _frame >= _steer_from:
		input.script_steer = -1.0   # steer right
	if _jump_sim != 0 and _frame == 5:
		input.jump_key = _jump_sim
	if not is_nan(_orbit_deg):
		cam.orbit_yaw = deg_to_rad(_orbit_deg)
	input.begin_frame()
	if input.jump_key != 0 and barcelona == null:
		_jump_to_district(input.jump_key)
	if input.toggle_mute:
		audio.muted = not audio.muted

	car.road_wetness = env_ctrl.road_wetness
	car.update(dt, input)
	if car.curb_bump > 0.0:
		cam.shake_energy = minf(1.0, cam.shake_energy + car.curb_bump)
	cam.update(dt, car, input)
	# bumper view: hide the car so no body panels clip into frame
	car.set_body_visible(cam.mode != 1)

	audio.update(dt, car, input)
	env_ctrl.update(dt, input)

	# per-frame physical surface + headlights
	ground_mat.set_shader_parameter("wetness", env_ctrl.road_wetness)
	ground_mat.set_shader_parameter("puddle_level", env_ctrl.road_puddles)
	if barcelona != null:
		barcelona.set_wetness(env_ctrl.road_wetness, env_ctrl.road_puddles)
	car.set_headlights(0.0 if _no_beams else env_ctrl.headlights)
	if _hide_car:
		car.visible = false

	input.end_frame()

	if barcelona != null:
		barcelona.update(dt, car.pos.x, car.pos.z)
		if bcn_lights != null:
			bcn_lights.update(dt, car.pos.x, car.pos.z)
	else:
		ground.update(dt, car.pos.x, car.pos.z)
		buildings.update(dt, car.pos.x, car.pos.z)
		street_lights.update(dt, car.pos.x, car.pos.z)

	_trip_m += car.speed * dt
	speedo.update_speed(dt, car.speed, _trip_m / 1000.0)
	if street_names != null:
		_street_accum += dt
		if _street_accum >= 0.25:
			_street_accum = 0.0
			street_plaque.set_street(street_names.query(car.pos.x, car.pos.z))
		street_plaque.update_plaque(dt)
	if OS.get_cmdline_user_args().has("--probe") and _frame % 120 == 0:
		print("PROBE f=%d speed=%.1f cars=%d promoted=%d tick=%.2fms max=%.2fms graph=%s stuck=%d" % [
			_frame, car.speed, TrafficManager.alive_count, TrafficManager.promoted_count,
			TrafficManager.tick_ms, TrafficManager.tick_ms_max,
			TrafficManager.graph.ready, TrafficManager.stuck_log.size()])
	_update_hud(raw_dt)
	_frame += 1
	if not _screenshot_path.is_empty() and _frame == _shot_frame:
		var img := get_viewport().get_texture().get_image()
		img.save_png(_screenshot_path)
		print("[NIGHTLOOP] screenshot saved to ", _screenshot_path)
		print("[NIGHTLOOP] dbg cam=%v car=%v orbit=(%.2f, %.2f) zoom=%.2f fov=%.1f" % [
			cam.position, car.pos, cam.orbit_yaw, cam.orbit_pitch, cam.zoom, cam.fov])
		get_tree().quit()


func _update_hud(raw_dt: float) -> void:
	_fps_accum += raw_dt
	_fps_frames += 1
	if _fps_accum >= 0.5:
		_fps = _fps_frames / _fps_accum
		_fps_accum = 0.0
		_fps_frames = 0
	var mouse_hint := "Esc frees the mouse" if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED \
		else "click to capture the mouse"
	if barcelona != null:
		# the map-data attribution line is an ODbL license condition —
		# it must stay visible in the credits/HUD
		hud.text = "Barcelona\n%.0f fps\nWASD drive · Shift/RMB glide · Space handbrake · C camera · 1-3 time · %s\nmap data %s" % [
			_fps, mouse_hint, barcelona.attribution]
		return
	var bx := floori((car.pos.x + CityPlan.warp_of(car.pos.x, car.pos.z).x) / CityPlan.PERIOD_X)
	var bz := floori((car.pos.z + CityPlan.warp_of(car.pos.x, car.pos.z).y) / CityPlan.PERIOD_Z)
	var district: int = CityPlan.district_of(bx, bz)
	hud.text = "district: %s\n%.0f fps   seed %d\nWASD drive · Shift/RMB glide · Space handbrake · C camera · 1-3 time · 6-9 jump · %s" % [
		DISTRICT_NAMES[district], _fps, CityPlan.world_seed, mouse_hint]


## Teleport onto a street in the nearest macro cell of the target district.
func _jump_to_district(key: int) -> void:
	if not JUMP_DISTRICTS.has(key):
		return
	var target: int = JUMP_DISTRICTS[key]
	var cmi := floori(car.pos.x / (CityPlan.PERIOD_X * 3.0))
	var cmj := floori(car.pos.z / (CityPlan.PERIOD_Z * 3.0))
	var best_mi := 0
	var best_mj := 0
	var found := false
	for r in range(1, 25):
		if found:
			break
		for mi in range(cmi - r, cmi + r + 1):
			if found:
				break
			for mj in range(cmj - r, cmj + r + 1):
				if maxi(absi(mi - cmi), absi(mj - cmj)) != r:
					continue
				if CityPlan.district_of(mi * 3 + 1, mj * 3 + 1) == target:
					best_mi = mi
					best_mj = mj
					found = true
					break
	if not found:
		return
	var ix := best_mi * 3 + 1
	var jz := best_mj * 3 + 1
	var gx := (ix + 0.5) * CityPlan.PERIOD_X
	var w := CityPlan.grid_to_world(gx, jz * CityPlan.PERIOD_Z - 2.2)
	car.pos.x = w.x
	car.pos.z = w.y
	car.yaw = PI / 2.0 + CityPlan.street_yaw_delta(1, jz, gx)
	car.vx = 0.0
	car.vz = 0.0
	car.yaw_rate = 0.0
	car.drift_amount = 0.0
	# snap the chase camera behind the car so it doesn't fly across the map
	cam.follow_yaw = car.yaw
	cam.position = Vector3(w.x - sin(car.yaw) * 7.0, car.pos.y + 3.0, w.y - cos(car.yaw) * 7.0)
	# solid ground on arrival: prewarm the streamers
	buildings.prewarm(w.x, w.y)
	street_lights.prewarm(w.x, w.y)
	ground.prewarm(w.x, w.y)


func _on_env_push(params: Dictionary, _headlights: float) -> void:
	facade_mat.set_shader_parameter("window_lit_fraction", params.window_lit_fraction)
	facade_mat.set_shader_parameter("window_glow", 0.7 + params.neon_intensity * 1.2)
	if street_lights != null:
		street_lights.set_intensity(params.streetlight_intensity)
	if barcelona != null:
		barcelona.apply_environment(params)
	if bcn_lights != null:
		bcn_lights.set_intensity(params.streetlight_intensity)


## Point the spawned car down the street: probe 16 headings and pick the one
## with the longest run of flat road hits. Runs on the first frame where the
## physics space actually sees the prewarmed tiles.
func _try_spawn_heading() -> void:
	var probe := PhysicsRayQueryParameters3D.create(
		car.pos + Vector3(0, 3, 0), car.pos + Vector3(0, -6, 0))
	if _space.intersect_ray(probe).is_empty():
		return   # bodies not flushed into the space yet — retry next frame
	_spawn_heading_pending = false
	var best_yaw := 0.0
	var best_score := -1.0
	for i in 16:
		var yaw := i * TAU / 16.0
		var dirv := Vector3(sin(yaw), 0.0, cos(yaw))
		var score := 0.0
		for s: float in [6.0, 12.0, 18.0, 24.0, 30.0]:
			var p := car.pos + dirv * s + Vector3(0, 3, 0)
			var q := PhysicsRayQueryParameters3D.create(p, p + Vector3(0, -6, 0))
			var hit := _space.intersect_ray(q)
			if not hit.is_empty() and hit.normal.y > 0.9 and hit.position.y < 1.0:
				score += 1.0
			else:
				break   # want a continuous stretch of road
		if score > best_score:
			best_score = score
			best_yaw = yaw
	car.yaw = best_yaw
	cam.follow_yaw = best_yaw
	cam.position = car.pos + Vector3(-sin(best_yaw) * 7.0, 3.0, -cos(best_yaw) * 7.0)


## Ground under (x, z) for the mesh world: ray from just above the current
## height downward, so the car follows its own level through bridges (+6)
## and tunnels (-6) instead of snapping to the deck above. A miss (streaming
## gap, or a probe point inside a hollow building shell) HOLDS the current
## level — never search from high above: that snapped wheels onto roofs and
## made the car climb buildings.
func _bcn_ground(x: float, z: float, ref_y: float) -> float:
	if _space == null:
		return ref_y
	var q := PhysicsRayQueryParameters3D.create(
		Vector3(x, ref_y + 2.5, z), Vector3(x, ref_y - 12.0, z))
	var hit := _space.intersect_ray(q)
	if hit.is_empty():
		return ref_y
	var y: float = hit.position.y
	if y > ref_y + 1.2:
		return ref_y   # ledge/wall top above wheel reach — not drivable
	return y
