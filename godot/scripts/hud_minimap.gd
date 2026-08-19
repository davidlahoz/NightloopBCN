extends Control
## GTA-style HUD minimap (top-right): the real street network around the
## player drawn from the StreetNames segment grid, heading-up, with ambient
## traffic as dots and a north marker. Pure 2D immediate drawing — the road
## cache refreshes every 0.3 s, the rotation every frame.

const SIZE := 224.0          # panel edge, px
const VIEW_R := 230.0        # world metres shown from centre to edge
const REFRESH := 0.3

var player_pos := Vector3.ZERO
var player_yaw := 0.0

var _sn: StreetNames
var _segs: Array[Vector4] = []     # cached world segments (ax, az, bx, bz)
var _accum := REFRESH


func _init(sn: StreetNames) -> void:
	_sn = sn
	custom_minimum_size = Vector2(SIZE, SIZE)
	clip_contents = true
	anchor_left = 1.0
	anchor_right = 1.0
	offset_left = -SIZE - 14.0
	offset_right = -14.0
	offset_top = 14.0
	offset_bottom = SIZE + 14.0
	mouse_filter = Control.MOUSE_FILTER_IGNORE


func _process(dt: float) -> void:
	_accum += dt
	if _accum >= REFRESH and _sn.is_ready():
		_accum = 0.0
		_segs.clear()
		var done: Dictionary = {}
		for si in _sn.segments_near(player_pos.x, player_pos.z, VIEW_R * 1.25):
			if done.has(si):
				continue
			done[si] = true
			var a := _sn.seg_a(si)
			var b := _sn.seg_b(si)
			_segs.append(Vector4(a.x, a.y, b.x, b.y))
	queue_redraw()


func _draw() -> void:
	var c := Vector2(SIZE, SIZE) * 0.5
	draw_rect(Rect2(Vector2.ZERO, Vector2(SIZE, SIZE)), Color(0.04, 0.05, 0.09, 0.82))
	var scale_px := (SIZE * 0.5) / VIEW_R
	# heading-up frame: rows map world xz onto screen right/up
	var fwd := Vector2(sin(player_yaw), cos(player_yaw))
	var right := Vector2(fwd.y, -fwd.x)
	var road := Color(0.42, 0.52, 0.66, 0.9)
	for s in _segs:
		var ra := Vector2(s.x - player_pos.x, s.y - player_pos.z)
		var rb := Vector2(s.z - player_pos.x, s.w - player_pos.z)
		var pa := c + Vector2(ra.dot(right), -ra.dot(fwd)) * scale_px
		var pb := c + Vector2(rb.dot(right), -rb.dot(fwd)) * scale_px
		draw_line(pa, pb, road, 2.0)
	# ambient traffic
	var tm := TrafficManager
	if tm.enabled:
		var dot := Color(0.95, 0.9, 0.55, 0.95)
		for ci in tm.c_alive.size():
			if tm.c_alive[ci] == 0:
				continue
			var rp := Vector2(tm.c_px[ci] - player_pos.x, tm.c_pz[ci] - player_pos.z)
			if rp.length_squared() > VIEW_R * VIEW_R:
				continue
			draw_circle(c + Vector2(rp.dot(right), -rp.dot(fwd)) * scale_px, 2.0, dot)
	# player arrow, always centred pointing up
	var tri := PackedVector2Array([
		c + Vector2(0, -7), c + Vector2(5, 6), c + Vector2(-5, 6)])
	draw_colored_polygon(tri, Color(1.0, 1.0, 1.0, 0.95))
	# north marker on the rim
	var nd := Vector2(Vector2(0, -1).dot(right), -Vector2(0, -1).dot(fwd))
	var np := c + nd * (SIZE * 0.5 - 12.0)
	draw_circle(np, 7.0, Color(0.1, 0.12, 0.2, 0.9))
	draw_string(get_theme_default_font(), np + Vector2(-4, 4), "N",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(0.9, 0.55, 0.3))
	# border
	draw_rect(Rect2(Vector2.ZERO, Vector2(SIZE, SIZE)),
		Color(0.55, 0.6, 0.7, 0.5), false, 1.5)
