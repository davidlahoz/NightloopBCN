class_name InputState
## Keyboard + mouse state, consumed once per frame by the simulation.
## Port of src/core/input.js on top of Godot's InputMap.
##
## Handedness note: steering and horizontal mouse input are NEGATED relative
## to the JS demo — Babylon renders left-handed, Godot right-handed, so the
## sign flip keeps "D turns right on screen" true with verbatim physics math.

var mouse_dx := 0.0
var mouse_dy := 0.0
var wheel := 0.0
var mood_key := 0        # 1..3, one-shot
var jump_key := 0        # 6..9, one-shot
var toggle_camera := false
var toggle_mute := false
var toggle_map := false

## Capture tooling can turn the mouse off entirely.
var mouse_enabled := true
## Capture mode: the physical keyboard is ignored and driving comes from the
## scripted values below (a popped-up capture window steals focus, so real
## keystrokes must never leak into a scripted run).
var capture_mode := false
var script_throttle := 0.0
var script_steer := 0.0

var _acc_dx := 0.0
var _acc_dy := 0.0
var _acc_wheel := 0.0


## Feed from _unhandled_input / _input.
func handle_event(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		# orbit only while captured — a free cursor crossing the window
		# (e.g. heading for the title bar) must not spin the camera
		if not mouse_enabled or Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
			return
		# window focus/entry can deliver one huge relative jump — drop it
		if event.relative.length() > 250.0:
			return
		_acc_dx += event.relative.x
		_acc_dy += event.relative.y
	elif event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_acc_wheel -= 60.0
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_acc_wheel += 60.0
	elif event.is_action_pressed("camera_toggle"):
		toggle_camera = true
	elif event.is_action_pressed("mute"):
		toggle_mute = true
	elif event.is_action_pressed("map"):
		toggle_map = true
	elif event.is_action_pressed("time_day"):
		mood_key = 1
	elif event.is_action_pressed("time_afternoon"):
		mood_key = 2
	elif event.is_action_pressed("time_night"):
		mood_key = 3
	elif event.is_action_pressed("jump_downtown"):
		jump_key = 6
	elif event.is_action_pressed("jump_residential"):
		jump_key = 7
	elif event.is_action_pressed("jump_industrial"):
		jump_key = 8
	elif event.is_action_pressed("jump_countryside"):
		jump_key = 9


## Latch accumulated deltas for this frame (negated horizontal — see above).
func begin_frame() -> void:
	mouse_dx = -_acc_dx
	_acc_dx = 0.0
	mouse_dy = _acc_dy
	_acc_dy = 0.0
	wheel = _acc_wheel
	_acc_wheel = 0.0


## Consume one-shot state at end of frame.
func end_frame() -> void:
	mood_key = 0
	jump_key = 0
	toggle_camera = false
	toggle_mute = false
	toggle_map = false


var throttle: float:
	get:
		if capture_mode:
			return script_throttle
		return 1.0 if Input.is_action_pressed("throttle") else 0.0

var brake: float:
	get:
		if capture_mode:
			return 0.0
		return 1.0 if Input.is_action_pressed("brake") else 0.0

## A = +1, D = -1 (negated vs the JS demo — handedness, see header).
var steer: float:
	get:
		if capture_mode:
			return script_steer
		return (1.0 if Input.is_action_pressed("steer_left") else 0.0) \
			- (1.0 if Input.is_action_pressed("steer_right") else 0.0)

var gliding: bool:
	get: return not capture_mode and Input.is_action_pressed("glide")

var handbrake: bool:
	get: return not capture_mode and Input.is_action_pressed("handbrake")
