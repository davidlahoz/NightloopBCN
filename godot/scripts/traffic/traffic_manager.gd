extends Node3D
## TrafficManager (autoload) — ambient traffic over the offline lane graph.
##
## Tier 1: cars are rows in flat arrays advanced kinematically along lane
## polylines with IDM car-following; visuals are per-variant MultiMeshes.
## Tier 0: the nearest cars are promoted to TrafficMVehicle physics bodies
## (M.A.V.S VehicleBody3D controller driven by IDM intent).
## Night LOD: beyond mesh_distance a car is only a pair of emissive light
## quads; a small pool of real SpotLight3Ds serves the nearest cars.
##
## Idle until setup(player, world) is called (Barcelona mode only).

# ---- exported tuning ----
@export var target_population := 220
@export var spawn_min := 150.0
@export var spawn_max := 250.0
@export var despawn_radius := 350.0
@export var promote_radius := 60.0
@export var demote_radius := 75.0
@export var max_promoted := 12
@export var mesh_distance := 80.0     # past this: light quads only
@export var headlight_pool := 6      # real SpotLight3D cones
@export var car_length := 4.5

# IDM
const IDM_T := 0.9
const IDM_A := 1.5
const IDM_B := 2.0
const IDM_S0 := 2.0
const JUNCTION_LOOK := 25.0
const TTC_LIMIT := 3.0
const STUCK_SECONDS := 15.0
const MAX_CARS := 400

const CH_G := 71   # 'G' protected green
const CH_g := 103  # 'g' permissive
const CH_y := 121
const CH_r := 114

var graph := LaneGraph.new()
var player: Node = null           # anything with .pos (the Car)
var enabled := false

# ---- car SoA ----
var c_lane := PackedInt32Array()
var c_dist := PackedFloat32Array()
var c_speed := PackedFloat32Array()
var c_v0 := PackedFloat32Array()      # desired-speed factor (jitter)
var c_T := PackedFloat32Array()       # headway jitter
var c_next := PackedInt32Array()      # chosen connection, -1 undecided
var c_exit := PackedInt32Array()      # connection being traversed on a via lane
var c_y := PackedFloat32Array()
var c_yaw := PackedFloat32Array()
var c_variant := PackedInt32Array()
var c_wait := PackedFloat32Array()
var c_accel := PackedFloat32Array()   # last IDM accel (brake-light state)
var c_alive := PackedByteArray()
var night_lights := 1.0               # env headlight level, set by main
var c_promoted: Array = []            # TrafficMVehicle or null
var _free: Array[int] = []
var alive_count := 0
var promoted_count := 0

var _lane_cars: Dictionary = {}       # lane -> PackedInt32Array sorted by dist asc
var c_px := PackedFloat32Array()      # world position cache (written by visuals,
var c_pz := PackedFloat32Array()      # reused by despawn/promotion checks)
var _xf_cache: Array[Transform3D] = []
var _time := 0.0
var _spawn_accum := 0.0
var _promo_accum := 0.0
var _ray_cursor := 0
var _rng := RandomNumberGenerator.new()

# visuals
var _variants: Array = []             # {mesh: ArrayMesh, wheel_r, template: Node3D}
var _variant_wcum: Array[float] = []  # cumulative spawn weights (trucks rarer)
var _variant_wsum := 0.0
var _variant_len: Array[float] = []   # body length per variant (IDM gaps)
var c_len := PackedFloat32Array()     # per-car body length
var _mm_cars: Array = []              # MultiMeshInstance3D per variant
var _mm_lights: MultiMeshInstance3D
var _mm_signals: MultiMeshInstance3D
var _spots: Array[SpotLight3D] = []

# debug
var overlay: Label
var debug_lanes := false
var _orient_test := false
var _orient_one := -1
var _follow_test := false
var _with_promo := false
var _debug_mesh: MeshInstance3D
var _debug_accum := 0.0
var tick_ms := 0.0
var tick_ms_max := 0.0
var stuck_log: Array[String] = []     # rolling, newest last


func setup(p_player: Node) -> void:
	player = p_player
	_rng.randomize()
	var uargs := OS.get_cmdline_user_args()
	debug_lanes = uargs.has("--lanes")
	if uargs.has("--single-car"):
		target_population = 1
	for a in uargs:
		if a.begins_with("--traffic="):
			target_population = maxi(int(a.substr(10)), 0)
	if target_population != 220:
		print("[traffic] population override: %d" % target_population)
	_orient_test = uargs.has("--orient-test")
	_follow_test = uargs.has("--follow-test")
	_with_promo = uargs.has("--with-promo")
	if _follow_test:
		target_population = 2
	for a in uargs:
		if a.begins_with("--orient-one="):
			_orient_test = true
			_orient_one = int(a.substr(13))
	WorkerThreadPool.add_task(func(): graph.load_bin(), false, "nl_lane_graph")
	_build_visual_pools()
	_build_overlay()
	enabled = true
	if uargs.has("--showroom"):
		# render a whole vehicle pack as-is for visual identification
		target_population = 0
		var pk: PackedScene = load("res://assets/car/truck-minipack.glb")
		var pr: Node3D = pk.instantiate()
		pr.position = player.pos + Vector3(-12.0, 45.0, 16.0)   # above roofs
		add_child(pr)
		print("[traffic] showroom: truck pack at player")
		return
	if _orient_test:
		# C3 orientation test: every variant at IDENTITY in a row. The fleet
		# contract is nose = +Z, so in a north-up top-down view every nose
		# must point screen-down. No cars are simulated.
		target_population = 0
		for i in _variants.size():
			if _orient_one >= 0 and i != _orient_one:
				continue
			var mi := MeshInstance3D.new()
			mi.mesh = _variants[i].mesh
			var off := Vector3(0, 0.2, -10.0) if _orient_one >= 0 \
				else Vector3((i - _variants.size() / 2.0) * 4.5, 0.2, -8.0)
			mi.transform = Transform3D(Basis.IDENTITY, player.pos + off)
			add_child(mi)
		print("[traffic] orient test: variant %s at identity, +Z = forward"
				% (str(_orient_one) if _orient_one >= 0 else "row"))


