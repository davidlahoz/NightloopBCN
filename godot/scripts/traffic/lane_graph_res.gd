class_name LaneGraph
extends RefCounted
## Loader for out/lane_graph.bin (format v1 — see out/lane_graph_format.md).
## Everything lands in flat Packed arrays (structure-of-arrays); per-lane
## point lookup is a division, not a search, because the offline resampler
## spaced points uniformly along each lane.

const PATH := "res://out/lane_graph.bin"

var ready := false

var lane_count := 0
var conn_count := 0
var tls_count := 0

var lane_point_start: PackedInt32Array
var points: PackedFloat32Array        # x, y, z, cumdist × point
var lane_speed: PackedFloat32Array
var lane_length: PackedFloat32Array
var lane_flags: PackedInt32Array      # bit0 internal, bit1 spawnable
var lane_spawn_weight: PackedFloat32Array
var lane_succ_start: PackedInt32Array
var succ_conn: PackedInt32Array
var conn_from: PackedInt32Array
var conn_to: PackedInt32Array
var conn_via: PackedInt32Array        # -1 when none
var conn_dir: PackedInt32Array
var conn_tls: PackedInt32Array        # -1 when uncontrolled
var conn_link: PackedInt32Array
var conn_conflict_start: PackedInt32Array
var conflicts: PackedInt32Array
var tls_offset: PackedFloat32Array
var tls_phase_start: PackedInt32Array
var phase_dur: PackedFloat32Array
var phase_state_off: PackedInt32Array
var phase_state_len: PackedInt32Array
var state_blob: PackedByteArray
var lane_id_off: PackedInt32Array
var string_blob: PackedByteArray

# derived at load
var tls_cycle: PackedFloat32Array     # total program duration per tls
var tls_pos: PackedVector3Array       # stop-line anchor per tls (for culling)
var spawn_grid: Dictionary = {}       # Vector2i(250 m cell) -> PackedInt32Array of spawnable lanes
const GRID := 250.0


func load_bin() -> bool:
	var f := FileAccess.open(PATH, FileAccess.READ)
	if f == null:
		push_error("[traffic] %s missing — run tools/build_lane_graph.py" % PATH)
		return false
	var buf := f.get_buffer(f.get_length())
	if buf.slice(0, 4).get_string_from_ascii() != "NLG1":
		push_error("[traffic] bad magic in lane_graph.bin")
		return false
	var version := buf.decode_u16(4)
	if version != 1:
		push_error("[traffic] lane_graph.bin version %d unsupported" % version)
		return false
	var L := buf.decode_u32(8)
	var P := buf.decode_u32(12)
	var C := buf.decode_u32(16)
	var T := buf.decode_u32(24)
	var PH := buf.decode_u32(28)
	var S := buf.decode_u32(32)
	var X := buf.decode_u32(36)
	var SB := buf.decode_u32(40)
	var STB := buf.decode_u32(44)
	lane_count = L
	conn_count = C
	tls_count = T

	var o := 48
	lane_point_start = buf.slice(o, o + (L + 1) * 4).to_int32_array(); o += (L + 1) * 4
	points = buf.slice(o, o + P * 16).to_float32_array(); o += P * 16
	lane_speed = buf.slice(o, o + L * 4).to_float32_array(); o += L * 4
	lane_length = buf.slice(o, o + L * 4).to_float32_array(); o += L * 4
	lane_flags = _u16_array(buf, o, L); o += L * 2
	lane_spawn_weight = buf.slice(o, o + L * 4).to_float32_array(); o += L * 4
	lane_succ_start = buf.slice(o, o + (L + 1) * 4).to_int32_array(); o += (L + 1) * 4
	succ_conn = buf.slice(o, o + S * 4).to_int32_array(); o += S * 4
	conn_from = buf.slice(o, o + C * 4).to_int32_array(); o += C * 4
	conn_to = buf.slice(o, o + C * 4).to_int32_array(); o += C * 4
	conn_via = buf.slice(o, o + C * 4).to_int32_array(); o += C * 4
	conn_dir = _u8_array(buf, o, C); o += C
	conn_tls = _u16_array(buf, o, C, true); o += C * 2
	conn_link = _u16_array(buf, o, C, true); o += C * 2
	conn_conflict_start = buf.slice(o, o + (C + 1) * 4).to_int32_array(); o += (C + 1) * 4
	conflicts = buf.slice(o, o + X * 4).to_int32_array(); o += X * 4
	tls_offset = buf.slice(o, o + T * 4).to_float32_array(); o += T * 4
	tls_phase_start = buf.slice(o, o + (T + 1) * 4).to_int32_array(); o += (T + 1) * 4
	phase_dur = buf.slice(o, o + PH * 4).to_float32_array(); o += PH * 4
	phase_state_off = buf.slice(o, o + PH * 4).to_int32_array(); o += PH * 4
	phase_state_len = _u16_array(buf, o, PH); o += PH * 2
	state_blob = buf.slice(o, o + STB); o += STB
	lane_id_off = buf.slice(o, o + (L + 1) * 4).to_int32_array(); o += (L + 1) * 4
	string_blob = buf.slice(o, o + SB); o += SB

	_derive()
	ready = true
	print("[traffic] lane graph: %d lanes, %d connections, %d signals" % [L, C, T])
	return true


