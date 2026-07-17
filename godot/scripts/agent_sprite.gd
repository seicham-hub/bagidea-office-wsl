extends Sprite3D
## Agent character v3. Uses real spritesheets when present:
##   - premade NPC sheets (4-direction idle + walk, assets/characters/npc/)
##   - composited custom characters (CharacterFactory, idle-only, tinted)
## Falls back to the original runtime-generated pixel sprite when the
## (license-restricted, gitignored) assets are missing — clones still run.
## Billboarded + shaded so sprites are lit by the 3D scene (HD-2D core trick).

@export var suit_color := Color8(38, 46, 76)
@export var hair_color := Color8(52, 38, 30)
@export var skin_color := Color8(236, 188, 152)
@export var tie_color := Color8(168, 52, 58)
## 1..12 = premade NPC sheet, 0 = composited custom, -1 = procedural fallback.
@export var npc_index := -1
@export var agent_name := "agent"
@export var agent_role := "Staff"
## "ceo" (the owner), "lead" (the Director) or "staff" — drives plate rank
## dressing on the HUD.
@export var rank := "staff"

const CharacterFactory := preload("res://scripts/character_factory.gd")
const AuraFactory := preload("res://scripts/aura_factory.gd")
const WALK_SPEED := 1.6        # m/s
const IDLE_FPS := 5.0
const WALK_FPS := 9.0
# Sheet row order (verified against the art): down, LEFT, up, RIGHT.
const DIR_DOWN := 0
const DIR_LEFT := 1
const DIR_UP := 2
const DIR_RIGHT := 3

# --- procedural fallback art (original look) -------------------------------
const ART_IDLE: Array[String] = [
	"................",
	".....oooo.......",
	"....ohhhho......",
	"...ohHhhhho.....",
	"...ohhhhhho.....",
	"...offffffo.....",
	"...ofeffefo.....",
	"...offffffo.....",
	"....oFFFFo......",
	"...oswwwwso.....",
	"..osswttwsso....",
	"..osswttwsso....",
	"..ossswwssso....",
	"..osssssssso....",
	"..ofssssssfo....",
	"...oSSSSSSo.....",
	"...oppppppo.....",
	"...oppppppo.....",
	"...oppo.oppo....",
	"...oppo.oppo....",
	"...oppo.oppo....",
	"..obbbo.obbbo...",
	"................",
	"................",
]
const ART_WALK: Array[String] = [
	"................",
	".....oooo.......",
	"....ohhhho......",
	"...ohHhhhho.....",
	"...ohhhhhho.....",
	"...offffffo.....",
	"...ofeffefo.....",
	"...offffffo.....",
	"....oFFFFo......",
	"...oswwwwso.....",
	"..osswttwsso....",
	"..osswttwsso....",
	"..ossswwssso....",
	"..osssssssso....",
	"..ofssssssfo....",
	"...oSSSSSSo.....",
	"...oppppppo.....",
	"..oppo..oppo....",
	"..oppo...oppo...",
	".oppo.....oppo..",
	".oppo.....oppo..",
	"obbbo......obbbo",
	"................",
	"................",
]

var idle_pos := Vector3.ZERO
var _hud: Node
var _walk_tween: Tween
var _t := 0.0
var _bob_speed := 2.2
var _walking := false
var _mode := "procedural"   # "npc" | "custom" | "procedural"
var _has_walk_rows := false
var _dir := DIR_DOWN
var _anim_t := 0.0
var _anim_frame := 0
var _last_pos := Vector3.ZERO
var _tex_idle: ImageTexture
var _tex_walk: ImageTexture

func _ready() -> void:
	layers = 2  # characters render on layer 2 — the map camera culls them
	_setup_visual()
	idle_pos = position
	_last_pos = position
	_t = randf() * TAU

	# MMO-style nameplate on the 2D HUD layer (crisp screen-space text).
	_hud = get_tree().current_scene.get_node_or_null("Hud")
	if _hud:
		_hud.register(self, agent_name, agent_role, _portrait(), suit_color.lightened(0.25))

func _exit_tree() -> void:
	if _hud:
		_hud.unregister(self)

var _aura_node: Node3D
var aura := ""
var is_ghost := false
var _trail_t := 0.0
## Live tailing: steer toward this node every frame (orders, supervision).
var follow_node: Node3D = null
var _follow_offset := Vector3(1.0, 0, 0.6)

