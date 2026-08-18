class_name TrafficSystem
extends Node3D
## AI traffic for the Barcelona world.
##
## Vehicles: "Generic passenger car pack" by Comrade1280 (Sketchfab,
## CC-BY 4.0 — see ASSETS.md). The pack is a showroom scene: each car is a
## "* Body" group with its wheels as sibling nodes, scattered around a
## display platform. At init the pack is dissected into normalized variant
## templates (footprint centre at origin, ground y = 0, forward +Z via the
## wheel rectangle's long axis; VARIANT_FLIP fixes the front/back ambiguity).
##
## AI: cars follow the baked OSM street polylines (StreetNames doubles as
## the road network), offset to the right of travel, braking for the player
## and each other. Each car carries a StaticBody3D box, so the player's
## mesh-world collision test treats traffic as solid for free.

const TARGET_CARS := 12
const SPAWN_MIN := 60.0
const SPAWN_MAX := 230.0
const DESPAWN := 320.0
const LANE_OFFSET := 1.7      # metres right of the way centreline
const PACK_PATH := "res://assets/car/generic_passenger_car_pack.glb"
## Variants whose extracted long-axis sign points backwards (calibrated
## visually — the wheel rectangle can't tell front from back).
const VARIANT_FLIP := {}

var _sn: StreetNames
var _templates: Array = []     # {node: Node3D, wheel_r: float}
var _cars: Array = []          # of TrafficCar
var _rng := RandomNumberGenerator.new()
var _spawn_segs := PackedInt32Array()
var _spawn_accum := 999.0


class TrafficCar:
	var node: Node3D
	var wheels: Array[Node3D] = []
	var wheel_r := 0.31
	var way := -1
	var seg := 0
	var dir := 1
	var t := 0.0
	var speed := 0.0
	var base_speed := 10.0
	var yaw := 0.0
	var spin := 0.0
	var y := 0.0
	var rpos := Vector2.ZERO   # rendered position, smoothed behind the path anchor


func _init(sn: StreetNames) -> void:
	_sn = sn
	_rng.randomize()
	_build_templates()


func update(dt: float, player_pos: Vector3) -> void:
	if _templates.is_empty() or not _sn.is_ready():
		return
	_spawn_accum += dt
	if _spawn_accum > 1.0:
		_spawn_accum = 0.0
		_spawn_segs = _sn.segments_near(player_pos.x, player_pos.z, SPAWN_MAX)
	if _cars.size() < TARGET_CARS:
		_spawn_one(player_pos)
	var space := get_world_3d().direct_space_state
	for c in _cars:
		_drive(c, dt, player_pos, space)


func _spawn_one(player_pos: Vector3) -> void:
	if _spawn_segs.is_empty():
		return
	for _attempt in 8:
		var si := _spawn_segs[_rng.randi_range(0, _spawn_segs.size() - 1)]
		var a := _sn.seg_a(si)
		var b := _sn.seg_b(si)
		var t := _rng.randf()
		var p := a.lerp(b, t)
		var d := Vector2(p.x - player_pos.x, p.y - player_pos.z).length()
		if d < SPAWN_MIN or d > SPAWN_MAX:
			continue
		var c := TrafficCar.new()
		var tdef: Dictionary = _templates[_rng.randi_range(0, _templates.size() - 1)]
		c.node = tdef.node.duplicate()
		c.wheel_r = tdef.wheel_r
		for w in c.node.get_children():
			if w.name.begins_with("wheel_pivot"):
				c.wheels.append(w)
		add_child(c.node)
		c.way = _sn.seg_way(si)
		c.seg = si
		c.dir = 1 if _rng.randf() < 0.5 else -1
		c.t = t
		c.base_speed = 8.0 + _rng.randf() * 4.0
		c.speed = c.base_speed * 0.5
		c.y = player_pos.y
		var fwd := ((b - a) * float(c.dir)).normalized()
		c.yaw = atan2(fwd.x, fwd.y)
		c.rpos = p + Vector2(-fwd.y, fwd.x) * LANE_OFFSET
		_cars.append(c)
		return


func _respawn(c: TrafficCar, player_pos: Vector3) -> void:
	# recycle in place: park it far away until a slot is found next frames
	c.node.queue_free()
	_cars.erase(c)
	_spawn_one(player_pos)