func _ready() -> void:
	set_process(true)


func _input(event: InputEvent) -> void:
	if enabled and event is InputEventKey and event.pressed and event.keycode == KEY_T:
		debug_lanes = not debug_lanes
		if not debug_lanes and _debug_mesh != null:
			_debug_mesh.mesh = ImmediateMesh.new()


func _process(dt: float) -> void:
	if not enabled or player == null or not graph.ready:
		return
	var t0 := Time.get_ticks_usec()
	_time += dt
	var ppos: Vector3 = player.pos

	_ensure_arrays()
	if not _did_fill:
		_did_fill = true
		_initial_fill(ppos)
	_separation_pass(ppos)
	_sim(dt, ppos)
	_do_transfers(ppos)
	_spawn_accum += dt
	if _spawn_accum >= 0.4:
		_spawn_accum = 0.0
		_spawn_despawn(ppos)
	_promo_accum += dt
	if _promo_accum >= 0.3:
		_promo_accum = 0.0
		_update_promotion(ppos)
	_update_elevation(ppos)
	_update_visuals(dt, ppos)
	if debug_lanes:
		_debug_accum += dt
		if _debug_accum > 0.5:
			_debug_accum = 0.0
			_draw_debug_lanes(ppos)

	var ms := (Time.get_ticks_usec() - t0) / 1000.0
	tick_ms = lerpf(tick_ms, ms, 0.1)
	tick_ms_max = maxf(tick_ms_max * 0.995, ms)
	if overlay != null:
		overlay.text = "traffic %d cars · %d promoted · %.2f ms (max %.2f)%s" % [
			alive_count, promoted_count, tick_ms, tick_ms_max,
			("\n" + stuck_log[-1]) if not stuck_log.is_empty() else ""]


func _ensure_arrays() -> void:
	if c_lane.size() == MAX_CARS:
		return
	c_lane.resize(MAX_CARS); c_dist.resize(MAX_CARS); c_speed.resize(MAX_CARS)
	c_v0.resize(MAX_CARS); c_T.resize(MAX_CARS); c_next.resize(MAX_CARS)
	c_exit.resize(MAX_CARS); c_y.resize(MAX_CARS); c_yaw.resize(MAX_CARS)
	c_variant.resize(MAX_CARS); c_wait.resize(MAX_CARS)
	c_accel.resize(MAX_CARS); c_len.resize(MAX_CARS)
	c_px.resize(MAX_CARS); c_pz.resize(MAX_CARS)
	_xf_cache.resize(MAX_CARS)
	c_alive.resize(MAX_CARS)
	c_promoted.resize(MAX_CARS)
	for i in range(MAX_CARS - 1, -1, -1):
		_free.append(i)


# --------------------------------------------------------------------------
# Tier 1 sim
# --------------------------------------------------------------------------
var _transfers: Array[int] = []
var _sep_gap := PackedFloat32Array()   # per car: nearest cross-lane obstacle ahead
var _sep_hash: Dictionary = {}

## Cross-lane separation for cars near the player: IDM only guards the same
## lane, so junctions with missing right-of-way data let cars overlap.
## A cheap 6 m spatial hash gives every visible car a "something is
## physically ahead of me" gap regardless of lanes.
func _separation_pass(ppos: Vector3) -> void:
	if _sep_gap.size() != MAX_CARS:
		_sep_gap.resize(MAX_CARS)
	_sep_hash.clear()
	var near := PackedInt32Array()
	for ci in MAX_CARS:
		_sep_gap[ci] = 1e9
		if c_alive[ci] == 0:
			continue
		if Vector2(c_px[ci] - ppos.x, c_pz[ci] - ppos.z).length_squared() > 120.0 * 120.0:
			continue
		near.append(ci)
		var key := Vector2i(floori(c_px[ci] / 6.0), floori(c_pz[ci] / 6.0))
		if not _sep_hash.has(key):
			_sep_hash[key] = PackedInt32Array()
		var arr: PackedInt32Array = _sep_hash[key]
		arr.append(ci)
		_sep_hash[key] = arr
	for ci in near:
		var fx := sin(c_yaw[ci])
		var fz := cos(c_yaw[ci])
		var cx := floori(c_px[ci] / 6.0)
		var cz := floori(c_pz[ci] / 6.0)
		var best := 1e9
		for dx in range(-1, 2):
			for dz in range(-1, 2):
				var key := Vector2i(cx + dx, cz + dz)
				if not _sep_hash.has(key):
					continue
				for cj in _sep_hash[key]:
					if cj == ci or c_lane[cj] == c_lane[ci]:
						continue   # same lane is IDM's job
					var ax := c_px[cj] - c_px[ci]
					var az := c_pz[cj] - c_pz[ci]
					var along := ax * fx + az * fz
					var lat := absf(ax * fz - az * fx)
					if along > 0.3 and along < 8.0 and lat < 2.0:
						best = minf(best, along - car_length * 0.6)
		# the player car blocks traffic exactly like another car
		var pax := ppos.x - c_px[ci]
		var paz := ppos.z - c_pz[ci]
		var palong := pax * fx + paz * fz
		var plat := absf(pax * fz - paz * fx)
		if palong > 0.3 and palong < 8.0 and plat < 2.2:
			best = minf(best, palong - car_length * 0.6)
		_sep_gap[ci] = maxf(best, 0.05)