func follow(node: Node3D, offset := Vector3(1.0, 0, 0.6)) -> void:
	follow_node = node
	_follow_offset = offset
	if _walk_tween:
		_walk_tween.kill()  # manual steering takes over

func unfollow() -> void:
	follow_node = null
	_walking = false

var _held_until := 0.0

## Freeze in place for `dur` seconds — used when the user clicks the character on
## the wallpaper so it stops to be looked at (camera zoom). While held, walk_to is
## a no-op and tailing is suspended, so the manager's loops can't drag it away.
func hold(dur := 9.0) -> void:
	_held_until = Time.get_ticks_msec() / 1000.0 + dur
	follow_node = null
	if _walk_tween:
		_walk_tween.kill()
	_walking = false
	_dir = DIR_DOWN   # turn to face the camera

func is_held() -> bool:
	return Time.get_ticks_msec() / 1000.0 < _held_until

## Spectral mode for sub-agent clones: steadily translucent (see-through,
## no flicker), cool self-lit tint, rising soul-wisp particles and an
## afterimage trail while gliding. Call after the node has entered the tree.
func set_ghost() -> void:
	is_ghost = true
	shaded = false
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	# CRITICAL: the default ALPHA_CUT_DISCARD throws away every pixel below
	# ~0.5 alpha — a 0.45-alpha ghost rendered as NOTHING (and the old pulse
	# blinked by crossing the cutoff). Real alpha blending for spirits.
	alpha_cut = SpriteBase3D.ALPHA_CUT_DISABLED
	_bob_speed = 1.8
	modulate = Color(0.7, 0.95, 1.25, 0.0)
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 0.65, 0.8)
	_add_ghost_wisps()

## The way out: fade to nothing, free.
func ghost_dissolve() -> void:
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", 0.0, 0.6)
	tw.tween_callback(queue_free)

## Soft cyan motes drifting up through the body — the soul is leaking.
func _add_ghost_wisps() -> void:
	var p := GPUParticles3D.new()
	p.amount = 10
	p.lifetime = 1.7
	p.preprocess = 1.7
	p.layers = 2
	var m := ParticleProcessMaterial.new()
	m.direction = Vector3(0, 1, 0)
	m.spread = 20.0
	m.gravity = Vector3.ZERO
	m.initial_velocity_min = 0.28
	m.initial_velocity_max = 0.55
	m.scale_min = 0.4
	m.scale_max = 1.0
	m.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
	m.emission_sphere_radius = 0.28
	m.color = Color(0.6, 0.92, 1.0, 0.5)
	p.process_material = m
	var quad := QuadMesh.new()
	quad.size = Vector2(0.09, 0.09)
	var qm := StandardMaterial3D.new()
	qm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	qm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	qm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	qm.vertex_color_use_as_albedo = true
	qm.emission_enabled = true
	qm.emission = Color(0.5, 0.85, 1.0)
	qm.emission_energy_multiplier = 1.4
	quad.material = qm
	p.draw_pass_1 = quad
	p.position = Vector3(0, -0.35, 0)
	add_child(p)

## A fading copy of the current sprite frame, left behind while moving.
func _drop_afterimage() -> void:
	var img := Sprite3D.new()
	img.texture = texture
	img.hframes = hframes
	img.vframes = vframes
	img.frame = frame
	img.pixel_size = pixel_size
	img.billboard = billboard
	img.shaded = false
	img.offset = offset
	img.alpha_cut = alpha_cut
	img.texture_filter = texture_filter
	img.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	img.layers = 2
	img.modulate = Color(0.55, 0.85, 1.25, 0.28)
	get_parent().add_child(img)
	img.global_position = global_position
	var tw := img.create_tween()
	tw.tween_property(img, "modulate:a", 0.0, 0.45)
	tw.tween_callback(img.queue_free)

## Equippable cosmetic aura (elemental ground ring) — picked in the editor.
func set_aura(element: String) -> void:
	if element == aura:
		return
	aura = element
	if _aura_node:
		_aura_node.queue_free()
		_aura_node = null
	if element == "" or element == "none" or not AuraFactory.ELEMENTS.has(element):
		return
	if not AuraFactory.has_assets():
		return
	_aura_node = AuraFactory.build(element)
	_aura_node.position = Vector3(0, -0.84, 0)  # node floats at y 0.86 — ring on floor
	add_child(_aura_node)

