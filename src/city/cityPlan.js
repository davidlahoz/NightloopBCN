/**
 * NIGHTLOOP city plan — the single source of truth for street layout.
 *
 * The city is a 3×3 axis-aligned street grid enclosing four blocks, driven as
 * a loop. Axis alignment gives an *exact* analytic mapping from world position
 * to road space (s = along street, t = across street) — the road shader uses
 * it per-pixel for lane wear, markings and gutters, and the CPU uses the same
 * math for wheel contacts and mesh baking.
 *
 * Zones by signed distance d from the curb face line (negative = on asphalt):
 *   d < 0            carriageway + gutter (gutter is the last 0.45 m)
 *   0 ≤ d < 0.15     curb (rolled top)
 *   0.15 ≤ d < 3.0   sidewalk (tilts toward the street)
 *   d ≥ 3.0          block interior
 *
 * All queries are allocation-free: results are written into caller-provided
 * or module-scope scratch objects.
 */

export const STREETS_X = [-100, 0, 100]; // N-S streets (run along Z), centerline x
export const STREETS_Z = [-80, 0, 80];   // E-W streets (run along X), centerline z
export const ROAD_HALF = 4.0;            // centerline → gutter start
export const GUTTER_W = 0.45;
export const CURB_FACE = ROAD_HALF + GUTTER_W;  // 4.45 curb face line
export const CURB_W = 0.15;
export const CURB_H = 0.13;
export const SIDEWALK_W = 2.85;
export const SIDEWALK_EDGE = CURB_FACE + CURB_W + SIDEWALK_W; // 7.45
export const CORNER_R = 5.5;             // curb fillet radius at intersections
export const EXTENT_X = 136;             // E-W streets span x ∈ [-EXTENT_X, EXTENT_X]
export const EXTENT_Z = 116;             // N-S streets span z ∈ [-EXTENT_Z, EXTENT_Z]

export const ZONE_ROAD = 0;
export const ZONE_CURB = 1;
export const ZONE_SIDEWALK = 2;
export const ZONE_BLOCK = 3;

/** Distance from x to the nearest N-S street centerline (signed t) and its index. */
export function nearestStreetX(x) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < STREETS_X.length; i++) {
    const d = Math.abs(x - STREETS_X[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
export function nearestStreetZ(z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < STREETS_Z.length; i++) {
    const d = Math.abs(z - STREETS_Z[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Road-space sample. Fills `out` with:
 *  iA, tA  — nearest N-S street index and lateral offset (x - centerX)
 *  iB, tB  — nearest E-W street index and lateral offset (z - centerZ)
 *  dA, dB  — per-street SDF beyond curb face (end caps included)
 *  d       — combined SDF (fillet-rounded union), <0 on asphalt
 *  wB      — 0..1 dominance of the E-W street (0 = N-S dominates)
 */
export function sampleRoadSpace(x, z, out) {
  const iA = nearestStreetX(x);
  const iB = nearestStreetZ(z);
  const tA = x - STREETS_X[iA];
  const tB = z - STREETS_Z[iB];
  let dA = Math.abs(tA) - CURB_FACE;
  let dB = Math.abs(tB) - CURB_FACE;
  // finite street end caps
  const endA = Math.abs(z) - EXTENT_Z;
  const endB = Math.abs(x) - EXTENT_X;
  if (endA > dA) dA = endA;
  if (endB > dB) dB = endB;

  // union with concave fillet radius CORNER_R
  let d = dA < dB ? dA : dB;
  if (dA < CORNER_R && dB < CORNER_R && dA > 0 && dB > 0) {
    const fx = CORNER_R - dA, fz = CORNER_R - dB;
    const fd = CORNER_R - Math.hypot(fx, fz);
    if (fd < d) d = fd;
  }

  out.iA = iA; out.tA = tA; out.dA = dA;
  out.iB = iB; out.tB = tB; out.dB = dB;
  out.d = d;
  // dominance: which street "owns" longitudinal features here
  const aIn = CURB_FACE - Math.abs(tA); // >0 inside N-S street width
  const bIn = CURB_FACE - Math.abs(tB);
  let wB = 0.5 + (bIn - aIn) * 0.25;
  out.wB = wB < 0 ? 0 : wB > 1 ? 1 : wB;
  return out;
}

/** Scratch for internal callers. */
export const rsScratch = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };

export function zoneOf(d) {
  if (d < 0) return ZONE_ROAD;
  if (d < CURB_W) return ZONE_CURB;
  if (d < CURB_W + SIDEWALK_W) return ZONE_SIDEWALK;
  return ZONE_BLOCK;
}

/**
 * The four inner blocks plus the ring of outer blocks, as rectangles
 * {x0,z0,x1,z1} of buildable area (sidewalk outer edge to sidewalk outer edge).
 * Outer blocks extend toward the world edge for skyline transition.
 */
export function blockRects() {
  const xs = [-260, ...STREETS_X, 260];
  const zs = [-220, ...STREETS_Z, 220];
  const rects = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = (i === 0 ? xs[i] : xs[i] + SIDEWALK_EDGE);
      const x1 = (i === xs.length - 2 ? xs[i + 1] : xs[i + 1] - SIDEWALK_EDGE);
      const z0 = (j === 0 ? zs[j] : zs[j] + SIDEWALK_EDGE);
      const z1 = (j === zs.length - 2 ? zs[j + 1] : zs[j + 1] - SIDEWALK_EDGE);
      if (x1 - x0 < 12 || z1 - z0 < 12) continue;
      rects.push({
        x0, z0, x1, z1,
        inner: i > 0 && i < xs.length - 2 && j > 0 && j < zs.length - 2,
      });
    }
  }
  return rects;
}

/**
 * Street segments between intersections (for chunked road meshes, curbs, props).
 * Each: {axis: 0|1, index, center, s0, s1} where s is z for axis 0 (N-S street)
 * and x for axis 1. Segments stop CURB_FACE short of crossing centerlines.
 */
export function streetSegments() {
  const segs = [];
  for (let i = 0; i < STREETS_X.length; i++) {
    const cx = STREETS_X[i];
    const cuts = [-EXTENT_Z, ...STREETS_Z, EXTENT_Z];
    for (let j = 0; j < cuts.length - 1; j++) {
      const s0 = cuts[j] + (j === 0 ? 0 : CURB_FACE);
      const s1 = cuts[j + 1] - (j === cuts.length - 2 ? 0 : CURB_FACE);
      if (s1 - s0 > 1) segs.push({ axis: 0, index: i, center: cx, s0, s1 });
    }
  }
  for (let i = 0; i < STREETS_Z.length; i++) {
    const cz = STREETS_Z[i];
    const cuts = [-EXTENT_X, ...STREETS_X, EXTENT_X];
    for (let j = 0; j < cuts.length - 1; j++) {
      const s0 = cuts[j] + (j === 0 ? 0 : CURB_FACE);
      const s1 = cuts[j + 1] - (j === cuts.length - 2 ? 0 : CURB_FACE);
      if (s1 - s0 > 1) segs.push({ axis: 1, index: i, center: cz, s0, s1 });
    }
  }
  return segs;
}

/** All intersection centers {x, z}. */
export function intersections() {
  const list = [];
  for (const sx of STREETS_X) for (const sz of STREETS_Z) list.push({ x: sx, z: sz });
  return list;
}