static func _u16_array(buf: PackedByteArray, off: int, n: int, none_to_neg := false) -> PackedInt32Array:
	var out := PackedInt32Array()
	out.resize(n)
	for i in n:
		var v := buf.decode_u16(off + i * 2)
		out[i] = -1 if (none_to_neg and v == 0xFFFF) else v
	return out


static func _u8_array(buf: PackedByteArray, off: int, n: int) -> PackedInt32Array:
	var out := PackedInt32Array()
	out.resize(n)
	for i in n:
		out[i] = buf[off + i]
	return out


func _derive() -> void:
	# conn_via -1 sentinel (stored as 0xFFFFFFFF)
	for i in conn_via.size():
		if conn_via[i] == -1 or conn_via[i] == 0xFFFFFFFF:
			conn_via[i] = -1
	# signal cycles + anchor positions (end of first controlled from-lane)
	tls_cycle.resize(tls_count)
	tls_pos.resize(tls_count)
	var seen := PackedByteArray()
	seen.resize(tls_count)
	for t in tls_count:
		var cyc := 0.0
		for p in range(tls_phase_start[t], tls_phase_start[t + 1]):
			cyc += phase_dur[p]
		tls_cycle[t] = maxf(cyc, 1.0)
	for c in conn_count:
		var t := conn_tls[c]
		if t >= 0 and seen[t] == 0:
			seen[t] = 1
			tls_pos[t] = lane_end_pos(conn_from[c])
	# spawn grid over spawnable lane start points
	for l in lane_count:
		if lane_flags[l] & 2 == 0:
			continue
		var p := lane_pos(l, 0.0)
		var key := Vector2i(floori(p.x / GRID), floori(p.z / GRID))
		if not spawn_grid.has(key):
			spawn_grid[key] = PackedInt32Array()
		var arr: PackedInt32Array = spawn_grid[key]
		arr.append(l)
		spawn_grid[key] = arr


## Position on a lane at arc distance d (no search: uniform resampling).
func lane_pos(lane: int, d: float) -> Vector3:
	var p0 := lane_point_start[lane]
	var n := lane_point_start[lane + 1] - p0
	var step := lane_length[lane] / maxf(n - 1, 1.0)
	var fi := clampf(d / maxf(step, 1e-6), 0.0, n - 1.001)
	var i := int(fi)
	var t := fi - i
	var a := (p0 + i) * 4
	var b := a + 4
	return Vector3(
		points[a] + (points[b] - points[a]) * t,
		points[a + 1] + (points[b + 1] - points[a + 1]) * t,
		points[a + 2] + (points[b + 2] - points[a + 2]) * t)


## Forward tangent (unit, XZ) at arc distance d.
func lane_tangent(lane: int, d: float) -> Vector3:
	var p0 := lane_point_start[lane]
	var n := lane_point_start[lane + 1] - p0
	var step := lane_length[lane] / maxf(n - 1, 1.0)
	var i := clampi(int(d / maxf(step, 1e-6)), 0, n - 2)
	var a := (p0 + i) * 4
	var b := a + 4
	var v := Vector3(points[b] - points[a], 0.0, points[b + 2] - points[a + 2])
	return v.normalized() if v.length_squared() > 1e-8 else Vector3.FORWARD


func lane_end_pos(lane: int) -> Vector3:
	return lane_pos(lane, lane_length[lane])


func lane_id(lane: int) -> String:
	return string_blob.slice(lane_id_off[lane], lane_id_off[lane + 1]).get_string_from_utf8()


## Signal state char for a connection at global time t: 'G','g','y','r' (0 = uncontrolled).
func signal_state(conn: int, t: float) -> int:
	var tl := conn_tls[conn]
	var link := conn_link[conn]
	if tl < 0 or link < 0:
		return 0
	var local := fmod(t + tls_offset[tl], tls_cycle[tl])
	for p in range(tls_phase_start[tl], tls_phase_start[tl + 1]):
		local -= phase_dur[p]
		if local < 0.0:
			if link < phase_state_len[p]:
				return state_blob[phase_state_off[p] + link]
			return 0
	return 0
