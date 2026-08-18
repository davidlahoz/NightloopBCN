class_name RoadProfile
## Ground heightfield — crown, camber, gutters, curbs, sidewalks, settling,
## wheel-track rutting, and the motorway's crossfall + raised centre median.
## Port of src/city/roadProfile.js. Single source of truth for:
##   - ground chunk mesh baking (LOD grids sample this)
##   - wheel contact queries (vehicle suspension)
##   - prop/building placement
##
## Port note: the JS demo used a hand-rolled pcg2d value-noise fbm so CPU and
## WGSL agreed bit-exactly. In the Godot port nothing on the GPU re-derives
## heights, so the settle/wobble noise runs on FastNoiseLite (C++ — ~20×
## faster than a GDScript hash chain) with the same frequencies/amplitudes.
## Physics and baked meshes both call ground_height, so they always agree.

const CROWN_H := 0.055        # crown rise at centreline (normal street)
const GUTTER_DIP := 0.022     # gutter channel depth below road edge
const SETTLE_AMP := 0.028     # low-frequency settling
const SETTLE_FREQ := 0.085
const FINE_AMP := 0.007       # finer undulation
const FINE_FREQ := 0.42
const RUT_DEPTH := 0.007      # wheel-track depressions
const SIDEWALK_TILT := 0.014  # rises away from curb
const MEDIAN_H := 0.13        # motorway centre island height
# block plateau meets the sidewalk EXACTLY at d = 3 (no plinth step)
const BLOCK_H := CityPlan.CURB_H + CityPlan.SIDEWALK_W * SIDEWALK_TILT

# Terrain noise is deliberately NOT world-seeded (matches the JS demo, whose
# hash2 noise had no seed input): only the plan/districts reshuffle per run.
static var _settle: FastNoiseLite = _make_noise(1337, SETTLE_FREQ, 3)
static var _fine: FastNoiseLite = _make_noise(2447, FINE_FREQ, 1)
static var _wobble: FastNoiseLite = _make_noise(9173, 0.6, 1)


static func _make_noise(nseed: int, freq: float, octaves: int) -> FastNoiseLite:
	var n := FastNoiseLite.new()
	n.noise_type = FastNoiseLite.TYPE_VALUE
	n.seed = nseed
	n.frequency = freq
	if octaves > 1:
		n.fractal_type = FastNoiseLite.FRACTAL_FBM
		n.fractal_octaves = octaves
		n.fractal_lacunarity = 2.03
		n.fractal_gain = 0.5
	else:
		n.fractal_type = FastNoiseLite.FRACTAL_NONE
	return n


## Gutter channel shape for the band [face-GUTTER_W, face].
static func _gutter_dip(at: float, face: float) -> float:
	if at <= face - CityPlan.GUTTER_W:
		return 0.0
	var g := (at - (face - CityPlan.GUTTER_W)) / CityPlan.GUTTER_W  # 0..1 across gutter
	if g < 0.75:
		return -GUTTER_DIP * (g / 0.75)
	return -GUTTER_DIP * (0.85 + (1.0 - g) / 0.25 * 0.15)


## Normal street crown/gutter profile; input clamped to the curb face.
static func cross_profile(at_in: float) -> float:
	var at := minf(at_in, CityPlan.CURB_FACE)
	var tc := minf(at, CityPlan.ROAD_HALF)
	var n := tc / CityPlan.ROAD_HALF
	return CROWN_H * (1.0 - n * n) + _gutter_dip(at, CityPlan.CURB_FACE)


## Motorway profile: raised median island, crossfall, gutter. island_scale
## gates the island down to a flat 7.5 cm plateau near junctions.
static func mway_profile(at_in: float, island_scale: float = 1.0) -> float:
	var at := minf(at_in, CityPlan.MWAY_FACE)
	if at < CityPlan.MWAY_MEDIAN:
		var s := minf(1.0, (CityPlan.MWAY_MEDIAN - at) / 0.35)
		return 0.075 + MEDIAN_H * (s * s * (3.0 - 2.0 * s)) * island_scale
	var run := (at - CityPlan.MWAY_MEDIAN) / (CityPlan.MWAY_HALF - CityPlan.MWAY_MEDIAN)
	return 0.075 * (1.0 - run) + _gutter_dip(at, CityPlan.MWAY_FACE)


## Wheel-track rutting for a normal street (tracks at |t| = 1.2, 2.8).
static func _rut_profile(at: float) -> float:
	var d1 := at - 1.2
	var d2 := at - 2.8
	return (exp(-d1 * d1 * 8.16) + exp(-d2 * d2 * 8.16)) * RUT_DEPTH


static func _settle_at(x: float, z: float) -> float:
	return SETTLE_AMP * _settle.get_noise_2d(x, z) + FINE_AMP * _fine.get_noise_2d(x, z)


static func _wobble_at(x: float, z: float) -> float:
	return 0.004 * _wobble.get_noise_2d(x + 31.7, z + 11.3)


## Ground height at world (x, z). `ctx` must be owned by the calling thread.
static func ground_height(x: float, z: float, ctx: CityPlan.PlanCtx) -> float:
	var rs := CityPlan.sample_road_space(x, z, ctx.rs, ctx)
	var d := rs.d
	var settle := _settle_at(x, z)

	if d < 0.0:
		var atA := absf(rs.tA)
		var atB := absf(rs.tB)
		var inA := atA < rs.faceA
		var inB := atB < rs.faceB
		# both profiles clamp internally, so they stay valid in fillet corners
		var hA := cross_profile(atA) - (_rut_profile(atA) * (1.0 - rs.wB) if inA else 0.0)
		var hB: float
		if rs.mwayB == 1:
			# island fades out across the junction
			var g := clampf((atA - rs.faceA - 0.6) / 2.0, 0.0, 1.0)
			hB = mway_profile(atB, g * g * (3.0 - 2.0 * g))
		else:
			hB = cross_profile(atB) - (_rut_profile(atB) * rs.wB if inB else 0.0)
		return maxf(hA, hB) + settle

	elif d < CityPlan.CURB_W:
		# rolled curb, gutter bottom → curb top; endpoints match both sides
		var edge_profile: float
		if rs.mwayB == 1 and rs.dB < rs.dA:
			edge_profile = mway_profile(CityPlan.MWAY_FACE)
		else:
			edge_profile = cross_profile(CityPlan.CURB_FACE)
		var edge_h := edge_profile + settle
		var top_h := CityPlan.CURB_H + _wobble_at(x, z) + settle * 0.35
		var s := d / CityPlan.CURB_W
		var rise := s * s * (3.0 - 2.0 * s)
		return edge_h + (top_h - edge_h) * pow(rise, 0.8)

	elif d < CityPlan.CURB_W + CityPlan.SIDEWALK_W:
		var ds := d - CityPlan.CURB_W
		return CityPlan.CURB_H + ds * SIDEWALK_TILT + _wobble_at(x, z) + settle * 0.35

	else:
		# same tail terms as the sidewalk branch → exactly continuous at d = 3
		return BLOCK_H + _wobble_at(x, z) + settle * 0.35


## Ground normal by central differences (for prop alignment).
static func ground_normal(x: float, z: float, eps: float, ctx: CityPlan.PlanCtx) -> Vector3:
	var hx1 := ground_height(x + eps, z, ctx)
	var hx0 := ground_height(x - eps, z, ctx)
	var hz1 := ground_height(x, z + eps, ctx)
	var hz0 := ground_height(x, z - eps, ctx)
	var n := Vector3(-(hx1 - hx0) / (2.0 * eps), 1.0, -(hz1 - hz0) / (2.0 * eps))
	return n.normalized()