func _sim(dt: float, _ppos: Vector3) -> void:
	_transfers.clear()
	for lane_key in _lane_cars.keys():
		var arr: PackedInt32Array = _lane_cars[lane_key]
		var lane := lane_key as int
		var llen := graph.lane_length[lane]
		var lspeed := graph.lane_speed[lane]
		for i in arr.size():
			var ci := arr[i]
			if c_promoted[ci] != null:
				_sync_promoted(ci, dt)
			var v := c_speed[ci]
			var v0 := lspeed * c_v0[ci]
			var gap := 1e9
			var v_lead := v0

			# leader in this lane
			if i + 1 < arr.size():
				var li := arr[i + 1]
				gap = c_dist[li] - c_dist[ci] - c_len[li]
				v_lead = c_speed[li]
			else:
				# look across the boundary into the chosen next lane
				var remaining := llen - c_dist[ci]
				var nxt := _peek_next_lane(ci, lane)
				if nxt >= 0 and _lane_cars.has(nxt):
					var narr: PackedInt32Array = _lane_cars[nxt]
					if narr.size() > 0:
						var li2 := narr[0]
						gap = remaining + c_dist[li2] - c_len[li2]
						v_lead = c_speed[li2]

			# junction gate on normal lanes
			if graph.lane_flags[lane] & 1 == 0:
				var remaining2 := llen - c_dist[ci]
				if remaining2 < JUNCTION_LOOK:
					var hold := _junction_hold(ci, lane, remaining2)
					if hold:
						var stop_gap := maxf(remaining2 - 1.2, 0.05)
						if stop_gap < gap:
							gap = stop_gap
							v_lead = 0.0
						c_wait[ci] += dt
						if c_wait[ci] > STUCK_SECONDS:
							_log_stuck(ci, lane, "held %ds at junction, forcing through" % int(c_wait[ci]))
							c_wait[ci] = -60.0   # mercy window: stop holding for a while
					else:
						c_wait[ci] = minf(c_wait[ci], 0.0) + dt * 0.0

			# cross-lane separation (near-player pass)
			if _sep_gap.size() == MAX_CARS and _sep_gap[ci] < gap:
				gap = _sep_gap[ci]
				v_lead = 0.0

			# IDM
			var accel := IDM_A
			if gap < 1e8:
				var delta_v := v - v_lead
				var s_star := IDM_S0 + maxf(0.0, v * (IDM_T * c_T[ci]) + (v * delta_v) / (2.0 * sqrt(IDM_A * IDM_B)))
				accel = IDM_A * (1.0 - pow(v / maxf(v0, 0.1), 4.0) - pow(s_star / maxf(gap, 0.2), 2.0))
			else:
				accel = IDM_A * (1.0 - pow(v / maxf(v0, 0.1), 4.0))
			v = maxf(v + accel * dt, 0.0)
			c_speed[ci] = v
			c_accel[ci] = accel
			c_dist[ci] += v * dt
			if v > 1.0:
				c_wait[ci] = maxf(c_wait[ci], 0.0) if c_wait[ci] > -1.0 else c_wait[ci] + dt
				if c_wait[ci] > 0.0:
					c_wait[ci] = 0.0
			if c_dist[ci] >= llen:
				_transfers.append(ci)


func _peek_next_lane(ci: int, lane: int) -> int:
	if graph.lane_flags[lane] & 1 != 0:
		# on a via lane: destination is the exit connection's to-lane
		var ex := c_exit[ci]
		return graph.conn_to[ex] if ex >= 0 else -1
	var cn := _choose_conn(ci, lane)
	if cn < 0:
		return -1
	var via := graph.conn_via[cn]
	return via if via >= 0 else graph.conn_to[cn]


func _choose_conn(ci: int, lane: int) -> int:
	if c_next[ci] >= 0:
		return c_next[ci]
	var s0 := graph.lane_succ_start[lane]
	var s1 := graph.lane_succ_start[lane + 1]
	if s1 <= s0:
		return -1
	# weighted-random route choice; no destination, no pathfinding
	var total := 0.0
	for s in range(s0, s1):
		total += _conn_weight(graph.succ_conn[s])
	var r := _rng.randf() * maxf(total, 0.001)
	for s in range(s0, s1):
		r -= _conn_weight(graph.succ_conn[s])
		if r <= 0.0:
			c_next[ci] = graph.succ_conn[s]
			return c_next[ci]
	c_next[ci] = graph.succ_conn[s1 - 1]
	return c_next[ci]


func _conn_weight(cn: int) -> float:
	var to := graph.conn_to[cn]
	return maxf(graph.lane_spawn_weight[to], 0.15)


