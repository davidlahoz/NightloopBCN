class_name CityPlan
## NIGHTLOOP city plan — the single source of truth for street layout.
## Direct port of src/city/cityPlan.js (Babylon demo).
##
## The city is an INFINITE periodic grid: N-S streets every PERIOD_X metres,
## E-W streets every PERIOD_Z metres. Every 4th E-W row (j == 2 mod 4) is a
## MOTORWAY. The whole plan is evaluated in a smoothly WARPED domain so every
## street becomes a gentle serpentine while the analytic grid math stays exact.
##
## The ground shader (shaders/ground.gdshader) mirrors warp_of, cell_seed and
## the street-thinning logic EXACTLY (u32 math) — change both or neither.
##
## All hashing mixes world_seed, so the map reshuffles per run. cell_seed uses
## 32-bit integer semantics identical to JS Math.imul so CPU and GPU agree.

const PERIOD_X := 200.0     # N-S street spacing (streets run along Z)
const PERIOD_Z := 160.0     # E-W street spacing (streets run along X)
const MWAY_MOD := 4         # every 4th E-W row…
const MWAY_REM := 2         # …with row index == 2 (mod 4) is a motorway

const ROAD_HALF := 4.0            # normal street: centre → gutter start
const GUTTER_W := 0.45
const CURB_FACE := ROAD_HALF + GUTTER_W    # 4.45 normal curb face
const CURB_W := 0.15
const CURB_H := 0.13
const SIDEWALK_W := 2.85
const SIDEWALK_EDGE := CURB_FACE + CURB_W + SIDEWALK_W  # 7.45 (normal)
const CORNER_R := 5.5             # curb fillet radius at crossings

# motorway row geometry
const MWAY_HALF := 12.0           # centre → gutter start
const MWAY_FACE := MWAY_HALF + GUTTER_W    # 12.45 curb face
const MWAY_MEDIAN := 1.0          # raised centre island half-width
const MWAY_LANE_W := 3.5          # three lanes per carriageway

const ZONE_ROAD := 0
const ZONE_CURB := 1
const ZONE_SIDEWALK := 2
const ZONE_BLOCK := 3

# Street curvature — two-octave serpentine per axis. Max slope ~0.13.
const WARP_MAX := 7.0
const WX1_A := 4.5; const WX1_K := 0.0146126; const WX1_P := 0.9   # λ ≈ 430 m
const WX2_A := 2.0; const WX2_K := 0.0299199; const WX2_P := 4.1   # λ ≈ 210 m
const WZ1_A := 4.0; const WZ1_K := 0.0161107; const WZ1_P := 2.3   # λ ≈ 390 m
const WZ2_A := 2.0; const WZ2_K := 0.0363201; const WZ2_P := 0.7   # λ ≈ 173 m

const DISTRICT_DOWNTOWN := 0
const DISTRICT_COMMERCIAL := 1
const DISTRICT_RESIDENTIAL := 2
const DISTRICT_INDUSTRIAL := 3
const DISTRICT_COUNTRYSIDE := 4

## Per-run world seed (u32). Set once at boot before any sampling.
static var world_seed: int = 0


## Road-space sample output (the JS `out` object).
class RoadSample:
	var iA: int = 0
	var tA: float = 0.0
	var dA: float = 0.0
	var faceA: float = CURB_FACE
	var iB: int = 0
	var tB: float = 0.0
	var dB: float = 0.0
	var faceB: float = CURB_FACE
	var d: float = 0.0
	var wB: float = 0.0
	var mwayB: int = 0


## Per-thread sampling context: street-thinning memo + scratch samples.
## Every worker thread must own its own PlanCtx (the memo Dictionary is not
## thread-safe to share); the main thread keeps one long-lived instance.
class PlanCtx:
	var memo: Dictionary = {}
	var rs := RoadSample.new()
	var rs2 := RoadSample.new()


