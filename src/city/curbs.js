/**
 * Curbs — the street edge: rolled curbs, sidewalks, dead-end caps, manhole
 * covers and storm-drain grates.
 *
 * Owns the SDF band d ∈ [0, 3.0] around every street (curb 0..0.15, sidewalk
 * 0.15..3.0), built as annular grids that follow the exact curb line the road
 * SDF produces (straights at CURB_FACE, corners as CORNER_R fillet arcs, sharp
 * offset corners at the street dead-ends). Every vertex height comes from
 * groundHeight(), every normal from groundNormal() — this module never invents
 * heights, so it seam-matches the road mesh (d<0) and the block modules (d≥3)
 * by construction.
 *
 * Draw calls: 4 quadrants × {curb concrete, sidewalk paving} = 8, plus one
 * thin-instanced manhole mesh and one thin-instanced drain mesh = 10 total.
 * Everything is static: world matrices frozen, thin-instance buffers static.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import {
  STREETS_X, STREETS_Z, CURB_FACE, CURB_W, CURB_H, SIDEWALK_EDGE,
  CORNER_R, EXTENT_X, EXTENT_Z, blockRects, streetSegments, intersections,
} from './cityPlan.js';
import { groundHeight, groundNormal, crossProfile } from './roadProfile.js';
import { valueNoise, hash2 } from './noise.js';

// ---------------------------------------------------------------------------
// Cross-section stations (metres of SDF distance d from the curb face).
// The last two sidewalk stations straddle the d=3.0 zone boundary by ±3 mm:
// groundHeight() is intentionally discontinuous there (block plinth sits 2 cm
// up) and sampling exactly at 3.0 would flip branches per-vertex on FP noise.
// 2.997 stays branch-stable on the sidewalk side, 3.003 lands branch-stable on
// the block side and seam-matches whatever the block module builds from d=3.
// ---------------------------------------------------------------------------
const CURB_STATIONS = [0, 0.03, 0.07, 0.11, 0.15];
const WALK_STATIONS = [0.15, 0.5, 1.0, 1.6, 2.3, 2.997, 3.003];
const ALL_STATIONS = [0, 0.03, 0.07, 0.11, 0.15, 0.5, 1.0, 1.6, 2.3, 2.997, 3.003];
const STEP_STRAIGHT = 0.4;
const STEP_ARC = 0.12;
const FILLET_C = CURB_FACE + CORNER_R; // curb-line fillet arc center offset (9.95)
const NRM_EPS = 0.04;
const EDGE_EPS = 0.0025;   // tight eps near d=3 so the plinth step doesn't smear normals

// Nominal (noise-free) rolled-curb profile, mirroring roadProfile.js exactly —
// used only to build an unstretched v texture coordinate across the curb roll.
const EDGE_H0 = crossProfile(CURB_FACE);
function nominalCurbH(d) {
  const s = d / CURB_W;
  const rise = s * s * (3 - 2 * s);
  return EDGE_H0 + (CURB_H - EDGE_H0) * Math.pow(rise, 0.8);
}
const CURB_V = (() => {
  const v = [0];
  for (let i = 1; i < CURB_STATIONS.length; i++) {
    v[i] = v[i - 1] + Math.hypot(
      CURB_STATIONS[i] - CURB_STATIONS[i - 1],
      nominalCurbH(CURB_STATIONS[i]) - nominalCurbH(CURB_STATIONS[i - 1]));
  }
  return v;
})();
function curbVOf(d) {
  if (d <= 0) return 0;
  if (d >= CURB_W) return CURB_V[CURB_V.length - 1];
  for (let i = 1; i < CURB_STATIONS.length; i++) {
    if (d <= CURB_STATIONS[i]) {
      const f = (d - CURB_STATIONS[i - 1]) / (CURB_STATIONS[i] - CURB_STATIONS[i - 1]);
      return CURB_V[i - 1] + (CURB_V[i] - CURB_V[i - 1]) * f;
    }
  }
  return CURB_V[CURB_V.length - 1];
}

const _gn = { x: 0, y: 1, z: 0 }; // groundNormal scratch (build-time only)

// ---------------------------------------------------------------------------
// Geometry accumulation. quad() picks triangle winding per-quad by testing the
// geometric face normal against the stored vertex normal, so no band ever ends
// up back-face-culled regardless of path direction.
// ---------------------------------------------------------------------------
class GeoBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.idx = [];
  }
  vcount() { return (this.pos.length / 3) | 0; }
  vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b, 1);
    return ((this.pos.length / 3) | 0) - 1;
  }
  /** Quad from four vertex ids in cyclic order. */
  quad(a, c, d, e) {
    const p = this.pos, n = this.nrm;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    let e1x = p[c * 3] - ax, e1y = p[c * 3 + 1] - ay, e1z = p[c * 3 + 2] - az;
    const e2x = p[d * 3] - ax, e2y = p[d * 3 + 1] - ay, e2z = p[d * 3 + 2] - az;
    let cx = e1y * e2z - e1z * e2y;
    let cy = e1z * e2x - e1x * e2z;
    let cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-16) {
      // first triangle degenerate (e.g. lathe center fan) — test the second
      e1x = p[e * 3] - ax; e1y = p[e * 3 + 1] - ay; e1z = p[e * 3 + 2] - az;
      cx = e2y * e1z - e2z * e1y;
      cy = e2z * e1x - e2x * e1z;
      cz = e2x * e1y - e2y * e1x;
    }
    // Babylon (LH) front faces have the RH-rule cross product OPPOSITE the
    // visible normal (verified against CreateGround's index order).
    const dot = cx * n[a * 3] + cy * n[a * 3 + 1] + cz * n[a * 3 + 2];
    if (dot <= 0) this.idx.push(a, c, d, a, d, e);
    else this.idx.push(a, d, c, a, e, d);
  }
  gridQuads(base, m, s) {
    for (let i = 0; i + 1 < m; i++) {
      for (let j = 0; j + 1 < s; j++) {
        this.quad(base + i * s + j, base + (i + 1) * s + j,
          base + (i + 1) * s + j + 1, base + i * s + j + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grime — baked as vertex colour (PBR multiplies albedo by vColor). Darker at
// the curb line / gutter splash zone, per-slab patchiness on the sidewalk.
// ---------------------------------------------------------------------------
function grimeAt(x, z, d, isCurb) {
  let g;
  if (isCurb) g = 0.60 + 1.55 * d;                    // 0.60 at gutter → 0.83 at curb top
  else g = 1 - 0.22 * Math.exp(-(d - CURB_W) * 1.9);  // fades with distance from curb
  g += (valueNoise(x * 0.57 + 13.7, z * 0.57 + 41.2) - 0.5) * 0.13;
  if (!isCurb) g += (hash2(Math.floor(x * 0.667) | 0, Math.floor(z * 0.667) | 0) - 0.5) * 0.07;
  return g < 0.3 ? 0.3 : g > 1 ? 1 : g;
}

function emitGroundVertex(b, x, z, d, u, v, isCurb) {
  const y = groundHeight(x, z);
  groundNormal(x, z, d > 2.9 ? EDGE_EPS : NRM_EPS, _gn);
  const g = grimeAt(x, z, d, isCurb);
  return b.vert(x, y, z, _gn.x, _gn.y, _gn.z, u, v, g, g * 0.985, g * 0.955);
}

// ---------------------------------------------------------------------------
// Curb-line path construction. Path points sit exactly on the d=0 contour with
// normals pointing toward increasing d (into the block); offsetting by d along
// the normal reproduces the SDF contours exactly (straights are linear,
// fillet-arc contours are concentric circles of radius CORNER_R - d).
// ---------------------------------------------------------------------------
function addStraight(pts, x0, z0, x1, z1, nx, nz, u0, skipFirst) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(len / STEP_STRAIGHT));
  for (let k = skipFirst ? 1 : 0; k <= n; k++) {
    const f = k / n;
    pts.push({ x: x0 + dx * f, z: z0 + dz * f, nx, nz, u: u0 + len * f });
  }
  return u0 + len;
}

function addArc(pts, cx, cz, a0, a1, u0, skipFirst) {
  let da = a1 - a0;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  const alen = Math.abs(da) * CORNER_R;
  const n = Math.max(1, Math.ceil(alen / STEP_ARC));
  for (let k = skipFirst ? 1 : 0; k <= n; k++) {
    const a = a0 + da * (k / n);
    const co = Math.cos(a), si = Math.sin(a);
    pts.push({
      x: cx + co * CORNER_R, z: cz + si * CORNER_R,
      nx: -co, nz: -si,                    // toward the arc center = increasing d
      u: u0 + alen * (k / n),
    });
  }
  return u0 + alen;
}

function emitBand(qc, qw, pts) {
  emitStrip(qc, pts, CURB_STATIONS, true);
  emitStrip(qw, pts, WALK_STATIONS, false);
}

function emitStrip(b, pts, stations, isCurb) {
  const s = stations.length;
  const base = b.vcount();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (let j = 0; j < s; j++) {
      const d = stations[j];
      emitGroundVertex(b, p.x + p.nx * d, p.z + p.nz * d, d, p.u, isCurb ? CURB_V[j] : d, isCurb);
    }
  }
  b.gridQuads(base, pts.length, s);
}

function nearStreet(v, arr) {
  for (let i = 0; i < arr.length; i++) if (Math.abs(v - arr[i]) < 0.75) return arr[i];
  return null;
}

/**
 * One block's curb/sidewalk band. Sides in cyclic order S, E, N, W; sides that
 * face a street get a straight, street-street corners get the CORNER_R fillet
 * arc, sides that run out to a street dead-end terminate exactly on the
 * |x|=EXTENT_X / |z|=EXTENT_Z end line (the end assemblies continue from there).
 */
function buildBlockBand(qc, qw, rect) {
  const w = nearStreet(rect.x0 - SIDEWALK_EDGE, STREETS_X);
  const e = nearStreet(rect.x1 + SIDEWALK_EDGE, STREETS_X);
  const s = nearStreet(rect.z0 - SIDEWALK_EDGE, STREETS_Z);
  const n = nearStreet(rect.z1 + SIDEWALK_EDGE, STREETS_Z);
  const sides = [
    s === null ? null : {
      x0: w !== null ? w + FILLET_C : -EXTENT_X, z0: s + CURB_FACE,
      x1: e !== null ? e - FILLET_C : EXTENT_X, z1: s + CURB_FACE, nx: 0, nz: 1,
    },
    e === null ? null : {
      x0: e - CURB_FACE, z0: s !== null ? s + FILLET_C : -EXTENT_Z,
      x1: e - CURB_FACE, z1: n !== null ? n - FILLET_C : EXTENT_Z, nx: -1, nz: 0,
    },
    n === null ? null : {
      x0: e !== null ? e - FILLET_C : EXTENT_X, z0: n - CURB_FACE,
      x1: w !== null ? w + FILLET_C : -EXTENT_X, z1: n - CURB_FACE, nx: 0, nz: -1,
    },
    w === null ? null : {
      x0: w + CURB_FACE, z0: n !== null ? n - FILLET_C : EXTENT_Z,
      x1: w + CURB_FACE, z1: s !== null ? s + FILLET_C : -EXTENT_Z, nx: 1, nz: 0,
    },
  ];
  let count = 0;
  for (let k = 0; k < 4; k++) if (sides[k]) count++;
  if (count === 0) return;
  const closed = count === 4;
  let start = 0;
  if (!closed) {
    for (let k = 0; k < 4; k++) {
      if (sides[k] && !sides[(k + 3) % 4]) { start = k; break; }
    }
  }
  const pts = [];
  let u = 0;
  for (let step = 0; step < count; step++) {
    const sd = sides[(start + step) % 4];
    u = addStraight(pts, sd.x0, sd.z0, sd.x1, sd.z1, sd.nx, sd.nz, u, pts.length > 0);
    if (step < count - 1 || closed) {
      // next existing side is cyclically adjacent by construction
      let m = (start + step + 1) % 4;
      while (!sides[m]) m = (m + 1) % 4;
      const nxt = sides[m];
      const ccx = sd.x1 + sd.nx * CORNER_R, ccz = sd.z1 + sd.nz * CORNER_R;
      const a0 = Math.atan2(sd.z1 - ccz, sd.x1 - ccx);
      const a1 = Math.atan2(nxt.z0 - ccz, nxt.x0 - ccx);
      u = addArc(pts, ccx, ccz, a0, a1, u, true);
    }
  }
  emitBand(qc, qw, pts);
}

// ---------------------------------------------------------------------------
// Street dead-ends. The SDF end cap is max(|t|-CURB_FACE, |along|-EXTENT), so
// the sidewalk runs straight across the end and the two outer corners are
// sharp with d = max(a, b) — meshed as tensor grids in (a, b) with the same
// station spacing as the strips, so every shared edge is vertex-exact.
// ---------------------------------------------------------------------------
function buildEnd(qc, qw, axis, c, e) {
  const pts = [];
  if (axis === 0) {
    addStraight(pts, c - CURB_FACE, e * EXTENT_Z, c + CURB_FACE, e * EXTENT_Z, 0, e, 0, false);
  } else {
    addStraight(pts, e * EXTENT_X, c - CURB_FACE, e * EXTENT_X, c + CURB_FACE, e, 0, 0, false);
  }
  emitBand(qc, qw, pts);
  emitEndSkirt(qc, axis, c, e);
  emitEndCorner(qc, qw, axis, c, e, -1);
  emitEndCorner(qc, qw, axis, c, e, 1);
}

/**
 * Vertical asphalt-slab face across a dead end: groundHeight() drops from the
 * road crown to the gutter level at the cap line, and the road module's cap
 * edge may leave that face open. Placed 3 mm beyond the end line so it never
 * z-fights a road-side cap face if one exists.
 */
function emitEndSkirt(b, axis, c, e) {
  const n = Math.ceil((2 * CURB_FACE) / STEP_STRAIGHT);
  const base = b.vcount();
  for (let k = 0; k <= n; k++) {
    const t = -CURB_FACE + (2 * CURB_FACE) * (k / n);
    let x, z, xi, zi, nx, nz;
    if (axis === 0) {
      x = c + t; z = e * (EXTENT_Z + 0.003); xi = x; zi = e * (EXTENT_Z - 0.01); nx = 0; nz = e;
    } else {
      z = c + t; x = e * (EXTENT_X + 0.003); zi = z; xi = e * (EXTENT_X - 0.01); nx = e; nz = 0;
    }
    const yb = groundHeight(x, z);
    let yt = groundHeight(xi, zi);
    if (yt < yb + 0.001) yt = yb + 0.001;
    b.vert(x, yb, z, nx, 0, nz, t, 0, 0.40, 0.395, 0.385);
    b.vert(x, yt, z, nx, 0, nz, t, yt - yb, 0.62, 0.61, 0.595);
  }
  for (let k = 0; k < n; k++) {
    b.quad(base + k * 2, base + (k + 1) * 2, base + (k + 1) * 2 + 1, base + k * 2 + 1);
  }
}

function emitEndCorner(bC, bW, axis, c, e, s) {
  let ox, oz, axx, axz, bxx, bxz;
  if (axis === 0) { ox = c + s * CURB_FACE; oz = e * EXTENT_Z; axx = 0; axz = e; bxx = s; bxz = 0; }
  else { ox = e * EXTENT_X; oz = c + s * CURB_FACE; axx = e; axz = 0; bxx = 0; bxz = s; }
  const st = ALL_STATIONS, ns = st.length;

  // curb sub-square: d = max(a,b) < CURB_W ⇔ both a,b ≤ 0.15 (stations 0..4)
  const baseC = bC.vcount();
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const a = st[i], bb = st[j], d = Math.max(a, bb);
      const x = ox + axx * a + bxx * bb, z = oz + axz * a + bxz * bb;
      const y = groundHeight(x, z);
      groundNormal(x, z, NRM_EPS, _gn);
      const g = grimeAt(x, z, d, true);
      bC.vert(x, y, z, _gn.x, _gn.y, _gn.z, a, curbVOf(d), g, g * 0.985, g * 0.955);
    }
  }
  bC.gridQuads(baseC, 5, 5);

  // sidewalk: full grid, indices only for cells outside the curb sub-square
  const baseW = bW.vcount();
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < ns; j++) {
      const a = st[i], bb = st[j], d = Math.max(a, bb);
      const x = ox + axx * a + bxx * bb, z = oz + axz * a + bxz * bb;
      const y = groundHeight(x, z);
      groundNormal(x, z, d > 2.9 ? EDGE_EPS : NRM_EPS, _gn);
      const g = grimeAt(x, z, d, false);
      bW.vert(x, y, z, _gn.x, _gn.y, _gn.z, a, bb, g, g * 0.985, g * 0.955);
    }
  }
  for (let i = 0; i + 1 < ns; i++) {
    for (let j = 0; j + 1 < ns; j++) {
      if (i < 4 && j < 4) continue;
      bW.quad(baseW + i * ns + j, baseW + (i + 1) * ns + j,
        baseW + (i + 1) * ns + j + 1, baseW + i * ns + j + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Manhole cover — lathe profile (r, y, grime), 48 segments. Machined rings and
// a dark cover/frame gap groove; the rim stands ~9 mm proud and the outer
// bevel buries itself in the asphalt. NOTE (deviation): the brief asks for the
// cover 6 mm BELOW groundHeight, but the road mesh is continuous asphalt over
// d<0 — anything below it is z-occluded and invisible. The relief is kept
// (plate 6 mm below rim) with the whole assembly floated just proud instead.
// ---------------------------------------------------------------------------
const MH_PROFILE = [
  [0.000, 0.0020, 0.100, 0.0016, 1.00, 1.00],
  [0.100, 0.0016, 0.113, -0.0022, 0.55, 0.40],
  [0.113, -0.0022, 0.137, -0.0022, 0.40, 0.40],
  [0.137, -0.0022, 0.150, 0.0013, 0.40, 0.55],
  [0.150, 0.0013, 0.220, 0.0008, 1.00, 1.00],
  [0.220, 0.0008, 0.233, -0.0024, 0.55, 0.40],
  [0.233, -0.0024, 0.257, -0.0024, 0.40, 0.40],
  [0.257, -0.0024, 0.270, 0.0005, 0.40, 0.55],
  [0.270, 0.0005, 0.300, 0.0000, 1.00, 0.95],
  [0.300, 0.0000, 0.302, -0.0090, 0.35, 0.15],
  [0.302, -0.0090, 0.318, -0.0090, 0.12, 0.12],
  [0.318, -0.0090, 0.320, 0.0048, 0.15, 0.75],
  [0.320, 0.0048, 0.350, 0.0052, 0.95, 0.95],
  [0.350, 0.0052, 0.380, -0.0100, 0.85, 0.60],
];
const MH_SEG = 48;
const MH_FRAC = [0.32, 0.58, 0.44, 0.70, 0.26];
const MH_T = [1.2, -2.8, 2.0, -1.2, 2.8, -2.0, 1.6, -2.4, 1.2, -2.8];

function buildManholeGeometry(b) {
  for (let p = 0; p < MH_PROFILE.length; p++) {
    const [r0, y0, r1, y1, g0, g1] = MH_PROFILE[p];
    const il = 1 / Math.hypot(r1 - r0, y1 - y0);
    const nr = -(y1 - y0) * il, ny = (r1 - r0) * il;
    const base = b.vcount();
    for (let ring = 0; ring < 2; ring++) {
      const r = ring ? r1 : r0, y = ring ? y1 : y0, g = ring ? g1 : g0;
      for (let k = 0; k < MH_SEG; k++) {
        const a = (k / MH_SEG) * Math.PI * 2;
        const co = Math.cos(a), si = Math.sin(a);
        b.vert(r * co, y, r * si, nr * co, ny, nr * si, r * co, r * si, g, g, g * 1.02);
      }
    }
    for (let k = 0; k < MH_SEG; k++) {
      const k2 = (k + 1) % MH_SEG;
      b.quad(base + k, base + k2, base + MH_SEG + k2, base + MH_SEG + k);
    }
  }
}

// ---------------------------------------------------------------------------
// Storm-drain grate 0.7×0.4, geometric slots (real depth, near-black floors)
// so it reads as cast iron at 3 m. Long axis local +x; instances yaw 90° on
// N-S streets. Top plane local y=0, apron edges bury below the asphalt.
// ---------------------------------------------------------------------------
const DR_SLOTS = [[-0.17, -0.13], [-0.095, -0.055], [-0.02, 0.02], [0.055, 0.095], [0.13, 0.17]];
const DR_BARS = [[-0.13, -0.095], [-0.055, -0.02], [0.02, 0.055], [0.095, 0.13]];
const DR_DEPTH = 0.009;

function drQuad(b, pts, nx, ny, nz, g) {
  const base = b.vcount();
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const u = Math.abs(ny) > 0.5 ? p[0] : p[0] + p[2];
    const v = Math.abs(ny) > 0.5 ? p[2] : p[1];
    b.vert(p[0], p[1], p[2], nx, ny, nz, u, v, g, g, g * 1.02);
  }
  b.quad(base, base + 1, base + 2, base + 3);
}

function buildDrainGeometry(b) {
  // frame top ring
  drQuad(b, [[-0.35, 0, 0.17], [0.35, 0, 0.17], [0.35, 0, 0.20], [-0.35, 0, 0.20]], 0, 1, 0, 1.0);
  drQuad(b, [[-0.35, 0, -0.20], [0.35, 0, -0.20], [0.35, 0, -0.17], [-0.35, 0, -0.17]], 0, 1, 0, 1.0);
  drQuad(b, [[-0.35, 0, -0.17], [-0.32, 0, -0.17], [-0.32, 0, 0.17], [-0.35, 0, 0.17]], 0, 1, 0, 1.0);
  drQuad(b, [[0.32, 0, -0.17], [0.35, 0, -0.17], [0.35, 0, 0.17], [0.32, 0, 0.17]], 0, 1, 0, 1.0);
  // bars
  for (let i = 0; i < DR_BARS.length; i++) {
    const [z0, z1] = DR_BARS[i];
    drQuad(b, [[-0.32, 0, z0], [0.32, 0, z0], [0.32, 0, z1], [-0.32, 0, z1]], 0, 1, 0, 0.96);
  }
  // slots: floor + four walls each
  for (let i = 0; i < DR_SLOTS.length; i++) {
    const [z0, z1] = DR_SLOTS[i];
    const yb = -DR_DEPTH;
    drQuad(b, [[-0.32, yb, z0], [0.32, yb, z0], [0.32, yb, z1], [-0.32, yb, z1]], 0, 1, 0, 0.10);
    drQuad(b, [[-0.32, yb, z0], [0.32, yb, z0], [0.32, 0, z0], [-0.32, 0, z0]], 0, 0, 1, 0.35);
    drQuad(b, [[-0.32, yb, z1], [0.32, yb, z1], [0.32, 0, z1], [-0.32, 0, z1]], 0, 0, -1, 0.35);
    drQuad(b, [[-0.32, yb, z0], [-0.32, yb, z1], [-0.32, 0, z1], [-0.32, 0, z0]], 1, 0, 0, 0.30);
    drQuad(b, [[0.32, yb, z0], [0.32, yb, z1], [0.32, 0, z1], [0.32, 0, z0]], -1, 0, 0, 0.30);
  }
  // mitred apron ring, outer edge 22 mm down (buried in the asphalt)
  const ay = -0.022, an = 0.91, at = 0.41;
  drQuad(b, [[-0.35, 0, 0.20], [0.35, 0, 0.20], [0.40, ay, 0.25], [-0.40, ay, 0.25]], 0, an, at, 0.80);
  drQuad(b, [[-0.35, 0, -0.20], [0.35, 0, -0.20], [0.40, ay, -0.25], [-0.40, ay, -0.25]], 0, an, -at, 0.80);
  drQuad(b, [[0.35, 0, -0.20], [0.35, 0, 0.20], [0.40, ay, 0.25], [0.40, ay, -0.25]], at, an, 0, 0.80);
  drQuad(b, [[-0.35, 0, -0.20], [-0.35, 0, 0.20], [-0.40, ay, 0.25], [-0.40, ay, -0.25]], -at, an, 0, 0.80);
}

// ---------------------------------------------------------------------------
// Thin-instance matrix: local +y aligned to the ground normal, yaw around it,
// det(+1) basis so winding is preserved. Row-major Babylon Matrix layout.
// ---------------------------------------------------------------------------
function writeInstance(buf, k, x, z, lift, yaw, eps) {
  const y = groundHeight(x, z) + lift;
  groundNormal(x, z, eps, _gn);
  const fx = Math.cos(yaw), fz = Math.sin(yaw);
  const dotf = fx * _gn.x + fz * _gn.z;
  let xx = fx - _gn.x * dotf, xy = -_gn.y * dotf, xz = fz - _gn.z * dotf;
  const il = 1 / Math.hypot(xx, xy, xz);
  xx *= il; xy *= il; xz *= il;
  const zx = xy * _gn.z - xz * _gn.y;
  const zy = xz * _gn.x - xx * _gn.z;
  const zz = xx * _gn.y - xy * _gn.x;
  const o = k * 16;
  buf[o] = xx; buf[o + 1] = xy; buf[o + 2] = xz; buf[o + 3] = 0;
  buf[o + 4] = _gn.x; buf[o + 5] = _gn.y; buf[o + 6] = _gn.z; buf[o + 7] = 0;
  buf[o + 8] = zx; buf[o + 9] = zy; buf[o + 10] = zz; buf[o + 11] = 0;
  buf[o + 12] = x; buf[o + 13] = y; buf[o + 14] = z; buf[o + 15] = 1;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Materials — PBRMaterial + vendored texture sets (chosen over a custom WGSL
// ShaderMaterial so CSM shadows, the scene light loop, IBL-if-added and fog
// come for free; see notes). Missing textures fail loudly magenta.
// ---------------------------------------------------------------------------
function makeTex(scene, url, tile, onErr) {
  const t = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, onErr);
  t.uScale = tile; t.vScale = tile;
  t.anisotropicFilteringLevel = 8;
  return t;
}

function failMagenta(m) {
  m.unlit = true;
  m.albedoTexture = null;
  m.albedoColor.copyFromFloats(1, 0, 1);
}

function makePbrSet(scene, name, folder, tile, metallic) {
  const m = new PBRMaterial(name, scene);
  m.metallic = metallic;
  m.roughness = 1;
  m.useRoughnessFromMetallicTextureAlpha = false;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = false;
  m.enableSpecularAntiAliasing = true;
  m.specularIntensity = 0.9;
  m.backFaceCulling = true;
  const onErr = () => failMagenta(m);
  m.albedoTexture = makeTex(scene, folder + 'color.jpg', tile, onErr);
  m.bumpTexture = makeTex(scene, folder + 'normal.jpg', tile, onErr);
  m.metallicTexture = makeTex(scene, folder + 'roughness.jpg', tile, onErr);
  m.ambientTexture = makeTex(scene, folder + 'ao.jpg', tile, onErr);
  m.ambientTextureStrength = 1;
  return m;
}

function finalizeMesh(scene, name, b, mat) {
  if (b.idx.length === 0) return null;
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = new Float32Array(b.pos);
  vd.normals = new Float32Array(b.nrm);
  vd.uvs = new Float32Array(b.uv);
  vd.colors = new Float32Array(b.col);
  vd.indices = b.vcount() > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx);
  vd.applyToMesh(mesh, false);
  mesh.material = mat;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

// ---------------------------------------------------------------------------

export class Curbs {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    this.scene = scene;

    this._matCurb = makePbrSet(scene, 'nlCurbConcrete', '/assets/textures/concrete/', 1 / 0.75, 0);
    this._matWalk = makePbrSet(scene, 'nlSidewalkPaving', '/assets/textures/paving/', 1 / 1.5, 0);
    // Moderate metallic: there is no IBL env texture, full metals would read black.
    this._matManhole = makePbrSet(scene, 'nlManholeSteel', '/assets/textures/metal/', 1 / 0.8, 0.45);
    this._matDrain = makePbrSet(scene, 'nlDrainIron', '/assets/textures/metal/', 1 / 0.4, 0.55);
    this._matWalk.bumpTexture.level = 0.9;

    // --- annular curb/sidewalk grids, bucketed into 4 quadrant mesh pairs ---
    const qCurb = [new GeoBuilder(), new GeoBuilder(), new GeoBuilder(), new GeoBuilder()];
    const qWalk = [new GeoBuilder(), new GeoBuilder(), new GeoBuilder(), new GeoBuilder()];
    const rects = blockRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const q = (((r.x0 + r.x1) * 0.5 >= 0) ? 1 : 0) + (((r.z0 + r.z1) * 0.5 >= 0) ? 2 : 0);
      buildBlockBand(qCurb[q], qWalk[q], r);
    }
    // all 12 street dead-ends (3 N-S streets × 2 + 3 E-W streets × 2)
    for (let i = 0; i < STREETS_X.length; i++) {
      for (let e = -1; e <= 1; e += 2) {
        const q = ((STREETS_X[i] >= 0) ? 1 : 0) + ((e > 0) ? 2 : 0);
        buildEnd(qCurb[q], qWalk[q], 0, STREETS_X[i], e);
      }
    }
    for (let i = 0; i < STREETS_Z.length; i++) {
      for (let e = -1; e <= 1; e += 2) {
        const q = ((e > 0) ? 1 : 0) + ((STREETS_Z[i] >= 0) ? 2 : 0);
        buildEnd(qCurb[q], qWalk[q], 1, STREETS_Z[i], e);
      }
    }

    /** All meshes owned by this module (integrator convenience: shadow wiring). */
    this.meshes = [];
    for (let q = 0; q < 4; q++) {
      const mc = finalizeMesh(scene, 'nlCurb_q' + q, qCurb[q], this._matCurb);
      const mw = finalizeMesh(scene, 'nlSidewalk_q' + q, qWalk[q], this._matWalk);
      if (mc) this.meshes.push(mc);
      if (mw) this.meshes.push(mw);
    }

    // --- manhole covers: one mesh, 10 thin instances on the carriageway ---
    {
      const b = new GeoBuilder();
      buildManholeGeometry(b);
      const mesh = finalizeMesh(scene, 'nlManhole', b, this._matManhole);
      const rng = mulberry32(20260731);
      const segs = streetSegments();
      const buf = new Float32Array(10 * 16);
      let k = 0;
      for (let i = 0; i < segs.length && k < 10; i++) {
        const sg = segs[i];
        if (sg.s1 - sg.s0 < 50) continue;   // long mid-block segments only
        const s = sg.s0 + (sg.s1 - sg.s0) * MH_FRAC[k % MH_FRAC.length];
        const t = MH_T[k % MH_T.length];    // lane offsets, several in the wheel path
        const x = sg.axis === 0 ? sg.center + t : s;
        const z = sg.axis === 0 ? s : sg.center + t;
        writeInstance(buf, k, x, z, 0.004, rng() * Math.PI * 2, 0.25);
        k++;
      }
      mesh.thinInstanceSetBuffer('matrix', buf.subarray(0, k * 16), 16, true);
      mesh.thinInstanceRefreshBoundingInfo();
      this.meshes.push(mesh);
      this._manholes = mesh;
    }

    // --- storm drains: one mesh, 4 per intersection in the gutters ---
    {
      const b = new GeoBuilder();
      buildDrainGeometry(b);
      const mesh = finalizeMesh(scene, 'nlDrain', b, this._matDrain);
      const its = intersections();
      const buf = new Float32Array(its.length * 4 * 16);
      let k = 0;
      for (let i = 0; i < its.length; i++) {
        const it = its[i];
        for (let sx = -1; sx <= 1; sx += 2) {
          for (let sz = -1; sz <= 1; sz += 2) {
            const onNS = sx * sz > 0;      // alternate arms around each corner
            const x = onNS ? it.x + sx * 4.2 : it.x + sx * 10.85;
            const z = onNS ? it.z + sz * 10.85 : it.z + sz * 4.2;
            writeInstance(buf, k, x, z, 0.010, onNS ? Math.PI / 2 : 0, 0.2);
            k++;
          }
        }
      }
      mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
      mesh.thinInstanceRefreshBoundingInfo();
      this.meshes.push(mesh);
      this._drains = mesh;
    }

    if (env) this.applyEnvironment(env);
  }

  /**
   * Weather push. Wetness darkens albedo and tightens roughness (multiplier on
   * the roughness texture); the curb/gutter splash zone reacts strongest.
   * Materials are intentionally left unfrozen: uniforms change on every apply
   * and shadow/light wiring by the integrator may happen after construction.
   */
  applyEnvironment(env) {
    const p = env.params;
    let w = p.wetnessTarget + p.rainRate * 0.25;
    if (w < 0) w = 0; else if (w > 1) w = 1;
    const mw = this._matWalk, mc = this._matCurb, mm = this._matManhole, md = this._matDrain;
    if (!mw.unlit) {
      mw.roughness = 1 - 0.40 * w;
      const s = 1 - 0.20 * w;
      mw.albedoColor.copyFromFloats(0.94 * s, 0.94 * s, 0.93 * s);
    }
    if (!mc.unlit) {
      mc.roughness = 1 - 0.52 * w;
      const s = 1 - 0.30 * w;
      mc.albedoColor.copyFromFloats(0.88 * s, 0.88 * s, 0.87 * s);
    }
    if (!mm.unlit) {
      mm.roughness = 1 - 0.55 * w;
      const s = 1 - 0.25 * w;
      mm.albedoColor.copyFromFloats(0.62 * s, 0.63 * s, 0.66 * s);
    }
    if (!md.unlit) {
      md.roughness = 1 - 0.50 * w;
      const s = 1 - 0.20 * w;
      md.albedoColor.copyFromFloats(0.30 * s, 0.31 * s, 0.33 * s);
    }
  }

  /** Everything is static — nothing to do per frame. Allocation-free. */
  update(dt, camX, camZ) { } // eslint-disable-line no-unused-vars

  /** All pipeline variants are plain PBR; nothing extra to touch. */
  warmup() { }
}