func _junction_hold(ci: int, lane: int, remaining: float) -> bool:
	if c_wait[ci] < -1.0:
		return false   # mercy window after a logged stuck hold
	var cn := _choose_conn(ci, lane)
	if cn < 0:
		return false
	if graph.conn_dir[cn] & 0x80:
		# offline conflict mapping failed at this junction (conn_dir bit 7):
		# FAIL CLOSED — yield to anything physically in the box (separation
		# pass), with the standard stuck-mercy escape. Never cross blind.
		return _sep_gap.size() == MAX_CARS and _sep_gap[ci] < remaining + 10.0
	# blocking-box rule: never enter the junction when the exit lane has no
	# room to receive the car — a green is no licence to stop inside the box.
	# Only the 15 s stuck-mercy in _sim overrides this.
	var to := graph.conn_to[cn]
	if remaining < 6.0 and _lane_cars.has(to):
		var tarr: PackedInt32Array = _lane_cars[to]
		if tarr.size() > 0:
			var fc := tarr[0]
			if c_dist[fc] < car_length + 0.7 and c_speed[fc] < 0.5:
				return true
	var sig := graph.signal_state(cn, _time)
	if sig == CH_r or sig == CH_y:
		# a red is never a deadlock — the program cycles. Don't let the
		# stuck-mercy force cars through it: reset the clock below 15 s.
		c_wait[ci] = minf(c_wait[ci], STUCK_SECONDS - 3.0)
		return true
	if sig == CH_G:
		return false   # protected green: signal already separates conflicts
	# permissive / uncontrolled: gap acceptance against precomputed conflicts
	if remaining > 12.0:
		return false
	var x0 := graph.conn_conflict_start[cn]
	var x1 := graph.conn_conflict_start[cn + 1]
	var stalled_only := true
	var blocked := false
	var min_blk_lane := 0x7FFFFFFF   # lowest waiting lane wins the tie-break
	for x in range(x0, x1):
		var oc := graph.conflicts[x]
		var via := graph.conn_via[oc]
		if via >= 0 and _lane_cars.has(via):
			var varr: PackedInt32Array = _lane_cars[via]
			for vi in varr:
				blocked = true
				if c_speed[vi] > 0.4:
					stalled_only = false
		var from := graph.conn_from[oc]
		if _lane_cars.has(from):
			var farr: PackedInt32Array = _lane_cars[from]
			if farr.size() > 0:
				var li := farr[farr.size() - 1]   # nearest to its junction
				var lv := maxf(c_speed[li], 0.1)
				if (graph.lane_length[from] - c_dist[li]) / lv < TTC_LIMIT:
					blocked = true
					stalled_only = false
				elif c_speed[li] < 0.4 \
						and graph.lane_length[from] - c_dist[li] < JUNCTION_LOOK:
					# a STOPPED approach car never blocks gap acceptance — it
					# only competes in the deadlock tie-break below
					min_blk_lane = mini(min_blk_lane, from)
	if blocked and stalled_only and c_wait[ci] > 3.0:
		# per-junction deadlock breaker: every blocker is itself stopped —
		# the car on the lowest lane id proceeds, the rest keep waiting
		return lane > min_blk_lane
	if not blocked and c_wait[ci] > 3.0 and min_blk_lane != 0x7FFFFFFF:
		# mutual-yield stand-off: several approaches waiting on each other —
		# enter the box one at a time, lowest lane id first
		return lane > min_blk_lane
	return blocked


func _do_transfers(ppos: Vector3) -> void:
	for ci in _transfers:
		if c_alive[ci] == 0:
			continue
		# chain across as many boundaries as the overflow demands: junction
		# clusters contain 0.2 m stub lanes a car crosses several of in one
		# tick — clamping to one boundary per tick made cars lurch there
		for _hop in 6:
			var lane := c_lane[ci]
			var llen := graph.lane_length[lane]
			if c_dist[ci] < llen:
				break
			var overflow := c_dist[ci] - llen
			var next_lane := -1
			if graph.lane_flags[lane] & 1 != 0:
				var ex := c_exit[ci]
				next_lane = graph.conn_to[ex] if ex >= 0 else -1
				c_exit[ci] = -1
			else:
				var cn := _choose_conn(ci, lane)
				if cn >= 0:
					var via := graph.conn_via[cn]
					if via >= 0:
						next_lane = via
						c_exit[ci] = cn
					else:
						next_lane = graph.conn_to[cn]
				c_next[ci] = -1
			if next_lane < 0:
				_log_stuck(ci, lane, "dead end, despawned")
				_despawn(ci)
				break
			_lane_remove(lane, ci)
			c_lane[ci] = next_lane
			c_dist[ci] = overflow
			_lane_insert(next_lane, ci)
		if c_alive[ci] != 0:
			# a car that somehow still overflows (6 chained micro-lanes) waits
			# at the end of its current lane — never teleport it
			var lane2 := c_lane[ci]
			c_dist[ci] = minf(c_dist[ci], graph.lane_length[lane2])


# --------------------------------------------------------------------------
# spawn / despawn
# --------------------------------------------------------------------------
func _spawn_despawn(ppos: Vector3) -> void:
	if _follow_test:
		return   # the two test cars live wherever their lane is
	# despawn far cars (position cache from the visuals pass)
	for ci in MAX_CARS:
		if c_alive[ci] == 0:
			continue
		if Vector2(c_px[ci] - ppos.x, c_pz[ci] - ppos.z).length() > despawn_radius:
			_despawn(ci)
	# spawn toward target population from a pooled candidate list (annulus
	# cells collected once per tick — random cell probing rejected ~97%)
	_spawn_pool.clear()
	var r := ceili(spawn_max / LaneGraph.GRID) + 1
	var cc := Vector2i(floori(ppos.x / LaneGraph.GRID), floori(ppos.z / LaneGraph.GRID))
	for dx in range(-r, r + 1):
		for dz in range(-r, r + 1):
			var key := Vector2i(cc.x + dx, cc.y + dz)
			if graph.spawn_grid.has(key):
				_spawn_pool.append_array(graph.spawn_grid[key])
	if _spawn_pool.is_empty():
		return
	var want := mini(target_population - alive_count, 20)
	var tries := 300
	while want > 0 and tries > 0:
		tries -= 1
		if _try_spawn(ppos):
			want -= 1


var _spawn_pool := PackedInt32Array()
var _did_fill := false