## Live identity update from the registry (rename / new role / new avatar).
func apply_identity(p_name: String, p_role: String, p_npc: int) -> void:
	var changed := p_npc != npc_index or p_name != agent_name or p_role != agent_role
	agent_name = p_name
	agent_role = p_role
	if p_npc != npc_index:
		npc_index = p_npc
		_setup_visual()
	if changed and _hud:
		_hud.unregister(self)
		_hud.register(self, agent_name, agent_role, _portrait(), suit_color.lightened(0.25))

## Portrait for the nameplate: the face region of the sheet's first cell.
func _portrait() -> Texture2D:
	if _mode in ["npc", "custom"]:
		var at := AtlasTexture.new()
		at.atlas = texture
		at.region = Rect2(14, 14, 36, 36)  # face centered, chin + shoulders in
		return at
	return texture  # procedural mini figure

func _setup_visual() -> void:
	if npc_index >= 1 and CharacterFactory.has_assets():
		var tex: ImageTexture = CharacterFactory.npc_texture(npc_index)
		if tex:
			texture = tex
			hframes = 4
			vframes = 8
			_mode = "npc"
			_has_walk_rows = true
			# Char body spans rows 10..63 of the 64px cell (54 px tall, feet on
			# the cell's bottom edge): 0.032 → ~1.7 m tall.
			pixel_size = 0.032
			# Full billboard: the sprite plane faces the camera even at the
			# high pitch (FIXED_Y reads paper-thin from a -45° camera).
			billboard = BaseMaterial3D.BILLBOARD_ENABLED
			return
	if npc_index == 0 and CharacterFactory.has_assets():
		var tex: ImageTexture = CharacterFactory.custom_texture(skin_color, hair_color, suit_color, suit_color.darkened(0.4))
		if tex:
			texture = tex
			hframes = 4
			vframes = 4
			_mode = "custom"
			_has_walk_rows = false
			pixel_size = 0.032
			billboard = BaseMaterial3D.BILLBOARD_ENABLED
			return
	_build_procedural()

func _build_procedural() -> void:
	var colors := {
		"o": Color8(18, 16, 22),
		"h": hair_color,
		"H": hair_color.lightened(0.25),
		"f": skin_color,
		"F": skin_color.darkened(0.16),
		"e": Color8(40, 40, 48),
		"s": suit_color,
		"S": suit_color.darkened(0.3),
		"w": Color8(225, 228, 235),
		"t": tie_color,
		"p": suit_color.darkened(0.4),
		"b": Color8(24, 22, 28),
	}
	_tex_idle = _bake(ART_IDLE, colors)
	_tex_walk = _bake(ART_WALK, colors)
	texture = _tex_idle
	hframes = 1
	vframes = 1
	_mode = "procedural"
	pixel_size = 0.07

func _bake(art: Array[String], colors: Dictionary) -> ImageTexture:
	var w: int = art[0].length()
	var h: int = art.size()
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		var row := art[y]
		for x in w:
			var key := row[x]
			if colors.has(key):
				img.set_pixel(x, y, colors[key])
	return ImageTexture.create_from_image(img)

