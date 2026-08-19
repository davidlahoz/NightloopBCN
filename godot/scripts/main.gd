extends Node3D
## NIGHTLOOP BCN — bootstrap + main loop.
##
## Command-line user args (after `--`):
##   --state=N         boot time-of-day 1 day / 2 afternoon / 3 night
##   --spawn=x,z       spawn the car at a world position
##   --yaw=deg         spawn heading (skips the road probe)
##   --screenshot=PATH save a frame then quit (capture tooling)
##   --shot-frame=N    frame to capture (default 45)
##   --drive=N         hold throttle for the first N frames (capture tooling)
##   --steer=N         hold right steer from frame N (capture tooling)

const MAX_STEP := 1.0 / 30.0

var input := InputState.new()
var car: Car
var cam: ChaseCamera
var barcelona: BarcelonaStreamer
var env_ctrl: EnvironmentCtrl
var audio: EngineAudio
var hud: Label
var speedo: Speedo
var street_names: StreetNames
var street_plaque: StreetPlaque
const HudMinimap := preload("res://scripts/hud_minimap.gd")
const CityMapOverlay := preload("res://scripts/city_map.gd")
var minimap: Control
var city_map: Control
var bcn_lights: BarcelonaStreetlights
var _street_accum := 0.0
var _trip_m := 0.0
var _space: PhysicsDirectSpaceState3D
var _spawn_heading_pending := false
var _spawn_custom := false
var _spawn_pt := Vector2()
var _topdown_h := 0.0
var _topdown_cam: Camera3D
var _orient_view := false
var _spawn_yaw := NAN
var _crash_sfx: AudioStreamPlayer
var _crash_cool := 0.0
var _open_map_at := 0
var _splash: CanvasLayer
var _splash_t := 0.0

var _frame := 0
var _screenshot_path := ""
var _shot_frame := 45
var _drive_frames := 0
var _steer_from := -1
var _orbit_deg := NAN
var _hide_car := false
var _no_beams := false
var _fps_accum := 0.0
var _fps_frames := 0
var _fps := 0.0