## Boot burst: fill the whole population at once with relaxed rules (any
## direction, from 40 m out) so the city isn't empty for the first minute.
func _initial_fill(ppos: Vector3) -> void:
	_spawn_pool.clear()
	var r := ceili(spawn_max / LaneGraph.GRID) + 1
	var cc := Vector2i(floori(ppos.x / LaneGraph.GRID), floori(ppos.z / LaneGraph.GRID))
	for dx in range(-r, r + 1):
		for dz in range(-r, r + 1):
			var key := Vector2i(cc.x + dx, cc.y + dz)
			if graph.spawn_grid.has(key):
				_spawn_pool.append_array(graph.spawn_grid[key])
	if _follow_test:
		_spawn_follow_test(ppos)
		return
	if _spawn_pool.is_empty():
		push_warning("[traffic] no spawnable lanes within %.0f m of (%.0f, %.0f) — player outside lane-graph coverage" % [
			spawn_max, ppos.x, ppos.z])
		return
	var want := target_population
	var tries := 6000
	while want > 0 and tries > 0:
		tries -= 1
		if _try_spawn(ppos, true):
			want -= 1
	print("[traffic] initial fill: %d cars" % alive_count)


## C3 two-car test: a slow leader and a normal follower on ONE long lane
## near the player. The follower must brake behind the leader, never
## overlap it, and the gap must stabilise.
func _spawn_follow_test(ppos: Vector3) -> void:
	var best := -1
	var best_d := 1e9
	for lane in graph.lane_count:
		if graph.lane_flags[lane] & 1 != 0 or graph.lane_length[lane] < 130.0:
			continue
		if graph.lane_spawn_weight[lane] <= 0.0:
			continue
		var p := graph.lane_pos(lane, 0.0)
		var dd := Vector2(p.x - ppos.x, p.z - ppos.z).length()
		if dd < best_d:
			best_d = dd
			best = lane
	if best < 0:
		print("[traffic] follow-test: no long lane nearby")
		return
	for k in 2:
		var ci: int = _free.pop_back()
		var d := 60.0 if k == 0 else 10.0
		var tan := graph.lane_tangent(best, d)
		var p2 := graph.lane_pos(best, d)
		c_alive[ci] = 1
		c_lane[ci] = best
		c_dist[ci] = d
		c_speed[ci] = 3.0
		c_v0[ci] = 0.35 if k == 0 else 1.0   # slow leader, normal follower
		c_T[ci] = 1.0
		c_next[ci] = -1
		c_exit[ci] = -1
		c_y[ci] = ppos.y
		c_yaw[ci] = atan2(tan.x, tan.z)
		c_variant[ci] = k
		c_len[ci] = _variant_len[k] if k < _variant_len.size() else car_length
		c_wait[ci] = 0.0
		c_promoted[ci] = null
		c_px[ci] = p2.x
		c_pz[ci] = p2.z
		_xf_cache[ci] = Transform3D(Basis(Vector3.UP, c_yaw[ci]), Vector3(p2.x, c_y[ci], p2.z))
		_lane_insert(best, ci)
		alive_count += 1
	print("[traffic] follow-test on lane %d (%s), len %.0f m" % [
		best, graph.lane_id(best), graph.lane_length[best]])


## One line of car state for --probe runs (single-car / follow-test).
func debug_cars() -> String:
	var parts: Array[String] = []
	var rows: Array[int] = []
	for ci in MAX_CARS:
		if c_alive[ci] == 1:
			rows.append(ci)
			if rows.size() >= 2:
				break
	for ci in rows:
		var sig := "-"
		if c_next[ci] >= 0:
			sig = String.chr(graph.signal_state(c_next[ci], _time))
		var promo := ""
		if c_promoted[ci] != null:
			var body: TrafficMVehicle = c_promoted[ci]
			var lp := graph.lane_pos(c_lane[ci], c_dist[ci])
			promo = " PROMO bv=%.1f by=%.1f err=%.1f steer=%.2f ef=%.0f" % [
				body.linear_velocity.length(), body.global_position.y,
				Vector2(body.global_position.x - lp.x,
					body.global_position.z - lp.z).length(),
				body.steering, body.engine_force]
		parts.append("car%d lane=%d d=%.1f/%.1f v=%.1f wait=%.1f sig=%s%s" % [
			ci, c_lane[ci], c_dist[ci], graph.lane_length[c_lane[ci]],
			c_speed[ci], c_wait[ci], sig, promo])
	if rows.size() == 2 and c_lane[rows[0]] == c_lane[rows[1]]:
		parts.append("gap=%.1f" % absf(c_dist[rows[1]] - c_dist[rows[0]]))
	return "  ".join(parts) if not parts.is_empty() else "no cars"


func _try_spawn(ppos: Vector3, relaxed := false) -> bool:
	var lane := _spawn_pool[_rng.randi_range(0, _spawn_pool.size() - 1)]
	# weight-accept so avenues fill before alleys
	if _rng.randf() > clampf(graph.lane_spawn_weight[lane] / 2.0, 0.3, 1.0):
		return false
	# a few distance samples per attempt: most of a candidate lane can lie
	# outside the annulus even when part of it is inside
	var d := 0.0
	var p := Vector3.ZERO
	var ok := false
	var lo := 40.0 if relaxed else spawn_min
	for _k in 3:
		d = _rng.randf() * maxf(graph.lane_length[lane] - car_length, 0.1)
		p = graph.lane_pos(lane, d)
		var dist_p := Vector2(p.x - ppos.x, p.z - ppos.z).length()
		if dist_p >= lo and dist_p <= spawn_max:
			ok = true
			break
	if not ok:
		return false
	# any flow direction: traffic roams the city instead of converging on
	# the player. Density is kept up by the annulus spawn/despawn loop —
	# cars that head away simply despawn sooner and are replaced.
	var tan := graph.lane_tangent(lane, d)
	# gap >= 2x IDM desired headway to every car already on the lane
	var v0 := graph.lane_speed[lane]
	var need := 2.0 * (IDM_S0 + v0 * IDM_T) + car_length
	if _lane_cars.has(lane):
		for oc in _lane_cars[lane]:
			if absf(c_dist[oc] - d) < need:
				return false
	if _free.is_empty():
		return false
	var ci: int = _free.pop_back()
	c_alive[ci] = 1
	c_lane[ci] = lane
	c_dist[ci] = d
	c_speed[ci] = v0 * 0.6
	# cruise at-to-slightly-over the posted limit (city drivers do)
	c_v0[ci] = _rng.randf_range(1.0, 1.22)
	c_T[ci] = _rng.randf_range(0.88, 1.12)
	c_next[ci] = -1
	c_exit[ci] = -1
	c_y[ci] = ppos.y
	c_yaw[ci] = atan2(tan.x, tan.z)
	c_variant[ci] = _pick_variant()
	c_len[ci] = _variant_len[c_variant[ci]] if not _variant_len.is_empty() else car_length
	c_wait[ci] = 0.0
	c_promoted[ci] = null
	c_px[ci] = p.x
	c_pz[ci] = p.z
	_xf_cache[ci] = Transform3D(Basis(Vector3.UP, c_yaw[ci]), Vector3(p.x, c_y[ci], p.z))
	_lane_insert(lane, ci)
	alive_count += 1
	return true


