extends Node3D
## Orbit camera rig v2: long lens, wide diorama framing, and a living
## multi-axis drift (slow Lissajous on yaw/pitch/distance plus a gentle
## target sway) so the wallpaper never feels frozen.

@export var target := Vector3(-0.5, 0.4, -2.8)
@export var yaw := -12.0
@export var pitch := -32.0
@export var distance := 33.0
@export var drift := true
## 0 = static, 1 = default cinematic drift, 2 = dramatic.
@export var drift_amount := 1.0

var _t := 0.0
# Cinematic interest shots: glide toward a character, linger, ease back.
var _focus_node: Node3D = null
var _focus_until := 0.0
var _focus_w := 0.0
var _focus_zoom := 21.0   # camera distance while focusing (smaller = tighter)

@onready var _cam: Camera3D = $Camera3D

func _ready() -> void:
	position = target
	rotation_degrees = Vector3(pitch, yaw, 0.0)
	_cam.position = Vector3(0.0, 0.0, distance)

## Ask the camera to visit something interesting for a few seconds.
## Callers rate-limit; the rig just performs the move.
func focus_on(node: Node3D, dur := 7.0, zoom := 21.0) -> void:
	if node == null or not is_instance_valid(node):
		return
	_focus_node = node
	_focus_until = Time.get_ticks_msec() / 1000.0 + dur
	_focus_zoom = zoom

## Is a close-up currently playing? Lets callers fire a "guaranteed" focus on
## a fresh order only when the camera is otherwise idle (no event running).
func is_focusing() -> bool:
	return is_instance_valid(_focus_node) and Time.get_ticks_msec() / 1000.0 < _focus_until

func _process(delta: float) -> void:
	if not drift or drift_amount <= 0.0:
		return
	_t += delta
	var a := drift_amount
	# Different prime-ish periods per axis → the path never visibly repeats.
	rotation_degrees.y = yaw + sin(_t * 0.060) * 5.0 * a
	rotation_degrees.x = pitch + sin(_t * 0.037 + 1.7) * 2.0 * a
	var drift_z := distance + sin(_t * 0.047 + 0.6) * 2.6 * a
	var drift_pos := target + Vector3(
		sin(_t * 0.027) * 1.1 * a,
		sin(_t * 0.051 + 0.9) * 0.15 * a,
		cos(_t * 0.033) * 0.8 * a)

	# Blend toward the interest shot and back out, slow and creamy.
	var now := Time.get_ticks_msec() / 1000.0
	var want := 1.0 if (_focus_node != null and is_instance_valid(_focus_node)
		and now < _focus_until) else 0.0
	_focus_w = move_toward(_focus_w, want, delta * 0.45)
	if _focus_w <= 0.0:
		if want == 0.0:
			_focus_node = null
		position = drift_pos
		_cam.position.z = drift_z
		return
	var k := smoothstep(0.0, 1.0, _focus_w)
	var fp: Vector3 = _focus_node.global_position
	position = drift_pos.lerp(Vector3(fp.x, fp.y + 0.35, fp.z), k)
	_cam.position.z = lerpf(drift_z, _focus_zoom, k)
