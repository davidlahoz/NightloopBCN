class_name Speedo
extends Control
## Analog dashboard speedometer, bottom right — black dial, amber ticks,
## glowing amber needle, white numerals, and an LCD strip (trip + digital
## km/h). Drawn entirely in _draw(); the needle eases toward the true speed
## with a damped spring (same feel as the web demo's SVG speedo).

const MAX_KMH := 260.0
const ANGLE_MIN := -130.0     # needle angle at 0 km/h (deg, 0 = up, cw+)
const ANGLE_MAX := 130.0      # needle angle at MAX_KMH
const DIAL_R := 104.0         # dial face radius
const MARGIN := 18.0          # distance from the viewport corner

var _angle := ANGLE_MIN
var _kmh := 0.0
var _trip_km := 0.0
var _shown_kmh := -1
var _shown_trip := -1
var _font: Font


func _init() -> void:
	_font = ThemeDB.fallback_font
	custom_minimum_size = Vector2(DIAL_R * 2 + 24, DIAL_R * 2 + 24)
	size = custom_minimum_size
	mouse_filter = Control.MOUSE_FILTER_IGNORE


func _ready() -> void:
	_place()
	get_viewport().size_changed.connect(_place)


func _place() -> void:
	var vp := get_viewport_rect().size
	position = Vector2(vp.x - size.x - MARGIN, vp.y - size.y - MARGIN)


## Called by main every frame with the car speed (m/s) and trip distance (km).
func update_speed(dt: float, speed_ms: float, trip_km: float) -> void:
	_kmh = speed_ms * 3.6
	_trip_km = trip_km
	var target := ANGLE_MIN + (ANGLE_MAX - ANGLE_MIN) * clampf(_kmh / MAX_KMH, 0.0, 1.0)
	var prev := _angle
	_angle += (target - _angle) * (1.0 - exp(-9.0 * dt))
	if absf(_angle - prev) > 0.03 or roundi(_kmh) != _shown_kmh or int(_trip_km * 10.0) != _shown_trip:
		_shown_kmh = roundi(_kmh)
		_shown_trip = int(_trip_km * 10.0)
		queue_redraw()


## Direction for a dial angle in degrees (0 = up, clockwise positive).
static func _dir(deg: float) -> Vector2:
	var r := deg_to_rad(deg)
	return Vector2(sin(r), -cos(r))


func _draw() -> void:
	var c := size / 2.0

	# ---- bezel + face ----
	draw_circle(c, DIAL_R + 9.0, Color(0.30, 0.31, 0.33, 0.95))
	draw_circle(c, DIAL_R + 6.5, Color(0.10, 0.10, 0.11, 0.98))
	draw_circle(c, DIAL_R, Color(0.028, 0.028, 0.034, 0.96))
	draw_circle(c, DIAL_R * 0.62, Color(0.045, 0.045, 0.052, 0.96))

	# ---- ticks: minor every 10 km/h, major every 20 (amber, at the rim) ----
	var amber := Color(1.0, 0.62, 0.13)
	var v := 0.0
	while v <= MAX_KMH:
		var major := fmod(v, 20.0) == 0.0
		var d := _dir(ANGLE_MIN + (ANGLE_MAX - ANGLE_MIN) * v / MAX_KMH)
		var r_out := DIAL_R - 4.0
		var r_in := r_out - (10.0 if major else 5.5)
		var col := amber if major else Color(0.95, 0.58, 0.12, 0.75)
		draw_line(c + d * r_in, c + d * r_out, col, 2.4 if major else 1.2, true)
		v += 10.0

	# ---- numerals every 20, white, inside the tick ring ----
	var num_col := Color(0.93, 0.94, 0.96)
	v = 0.0
	while v <= MAX_KMH:
		var d := _dir(ANGLE_MIN + (ANGLE_MAX - ANGLE_MIN) * v / MAX_KMH)
		var p := c + d * (DIAL_R - 27.0)
		var txt := str(int(v))
		draw_string(_font, Vector2(p.x - 22.0, p.y + 5.0), txt,
			HORIZONTAL_ALIGNMENT_CENTER, 44.0, 14, num_col)
		v += 20.0

	# unit label
	draw_string(_font, Vector2(c.x - 22.0, c.y + 34.0), "km/h",
		HORIZONTAL_ALIGNMENT_CENTER, 44.0, 11, Color(0.75, 0.77, 0.80, 0.85))

	# ---- needle: amber blade with a short tail, layered for a glow look ----
	var nd := _dir(_angle)
	var np := Vector2(nd.y, -nd.x)   # perpendicular
	var tip := c + nd * (DIAL_R - 16.0)
	var tail := c - nd * 18.0
	for layer in [[7.0, Color(1.0, 0.5, 0.05, 0.10)], [4.2, Color(1.0, 0.53, 0.06, 0.28)], [2.0, Color(1.0, 0.62, 0.10, 0.95)]]:
		var w: float = layer[0]
		var col: Color = layer[1]
		draw_colored_polygon(PackedVector2Array([
			tail + np * w, tail - np * w, tip - np * (w * 0.35), tip + np * (w * 0.35),
		]), col)
	draw_circle(c, 8.0, Color(0.07, 0.07, 0.08))
	draw_circle(c, 8.0, Color(0.35, 0.36, 0.38), false, 1.5, true)

	# ---- LCD strip: TRIP + digital speed ----
	var lcd := Rect2(c.x - 62.0, c.y + DIAL_R - 46.0, 124.0, 30.0)
	draw_rect(lcd, Color(0.035, 0.055, 0.04, 0.96))
	draw_rect(lcd, Color(0.28, 0.30, 0.28), false, 1.0)
	draw_line(lcd.position + Vector2(64.0, 4.0), lcd.position + Vector2(64.0, 26.0), Color(0.28, 0.30, 0.28), 1.0)
	var lcd_col := Color(0.80, 0.95, 0.84)
	var lcd_dim := Color(0.60, 0.72, 0.63, 0.85)
	draw_string(_font, lcd.position + Vector2(6.0, 12.0), "TRIP",
		HORIZONTAL_ALIGNMENT_LEFT, 56.0, 8, lcd_dim)
	draw_string(_font, lcd.position + Vector2(6.0, 25.0), "%.1f km" % _trip_km,
		HORIZONTAL_ALIGNMENT_LEFT, 56.0, 10, lcd_col)
	draw_string(_font, lcd.position + Vector2(68.0, 12.0), "SPEED",
		HORIZONTAL_ALIGNMENT_LEFT, 52.0, 8, lcd_dim)
	draw_string(_font, lcd.position + Vector2(66.0, 25.0), str(_shown_kmh),
		HORIZONTAL_ALIGNMENT_CENTER, 54.0, 13, lcd_col)