func _process(delta: float) -> void:
	# Facing follows actual movement.
	var v := position - _last_pos
	_last_pos = position
	if _walking and v.length() > 0.001:
		if absf(v.x) > absf(v.z):
			_dir = DIR_RIGHT if v.x > 0.0 else DIR_LEFT
		else:
			_dir = DIR_DOWN if v.z > 0.0 else DIR_UP

	# Idle bob (procedural only — sheet anims carry their own life).
	_t += delta * _bob_speed

	if is_ghost and _walking:
		_trail_t -= delta
		if _trail_t <= 0.0:
			_trail_t = 0.15
			_drop_afterimage()

	# Continuous tailing: keep up with the followed node — walking whenever
	# they walk. Steering only operates at CLOSE range (same room, line of
	# sight assumed); when the target gets far, the manager's tail loop
	# re-routes along the A* graph so nobody cuts through walls.
	if follow_node != null and not is_held():
		if not is_instance_valid(follow_node):
			follow_node = null
		else:
			var tgt: Vector3 = follow_node.position + _follow_offset
			var dist := position.distance_to(tgt)
			if dist > 3.4:
				_walking = false  # too far for steering — wait for a graph path
			elif dist > 0.22:
				var sp := WALK_SPEED * (4.0 if is_ghost else 1.0)
				position = position.move_toward(tgt, sp * delta)
				_walking = true
			elif _walking:
				_walking = false
				_dir = DIR_DOWN
	# Sheet art: feet sit 31 px below cell center; node stands at y 0.86
	# (0.86 / 0.032 ≈ 27 px) → lift by 4 px so feet land exactly on the floor.
	if _mode == "procedural":
		offset.y = sin(_t) * 0.15
	else:
		# Ghosts hover — a visible float on top of the sheet's baked feet line.
		offset.y = 4.0 + (sin(_t) * 2.6 if is_ghost else 0.0)
		offset.x = 0.0

	match _mode:
		"npc", "custom":
			var fps := WALK_FPS if _walking else IDLE_FPS
			_anim_t += delta * fps
			if _anim_t >= 1.0:
				_anim_t = fmod(_anim_t, 1.0)
				_anim_frame = (_anim_frame + 1) % 4
			var row := _dir
			if _walking:
				if _has_walk_rows:
					row += 4
				else:
					# Idle-only sheets (custom composites): fake the stride
					# with a step-hop so walking still reads as walking.
					offset.y = 4.0 + absf(sin(_t * 1.6)) * 2.2
					offset.x = sin(_t * 0.8) * 1.4
			frame = row * 4 + _anim_frame
		"procedural":
			if _walking:
				_anim_t += delta
				if _anim_t >= 0.16:
					_anim_t = 0.0
					_anim_frame = 1 - _anim_frame
					texture = _tex_walk if _anim_frame == 1 else _tex_idle
			elif texture != _tex_idle:
				texture = _tex_idle

func set_status(text: String) -> void:
	if _hud:
		_hud.set_status(self, text)

var _hurry := false   # has work to do → moves at double pace (ghosts already 4x)

# Force the hurried (running) gait on/off regardless of state — used by the
# chase/tag game so agents actually SPRINT. set_state() recomputes it after.
func set_hurry(on: bool) -> void:
	_hurry = on

func set_state(state: String) -> void:
	# "blocked" agents only move when hurrying to the Security desk to ask for a
	# permission — so they should RUN there, like an agent dispatched to work.
	_hurry = state == "working" or state == "meeting" or state == "blocked"
	if _hud:
		_hud.set_state(self, state)

## Walk through waypoints (straight tween legs along the A* graph).
## Returns the total walk duration in seconds.
## Cancel any walk and jump to a spot — used when the room grid is rearranged
## (jigsaw swap) so characters land in the right room immediately.
func teleport(pos: Vector3) -> void:
	follow_node = null
	if _walk_tween:
		_walk_tween.kill()
	_walking = false
	position = pos

func walk_to(points: Array, face_dir := -1) -> float:
	if is_held():
		return 0.0   # frozen by a wallpaper-click focus — ignore movement orders
	if points.is_empty():
		if face_dir >= 0: _dir = face_dir   # already there — just turn to face
		return 0.0
	follow_node = null  # an explicit walk always overrides tailing
	if _walk_tween:
		_walk_tween.kill()
	_walk_tween = create_tween()
	var from := position
	var total := 0.0
	# Ghosts hurry 4x; a working agent hurries 2x; idle strolling stays 1x.
	var speed: float = WALK_SPEED * (4.0 if is_ghost else (2.0 if _hurry else 1.0))
	for p in points:
		var leg_time: float = max(from.distance_to(p) / speed, 0.05)
		_walk_tween.tween_property(self, "position", p, leg_time)
		total += leg_time
		from = p
	_walking = true
	_bob_speed = 7.0
	_walk_tween.finished.connect(func():
		_bob_speed = 2.2
		_walking = false
		# default: face the camera on arrival; a caller can request another facing
		# (e.g. DIR_UP to face the monitor when seating at a work desk).
		_dir = face_dir if face_dir >= 0 else DIR_DOWN)
	return total