func _drive(c: TrafficCar, dt: float, player_pos: Vector3, space: PhysicsDirectSpaceState3D) -> void:
	var a := _sn.seg_a(c.seg)
	var b := _sn.seg_b(c.seg)
	if c.dir < 0:
		var tmp := a
		a = b
		b = tmp
	var seg_len := a.distance_to(b)
	if seg_len < 0.05:
		seg_len = 0.05

	# ---- avoidance: brake for the player and other traffic ahead ----
	var fwd := (b - a) / seg_len
	var pos2 := a.lerp(b, c.t)
	var target := c.base_speed
	var blockers := [Vector2(player_pos.x, player_pos.z)]
	for o in _cars:
		if o != c:
			blockers.append(Vector2(o.node.position.x, o.node.position.z))
	for bp in blockers:
		var delta: Vector2 = bp - pos2
		var along := delta.dot(fwd)
		var lat := absf(delta.cross(fwd))
		# narrow corridor only — traffic must filter past obstacles that sit
		# beside its lane (a parked player used to jam both directions)
		if along > 0.5 and along < 14.0 and lat < 1.9:
			target = minf(target, clampf((along - 5.5) * 1.2, 0.0, c.base_speed))
	c.speed += clampf(target - c.speed, -9.0 * dt, 3.5 * dt)

	# ---- advance along the polyline; turn at intersections ----
	var advance := c.speed * dt / seg_len
	c.t += advance
	while c.t >= 1.0:
		var next := c.seg + c.dir
		if next < _sn.way_first_seg(c.way) or next > _sn.way_last_seg(c.way):
			if not _take_turn(c):
				_respawn(c, player_pos)
				return
			next = c.seg
		else:
			c.seg = next
		c.t = maxf((c.t - 1.0) * seg_len, 0.0)
		a = _sn.seg_a(c.seg)
		b = _sn.seg_b(c.seg)
		if c.dir < 0:
			var tmp2 := a
			a = b
			b = tmp2
		seg_len = maxf(a.distance_to(b), 0.05)
		c.t /= seg_len
		fwd = (b - a) / seg_len
	pos2 = a.lerp(b, c.t)

	# right-hand lane offset (Spain drives on the right: screen-right of
	# travel is -X for a +Z heading in our mirrored frame) + ground follow
	var right := Vector2(-fwd.y, fwd.x)
	pos2 += right * LANE_OFFSET
	var q := PhysicsRayQueryParameters3D.create(
		Vector3(pos2.x, c.y + 2.5, pos2.y), Vector3(pos2.x, c.y - 8.0, pos2.y))
	var hit := space.intersect_ray(q)
	if not hit.is_empty() and hit.position.y < c.y + 1.2:
		c.y = hit.position.y

	# despawn when far behind
	if Vector2(pos2.x - player_pos.x, pos2.y - player_pos.z).length() > DESPAWN:
		_respawn(c, player_pos)
		return

	# ---- smoothed follower: rounds the polyline corners ----
	c.rpos += (pos2 - c.rpos) * minf(1.0, 5.0 * dt)
	var target_yaw := atan2(fwd.x, fwd.y)
	c.yaw += wrapf(target_yaw - c.yaw, -PI, PI) * minf(1.0, 6.0 * dt)
	c.node.position = Vector3(c.rpos.x, c.y, c.rpos.y)
	c.node.rotation = Vector3(0.0, c.yaw, 0.0)
	c.spin += c.speed / c.wheel_r * dt
	for w in c.wheels:
		w.rotation = Vector3(c.spin, w.rotation.y, 0.0)


## At the end of a way, continue onto a connecting street (or U-turn at a
## dead end). Returns false when there is nothing to connect to.
func _take_turn(c: TrafficCar) -> bool:
	var p := _sn.way_end_point(c.way) if c.dir > 0 else _sn.way_start_point(c.way)
	var candidates := _sn.ways_at_point(p)
	var options: Array = []
	for wi in candidates:
		if wi == c.way:
			continue
		options.append(wi)
	if options.is_empty():
		# dead end: U-turn on the same way
		c.dir = -c.dir
		c.seg = c.seg
		c.t = 0.0
		return true
	var pick: int = options[_rng.randi_range(0, options.size() - 1)]
	var starts := _sn.way_start_point(pick).distance_to(p) < 1.0
	c.way = pick
	if starts:
		c.dir = 1
		c.seg = _sn.way_first_seg(pick)
	else:
		c.dir = -1
		c.seg = _sn.way_last_seg(pick)
	c.t = 0.0
	return true


# --- variant extraction from the showroom scene --------------------------

