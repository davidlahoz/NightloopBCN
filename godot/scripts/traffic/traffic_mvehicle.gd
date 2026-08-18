class_name TrafficMVehicle
extends MVehicle3D
## Promoted ambient car — Tier 0.
##
## Uses M.A.V.S's VehicleBody3D controller class (per the integration rule:
## controller only, no opponent AI / traffic manager / nav pathing), but
## overrides the per-frame loop: the player-input plumbing is bypassed and
## steering/engine_force/brake are produced from the kinematic sim's IDM
## intent. MAV + Godot vehicle physics drive the wheels; IDM decides intent.
##
## Convention: VehicleBody3D forward is -Z, our car models face +Z, so the
## visual is mounted rotated PI around Y by the spawner.

var target_speed := 0.0        # m/s, set from IDM every frame
var target_point := Vector3.ZERO   # lookahead point on the lane

const MAX_STEER := 0.6
const FORCE_P := 900.0
const MAX_FORCE := 3200.0
const BRAKE_P := 2.2
const MAX_BRAKE := 9.0


func _ready() -> void:
	# skip MVehicle3D._ready: it only warns about Jolt and grabs the camera
	# for the player vehicle — neither applies to ambient cars
	pass


func _physics_process(_delta: float) -> void:
	var v := linear_velocity.length()
	var local := to_local(target_point)
	# forward is -Z: steer toward the lookahead, positive turns left
	steering = clampf(atan2(-local.x, maxf(-local.z, 0.5)), -MAX_STEER, MAX_STEER)
	var err := target_speed - v
	if err > 0.25:
		# positive engine_force drives the body toward its -Z forward
		engine_force = clampf(err * FORCE_P, 0.0, MAX_FORCE)
		brake = 0.0
	elif err < -0.5:
		engine_force = 0.0
		brake = clampf(-err * BRAKE_P, 0.0, MAX_BRAKE)
	else:
		engine_force = 0.0
		brake = 0.6 if target_speed < 0.2 else 0.0
