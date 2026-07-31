/**
 * NIGHTLOOP city plan — the single source of truth for street layout.
 *
 * The city is an INFINITE periodic grid: N-S streets every PERIOD_X metres,
 * E-W streets every PERIOD_Z metres. Every 4th E-W row (j ≡ 2 mod 4) is a
 * MOTORWAY: a wide dual carriageway with a raised centre median. Axis
 * alignment gives an exact analytic mapping from world position to road
 * space (s along, t across) — the road shader mirrors this math per-pixel
 * (src/shaders/road.fragment.wgsl MUST stay in sync).
 *
 * Zones by signed distance d from the curb face line (negative = on asphalt):
 *   d < 0            carriageway + gutter (gutter is the last 0.45 m)
 *   0 ≤ d < 0.15     curb (rolled top)
 *   0.15 ≤ d < 3.0   sidewalk (tilts toward the street)
 *   d ≥ 3.0          block interior
 *
 * All queries are allocation-free.
 */

export const PERIOD_X = 200;     // N-S street spacing (streets run along Z)
export const PERIOD_Z = 160;     // E-W street spacing (streets run along X)
export const MWAY_MOD = 4;       // every 4th E-W row…
export const MWAY_REM = 2;       // …with row index ≡ 2 (mod 4) is a motorway

export const ROAD_HALF = 4.0;            // normal street: centre → gutter start
export const GUTTER_W = 0.45;
export const CURB_FACE = ROAD_HALF + GUTTER_W;   // 4.45 normal curb face
export const CURB_W = 0.15;
export const CURB_H = 0.13;
export const SIDEWALK_W = 2.85;
export const SIDEWALK_EDGE = CURB_FACE + CURB_W + SIDEWALK_W; // 7.45 (normal)
export const CORNER_R = 5.5;             // curb fillet radius at crossings

// motorway row geometry
export const MWAY_HALF = 12.0;           // centre → gutter start
export const MWAY_FACE = MWAY_HALF + GUTTER_W;   // 12.45 curb face
export const MWAY_MEDIAN = 1.0;          // raised centre island half-width
export const MWAY_LANE_W = 3.5;          // three lanes per carriageway

export const ZONE_ROAD = 0;
export const ZONE_CURB = 1;
export const ZONE_SIDEWALK = 2;
export const ZONE_BLOCK = 3;

/** Row index of the E-W street nearest to z. */
export function rowIndex(z) {
  return Math.round(z / PERIOD_Z);
}
/** Column index of the N-S street nearest to x. */
export function colIndex(x) {
  return Math.round(x / PERIOD_X);
}
/** True when E-W row j is a motorway. */
export function rowIsMotorway(j) {
  return ((j % MWAY_MOD) + MWAY_MOD) % MWAY_MOD === MWAY_REM;
}
/** Curb-face half width of E-W row j. */
export function rowFace(j) {
  return rowIsMotorway(j) ? MWAY_FACE : CURB_FACE;
}
/** Sidewalk outer edge of E-W row j (block edge / building line). */
export function rowSwEdge(j) {
  return rowFace(j) + CURB_W + SIDEWALK_W;
}

/**
 * Road-space sample. Fills `out` with:
 *  iA, tA  — nearest N-S street col index and lateral offset (x - centerX)
 *  iB, tB  — nearest E-W street row index and lateral offset (z - centerZ)
 *  faceA, faceB — curb-face half widths of those two streets
 *  dA, dB  — per-street SDF beyond curb face
 *  d       — combined SDF (fillet-rounded union), <0 on asphalt
 *  wB      — 0..1 dominance of the E-W street
 *  mwayB   — 1 when the E-W street is a motorway
 */
export function sampleRoadSpace(x, z, out) {
  const iA = colIndex(x);
  const iB = rowIndex(z);
  const tA = x - iA * PERIOD_X;
  const tB = z - iB * PERIOD_Z;
  const faceA = CURB_FACE;
  const faceB = rowFace(iB);
  const dA = Math.abs(tA) - faceA;
  const dB = Math.abs(tB) - faceB;

  // union with concave fillet radius CORNER_R
  let d = dA < dB ? dA : dB;
  if (dA < CORNER_R && dB < CORNER_R && dA > 0 && dB > 0) {
    const fx = CORNER_R - dA, fz = CORNER_R - dB;
    const fd = CORNER_R - Math.hypot(fx, fz);
    if (fd < d) d = fd;
  }

  out.iA = iA; out.tA = tA; out.dA = dA; out.faceA = faceA;
  out.iB = iB; out.tB = tB; out.dB = dB; out.faceB = faceB;
  out.d = d;
  out.mwayB = rowIsMotorway(iB) ? 1 : 0;
  // dominance normalised by width so the motorway owns its whole span
  const aIn = (faceA - Math.abs(tA)) / faceA;
  const bIn = (faceB - Math.abs(tB)) / faceB;
  let wB = 0.5 + (bIn - aIn) * 1.1;
  out.wB = wB < 0 ? 0 : wB > 1 ? 1 : wB;
  return out;
}

