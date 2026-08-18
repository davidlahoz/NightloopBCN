class_name EnvironmentCtrl
extends Node3D
## Environment — sun, ambient, fog, sky, tonemap, and the time-of-day state
## machine. Port of src/weather/environment.js + src/weather/states.js.
##
## One flat parameter dictionary is blended between state presets over ~4 s.
## Street wetness is NOT part of the blend: it lags the state through
## first-order wetting/drying dynamics, so the damp night look fades in
## physically rather than popping.

const TRANSITION_S := 4.0

const STATES := {
	1: { # Day — high sun, dry clean streets, lights off
		"sun_elevation": 38.0, "sun_azimuth": 225.0, "sun_intensity": 3.6,
		"sun_color": Color(1.0, 0.95, 0.85),
		"zenith_color": Color(0.30, 0.46, 0.72), "horizon_color": Color(0.62, 0.72, 0.86),
		"ambient_sky": Color(0.52, 0.58, 0.70), "ambient_intensity": 1.3,
		"fog_color": Color(0.52, 0.56, 0.65), "fog_density": 0.0018,
		"exposure": 1.05,
		"wetness_target": 0.05, "puddle_level": 0.08,
		"streetlight_intensity": 0.0, "neon_intensity": 0.22, "window_lit_fraction": 0.06,
		"headlights": 0.0,
	},
	2: { # Afternoon — low warm sun raking down the canyons (golden hour)
		"sun_elevation": 10.0, "sun_azimuth": 248.0, "sun_intensity": 4.2,
		"sun_color": Color(1.0, 0.66, 0.34),
		"zenith_color": Color(0.15, 0.21, 0.36), "horizon_color": Color(1.0, 0.60, 0.28),
		"ambient_sky": Color(0.34, 0.36, 0.47), "ambient_intensity": 0.85,
		"fog_color": Color(0.44, 0.38, 0.34), "fog_density": 0.0022,
		"exposure": 1.0,
		"wetness_target": 0.15, "puddle_level": 0.22,
		"streetlight_intensity": 0.35, "neon_intensity": 0.6, "window_lit_fraction": 0.25,
		"headlights": 0.35,
	},
	3: { # Night — the hero look: dark sky, streetlights, damp street
		"sun_elevation": -8.0, "sun_azimuth": 205.0, "sun_intensity": 0.0,
		"sun_color": Color(0.5, 0.55, 0.7),
		"zenith_color": Color(0.015, 0.022, 0.050), "horizon_color": Color(0.10, 0.09, 0.14),
		"ambient_sky": Color(0.10, 0.13, 0.22), "ambient_intensity": 0.55,
		"fog_color": Color(0.10, 0.105, 0.145), "fog_density": 0.0048,
		"exposure": 1.12,
		"wetness_target": 0.55, "puddle_level": 0.75,   # "rain earlier tonight" street
		"streetlight_intensity": 1.35, "neon_intensity": 1.5, "window_lit_fraction": 0.5,
		"headlights": 1.2,
	},
}

var state_id := 3
var headlights := 1.0
var road_wetness := 0.55
var road_puddles := 0.75
var params: Dictionary = {}
## Called with (params, headlights) whenever looks change — main wires this
## to push uniforms into ground/facade/light materials and the car.
var apply_hook: Callable

var sun: DirectionalLight3D
var world_env: WorldEnvironment
var _sky_mat: ProceduralSkyMaterial
var _from: Dictionary = {}
var _to: Dictionary = {}
var _t := 1.0
var _wet_target := 0.55
var _puddle_target := 0.75
var _push_accum := 0.0


func _init() -> void:
	sun = DirectionalLight3D.new()
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	sun.directional_shadow_max_distance = 180.0
	add_child(sun)

	_sky_mat = ProceduralSkyMaterial.new()
	_sky_mat.sun_angle_max = 15.0
	var sky := Sky.new()
	sky.sky_material = _sky_mat
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.glow_enabled = true
	env.glow_intensity = 0.45
	env.glow_bloom = 0.05
	env.glow_hdr_threshold = 1.6
	env.fog_enabled = true
	env.fog_mode = Environment.FOG_MODE_EXPONENTIAL
	env.fog_aerial_perspective = 0.4
	env.fog_sky_affect = 0.3
	# SSR off: its edge-of-screen fallback smears the lit windows into milky
	# blobs on the wet road. Real lights give the specular streaks instead;
	# proper planar reflections are a later milestone (the demo used a mirror).
	env.ssr_enabled = false
	world_env = WorldEnvironment.new()
	world_env.environment = env
	add_child(world_env)

	params = STATES[3].duplicate(true)
	_apply_instant(STATES[3])