func _pick_variant() -> int:
	if _variant_wcum.is_empty():
		return 0
	var r := _rng.randf() * _variant_wsum
	for i in _variant_wcum.size():
		if r <= _variant_wcum[i]:
			return i
	return _variant_wcum.size() - 1


func _despawn(ci: int) -> void:
	if c_alive[ci] == 0:
		return
	if c_promoted[ci] != null:
		_demote(ci, false)
	_lane_remove(c_lane[ci], ci)
	c_alive[ci] = 0
	_free.append(ci)
	alive_count -= 1


func _lane_insert(lane: int, ci: int) -> void:
	var arr: PackedInt32Array = _lane_cars.get(lane, PackedInt32Array())
	var pos := arr.size()
	for i in arr.size():
		if c_dist[arr[i]] > c_dist[ci]:
			pos = i
			break
	arr.insert(pos, ci)
	_lane_cars[lane] = arr


func _lane_remove(lane: int, ci: int) -> void:
	if not _lane_cars.has(lane):
		return
	var arr: PackedInt32Array = _lane_cars[lane]
	var i := arr.find(ci)
	if i >= 0:
		arr.remove_at(i)
	if arr.is_empty():
		_lane_cars.erase(lane)
	else:
		_lane_cars[lane] = arr


# --------------------------------------------------------------------------
# Tier 0 — promotion to M.A.V.S physics bodies
# --------------------------------------------------------------------------
func _update_promotion(ppos: Vector3) -> void:
	if _follow_test and not _with_promo:
		return   # C3 follower test measures pure IDM — no physics bodies
	var near: Array = []
	for ci in MAX_CARS:
		if c_alive[ci] == 0:
			continue
		var d := Vector2(c_px[ci] - ppos.x, c_pz[ci] - ppos.z).length()
		if c_promoted[ci] != null and d > demote_radius:
			_demote(ci, true)
		elif c_promoted[ci] == null and d < promote_radius:
			near.append([d, ci])
	near.sort()
	for e in near:
		if promoted_count >= max_promoted:
			break
		_promote(e[1])


func _promote(ci: int) -> void:
	if _variants.is_empty():
		return
	# physics bodies need REAL collision under the wheels — sidewalk/plaza
	# cuts without physics would drop a VehicleBody3D into the abyss
	var space := get_world_3d().direct_space_state
	var pp := graph.lane_pos(c_lane[ci], c_dist[ci])
	var q := PhysicsRayQueryParameters3D.create(
		Vector3(pp.x, c_y[ci] + 2.0, pp.z), Vector3(pp.x, c_y[ci] - 3.0, pp.z))
	var hit := space.intersect_ray(q)
	if hit.is_empty():
		return   # unsupported ground: stay kinematic (clamped and safe)
	var vdef: Dictionary = _variants[c_variant[ci]]
	var body := TrafficMVehicle.new()
	body.mass = 1200.0
	var pos := graph.lane_pos(c_lane[ci], c_dist[ci])
	var tan := graph.lane_tangent(c_lane[ci], c_dist[ci])
	# body forward is +Z (empirically: positive engine_force drives +Z),
	# which matches the fleet convention — no rotation flips anywhere
	var yaw := atan2(tan.x, tan.z)
	body.basis = Basis(Vector3.UP, yaw)
	body.position = Vector3(pos.x, c_y[ci] + 0.4, pos.z)
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	var mb: AABB = (vdef.mesh as ArrayMesh).get_aabb()
	box.size = Vector3(clampf(mb.size.x * 0.92, 1.2, 2.6),
		maxf(mb.size.y * 0.85, 0.9), clampf(mb.size.z * 0.95, 3.0, 8.6))
	shape.shape = box
	shape.position = Vector3(0, box.size.y * 0.5 + 0.25, 0)
	body.add_child(shape)
	var visual: Node3D = vdef.template.duplicate()
	body.add_child(visual)
	for wdef in vdef.wheels:
		var w := VehicleWheel3D.new()
		w.position = Vector3(wdef.x, wdef.y + 0.15, wdef.z)
		w.wheel_radius = vdef.wheel_r
		w.wheel_rest_length = 0.15
		w.suspension_stiffness = 45.0
		w.use_as_traction = wdef.z < 0.0    # rear wheels drive
		w.use_as_steering = wdef.z > 0.0    # front wheels steer
		body.add_child(w)
	body.linear_velocity = tan * c_speed[ci]
	add_child(body)
	c_promoted[ci] = body
	promoted_count += 1


