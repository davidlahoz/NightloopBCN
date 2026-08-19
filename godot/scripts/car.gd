class_name Car
extends Node3D
## The car. Arcade planar dynamics + per-wheel visual suspension.
## Port of src/vehicle/car.js.
##
## Dynamics: kinematic-bicycle core with lateral slip (Glide eases rear grip).
## Suspension: each wheel follows the road heightfield; the sprung body reacts
## with a damped spring in heave/pitch/roll, plus acceleration lean.
##
## Handedness: Babylon is left-handed (+Z forward, screen right = +X); Godot
## is right-handed (screen right = -X for a chase view). The sim math is
## ported verbatim; InputState negates steering/mouse-carve so on-screen
## left/right match, and visual rotation signs are mapped where they differ.

# tuning (the JS demo exposed these as live params)
var top_speed := 55.0
var accel := 11.0
var brake_decel := 14.0
var grip := 9.0
var glide_grip := 1.7
var steer_max := 0.52
var glide_yaw_gain := 1.35
var wet_grip_loss := 0.28

const WHEELBASE := 2.62
const TRACK := 1.56
const WHEEL_R := 0.325

# ---- dynamic state ----
var pos := Vector3.ZERO
var yaw := 0.0
var vx := 0.0
var vz := 0.0
var yaw_rate := 0.0
var steer_angle := 0.0
var speed := 0.0
var local_accel_z := 0.0
var lateral_g := 0.0
var drift_amount := 0.0
var slip_yaw_offset := 0.0
var braking := false
var carve := 0.0
var curb_bump := 0.0
var wall_hit := 0.0    # inward impact speed this frame (m/s), for crash SFX
var scrub := 0.0
## surface wetness 0..1, pushed by the weather system
var road_wetness := 0.0

var _heave := 0.0; var _heave_v := 0.0
var _pitch := 0.0; var _pitch_v := 0.0
var _roll := 0.0; var _roll_v := 0.0
var _t_pitch := 0.0; var _t_roll := 0.0
var _prev_vz := 0.0
var _prev_vx := 0.0

# ---- wheel state (FL, FR, RL, RR) ----
var wheel_spin: Array[float] = [0.0, 0.0, 0.0, 0.0]
var wheel_contact_x: Array[float] = [0.0, 0.0, 0.0, 0.0]
var wheel_contact_z: Array[float] = [0.0, 0.0, 0.0, 0.0]
var wheel_ground_y: Array[float] = [0.0, 0.0, 0.0, 0.0]
var wheel_steer: Array[float] = [0.0, 0.0]
var wheel_radius := WHEEL_R

var body_node: Node3D
var headlight_l: SpotLight3D
var headlight_r: SpotLight3D
var _model_wheels: Array = []      # from CarModel: {pivot, spin, base_pos, up, axle}
var _fallback_wheels: Array = []   # procedural: {pivot, spin}
var _tail_mats: Array = []
var _head_mat: StandardMaterial3D = null

## Ground height query (x, z, ref_y) -> y; main.gd wires the Barcelona
## physics raycast in here.
var ground_fn: Callable
## Physics space for mesh-world wall rays (set per frame by main).
var space: PhysicsDirectSpaceState3D = null


static func _damp(rate: float, dt: float) -> float:
	return 1.0 - exp(-rate * dt)


func _init() -> void:
	ground_fn = func(_x: float, _z: float, ref_y: float) -> float:
		return ref_y
	body_node = Node3D.new()
	body_node.name = "CarBody"
	add_child(body_node)
	_build_headlights()
	_build_fallback()
	_try_load_model()