## 32-bit unsigned multiply (JS Math.imul mod 2^32). Operands must be in
## [0, 2^32); result is masked to 32 bits. Split-halves form avoids 64-bit
## overflow of the intermediate product.
static func mul32(a: int, b: int) -> int:
	return ((a & 0xFFFF) * b + (((a >> 16) * (b & 0xFFFF)) << 16)) & 0xFFFFFFFF


## Deterministic per-cell seed in [0,1). Mirrored EXACTLY by the ground
## shader (u32 math) — change both or neither.
static func cell_seed(i: int, j: int, salt: int = 0) -> float:
	var h: int = (mul32(i & 0xFFFFFFFF, 374761393) + mul32(j & 0xFFFFFFFF, 668265263) \
		+ mul32(salt & 0xFFFFFFFF, 2246822519) + world_seed) & 0xFFFFFFFF
	h = mul32(h ^ (h >> 13), 1274126177)
	return float(h ^ (h >> 16)) / 4294967296.0


## Warp offset at world (x, z): grid = world + offset.
static func warp_of(x: float, z: float) -> Vector2:
	return Vector2(
		WX1_A * sin(z * WX1_K + WX1_P) + WX2_A * sin(z * WX2_K + WX2_P),
		WZ1_A * sin(x * WZ1_K + WZ1_P) + WZ2_A * sin(x * WZ2_K + WZ2_P))


## Inverse warp: the world point whose grid image is (gx, gz). Fixed-point
## iteration (|∂warp| < 0.14 → error < 1 cm). Returns world (x, z).
static func grid_to_world(gx: float, gz: float) -> Vector2:
	var px := gx
	var pz := gz
	for i in 3:
		var w := warp_of(px, pz)
		px = gx - w.x
		pz = gz - w.y
	return Vector2(px, pz)


## World-space heading of a street at grid coord s along it, as a yaw DELTA
## from the street's nominal axis (rad; heading(yaw) = (sin yaw, cos yaw)).
## axis 0 = N-S street, axis 1 = E-W row.
static func street_yaw_delta(axis: int, line: int, s: float) -> float:
	if axis == 0:
		var cx := line * PERIOD_X
		var p0 := grid_to_world(cx, s - 2.0)
		var p1 := grid_to_world(cx, s + 2.0)
		return atan2(p1.x - p0.x, p1.y - p0.y)
	var cz := line * PERIOD_Z
	var q0 := grid_to_world(s - 2.0, cz)
	var q1 := grid_to_world(s + 2.0, cz)
	return atan2(q1.x - q0.x, q1.y - q0.y) - PI / 2.0


static func row_index(z: float) -> int:
	return roundi(z / PERIOD_Z)

static func col_index(x: float) -> int:
	return roundi(x / PERIOD_X)

static func row_is_motorway(j: int) -> bool:
	return ((j % MWAY_MOD) + MWAY_MOD) % MWAY_MOD == MWAY_REM

static func row_face(j: int) -> float:
	return MWAY_FACE if row_is_motorway(j) else CURB_FACE

static func row_sw_edge(j: int) -> float:
	return row_face(j) + CURB_W + SIDEWALK_W