func _ready() -> void:
	# ---- args ----
	var boot_state := 0
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--state="):
			boot_state = clampi(int(a.substr(8)), 1, 3)
		elif a.begins_with("--screenshot="):
			_screenshot_path = a.substr(13)
		elif a.begins_with("--shot-frame="):
			_shot_frame = int(a.substr(13))
		elif a.begins_with("--drive="):
			_drive_frames = int(a.substr(8))
		elif a.begins_with("--steer="):
			_steer_from = int(a.substr(8))
		elif a.begins_with("--orbit="):
			_orbit_deg = float(a.substr(8))
		elif a == "--hide-car":
			_hide_car = true
		elif a == "--no-beams":
			_no_beams = true
		elif a.begins_with("--spawn="):
			var parts := a.substr(8).split(",")
			if parts.size() == 2:
				_spawn_custom = true
				_spawn_pt = Vector2(float(parts[0]), float(parts[1]))
		elif a.begins_with("--topdown"):
			_topdown_h = float(a.substr(10)) if a.begins_with("--topdown=") else 220.0
		elif a.begins_with("--yaw="):
			_spawn_yaw = deg_to_rad(float(a.substr(6)))
		elif a.begins_with("--open-map="):
			_open_map_at = int(a.substr(11))
		elif a == "--orient-test" or a.begins_with("--orient-one="):
			_orient_view = true
			if _topdown_h <= 0.0:
				_topdown_h = 1.0   # any positive value activates the debug camera
	if not BarcelonaStreamer.available():
		push_error("[NIGHTLOOP] Barcelona tile data missing — drop it at godot/barcelona/")
		get_tree().quit(1)
		return
	if boot_state == 0:
		boot_state = 2

	var t0 := Time.get_ticks_msec()

	# ---- world systems ----
	env_ctrl = EnvironmentCtrl.new()
	env_ctrl.apply_hook = _on_env_push
	add_child(env_ctrl)
	barcelona = BarcelonaStreamer.new()
	add_child(barcelona)

	# ---- vehicle + camera + audio ----
	car = Car.new()
	# central Barcelona has roads straight through the origin
	car.pos = Vector3(0.0, 0.5, 0.0)
	if _spawn_custom:
		# elevation unknown here — _try_spawn_heading finds the ground first
		car.pos = Vector3(_spawn_pt.x, 0.5, _spawn_pt.y)
	add_child(car)
	cam = ChaseCamera.new()
	add_child(cam)
	# heights and walls come from the tile collision geometry
	car.ground_fn = _bcn_ground
	cam.ground_fn = _bcn_ground
	# face down the street once tile bodies are in the physics space
	_spawn_heading_pending = true
	audio = EngineAudio.new()
	add_child(audio)
	_crash_sfx = AudioStreamPlayer.new()
	_crash_sfx.stream = load("res://assets/audio/crash.mp3")
	_crash_sfx.volume_db = -6.0
	add_child(_crash_sfx)

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
	if StreetNames.available():
		street_names = StreetNames.new()
		street_plaque = StreetPlaque.new()
		canvas.add_child(street_plaque)
		bcn_lights = BarcelonaStreetlights.new(street_names)
		add_child(bcn_lights)
		TrafficManager.setup(car)
		minimap = HudMinimap.new(street_names)
		canvas.add_child(minimap)
		city_map = CityMapOverlay.new(street_names)
		city_map.teleport_cb = _teleport_to
		canvas.add_child(city_map)

	# ---- splash: the logo holds over boot, then fades out in 2 s ----
	_splash = CanvasLayer.new()
	_splash.layer = 100
	var sbg := ColorRect.new()
	sbg.color = Color(0.02, 0.025, 0.045)
	sbg.set_anchors_preset(Control.PRESET_FULL_RECT)
	_splash.add_child(sbg)
	var slogo := TextureRect.new()
	slogo.texture = load("res://assets/textures/logo.png")
	slogo.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	slogo.set_anchors_preset(Control.PRESET_FULL_RECT)
	_splash.add_child(slogo)
	add_child(_splash)

	# ---- prewarm the streamer around the spawn ----
	barcelona.prewarm(car.pos.x, car.pos.z)
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
	if _splash != null:
		_splash_t += raw_dt
		var fade := clampf((_splash_t - 0.4) / 2.0, 0.0, 1.0)   # brief hold, 2 s fade
		for c in _splash.get_children():
			(c as CanvasItem).modulate.a = 1.0 - fade
		if fade >= 1.0:
			_splash.queue_free()
			_splash = null
	_space = get_world_3d().direct_space_state
	car.space = _space
	if _spawn_heading_pending:
		_try_spawn_heading()
	# scripted-capture hooks (bypass the real keyboard entirely)
	if _drive_frames > 0:
		input.script_throttle = 1.0 if _frame < _drive_frames else 0.0
	if _steer_from >= 0 and _frame >= _steer_from:
		input.script_steer = -1.0   # steer right
	if not is_nan(_orbit_deg):
		cam.orbit_yaw = deg_to_rad(_orbit_deg)
	input.begin_frame()
	if input.toggle_mute:
		audio.muted = not audio.muted
	if _frame == 120 and OS.get_cmdline_user_args().has("--ground-debug"):
		for off in [Vector2(0, 0), Vector2(6, 6), Vector2(-8, 0)]:
			var gq := PhysicsRayQueryParameters3D.create(
				Vector3(car.pos.x + off.x, car.pos.y + 4.0, car.pos.z + off.y),
				Vector3(car.pos.x + off.x, car.pos.y - 20.0, car.pos.z + off.y))
			var gh := _space.intersect_ray(gq)
			if gh.is_empty():
				print("[dbg] off=%s NO HIT (car y=%.2f)" % [off, car.pos.y])
			else:
				var col: Node = gh.collider
				print("[dbg] off=%s hit y=%.2f collider=%s parent=%s gp=%s" % [
					off, gh.position.y, col.name, col.get_parent().name,
					col.get_parent().get_parent().name])
	if _open_map_at > 0 and _frame == _open_map_at:
		input.toggle_map = true   # capture tooling: pop the map overlay
	if input.toggle_map and city_map != null:
		if city_map.visible:
			city_map.close_map()
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		else:
			city_map.player_pos = car.pos
			city_map.open_map()
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	if city_map != null and city_map.visible:
		# world keeps running, the car holds still under the map
		city_map.player_pos = car.pos
		city_map.player_yaw = car.yaw
		input.end_frame()
		_update_hud(raw_dt)
		_frame += 1
		barcelona.update(dt, car.pos.x, car.pos.z)
		if not _screenshot_path.is_empty() and _frame >= _shot_frame:
			var mimg := get_viewport().get_texture().get_image()
			mimg.save_png(_screenshot_path)
			print("[NIGHTLOOP] screenshot saved to ", _screenshot_path)
			get_tree().quit()
		return

	car.road_wetness = env_ctrl.road_wetness
	car.update(dt, input)
	if car.curb_bump > 0.0:
		cam.shake_energy = minf(1.0, cam.shake_energy + car.curb_bump)
	# crash SFX: any hard hit on walls, poles or (promoted) traffic bodies
	_crash_cool = maxf(_crash_cool - dt, 0.0)
	if car.wall_hit > 2.5 and _crash_cool <= 0.0 and not audio.muted:
		_crash_cool = 0.6
		_crash_sfx.volume_db = lerpf(-14.0, 0.0, clampf((car.wall_hit - 2.5) / 12.0, 0.0, 1.0))
		_crash_sfx.pitch_scale = randf_range(0.92, 1.08)
		_crash_sfx.play()
	cam.update(dt, car, input)
	# bumper view: hide the car so no body panels clip into frame
	car.set_body_visible(cam.mode != 1)
	if _topdown_h > 0.0:
		# debug overhead view (--topdown[=H]): north (-Z) is screen-up
		if _topdown_cam == null:
			_topdown_cam = Camera3D.new()
			_topdown_cam.far = 4000.0
			add_child(_topdown_cam)
		if _orient_view:
			# C3 orientation test: three-quarter view from the south-east —
			# the nose faces the camera iff the variant's forward is +Z
			_topdown_cam.position = car.pos + Vector3(5.5, 3.0, -3.5)
			_topdown_cam.look_at(car.pos + Vector3(0, 0.7, -10.0))
		else:
			_topdown_cam.position = car.pos + Vector3(0, _topdown_h, 0)
			_topdown_cam.basis = Basis.looking_at(Vector3.DOWN, Vector3(0, 0, -1))
		_topdown_cam.make_current()

	audio.update(dt, car, input)
	env_ctrl.update(dt, input)

	# per-frame physical surface + headlights
	barcelona.set_wetness(env_ctrl.road_wetness, env_ctrl.road_puddles)
	car.set_headlights(0.0 if _no_beams else env_ctrl.headlights)
	TrafficManager.night_lights = env_ctrl.headlights
	if _hide_car:
		car.visible = false

	input.end_frame()

	barcelona.update(dt, car.pos.x, car.pos.z)
	if bcn_lights != null:
		bcn_lights.update(dt, car.pos.x, car.pos.z)

	_trip_m += car.speed * dt
	speedo.update_speed(dt, car.speed, _trip_m / 1000.0)
	if street_names != null:
		_street_accum += dt
		if _street_accum >= 0.25:
			_street_accum = 0.0
			street_plaque.set_street(street_names.query(car.pos.x, car.pos.z))
		street_plaque.update_plaque(dt)
	if minimap != null:
		minimap.player_pos = car.pos
		minimap.player_yaw = car.yaw
	if OS.get_cmdline_user_args().has("--probe") and _frame % 120 == 0:
		print("PROBE f=%d speed=%.1f cars=%d promoted=%d tick=%.2fms max=%.2fms graph=%s stuck=%d" % [
			_frame, car.speed, TrafficManager.alive_count, TrafficManager.promoted_count,
			TrafficManager.tick_ms, TrafficManager.tick_ms_max,
			TrafficManager.graph.ready, TrafficManager.stuck_log.size()])
		if TrafficManager.alive_count <= 2 and TrafficManager.alive_count > 0:
			print("PROBE " + TrafficManager.debug_cars())
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
	# the map-data attribution line is an ODbL license condition —
	# it must stay visible in the credits/HUD
	hud.text = "Barcelona\n%.0f fps\nWASD drive · Shift/RMB glide · Space handbrake · C camera · 1-3 time · M map · P mute · %s\nmap data %s" % [
		_fps, mouse_hint, barcelona.attribution]