func _sync_promoted(ci: int, _dt: float) -> void:
	var body: TrafficMVehicle = c_promoted[ci]
	# fell through a collision gap, or flipped: back to the kinematic sim
	if body.global_position.y < c_y[ci] - 3.0 or body.basis.y.dot(Vector3.UP) < 0.4:
		_log_stuck(ci, c_lane[ci], "promoted body fell/flipped — demoted")
		_demote(ci, false)
		return
	body.target_speed = c_speed[ci]
	var look := minf(c_dist[ci] + 6.0 + c_speed[ci] * 0.5, graph.lane_length[c_lane[ci]])
	var tp := graph.lane_pos(c_lane[ci], look)
	tp.y = body.global_position.y
	body.target_point = tp
	# pull the logical distance toward the body's real progress
	var lp := graph.lane_pos(c_lane[ci], c_dist[ci])
	var tan := graph.lane_tangent(c_lane[ci], c_dist[ci])
	var err := Vector3(body.global_position.x - lp.x, 0.0, body.global_position.z - lp.z)
	c_dist[ci] = clampf(c_dist[ci] + err.dot(tan) * 0.5, 0.0, graph.lane_length[c_lane[ci]])
	c_y[ci] = body.global_position.y


func _demote(ci: int, reproject: bool) -> void:
	var body: TrafficMVehicle = c_promoted[ci]
	if reproject:
		c_speed[ci] = body.linear_velocity.length()
	body.queue_free()
	c_promoted[ci] = null
	promoted_count -= 1


# --------------------------------------------------------------------------
# elevation + visuals
# --------------------------------------------------------------------------
func _update_elevation(_ppos: Vector3) -> void:
	var space := get_world_3d().direct_space_state
	var budget := 24
	var scanned := 0
	while budget > 0 and scanned < MAX_CARS:
		var ci := _ray_cursor
		_ray_cursor = (_ray_cursor + 1) % MAX_CARS
		scanned += 1
		if c_alive[ci] == 0 or c_promoted[ci] != null:
			continue
		budget -= 1
		var p := graph.lane_pos(c_lane[ci], c_dist[ci])
		var q := PhysicsRayQueryParameters3D.create(
			Vector3(p.x, c_y[ci] + 2.5, p.z), Vector3(p.x, c_y[ci] - 9.0, p.z))
		var hit := space.intersect_ray(q)
		if not hit.is_empty() and hit.position.y < c_y[ci] + 1.2 \
				and hit.position.y > c_y[ci] - 2.5:
			c_y[ci] = hit.position.y


func _update_visuals(dt: float, ppos: Vector3) -> void:
	var counts := PackedInt32Array()
	counts.resize(_variants.size())
	var light_count := 0
	var sig_count := 0
	var mm_l: MultiMesh = _mm_lights.multimesh
	var spot_candidates: Array = []
	var blend := minf(dt / 0.15, 1.0)   # ~0.15 s basis smoothing

	var frame_parity := int(Engine.get_process_frames()) & 1
	for ci in MAX_CARS:
		if c_alive[ci] == 0:
			continue
		if c_promoted[ci] != null:
			var bp: Vector3 = (c_promoted[ci] as Node3D).global_position
			c_px[ci] = bp.x
			c_pz[ci] = bp.z
			continue
		var d := Vector2(c_px[ci] - ppos.x, c_pz[ci] - ppos.z).length()
		var xf: Transform3D
		if d >= mesh_distance and (ci & 1) == frame_parity:
			# far imposter: reuse last frame's sampled transform
			xf = _xf_cache[ci]
		else:
			var lane := c_lane[ci]
			var p := graph.lane_pos(lane, c_dist[ci])
			c_px[ci] = p.x
			c_pz[ci] = p.z
			var tan := graph.lane_tangent(lane, c_dist[ci])
			var target_yaw := atan2(tan.x, tan.z)
			c_yaw[ci] += wrapf(target_yaw - c_yaw[ci], -PI, PI) * blend
			xf = Transform3D(Basis(Vector3.UP, c_yaw[ci]), Vector3(p.x, c_y[ci], p.z))
			_xf_cache[ci] = xf
			d = Vector2(p.x - ppos.x, p.z - ppos.z).length()
		if d < mesh_distance:
			var vi := c_variant[ci]
			var mmi: MultiMeshInstance3D = _mm_cars[vi]
			if counts[vi] < 64:
				mmi.multimesh.set_instance_transform(counts[vi], xf)
				counts[vi] += 1
			if sig_count < 128:
				_mm_signals.multimesh.set_instance_transform(sig_count, xf)
				_mm_signals.multimesh.set_instance_custom_data(
					sig_count, _signal_state(ci))
				sig_count += 1
			spot_candidates.append([d, ci, xf])
		elif light_count < 256:
			mm_l.set_instance_transform(light_count, xf)
			light_count += 1

	for vi in _variants.size():
		(_mm_cars[vi] as MultiMeshInstance3D).multimesh.visible_instance_count = counts[vi]
	mm_l.visible_instance_count = light_count
	_mm_lights.visible = night_lights > 0.15   # far imposters are a night LOD
	_mm_signals.multimesh.visible_instance_count = sig_count

	# a handful of real headlight cones for the nearest cars (night only)
	spot_candidates.sort_custom(func(a, b): return a[0] < b[0])
	for i in _spots.size():
		var s := _spots[i]
		if i < spot_candidates.size() and night_lights > 0.15:
			var xf: Transform3D = spot_candidates[i][2]
			s.global_transform = xf * Transform3D(Basis(Vector3.UP, PI), Vector3(0, 0.7, 2.0))
			s.visible = true
		else:
			s.visible = false