func _build_headlights() -> void:
	for side in [-1.0, 1.0]:
		var l := SpotLight3D.new()
		l.position = Vector3(0.62 * side, 0.68, 2.05)
		# aim forward (+Z model space): SpotLight3D shines along -Z of its basis
		l.rotation = Vector3(deg_to_rad(-6.5), PI, 0.0)
		l.spot_range = 55.0
		l.spot_angle = 38.0
		l.spot_angle_attenuation = 2.2
		# diffuse pool only: full specular smears a milky glare blob across
		# the wet asphalt whenever the camera faces the beams
		l.light_specular = 0.08
		l.light_color = Color(1.0, 0.93, 0.82)
		l.light_energy = 0.0
		l.shadow_enabled = false
		add_child(l)
		if side < 0.0:
			headlight_l = l
		else:
			headlight_r = l


## Simple placeholder car (box + cylinders) — replaced by the GLB on success.
func _build_fallback() -> void:
	var paint := StandardMaterial3D.new()
	paint.albedo_color = Color(0.8, 0.214, 0.0)
	paint.metallic = 0.35
	paint.roughness = 0.42
	var body := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(1.86, 0.62, 4.6)
	body.mesh = bm
	body.material_override = paint
	body.position = Vector3(0, 0.62, 0)
	body_node.add_child(body)
	var cabin := MeshInstance3D.new()
	var cm := BoxMesh.new()
	cm.size = Vector3(1.55, 0.45, 2.0)
	cabin.mesh = cm
	cabin.material_override = paint
	cabin.position = Vector3(0, 1.1, -0.35)
	body_node.add_child(cabin)

	var tire := StandardMaterial3D.new()
	tire.albedo_color = Color(0.02, 0.02, 0.022)
	tire.roughness = 0.9
	for i in 4:
		var left := i % 2 == 0
		var pivot := Node3D.new()
		pivot.position = Vector3(
			(-1.0 if left else 1.0) * TRACK * 0.5,
			WHEEL_R,
			(1.0 if i < 2 else -1.0) * WHEELBASE * 0.5)
		add_child(pivot)
		var spin := Node3D.new()
		pivot.add_child(spin)
		var wm := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.height = 0.26
		cyl.top_radius = WHEEL_R
		cyl.bottom_radius = WHEEL_R
		wm.mesh = cyl
		wm.material_override = tire
		wm.rotation.z = PI / 2.0
		spin.add_child(wm)
		_fallback_wheels.append({"pivot": pivot, "spin": spin, "base_y": WHEEL_R})


func _try_load_model() -> void:
	var model := CarModel.build()
	if model.is_empty():
		print("[NIGHTLOOP] car GLB unavailable, keeping placeholder car")
		return
	# retire the placeholder (free immediately — we're not in the tree yet)
	for c in body_node.get_children():
		body_node.remove_child(c)
		c.free()
	for w in _fallback_wheels:
		remove_child(w.pivot)
		w.pivot.free()
	_fallback_wheels.clear()
	body_node.add_child(model.visual)
	_model_wheels = model.wheels
	_tail_mats = model.tail_mats
	_head_mat = model.head_mat
	if not _model_wheels.is_empty():
		wheel_radius = _model_wheels[0].radius
	# the beams originate at the model's actual lamp lenses, not guesses
	if model.headlight_pos.size() == 2:
		headlight_l.position = model.headlight_pos[0] + Vector3(0, 0, 0.06)
		headlight_r.position = model.headlight_pos[1] + Vector3(0, 0, 0.06)


## Bumper view hides the bodywork only — the headlights stay live.
func set_body_visible(v: bool) -> void:
	body_node.visible = v
	for w in _fallback_wheels:
		w.pivot.visible = v


## Drive beams and lens glow together from the weather's headlight value.
func set_headlights(hl: float) -> void:
	headlight_l.light_energy = hl * 5.0
	headlight_r.light_energy = hl * 5.0
	if _head_mat != null:
		_head_mat.emission_energy_multiplier = hl * 2.2


