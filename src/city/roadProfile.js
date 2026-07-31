/**
 * Ground heightfield — crown, camber, gutters, curbs, sidewalks, settling,
 * wheel-track rutting, and the motorway's carriageway crossfall + raised
 * centre median. Single source of truth for:
 *   - road chunk mesh baking (LOD grids sample this)
 *   - wheel contact queries (vehicle suspension)
 *   - prop/building placement
 *
 * Zone seams are exact: the road mesh (d<0), curb strip (0..CURB_W) and
 * sidewalk (CURB_W..) are built by different modules and MUST agree at their
 * shared borders.
 */
import {
  CURB_FACE, CURB_W, CURB_H, SIDEWALK_W, ROAD_HALF, GUTTER_W,
  MWAY_FACE, MWAY_HALF, MWAY_MEDIAN,
  sampleRoadSpace, rsScratch,
} from './cityPlan.js';
import { fbm3, valueNoise } from './noise.js';

export const CROWN_H = 0.055;        // crown rise at centreline (normal street)
export const GUTTER_DIP = 0.022;     // gutter channel depth below road edge
const SETTLE_AMP = 0.028;            // low-frequency settling
const SETTLE_FREQ = 0.085;
const FINE_AMP = 0.007;              // finer undulation
const FINE_FREQ = 0.42;
const RUT_DEPTH = 0.007;             // wheel-track depressions
const SIDEWALK_TILT = 0.014;         // rises away from curb
export const MEDIAN_H = 0.13;        // motorway centre island height
export const BLOCK_H = CURB_H + SIDEWALK_W * SIDEWALK_TILT + 0.02;

/** Gutter channel shape for the band [face-GUTTER_W, face]. */
function gutterDip(at, face) {
  if (at <= face - GUTTER_W) return 0;
  const g = (at - (face - GUTTER_W)) / GUTTER_W; // 0..1 across gutter
  return -GUTTER_DIP * (g < 0.75 ? g / 0.75 : 0.85 + (1 - g) / 0.25 * 0.15);
}

/** Normal street crown/gutter profile; input clamped to the curb face. */
export function crossProfile(atIn) {
  const at = atIn > CURB_FACE ? CURB_FACE : atIn;
  const tc = at > ROAD_HALF ? ROAD_HALF : at;
  return CROWN_H * (1 - (tc / ROAD_HALF) * (tc / ROAD_HALF)) + gutterDip(at, CURB_FACE);
}

/**
 * Motorway profile: raised median island, per-carriageway crossfall, gutter.
 * islandScale gates the raised island down to a flat 7.5 cm plateau near
 * junctions so crossing traffic never mounts a hump (matches the shader's
 * intT-gated median mask).
 */
export function mwayProfile(atIn, islandScale = 1) {
  const at = atIn > MWAY_FACE ? MWAY_FACE : atIn;
  if (at < MWAY_MEDIAN) {
    // raised island with rounded shoulders
    const s = Math.min(1, (MWAY_MEDIAN - at) / 0.35);
    return 0.075 + MEDIAN_H * (s * s * (3 - 2 * s)) * islandScale;
  }
  // linear crossfall from the median edge down toward the outer gutter
  const run = (at - MWAY_MEDIAN) / (MWAY_HALF - MWAY_MEDIAN); // 0..1
  return 0.075 * (1 - run) + gutterDip(at, MWAY_FACE);
}

/** Wheel-track rutting for a normal street (two lanes, tracks |t|=1.2, 2.8). */
function rutProfile(at) {
  const d1 = at - 1.2, d2 = at - 2.8;
  return (Math.exp(-d1 * d1 * 8.16) + Math.exp(-d2 * d2 * 8.16)) * RUT_DEPTH;
}

function settleAt(x, z) {
  return (
    SETTLE_AMP * (fbm3(x * SETTLE_FREQ, z * SETTLE_FREQ) - 0.5) * 2 +
    FINE_AMP * (valueNoise(x * FINE_FREQ, z * FINE_FREQ) - 0.5) * 2
  );
}

function wobbleAt(x, z) {
  return 0.004 * (valueNoise(x * 0.6 + 31.7, z * 0.6 + 11.3) - 0.5) * 2;
}

/**
 * Ground height at world (x, z). Allocation-free.
 * @returns {number} y in metres
 */
export function groundHeight(x, z) {
  const rs = sampleRoadSpace(x, z, rsScratch);
  const d = rs.d;
  const settle = settleAt(x, z);

  if (d < 0) {
    const atA = Math.abs(rs.tA), atB = Math.abs(rs.tB);
    const inA = atA < rs.faceA;
    const inB = atB < rs.faceB;
    const hA = inA ? crossProfile(atA) - rutProfile(atA) * (1 - rs.wB) : -1;
    let hB = -1;
    if (inB) {
      if (rs.mwayB) {
        // island fades out across the junction (|tA| 0.6..2.6 beyond the face)
        let g = (atA - rs.faceA - 0.6) / 2.0;
        g = g < 0 ? 0 : g > 1 ? 1 : g;
        hB = mwayProfile(atB, g * g * (3 - 2 * g));
      } else {
        hB = crossProfile(atB) - rutProfile(atB) * rs.wB;
      }
    }
    return (hA > hB ? hA : hB) + settle;

  } else if (d < CURB_W) {
    // rolled curb, gutter bottom → curb top; endpoints match both neighbours
    const edgeProfile = rs.mwayB && rs.dB < rs.dA ? mwayProfile(MWAY_FACE) : crossProfile(CURB_FACE);
    const edgeH = edgeProfile + settle;                      // == road branch at d=0
    const topH = CURB_H + wobbleAt(x, z) + settle * 0.35;    // == sidewalk branch at d=CURB_W
    const s = d / CURB_W;
    const rise = s * s * (3 - 2 * s);
    return edgeH + (topH - edgeH) * Math.pow(rise, 0.8);

  } else if (d < CURB_W + SIDEWALK_W) {
    const ds = d - CURB_W;
    return CURB_H + ds * SIDEWALK_TILT + wobbleAt(x, z) + settle * 0.35;

  } else {
    return BLOCK_H + settle * 0.25;
  }
}

/**
 * Ground normal by central differences (for prop alignment; meshes bake their
 * own). Writes into out {x,y,z}, normalised.
 */
export function groundNormal(x, z, eps, out) {
  const hx1 = groundHeight(x + eps, z), hx0 = groundHeight(x - eps, z);
  const hz1 = groundHeight(x, z + eps), hz0 = groundHeight(x, z - eps);
  const nx = -(hx1 - hx0) / (2 * eps), nz = -(hz1 - hz0) / (2 * eps), ny = 1;
  const il = 1 / Math.hypot(nx, ny, nz);
  out.x = nx * il; out.y = ny * il; out.z = nz * il;
  return out;
}