## Push current params into engine objects. Call after any param change.
func apply() -> void:
	var p := params
	var el := deg_to_rad(p.sun_elevation)
	var az := deg_to_rad(p.sun_azimuth)
	# direction the light travels (from sun toward scene)
	var sun_dir := Vector3(-cos(el) * sin(az), -sin(el), -cos(el) * cos(az))
	if absf(sun_dir.y) < 0.999:
		sun.basis = Basis.looking_at(sun_dir, Vector3.UP)
	var sun_up: float = maxf(0.0, sin(el) * 8.0)   # fade sun as it sets
	sun.light_energy = p.sun_intensity * minf(1.0, sun_up) * 0.42
	sun.light_color = p.sun_color

	var env := world_env.environment
	env.ambient_light_color = p.ambient_sky
	env.ambient_light_energy = p.ambient_intensity * 0.85
	env.tonemap_exposure = p.exposure
	env.fog_light_color = p.fog_color
	env.fog_density = p.fog_density
	_sky_mat.sky_top_color = p.zenith_color
	_sky_mat.sky_horizon_color = p.horizon_color
	_sky_mat.ground_bottom_color = p.zenith_color * 0.4
	_sky_mat.ground_horizon_color = p.horizon_color * 0.7

	if apply_hook.is_valid():
		apply_hook.call(params, headlights)


func _apply_instant(s: Dictionary) -> void:
	for k in s:
		if k == "wetness_target" or k == "puddle_level" or k == "headlights":
			continue
		params[k] = s[k]
	headlights = s.headlights
	_wet_target = s.wetness_target
	_puddle_target = s.puddle_level
	apply()


## Jump instantly (boot / district capture).
func jump_to(id: int) -> void:
	if not STATES.has(id):
		return
	state_id = id
	_from = {}
	_to = {}
	_t = 1.0
	_apply_instant(STATES[id])
	road_wetness = STATES[id].wetness_target
	road_puddles = STATES[id].puddle_level


## Begin an eased transition to state id (1..3).
func go_to(id: int) -> void:
	if not STATES.has(id):
		return
	state_id = id
	var s: Dictionary = STATES[id]
	var from := {}
	for k in s:
		if k == "wetness_target" or k == "puddle_level":
			continue
		if k == "headlights":
			from[k] = headlights
			continue
		from[k] = params[k]
	_from = from
	_to = s
	_t = 0.0


func update(dt: float, input: InputState) -> void:
	if input.mood_key != 0:
		go_to(input.mood_key)

	if not _to.is_empty():
		_t = minf(1.0, _t + dt / TRANSITION_S)
		var e := _t * _t * (3.0 - 2.0 * _t)   # smoothstep ease
		for k in _to:
			if k == "wetness_target" or k == "puddle_level":
				continue
			if k == "headlights":
				headlights = _from[k] + (_to[k] - _from[k]) * e
				continue
			var a = _from[k]
			var b = _to[k]
			if a is Color:
				params[k] = (a as Color).lerp(b, e)
			elif k == "sun_azimuth":
				var d0 := wrapf(b - a, -180.0, 180.0)
				params[k] = a + d0 * e
			else:
				params[k] = a + (b - a) * e
		_wet_target = _to.wetness_target
		_puddle_target = _to.puddle_level
		# throttle the material pushes to ~15 Hz during the transition
		_push_accum += dt
		if _push_accum > 0.066 or _t >= 1.0:
			_push_accum = 0.0
			apply()
		if _t >= 1.0:
			_from = {}
			_to = {}

	# ---- physical wetting/drying lag (never blended, always integrated) ----
	var wet_target := _wet_target
	var wet_rate := 0.15 if wet_target > road_wetness else 0.033
	road_wetness += (wet_target - road_wetness) * (1.0 - exp(-wet_rate * dt))
	var pud_rate := 0.055 if _puddle_target > road_puddles else 0.021
	road_puddles += (_puddle_target - road_puddles) * (1.0 - exp(-pud_rate * dt))