/** Scratch for internal callers. */
export const rsScratch = {
  iA: 0, tA: 0, dA: 0, faceA: CURB_FACE,
  iB: 0, tB: 0, dB: 0, faceB: CURB_FACE,
  d: 0, wB: 0, mwayB: 0,
};

export function zoneOf(d) {
  if (d < 0) return ZONE_ROAD;
  if (d < CURB_W) return ZONE_CURB;
  if (d < CURB_W + SIDEWALK_W) return ZONE_SIDEWALK;
  return ZONE_BLOCK;
}

/** Deterministic per-cell seed in [0,1). */
export function cellSeed(i, j, salt = 0) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Block cells intersecting a world-space region. Each block sits between
 * col ix..ix+1 and row jz..jz+1. Returns fresh objects (call at region
 * changes only, never per frame).
 */
export function blocksInRegion(minX, maxX, minZ, maxZ) {
  const out = [];
  const i0 = Math.floor(minX / PERIOD_X), i1 = Math.ceil(maxX / PERIOD_X);
  const j0 = Math.floor(minZ / PERIOD_Z), j1 = Math.ceil(maxZ / PERIOD_Z);
  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      const x0 = i * PERIOD_X + SIDEWALK_EDGE;
      const x1 = (i + 1) * PERIOD_X - SIDEWALK_EDGE;
      const z0 = j * PERIOD_Z + rowSwEdge(j);
      const z1 = (j + 1) * PERIOD_Z - rowSwEdge(j + 1);
      if (x1 - x0 < 12 || z1 - z0 < 12) continue;
      out.push({ ix: i, jz: j, x0, z0, x1, z1, seed: cellSeed(i, j) });
    }
  }
  return out;
}

/**
 * Street segments (between crossings) intersecting a region.
 * Each: {axis: 0|1, line, center, s0, s1, mway} — axis 0 = N-S street
 * (s along z), axis 1 = E-W street (s along x). Segment ends stop at the
 * crossing street's curb face.
 */
export function segmentsInRegion(minX, maxX, minZ, maxZ) {
  const out = [];
  const i0 = Math.floor(minX / PERIOD_X), i1 = Math.ceil(maxX / PERIOD_X);
  const j0 = Math.floor(minZ / PERIOD_Z), j1 = Math.ceil(maxZ / PERIOD_Z);
  // N-S streets: cols i0..i1, pieces between rows
  for (let i = i0; i <= i1; i++) {
    const cx = i * PERIOD_X;
    if (cx + CURB_FACE < minX || cx - CURB_FACE > maxX) continue;
    for (let j = j0; j < j1; j++) {
      const s0 = j * PERIOD_Z + rowFace(j);
      const s1 = (j + 1) * PERIOD_Z - rowFace(j + 1);
      if (s1 < minZ || s0 > maxZ || s1 - s0 < 1) continue;
      out.push({ axis: 0, line: i, center: cx, s0, s1, mway: false });
    }
  }
  // E-W streets: rows j0..j1, pieces between cols
  for (let j = j0; j <= j1; j++) {
    const cz = j * PERIOD_Z;
    const face = rowFace(j);
    if (cz + face < minZ || cz - face > maxZ) continue;
    for (let i = i0; i < i1; i++) {
      const s0 = i * PERIOD_X + CURB_FACE;
      const s1 = (i + 1) * PERIOD_X - CURB_FACE;
      if (s1 < minX || s0 > maxX || s1 - s0 < 1) continue;
      out.push({ axis: 1, line: j, center: cz, s0, s1, mway: rowIsMotorway(j) });
    }
  }
  return out;
}

/** Crossings (i, j) intersecting a region, with the E-W row's type. */
export function crossingsInRegion(minX, maxX, minZ, maxZ) {
  const out = [];
  const i0 = Math.round(minX / PERIOD_X), i1 = Math.round(maxX / PERIOD_X);
  const j0 = Math.round(minZ / PERIOD_Z), j1 = Math.round(maxZ / PERIOD_Z);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      out.push({ i, j, x: i * PERIOD_X, z: j * PERIOD_Z, mway: rowIsMotorway(j) });
    }
  }
  return out;
}
