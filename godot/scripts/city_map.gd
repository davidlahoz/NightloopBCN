extends Control
## Full-screen city map overlay (key M). Pans and zooms the baked city
## texture (tools/bake_city_map.py); zoomed in, real street names appear
## from the StreetNames data; the player is the red dot. Clicking asks to
## teleport the hero car there. Wheel zooms to the cursor, drag pans,
## M / Esc closes.

# must match tools/bake_city_map.py output
const WORLD_ORIGIN := Vector2(-15677.0, -14242.0)
const WORLD_SIDE := 30985.0
const NAME_ZOOM := 700.0      # show street names below this half-width

var player_pos := Vector3.ZERO
var player_yaw := 0.0
var teleport_cb: Callable     # Callable(Vector2 world_xz)

var _sn: StreetNames
var _tex: Texture2D
var _center := Vector2.ZERO   # world xz at screen centre
var _half_w := 900.0          # world metres from centre to screen edge (x)
var _dragging := false
var _drag_accum := 0.0
var _confirm: ConfirmationDialog
var _pending := Vector2.ZERO
var _font: Font


func _init(sn: StreetNames) -> void:
	_sn = sn
	_tex = load("res://assets/textures/city_map.png")
	visible = false
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	_font = ThemeDB.fallback_font
	_confirm = ConfirmationDialog.new()
	_confirm.title = "Teleport"
	_confirm.dialog_text = "Teleport here?"
	_confirm.confirmed.connect(_do_teleport)
	add_child(_confirm)


func open_map() -> void:
	_center = Vector2(player_pos.x, player_pos.z)
	_half_w = 900.0
	visible = true


func close_map() -> void:
	visible = false


func _process(_dt: float) -> void:
	if visible:
		queue_redraw()


func _ppm() -> float:
	return size.x * 0.5 / _half_w


func _world_at(p: Vector2) -> Vector2:
	return _center + (p - size * 0.5) / _ppm()


func _screen_of(w: Vector2) -> Vector2:
	return size * 0.5 + (w - _center) * _ppm()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb: InputEventMouseButton = event
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			_zoom_at(mb.position, 0.8)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			_zoom_at(mb.position, 1.25)
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_dragging = true
				_drag_accum = 0.0
			else:
				_dragging = false
				if _drag_accum < 8.0:
					_pending = _world_at(mb.position)
					_confirm.dialog_text = "Teleport here?  (%.0f, %.0f)" % [
						_pending.x, _pending.y]
					_confirm.popup_centered()
		accept_event()
	elif event is InputEventMouseMotion and _dragging:
		var mm: InputEventMouseMotion = event
		_center -= mm.relative / _ppm()
		_drag_accum += mm.relative.length()
		accept_event()


func _zoom_at(p: Vector2, factor: float) -> void:
	var before := _world_at(p)
	_half_w = clampf(_half_w * factor, 130.0, 12000.0)
	# keep the world point under the cursor fixed
	_center += before - _world_at(p)


func _do_teleport() -> void:
	if teleport_cb.is_valid():
		teleport_cb.call(_pending)
	close_map()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color(0.03, 0.04, 0.07, 0.96))
	# map texture region for the visible world rect
	var mpp := WORLD_SIDE / float(_tex.get_width())
	var half := Vector2(size.x, size.y) * 0.5 / _ppm()
	var reg_pos := (_center - half - WORLD_ORIGIN) / mpp
	var reg_size := half * 2.0 / mpp
	draw_texture_rect_region(_tex, Rect2(Vector2.ZERO, size),
		Rect2(reg_pos, reg_size))
	# street names, zoomed in only
	if _sn != null and _sn.is_ready() and _half_w < NAME_ZOOM:
		var done: Dictionary = {}
		var labels := 0
		for si in _sn.segments_near(_center.x, _center.y, _half_w * 1.3):
			var wi := _sn.seg_way(si)
			if done.has(wi):
				continue
			done[wi] = true
			var nm := _sn.way_name(wi)
			if nm.is_empty():
				continue
			var a := _sn.seg_a(si)
			var b := _sn.seg_b(si)
			var sp := _screen_of((a + b) * 0.5)
			if sp.x < 0.0 or sp.y < 0.0 or sp.x > size.x or sp.y > size.y:
				continue
			draw_string(_font, sp + Vector2(4, -3), nm,
				HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(0.85, 0.88, 0.95, 0.85))
			labels += 1
			if labels >= 90:
				break
	# player: red dot + heading tick
	var pp := _screen_of(Vector2(player_pos.x, player_pos.z))
	var fwd := Vector2(sin(player_yaw), cos(player_yaw))
	draw_line(pp, pp + Vector2(fwd.x, fwd.y) * 14.0, Color(1, 0.3, 0.25, 0.9), 2.0)
	draw_circle(pp, 6.0, Color(0.9, 0.12, 0.1))
	draw_arc(pp, 6.0, 0.0, TAU, 20, Color(1, 1, 1, 0.9), 1.5)
	# hints
	draw_string(_font, Vector2(16, size.y - 14),
		"wheel zoom · drag pan · click teleport · M close",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.7, 0.75, 0.85, 0.8))