func update(dt: float, input: InputState) -> void:
	# ---- surface conditions ----
	var wet := road_wetness
	var surf_grip := 1.0 - wet * wet_grip_loss

	# ---- steering (mouse carves the line while gliding) ----
	if input.gliding:
		carve += input.mouse_dx * 0.0011
	carve -= carve * _damp(1.1 if input.gliding else 6.0, dt)
	carve = clampf(carve, -0.55, 0.55)
	var av := absf(vz)
	var speed_fade := 1.0 / (1.0 + av * 0.045 + maxf(0.0, av - 30.0) * 0.03)
	var kb_scale := 1.0 - drift_amount * 0.55
	var steer_target := (input.steer * steer_max * kb_scale + carve) * speed_fade
	steer_angle += (steer_target - steer_angle) * _damp(8.0 - minf(3.2, av * 0.055), dt)

	# ---- glide state eases in/out ----
	var glide_target := 1.0 if (input.gliding or input.handbrake) and absf(vz) > 6.0 else 0.0
	drift_amount += (glide_target - drift_amount) * _damp(3.2 if glide_target > 0.0 else 2.2, dt)

	# ---- longitudinal ----
	var az := 0.0
	braking = false
	if input.throttle > 0.0:
		var traction := (1.0 - scrub * 0.45) * (1.0 - wet * 0.12)
		az += accel * (1.0 - maxf(0.0, vz) / top_speed) * traction
	if input.brake > 0.0:
		if vz > 0.5:
			az -= brake_decel * (1.0 - wet * 0.25)
			braking = true
		elif vz > -11.0:
			az -= accel * 0.55   # reverse, capped ~40 km/h
	if input.handbrake and absf(vz) > 0.5:
		az -= signf(vz) * 8.5 * (0.7 + 0.3 * surf_grip)
		braking = true
	az -= vz * 0.045 + signf(vz) * 0.35
	az -= absf(vx) * 0.15 * drift_amount * (0.6 + 0.4 * surf_grip)
	vz += az * dt
	if absf(vz) < 0.15 and input.throttle == 0.0 and input.brake == 0.0:
		vz = 0.0

	# ---- yaw ----
	var kin_yaw_rate := (vz / WHEELBASE) * tan(steer_angle)
	var drift_yaw_rate := kin_yaw_rate * glide_yaw_gain
	var target_yaw_rate := kin_yaw_rate + (drift_yaw_rate - kin_yaw_rate) * drift_amount
	var lat_cap := (15.0 + drift_amount * 26.0) * surf_grip
	var max_yaw := lat_cap / maxf(4.0, av)
	target_yaw_rate = clampf(target_yaw_rate, -max_yaw, max_yaw)
	yaw_rate += (target_yaw_rate - yaw_rate) * _damp(6.0 - drift_amount * 2.5, dt)
	yaw += yaw_rate * dt

	# ---- lateral slip ----
	var slip_now := atan2(absf(vx), absf(vz) + 0.5) if speed > 2.0 else 0.0
	var source_fade := maxf(0.0, 1.0 - slip_now / 0.82)
	vx += -yaw_rate * vz * dt * (0.25 + drift_amount * 0.75) * source_fade
	var sat_boost := 1.0 + maxf(0.0, slip_now - 0.45) * 7.0
	var grip_now := (grip + (glide_grip - grip) * drift_amount) * sat_boost * surf_grip
	var vx_decay := vx * _damp(grip_now, dt)
	vx -= vx_decay
	lateral_g = clampf((vx_decay / dt if dt > 0.0 else 0.0) / 9.81, -3.0, 3.0)

	# ---- integrate world position ----
	var cy := cos(yaw)
	var sy := sin(yaw)
	var wvx := vx * cy + vz * sy
	var wvz := -vx * sy + vz * cy
	pos.x += wvx * dt
	pos.z += wvz * dt

	# ---- colliders ----
	# Curbs are NOT walls: the 13 cm heightfield step reaches the body through
	# the suspension. Hard containment only at the building line and the
	# motorway median barrier.
	curb_bump = 0.0
	wall_hit = 0.0
	# walls are real StaticBody3D geometry — box pushback
	var adj := _mesh_wall_collide(dt, cy, sy, wvx, wvz)
	wvx = adj.x
	wvz = adj.y
	speed = Vector2(vx, vz).length()
	slip_yaw_offset = atan2(vx, absf(vz)) if speed > 2.0 else 0.0
	scrub = minf(1.0, absf(vx) * 0.10 + drift_amount * 0.35 + (0.45 if input.handbrake else 0.0)) if speed > 3.0 else 0.0
	# forgiving: past ~30° of slip the rear catches — no surprise spins
	if speed > 5.0:
		var overshoot := absf(slip_yaw_offset) - 0.52
		if overshoot > 0.0:
			yaw_rate -= signf(slip_yaw_offset) * overshoot * dt * (8.0 + drift_amount * 22.0)
	local_accel_z = (vz - _prev_vz) / (dt if dt > 0.0 else 1.0)
	_prev_vz = vz
	_prev_vx = vx
	_post_colliders(dt, cy, sy)


