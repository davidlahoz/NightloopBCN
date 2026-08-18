class_name ChaseCamera
extends Camera3D
## Spring-arm chase camera with velocity-aware behaviour, free mouse orbit,
## eased scroll zoom, speed-driven FOV, drift banking, and an alternate
## bumper view (toggled with C). Port of src/camera/chaseCamera.js.

var cam_dist := 5.6
var cam_height := 1.85
var cam_fov := 52.0        # degrees, base
var cam_fov_speed := 14.0  # degrees of speed gain
var cam_lag := 0.09
var cam_bank := 2.6        # drift bank degrees
var cam_stiff := 7.5
var cam_side_offset := 0.42
var cam_shake := 1.0

var mode := 0              # 0 = chase, 1 = bumper
var orbit_yaw := 0.0
var orbit_pitch := 0.0
var zoom := 0.45
var shake_energy := 0.0
var follow_yaw := 0.0

var _orbit_idle := 0.0
var _zoom_target := 0.45
var _smooth_fov := 52.0
var _roll := 0.0
var _arm_stretch := 0.0
var _pos := Vector3(0, 3, -8)
var _look := Vector3.ZERO
var _shake_t := 0.0
var _ctx: CityPlan.PlanCtx
## Ground clearance query (x, z, ref_y) -> y; mesh worlds swap in a raycast.
var ground_fn: Callable


static func _damp(rate: float, dt: float) -> float:
	return 1.0 - exp(-rate * dt)


func _init(ctx: CityPlan.PlanCtx) -> void:
	_ctx = ctx
	ground_fn = func(x: float, z: float, _ref_y: float) -> float:
		return RoadProfile.ground_height(x, z, _ctx)
	near = 0.3
	far = 2000.0
	fov = cam_fov
	_smooth_fov = cam_fov
	position = Vector3(0, 3, -8)
	current = true


func update(dt: float, car: Car, input: InputState) -> void:
	if input.toggle_camera:
		mode ^= 1

	# ---- zoom (scroll) ----
	if input.wheel != 0.0:
		_zoom_target = clampf(_zoom_target + input.wheel * 0.0008, 0.0, 1.0)
	zoom += (_zoom_target - zoom) * _damp(6.0, dt)

	# ---- mouse orbit (the mouse carves the car's line during Glide) ----
	if not input.gliding and (input.mouse_dx != 0.0 or input.mouse_dy != 0.0):
		orbit_yaw += input.mouse_dx * 0.0032
		orbit_pitch = clampf(orbit_pitch + input.mouse_dy * 0.0022, -0.35, 0.55)
		_orbit_idle = 0.0
	else:
		_orbit_idle += dt
	# recentre while driving after a moment of mouse inactivity
	var speed := car.speed
	if _orbit_idle > 1.2 and speed > 3.0:
		var rc := _damp(1.8, dt)
		orbit_yaw -= orbit_yaw * rc
		orbit_pitch -= orbit_pitch * rc

	# ---- follow yaw: car yaw blended toward travel direction in drift ----
	var target_yaw := car.yaw + car.drift_amount * car.slip_yaw_offset * 0.55
	var dy := wrapf(target_yaw - follow_yaw, -PI, PI)
	follow_yaw += dy * _damp(cam_stiff, dt)

	if mode == 1:
		_update_bumper(dt, car)
		return

	# ---- desired position ----
	var dist := (cam_dist + zoom * 5.5) * (1.0 + _arm_stretch)
	var height := cam_height + zoom * 1.3

	var stretch_target := car.local_accel_z * cam_lag * 0.1
	_arm_stretch += (stretch_target - _arm_stretch) * _damp(3.5, dt)

	var yaw := follow_yaw + orbit_yaw
	var pitch := 0.16 + orbit_pitch + zoom * 0.1
	var fwd := Vector3(sin(yaw), 0.0, cos(yaw))
	var right := Vector3(cos(yaw), 0.0, -sin(yaw))
	var cp := cos(pitch)
	var sp := sin(pitch)

	var desired := car.pos
	desired.x -= fwd.x * dist * cp
	desired.z -= fwd.z * dist * cp
	desired.y += height + dist * sp * 0.55
	desired.x += right.x * cam_side_offset
	desired.z += right.z * cam_side_offset

	# never below ground
	var gy: float = ground_fn.call(desired.x, desired.z, desired.y) + 0.35
	if desired.y < gy:
		desired.y = gy

	# ---- smooth position ----
	var k := _damp(cam_stiff * 1.4, dt)
	_pos.x += (desired.x - _pos.x) * k
	_pos.y += (desired.y - _pos.y) * (k * 0.8)
	_pos.z += (desired.z - _pos.z) * k

	# ---- look target: ahead of the car ----
	var target := car.pos + fwd * 3.0
	target.y += 0.9
	var lk := _damp(cam_stiff * 1.8, dt)
	_look += (target - _look) * lk

	# ---- shake ----
	_shake_t += dt * (8.0 + speed * 0.6)
	var shake_amp := shake_energy * cam_shake * 0.02
	var shx := sin(_shake_t * 2.17) * shake_amp
	var shy := sin(_shake_t * 3.31 + 1.3) * shake_amp * 0.7

	position = Vector3(_pos.x + shx, _pos.y + shy, _pos.z)

	# ---- roll (bank into drift) ----
	var roll_target := -car.lateral_g * deg_to_rad(cam_bank)
	_roll += (roll_target - _roll) * _damp(3.0, dt)
	_look_with_roll()

	# ---- fov ----
	var speed_t := minf(speed / 38.0, 1.0)
	var fov_t := cam_fov + cam_fov_speed * speed_t * (speed / 38.0 if speed / 38.0 < 1.0 else 1.0) + car.drift_amount * 5.5
	_smooth_fov += (fov_t - _smooth_fov) * _damp(2.5, dt)
	fov = _smooth_fov

	shake_energy -= shake_energy * _damp(4.0, dt)


func _update_bumper(dt: float, car: Car) -> void:
	# low, fixed to the body, flatters the road shader
	var sy := sin(car.yaw)
	var cy := cos(car.yaw)
	var desired := car.pos + Vector3(sy * 1.9, 0.55, cy * 1.9)
	var k := _damp(30.0, dt)
	_pos += (desired - _pos) * k
	position = _pos
	_look = _pos + Vector3(sy * 10.0, 0.12, cy * 10.0)
	var fov_t := cam_fov + 8.0
	_smooth_fov += (fov_t - _smooth_fov) * _damp(4.0, dt)
	fov = _smooth_fov
	_roll += (0.0 - _roll) * _damp(3.0, dt)
	_look_with_roll()


func _look_with_roll() -> void:
	var view := (_look - position)
	if view.length_squared() < 1e-6:
		return
	view = view.normalized()
	var up := Vector3.UP
	if absf(_roll) > 1e-4:
		up = Basis(view, _roll) * Vector3.UP
	if absf(view.dot(up)) < 0.999:
		look_at(_look, up)