func _build_templates() -> void:
	if not ResourceLoader.exists(PACK_PATH):
		push_warning("[NIGHTLOOP] traffic pack missing")
		return
	var packed: PackedScene = load(PACK_PATH)
	var root: Node3D = packed.instantiate()

	# gather body groups and wheel groups with their world transforms
	var bodies: Array = []   # {name, node, xf}
	var wheels: Array = []   # {node, xf, center, radius}
	var stack: Array = [[root, Transform3D.IDENTITY]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D:
			xf = xf * n.transform
		var lname := String(n.name).to_lower()
		if lname.ends_with("body") or lname.ends_with("body2"):
			bodies.append({"name": String(n.name), "node": n, "xf": xf})
			continue
		if lname.begins_with("wheel"):
			var ab := _subtree_aabb(n, xf)
			wheels.append({"node": n, "xf": xf, "center": ab.get_center(), "radius": maxf(ab.size.y, 0.4) / 2.0})
			continue
		for ch in n.get_children():
			stack.append([ch, xf])

	for bdef in bodies:
		var bb := _subtree_aabb(bdef.node, bdef.xf)
		var bc := bb.get_center()
		# claim the 4 nearest wheels within 4 m
		var mine: Array = []
		for w in wheels:
			var d: float = Vector2(w.center.x - bc.x, w.center.z - bc.z).length()
			if d < 4.0:
				mine.append([d, w])
		mine.sort_custom(func(p, q): return p[0] < q[0])
		mine = mine.slice(0, 4)
		if mine.size() < 4:
			continue
		# long axis of the wheel rectangle = forward
		var centroid := Vector2.ZERO
		for m in mine:
			centroid += Vector2(m[1].center.x, m[1].center.z)
		centroid /= 4.0
		var cxx := 0.0
		var czz := 0.0
		var cxz := 0.0
		for m in mine:
			var dx: float = m[1].center.x - centroid.x
			var dz: float = m[1].center.z - centroid.y
			cxx += dx * dx
			czz += dz * dz
			cxz += dx * dz
		var axis := 0.5 * atan2(2.0 * cxz, cxx - czz)
		# axis is the direction of maximum spread in the xz plane; make it yaw
		var yaw := PI / 2.0 - axis
		if VARIANT_FLIP.get(bdef.name, false):
			yaw += PI
		var frame := Transform3D(Basis(Vector3.UP, yaw), Vector3(centroid.x, 0.0, centroid.y))
		var inv := frame.affine_inverse()

		# the pack's cars are authored at uneven scales — normalise every
		# variant to a realistic ~2.7 m wheelbase
		var fwd2 := Vector2(sin(yaw), cos(yaw))
		var pmin := INF
		var pmax := -INF
		for m in mine:
			var proj := Vector2(m[1].center.x, m[1].center.z).dot(fwd2)
			pmin = minf(pmin, proj)
			pmax = maxf(pmax, proj)
		var wheelbase := maxf(pmax - pmin, 0.8)
		var s := clampf(2.7 / wheelbase, 0.55, 1.9)

		var tpl := Node3D.new()
		tpl.name = String(bdef.name).replace(" ", "_")
		tpl.scale = Vector3.ONE * s
		_copy_meshes(bdef.node, bdef.xf, inv, tpl)
		for m in mine:
			var pivot := Node3D.new()
			pivot.name = "wheel_pivot"
			pivot.position = inv * m[1].center
			tpl.add_child(pivot)
			var winv := Transform3D(Basis.IDENTITY, m[1].center).affine_inverse()
			_copy_meshes(m[1].node, m[1].xf, winv, pivot)
		_templates.append({"node": tpl, "wheel_r": m_radius(mine) * s})
	root.free()
	print("[NIGHTLOOP] traffic: %d car variants extracted" % _templates.size())


func _copy_meshes(from: Node, from_xf: Transform3D, inv: Transform3D, into: Node3D) -> void:
	var stack: Array = [[from, from_xf]]
	var added := false
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var xf: Transform3D = e[1]
		if n is Node3D and n != from:
			xf = xf * n.transform
		if n is MeshInstance3D and n.mesh != null:
			var mi := MeshInstance3D.new()
			mi.mesh = n.mesh
			for si in n.mesh.get_surface_count():
				var m: Material = n.get_surface_override_material(si)
				if m != null:
					mi.set_surface_override_material(si, m)
			mi.transform = inv * xf
			into.add_child(mi)
			added = true
		for ch in n.get_children():
			stack.append([ch, xf])
	# one collision box per template root so the player's wall test sees us
	if added and into.name != "wheel_pivot" and into.get_node_or_null("colbody") == null:
		var body := StaticBody3D.new()
		body.name = "colbody"
		var shape := CollisionShape3D.new()
		var box := BoxShape3D.new()
		box.size = Vector3(1.9, 1.2, 4.4)
		shape.shape = box
		shape.position = Vector3(0.0, 0.7, 0.0)
		body.add_child(shape)
		into.add_child(body)


static func m_radius(mine: Array) -> float:
	var r := 0.0
	for m in mine:
		r += m[1].radius
	return r / mine.size()


static func _subtree_aabb(node: Node, xf: Transform3D) -> AABB:
	var result := AABB()
	var first := true
	var stack: Array = [[node, xf]]
	while not stack.is_empty():
		var e: Array = stack.pop_back()
		var n: Node = e[0]
		var nxf: Transform3D = e[1]
		if n is Node3D and n != node:
			nxf = nxf * n.transform
		if n is MeshInstance3D and n.mesh != null:
			var ab: AABB = nxf * n.mesh.get_aabb()
			if first:
				result = ab
				first = false
			else:
				result = result.merge(ab)
		for ch in n.get_children():
			stack.append([ch, nxf])
	return result