## Mesh-world wall collision: a box the size of the body is tested against
## the tile geometry every frame (works at zero speed and catches corners —
## a single forward ray let the car creep into buildings and clip walls at
## an angle). Contacts with mostly-vertical surfaces push the car out and
## kill the inward velocity, like the plan's building-line pushback.
static var _wall_shape: BoxShape3D = null

func _mesh_wall_collide(dt: float, cy: float, sy: float, wvx: float, wvz: float) -> Vector2:
	if space == null:
		return Vector2(wvx, wvz)
	if _wall_shape == null:
		_wall_shape = BoxShape3D.new()
		_wall_shape.size = Vector3(1.72, 0.7, 4.35)   # slightly under body size
	var params := PhysicsShapeQueryParameters3D.new()
	params.shape = _wall_shape
	params.transform = Transform3D(Basis(Vector3.UP, yaw), pos + Vector3(0.0, 0.75, 0.0))
	var rest := space.get_rest_info(params)
	if rest.is_empty():
		return Vector2(wvx, wvz)
	var n: Vector3 = rest.normal
	if absf(n.y) > 0.5:
		return Vector2(wvx, wvz)   # ramp/kerb/ceiling contact, not a wall
	n.y = 0.0
	if n.length() < 0.1:
		return Vector2(wvx, wvz)
	n = n.normalized()
	# make sure the push points from the contact toward the car
	var contact: Vector3 = rest.point
	if (Vector3(pos.x - contact.x, 0.0, pos.z - contact.z)).dot(n) < 0.0:
		n = -n
	# no penetration depth from get_rest_info: push out a little each frame —
	# reads as a firm, slightly springy wall
	var push := minf(0.35, 0.10 + speed * dt)
	pos.x += n.x * push
	pos.z += n.z * push
	var into := -(wvx * n.x + wvz * n.z)
	if into > 0.0:
		wvx += n.x * into * 1.35
		wvz += n.z * into * 1.35
		vx = wvx * cy - wvz * sy
		vz = wvx * sy + wvz * cy
		vz *= 0.985
		curb_bump = maxf(curb_bump, minf(1.0, into * 0.15))
		wall_hit = maxf(wall_hit, into)
	return Vector2(wvx, wvz)