## Road-space sample at world (x, z). Fills `out`; see RoadSample fields.
## d < 0 on asphalt; fillet-rounded union of the two nearest streets.
static func sample_road_space(x: float, z: float, out: RoadSample, ctx: PlanCtx) -> RoadSample:
	var w := warp_of(x, z)
	var wx := x + w.x
	var wz := z + w.y
	var iA := roundi(wx / PERIOD_X)
	var iB := roundi(wz / PERIOD_Z)
	var tA := wx - iA * PERIOD_X
	var tB := wz - iB * PERIOD_Z
	var faceA := CURB_FACE
	var faceB := row_face(iB)

	# street thinning: suppress the N-S street where its segment is absent
	var armN := ns_seg_present(iA, iB, ctx)
	var armS := ns_seg_present(iA, iB - 1, ctx)
	if not (armN and armS):
		var col_here: bool
		if tB > faceB:
			col_here = armN
		elif tB < -faceB:
			col_here = armS
		else:
			col_here = armN or armS
		if not col_here:
			tA = faceA + 40.0

	var dA := absf(tA) - faceA
	var dB := absf(tB) - faceB

	# union with concave fillet radius CORNER_R
	var d := minf(dA, dB)
	if dA < CORNER_R and dB < CORNER_R and dA > 0.0 and dB > 0.0:
		var fx := CORNER_R - dA
		var fz := CORNER_R - dB
		var fd := CORNER_R - sqrt(fx * fx + fz * fz)
		if fd < d:
			d = fd

	out.iA = iA; out.tA = tA; out.dA = dA; out.faceA = faceA
	out.iB = iB; out.tB = tB; out.dB = dB; out.faceB = faceB
	out.d = d
	out.mwayB = 1 if row_is_motorway(iB) else 0
	var a_in := (faceA - absf(tA)) / faceA
	var b_in := (faceB - absf(tB)) / faceB
	out.wB = clampf(0.5 + (b_in - a_in) * 1.1, 0.0, 1.0)
	return out


static func zone_of(d: float) -> int:
	if d < 0.0:
		return ZONE_ROAD
	if d < CURB_W:
		return ZONE_CURB
	if d < CURB_W + SIDEWALK_W:
		return ZONE_SIDEWALK
	return ZONE_BLOCK


## District of block cell (ix, jz) — macro cells of 3×3 blocks.
static func district_of(ix: int, jz: int) -> int:
	var mi := floori(ix / 3.0)
	var mj := floori(jz / 3.0)
	# the spawn neighbourhood is always the lively commercial mix
	if mi >= -1 and mi <= 0 and mj >= -1 and mj <= 0:
		return DISTRICT_COMMERCIAL
	var r := cell_seed(mi, mj, 977)
	if r < 0.22:
		return DISTRICT_DOWNTOWN
	if r < 0.52:
		return DISTRICT_COMMERCIAL
	if r < 0.76:
		return DISTRICT_RESIDENTIAL
	if r < 0.88:
		return DISTRICT_INDUSTRIAL
	return DISTRICT_COUNTRYSIDE


## Height bias 0..1 that clusters at macro scale.
static func district_height_bias(ix: int, jz: int) -> float:
	var mi := floori(ix / 3.0)
	var mj := floori(jz / 3.0)
	return 0.55 * cell_seed(mi, mj, 31) + 0.45 * cell_seed(ix, jz, 5)


# --- Street thinning (mirrored EXACTLY in ground.gdshader) -----------------

static func _ns_drop_cand(i: int, jc: int) -> bool:
	var p := 0.16 + 0.34 * cell_seed(floori(i / 3.0), floori(jc / 3.0), 611)
	return cell_seed(i, jc, 271) < p

static func _ns_drop_raw(i: int, jc: int) -> bool:
	return _ns_drop_cand(i, jc) and not _ns_drop_cand(i, jc - 1)


## True when the N-S street at col i exists between rows jc and jc+1.
static func ns_seg_present(i: int, jc: int, ctx: PlanCtx) -> bool:
	# the spawn street must always exist (the car boots onto it)
	if i == 0 and (jc == -1 or jc == 0):
		return true
	var key := (i + 32768) * 65536 + (jc + 32768)
	if ctx.memo.has(key):
		return ctx.memo[key]
	var v := not (_ns_drop_raw(i, jc) and not (_ns_drop_raw(i - 1, jc) and _ns_drop_raw(i - 2, jc)))
	if ctx.memo.size() > 8192:
		ctx.memo.clear()
	ctx.memo[key] = v
	return v