## Per-car INSTANCE_CUSTOM for the signal quads:
## r = brake (IDM decel > 0.5 m/s², or held at a stop),
## g/b = left/right indicator (blinking from 1.5 s before a turn, and
## through the junction), a = headlights (environment level).
func _signal_state(ci: int) -> Color:
	var brake := 1.0 if (c_accel[ci] < -0.5 or c_speed[ci] < 0.3) else 0.0
	var left := 0.0
	var right := 0.0
	var cn := c_next[ci] if c_next[ci] >= 0 else c_exit[ci]
	if cn >= 0:
		var dircode := graph.conn_dir[cn] & 0x7F
		if dircode == 1 or dircode == 2:
			var lane := c_lane[ci]
			var on_via := graph.lane_flags[lane] & 1 != 0
			var rem := graph.lane_length[lane] - c_dist[ci]
			if on_via or rem < maxf(c_speed[ci], 2.0) * 1.5:
				var blink := 1.0 if fmod(_time, 0.8) < 0.4 else 0.0
				if dircode == 1:
					left = blink
				else:
					right = blink
	return Color(brake, left, right, night_lights)


func _build_visual_pools() -> void:
	_variants = TrafficFleet.build_variants()
	_variants.append_array(TrafficFleet.build_truck_variants())
	_variant_wsum = 0.0
	for vdef in _variants:
		_variant_wsum += vdef.get("spawn_weight", 1.0)
		_variant_wcum.append(_variant_wsum)
		_variant_len.append(maxf((vdef.mesh as ArrayMesh).get_aabb().size.z, 3.4))
	for vdef in _variants:
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = vdef.mesh
		mm.instance_count = 64
		mm.visible_instance_count = 0
		var mmi := MultiMeshInstance3D.new()
		mmi.multimesh = mm
		mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mmi)
		_mm_cars.append(mmi)
	var lm := MultiMesh.new()
	lm.transform_format = MultiMesh.TRANSFORM_3D
	lm.mesh = TrafficFleet.build_light_quads()
	lm.instance_count = 256
	lm.visible_instance_count = 0
	_mm_lights = MultiMeshInstance3D.new()
	_mm_lights.multimesh = lm
	_mm_lights.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_mm_lights)
	var sm := MultiMesh.new()
	sm.transform_format = MultiMesh.TRANSFORM_3D
	sm.use_custom_data = true
	sm.mesh = TrafficFleet.build_signal_quads()
	sm.instance_count = 128
	sm.visible_instance_count = 0
	_mm_signals = MultiMeshInstance3D.new()
	_mm_signals.multimesh = sm
	_mm_signals.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_mm_signals)
	for i in headlight_pool:
		var s := SpotLight3D.new()
		s.spot_range = 30.0
		s.spot_angle = 28.0
		s.light_energy = 3.0
		s.light_color = Color(1.0, 0.93, 0.8)
		s.light_specular = 0.05
		s.shadow_enabled = false
		s.visible = false
		add_child(s)
		_spots.append(s)
	_debug_mesh = MeshInstance3D.new()
	_debug_mesh.mesh = ImmediateMesh.new()
	var dm := StandardMaterial3D.new()
	dm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dm.vertex_color_use_as_albedo = true
	_debug_mesh.material_override = dm
	add_child(_debug_mesh)


func _build_overlay() -> void:
	var canvas := CanvasLayer.new()
	add_child(canvas)
	overlay = Label.new()
	overlay.position = Vector2(14, 120)
	overlay.add_theme_font_size_override("font_size", 13)
	overlay.add_theme_color_override("font_color", Color(0.6, 0.9, 0.7, 0.9))
	canvas.add_child(overlay)


func _log_stuck(ci: int, lane: int, why: String) -> void:
	var msg := "stuck car %d on %s: %s" % [ci, graph.lane_id(lane), why]
	stuck_log.append(msg)
	if stuck_log.size() > 64:
		stuck_log.pop_front()
	push_warning("[traffic] " + msg)


## Debug draw: nearby lanes as coloured lines with direction arrows (key T).
func _draw_debug_lanes(ppos: Vector3) -> void:
	var im: ImmediateMesh = _debug_mesh.mesh
	im.clear_surfaces()
	im.surface_begin(Mesh.PRIMITIVE_LINES)
	var drawn := 0
	for lane in graph.lane_count:
		if drawn > 1500:
			break
		var p0 := graph.lane_pos(lane, 0.0)
		if Vector2(p0.x - ppos.x, p0.z - ppos.z).length() > 220.0:
			continue
		drawn += 1
		var internal := graph.lane_flags[lane] & 1 != 0
		var col := Color(1.0, 0.6, 0.15) if internal else Color(0.3, 0.75, 1.0)
		var s0 := graph.lane_point_start[lane]
		var s1 := graph.lane_point_start[lane + 1]
		for i in range(s0, s1 - 1):
			var a := Vector3(graph.points[i * 4], ppos.y + 0.4, graph.points[i * 4 + 2])
			var b := Vector3(graph.points[(i + 1) * 4], ppos.y + 0.4, graph.points[(i + 1) * 4 + 2])
			im.surface_set_color(col)
			im.surface_add_vertex(a)
			im.surface_set_color(col)
			im.surface_add_vertex(b)
		# direction arrow at the midpoint
		var mid := graph.lane_length[lane] * 0.5
		var mp := graph.lane_pos(lane, mid)
		mp.y = ppos.y + 0.4
		var tn := graph.lane_tangent(lane, mid)
		var side := Vector3(-tn.z, 0.0, tn.x)
		for sgn in [-1.0, 1.0]:
			im.surface_set_color(Color.WHITE)
			im.surface_add_vertex(mp + tn * 1.2)
			im.surface_set_color(Color.WHITE)
			im.surface_add_vertex(mp - tn * 0.4 + side * sgn * 0.7)
	im.surface_end()
