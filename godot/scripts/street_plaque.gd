class_name StreetPlaque
extends Control
## The iconic Barcelona marble street plaque, top centre — engraved caps on
## veined marble (Marble007, ambientCG, CC0) with corner screws. Shows the
## current street name and crossfades when it changes.

const MARBLE_PATH := "res://assets/textures/marble007.jpg"
const TOP_MARGIN := 14.0
const FADE_SPEED := 5.0

var _marble: Texture2D
var _font: Font
var _lines: PackedStringArray = []
var _target_name := ""
var _shown_name := ""
var _alpha := 0.0
var _plaque_size := Vector2(240, 96)


func _init() -> void:
	_marble = load(MARBLE_PATH)
	_font = ThemeDB.fallback_font
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	modulate.a = 0.0


## Set the street under the car ("" hides the plaque).
func set_street(street: String) -> void:
	_target_name = street


func update_plaque(dt: float) -> void:
	if _target_name != _shown_name:
		# fade out, swap, fade back in
		_alpha = maxf(0.0, _alpha - FADE_SPEED * dt)
		if _alpha <= 0.01:
			_shown_name = _target_name
			_layout()
	elif not _shown_name.is_empty():
		_alpha = minf(1.0, _alpha + FADE_SPEED * dt)
	modulate.a = _alpha


## Split the name into plaque lines like the real signs:
## "Passeig de Gràcia" -> PASSEIG / DE / GRÀCIA.
func _layout() -> void:
	_lines.clear()
	if _shown_name.is_empty():
		queue_redraw()
		return
	var words := _shown_name.to_upper().split(" ")
	match words.size():
		1:
			_lines.append(words[0])
		2:
			_lines.append(words[0])
			_lines.append(words[1])
		_:
			# type word on top, connectors in the middle, the name at the bottom
			_lines.append(words[0])
			var mid := " ".join(words.slice(1, words.size() - 1))
			_lines.append(mid)
			_lines.append(words[words.size() - 1])

	# measure with tracking to size the plaque
	var widest := 0.0
	for i in _lines.size():
		widest = maxf(widest, _tracked_width(_lines[i], _line_font_size(i)))
	var w := clampf(widest + 64.0, 200.0, 440.0)
	var h := 36.0 + _lines.size() * 27.0
	_plaque_size = Vector2(w, h)
	size = _plaque_size
	_place()
	queue_redraw()


func _ready() -> void:
	_place()
	get_viewport().size_changed.connect(_place)


func _place() -> void:
	position = Vector2((get_viewport_rect().size.x - size.x) / 2.0, TOP_MARGIN)


func _line_font_size(i: int) -> int:
	# connectors slightly smaller, final name line largest
	if _lines.size() >= 3 and i == 1:
		return 14
	if i == _lines.size() - 1 and _lines.size() > 1:
		return 22
	return 18


const TRACKING := 3.0   # engraved caps are widely letter-spaced

func _tracked_width(text: String, font_size: int) -> float:
	var w := 0.0
	for ch in text:
		w += _font.get_string_size(ch, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x + TRACKING
	return w - TRACKING if w > 0.0 else 0.0


func _draw_tracked(text: String, center_x: float, y: float, font_size: int, col: Color) -> void:
	var x := center_x - _tracked_width(text, font_size) / 2.0
	for ch in text:
		# incised lettering: lit lower lip, shaded upper edge, near-black face
		draw_char(_font, Vector2(x + 1.2, y + 1.2), ch, font_size, Color(1, 1, 1, 0.65))
		draw_char(_font, Vector2(x - 0.8, y - 0.8), ch, font_size, Color(0, 0, 0, 0.30))
		draw_char(_font, Vector2(x, y), ch, font_size, col)
		x += _font.get_string_size(ch, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x + TRACKING


func _draw() -> void:
	if _lines.is_empty():
		return
	var w := _plaque_size.x
	var h := _plaque_size.y

	# drop shadow, then the marble slab as a rounded polygon with UVs
	var pts := _rounded_rect_points(Rect2(0, 0, w, h), 7.0)
	var shadow := PackedVector2Array()
	for p in pts:
		shadow.append(p + Vector2(0, 2.5))
	draw_colored_polygon(shadow, Color(0, 0, 0, 0.35))
	var uvs := PackedVector2Array()
	for p in pts:
		# a stable patch of the texture, slightly rectangular like a cut slab
		uvs.append(Vector2(0.58 + p.x / w * 0.38, 0.06 + p.y / h * 0.2))
	draw_colored_polygon(pts, Color(1.0, 0.99, 0.95), uvs, _marble)
	# lift toward the ivory of the real plaques
	draw_colored_polygon(pts, Color(1.0, 0.98, 0.92, 0.25))
	draw_polyline(pts + PackedVector2Array([pts[0]]), Color(0.55, 0.52, 0.47, 0.6), 1.0, true)

	# corner screws
	for s in [Vector2(14, 14), Vector2(w - 14, 14), Vector2(14, h - 14), Vector2(w - 14, h - 14)]:
		draw_circle(s, 3.2, Color(0.42, 0.40, 0.36))
		draw_circle(s, 3.2, Color(0.25, 0.23, 0.20), false, 1.0, true)
		draw_line(s + Vector2(-1.8, -0.6), s + Vector2(1.8, 0.6), Color(0.28, 0.26, 0.23), 1.0, true)

	# engraved text — near-black like the real incised plaques
	var ink := Color(0.13, 0.12, 0.11)
	var y := (h - _lines.size() * 27.0) / 2.0 + 19.0
	for i in _lines.size():
		_draw_tracked(_lines[i], w / 2.0, y, _line_font_size(i), ink)
		y += 27.0


func _rounded_rect_points(r: Rect2, radius: float) -> PackedVector2Array:
	var pts := PackedVector2Array()
	var corners := [
		[Vector2(r.position.x + radius, r.position.y + radius), PI, PI * 1.5],
		[Vector2(r.end.x - radius, r.position.y + radius), PI * 1.5, TAU],
		[Vector2(r.end.x - radius, r.end.y - radius), 0.0, PI * 0.5],
		[Vector2(r.position.x + radius, r.end.y - radius), PI * 0.5, PI],
	]
	for c in corners:
		for i in 6:
			var a: float = lerpf(c[1], c[2], i / 5.0)
			pts.append(c[0] + Vector2(cos(a), sin(a)) * radius)
	return pts
