class_name EngineAudio
extends Node
## Engine sound — the vendored loop revved in real time via playback rate.
## Port of the src/audio/engine.js approach ("Car Engine Loop 96kHz 4s" by
## qubodup, CC-BY 3.0 — see ASSETS.md).

var muted := false

var _player: AudioStreamPlayer
var _pitch := 0.7


func _init() -> void:
	_player = AudioStreamPlayer.new()
	var stream: AudioStream = load("res://assets/audio/engine-loop.wav")
	if stream is AudioStreamWAV:
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
		stream.loop_begin = 0
		var bytes_per_frame := 2 if stream.format == AudioStreamWAV.FORMAT_16_BITS else 1
		if stream.stereo:
			bytes_per_frame *= 2
		stream.loop_end = stream.data.size() / bytes_per_frame
	_player.stream = stream
	_player.volume_db = -60.0
	add_child(_player)


func update(dt: float, car: Car, input: InputState) -> void:
	if _player.stream == null:
		return
	if not _player.playing:
		_player.play()
	# rev follows speed, with a throttle blip so launches sound eager
	var speed_t: float = clampf(car.speed / car.top_speed, 0.0, 1.0)
	var target: float = 0.55 + speed_t * 1.55 + input.throttle * 0.14 + car.drift_amount * 0.10
	_pitch += (target - _pitch) * (1.0 - exp(-6.0 * dt))
	_player.pitch_scale = maxf(0.3, _pitch)
	var vol_lin: float = 0.16 + 0.30 * speed_t + 0.22 * input.throttle
	_player.volume_db = -60.0 if muted else linear_to_db(vol_lin)