## Everything after collisions: wheel contacts, sprung body, transforms.
func _post_colliders(dt: float, cy: float, sy: float) -> void:
	# ---- wheel contacts + Ackermann ----
	if absf(steer_angle) > 1e-4:
		var r := WHEELBASE / tan(absf(steer_angle))
		var inner := atan(WHEELBASE / (r - TRACK * 0.5))
		var outer := atan(WHEELBASE / (r + TRACK * 0.5))
		if steer_angle > 0.0:
			wheel_steer[0] = outer; wheel_steer[1] = inner
		else:
			wheel_steer[0] = -inner; wheel_steer[1] = -outer
	else:
		wheel_steer[0] = 0.0
		wheel_steer[1] = 0.0

	var g_sum := 0.0
	for i in 4:
		var left := i % 2 == 0
		var lx := (-1.0 if left else 1.0) * TRACK * 0.5
		var lz := (1.0 if i < 2 else -1.0) * WHEELBASE * 0.5
		var wx := pos.x + lx * cy + lz * sy
		var wz := pos.z - lx * sy + lz * cy
		wheel_contact_x[i] = wx
		wheel_contact_z[i] = wz
		var gy: float = ground_fn.call(wx, wz, pos.y)
		wheel_ground_y[i] = gy
		g_sum += gy
	var g_avg := g_sum * 0.25
	pos.y = g_avg

	# ---- sprung body: terrain attitude fast, acceleration lean springy ----
	var front_avg := (wheel_ground_y[0] + wheel_ground_y[1]) * 0.5
	var rear_avg := (wheel_ground_y[2] + wheel_ground_y[3]) * 0.5
	var left_avg := (wheel_ground_y[0] + wheel_ground_y[2]) * 0.5
	var right_avg := (wheel_ground_y[1] + wheel_ground_y[3]) * 0.5
	var terrain_pitch := atan2(rear_avg - front_avg, WHEELBASE)
	var terrain_roll := -atan2(right_avg - left_avg, TRACK)
	_t_pitch += (terrain_pitch - _t_pitch) * _damp(16.0, dt)
	_t_roll += (terrain_roll - _t_roll) * _damp(16.0, dt)
	var pitch_t := local_accel_z * 0.006
	var roll_t := lateral_g * 0.030 + vx * 0.006
	var k := 55.0
	var c := 9.5
	_heave_v += ((0.0 - _heave) * k - _heave_v * c) * dt
	_heave += _heave_v * dt
	_pitch_v += ((pitch_t - _pitch) * k - _pitch_v * c) * dt
	_pitch += _pitch_v * dt
	_roll_v += ((roll_t - _roll) * k - _roll_v * c) * dt
	_roll += _roll_v * dt

	# ---- apply transforms ----
	position = pos
	rotation = Vector3(0.0, yaw, 0.0)
	var p_tot := clampf(_pitch + _t_pitch, -0.12, 0.12)
	var r_tot := clampf(_roll + _t_roll, -0.12, 0.12)
	# R_x(+θ) noses down in both engines (same matrix); roll is negated once
	# for the mirrored steering convention so terrain attitude tips downhill.
	body_node.position.y = _heave
	body_node.rotation = Vector3(p_tot, 0.0, -r_tot)

	# ---- wheels: plant on ground, spin, steer ----
	var spin_rate := vz / wheel_radius
	for i in 4:
		wheel_spin[i] += spin_rate * dt
	for tm in _tail_mats:
		if vz < -0.3:
			tm.emission = Color(1.0, 0.95, 0.8)
			tm.emission_energy_multiplier = 2.2
		else:
			tm.emission = Color(1.0, 0.08, 0.03)
			tm.emission_energy_multiplier = 3.4 if braking else 1.2
	if not _model_wheels.is_empty():
		for i in 4:
			var w: Dictionary = _model_wheels[i]
			var dy: float = (wheel_ground_y[i] - g_avg) * w.inv_w_per_l
			var pivot: Node3D = w.pivot
			pivot.position = w.center_p + w.up_l * dy
			if i < 2:
				pivot.basis = Basis(w.up_l, wheel_steer[i])
			var spin: Node3D = w.spin
			spin.basis = Basis(w.axle_l, wheel_spin[i])
	else:
		for i in 4:
			var w: Dictionary = _fallback_wheels[i]
			var pivot: Node3D = w.pivot
			pivot.position.y = w.base_y + (wheel_ground_y[i] - g_avg)
			if i < 2:
				pivot.rotation = Vector3(0.0, wheel_steer[i], 0.0)
			var spin: Node3D = w.spin
			spin.rotation = Vector3(wheel_spin[i], 0.0, 0.0)