## Map-overlay teleport: drop the hero at the clicked spot; the custom-spawn
## path finds the local ground level and points the car down the street once
## the tiles are in the physics space.
func _teleport_to(w: Vector2) -> void:
	car.pos = Vector3(w.x, 0.5, w.y)
	car.vx = 0.0
	car.vz = 0.0
	car.yaw_rate = 0.0
	car.drift_amount = 0.0
	_spawn_custom = true
	_spawn_pt = w
	_spawn_heading_pending = true
	if barcelona != null:
		barcelona.prewarm(w.x, w.y)
	cam.position = car.pos + Vector3(0, 3, -7)
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _on_env_push(params: Dictionary, _headlights: float) -> void:
	if barcelona != null:
		barcelona.apply_environment(params)
	if bcn_lights != null:
		bcn_lights.set_intensity(params.streetlight_intensity)


## Point the spawned car down the street: probe 16 headings and pick the one
## with the longest run of flat road hits. Runs on the first frame where the
## physics space actually sees the prewarmed tiles.
func _try_spawn_heading() -> void:
	if _spawn_custom:
		# arbitrary spawn point: the local ground level is unknown (the map
		# spans ~100 m of altitude), so find it with one long ray first
		var lq := PhysicsRayQueryParameters3D.create(
			Vector3(car.pos.x, 120.0, car.pos.z), Vector3(car.pos.x, -150.0, car.pos.z))
		var lhit := _space.intersect_ray(lq)
		if lhit.is_empty():
			return   # tiles not streamed/flushed yet — retry next frame
		car.pos.y = lhit.position.y + 0.5
		_spawn_custom = false
	var probe := PhysicsRayQueryParameters3D.create(
		car.pos + Vector3(0, 3, 0), car.pos + Vector3(0, -6, 0))
	if _space.intersect_ray(probe).is_empty():
		return   # bodies not flushed into the space yet — retry next frame
	_spawn_heading_pending = false
	if not is_nan(_spawn_yaw):
		# explicit heading (--yaw=deg, capture tooling): skip the probe
		car.yaw = _spawn_yaw
		cam.follow_yaw = _spawn_yaw
		cam.position = car.pos + Vector3(-sin(_spawn_yaw) * 7.0, 3.0, -cos(_spawn_yaw) * 7.0)
		return
	var best_yaw := 0.0
	var best_score := -1.0
	for i in 16:
		var yaw := i * TAU / 16.0
		var dirv := Vector3(sin(yaw), 0.0, cos(yaw))
		var score := 0.0
		for s: float in [6.0, 12.0, 18.0, 24.0, 30.0]:
			# the generated ground planes run UNDER the buildings, so flat
			# ground alone is not proof of road — the path must also be
			# clear of walls at bumper height
			var wq := PhysicsRayQueryParameters3D.create(
				car.pos + Vector3(0, 1.2, 0), car.pos + dirv * s + Vector3(0, 1.2, 0))
			if not _space.intersect_ray(wq).is_empty():
				break
			var p := car.pos + dirv * s + Vector3(0, 3, 0)
			var q := PhysicsRayQueryParameters3D.create(p, p + Vector3(0, -6, 0))
			var hit := _space.intersect_ray(q)
			if not hit.is_empty() and hit.normal.y > 0.9 and hit.position.y < car.pos.y + 1.0:
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
	if y < ref_y - 2.5:
		# collision gap (sidewalks/plazas without physics) or a tunnel floor
		# far below: hold the current level instead of falling through
		return ref_y
	return y