## Block cells intersecting a world-space region. Each block sits between
## col ix..ix+1 and row jz..jz+1 (grid-space bounds; warp corners on use).
static func blocks_in_region(min_x: float, max_x: float, min_z: float, max_z: float, ctx: PlanCtx) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var i0 := floori(min_x / PERIOD_X)
	var i1 := ceili(max_x / PERIOD_X)
	var j0 := floori(min_z / PERIOD_Z)
	var j1 := ceili(max_z / PERIOD_Z)
	for j in range(j0, j1):
		# a run may be anchored up to 2 cols left of the region (3-cell cap)
		var i := i0
		var guard := 0
		while not ns_seg_present(i, j, ctx) and guard < 8:
			i -= 1
			guard += 1
		while i < i1:
			var span := 1
			while not ns_seg_present(i + span, j, ctx):
				span += 1
			var x0 := i * PERIOD_X + SIDEWALK_EDGE
			var x1 := (i + span) * PERIOD_X - SIDEWALK_EDGE
			var z0 := j * PERIOD_Z + row_sw_edge(j)
			var z1 := (j + 1) * PERIOD_Z - row_sw_edge(j + 1)
			if x1 >= min_x and x0 <= max_x:
				out.append({
					"ix": i, "ix_end": i + span - 1, "jz": j,
					"x0": x0, "z0": z0, "x1": x1, "z1": z1,
					"seed": cell_seed(i, j),
				})
			i += span
	return out


## Street segments (between crossings) intersecting a region. Each:
## {axis: 0|1, line, center, s0, s1, mway}. Grid-space coordinates.
static func segments_in_region(min_x: float, max_x: float, min_z: float, max_z: float, ctx: PlanCtx) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var i0 := floori(min_x / PERIOD_X)
	var i1 := ceili(max_x / PERIOD_X)
	var j0 := floori(min_z / PERIOD_Z)
	var j1 := ceili(max_z / PERIOD_Z)
	# N-S streets: cols i0..i1, pieces between rows (thinned segments skipped)
	for i in range(i0, i1 + 1):
		var cx := i * PERIOD_X
		if cx + CURB_FACE < min_x or cx - CURB_FACE > max_x:
			continue
		for j in range(j0, j1):
			if not ns_seg_present(i, j, ctx):
				continue
			var s0 := j * PERIOD_Z + row_face(j)
			var s1 := (j + 1) * PERIOD_Z - row_face(j + 1)
			if s1 < min_z or s0 > max_z or s1 - s0 < 1.0:
				continue
			out.append({"axis": 0, "line": i, "center": cx, "s0": s0, "s1": s1, "mway": false})
	# E-W streets: rows j0..j1, pieces between cols
	for j in range(j0, j1 + 1):
		var cz := j * PERIOD_Z
		var face := row_face(j)
		if cz + face < min_z or cz - face > max_z:
			continue
		for i in range(i0, i1):
			var s0 := i * PERIOD_X + CURB_FACE
			var s1 := (i + 1) * PERIOD_X - CURB_FACE
			if s1 < min_x or s0 > max_x or s1 - s0 < 1.0:
				continue
			out.append({"axis": 1, "line": j, "center": cz, "s0": s0, "s1": s1, "mway": row_is_motorway(j)})
	return out


## Crossings (i, j) intersecting a region, with arm presence flags.
static func crossings_in_region(min_x: float, max_x: float, min_z: float, max_z: float, ctx: PlanCtx) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var i0 := roundi(min_x / PERIOD_X)
	var i1 := roundi(max_x / PERIOD_X)
	var j0 := roundi(min_z / PERIOD_Z)
	var j1 := roundi(max_z / PERIOD_Z)
	for i in range(i0, i1 + 1):
		for j in range(j0, j1 + 1):
			out.append({
				"i": i, "j": j, "x": i * PERIOD_X, "z": j * PERIOD_Z,
				"mway": row_is_motorway(j),
				"arm_n": ns_seg_present(i, j, ctx), "arm_s": ns_seg_present(i, j - 1, ctx),
			})
	return out
