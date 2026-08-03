/**
 * Curbs — the street edge: rolled curbs, sidewalks, manhole covers and
 * storm-drain grates, STREAMED per block around the car (the city is endless).
 *
 * Owns the SDF band d ∈ [0, 3.0] around every street (curb 0..0.15, sidewalk
 * 0.15..3.0). In the periodic plan every block is a closed loop: 4 straights
 * (using each street's own curb face — motorway rows are wider) joined by 4
 * CORNER_R fillet arcs. Every vertex height comes from groundHeight(), every
 * normal from groundNormal() — this module never invents heights, so it
 * seam-matches the road mesh (d<0) and the block modules (d≥3) by
 * construction.
 *
 * Streaming: blocks inside R_BUILD of the car are built cooperatively (a
 * generator emits ~40 path rows per slice under the shared build budget) and
 * disposed beyond R_DROP. Manholes/drains are thin-instance buffers rebuilt
 * from the region every ~48 m of travel.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { params } from '../core/params.js';
import { quality } from '../core/quality.js';
import groundBandVertex from '../shaders/groundBand.vertex.wgsl?raw';
import groundBandFragment from '../shaders/groundBand.fragment.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';
import {
  PERIOD_X, PERIOD_Z, CURB_FACE, CURB_W, CURB_H, CORNER_R,
  rowFace, blocksInRegion, segmentsInRegion, crossingsInRegion, cellSeed,
  gridToWorld, sampleRoadSpace, districtOf, DISTRICT_COUNTRYSIDE,
} from './cityPlan.js';
import { groundHeight, groundNormal, crossProfile } from './roadProfile.js';
import { valueNoise, hash2 } from './noise.js';
import { buildBudget } from '../core/buildBudget.js';

const R_BUILD = 300;       // blocks exist inside this distance of the car
const R_DROP = 340;        // …and are disposed beyond this
const RESCAN_DIST = 22;    // staggered vs roads (24) / buildings (26)
const R_INST = 260;        // manhole/drain instancing radius
const INST_RESCAN = 44;    // staggered vs props (52)
const ROWS_PER_SLICE = 40;

// ---------------------------------------------------------------------------
// Cross-section stations (metres of SDF distance d from the curb face).
// The last two sidewalk stations straddle the d=3.0 zone boundary by ±3 mm:
// groundHeight() is intentionally discontinuous there (block plinth sits 2 cm
// up) and sampling exactly at 3.0 would flip branches per-vertex on FP noise.
// ---------------------------------------------------------------------------
const CURB_STATIONS = [0, 0.03, 0.07, 0.11, 0.15];
const WALK_STATIONS = [0.15, 0.5, 1.0, 1.6, 2.3, 3.0];
const STEP_STRAIGHT = 0.4;
const STEP_ARC = 0.12;
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

const _gn = { x: 0, y: 1, z: 0 }; // groundNormal scratch (build-time only)
const _gw = { x: 0, z: 0 };       // gridToWorld scratch (build-time only)

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
// the normal reproduces the SDF contours exactly.
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

/**
 * Project a world point onto the exact (warped) d=0 curb contour and derive
 * the outward normal from the SDF gradient. Mutates p {x, z, nx, nz}.
 */
const _crsA = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };
function projectToContour(p) {
  const e = 0.03;
  let gx = 0, gz = 1;
  for (let it = 0; it < 3; it++) {
    sampleRoadSpace(p.x, p.z, _crsA);
    const d = _crsA.d;
    sampleRoadSpace(p.x + e, p.z, _crsA); const dx1 = _crsA.d;
    sampleRoadSpace(p.x - e, p.z, _crsA); const dx0 = _crsA.d;
    sampleRoadSpace(p.x, p.z + e, _crsA); const dz1 = _crsA.d;
    sampleRoadSpace(p.x, p.z - e, _crsA); const dz0 = _crsA.d;
    gx = (dx1 - dx0) / (2 * e); gz = (dz1 - dz0) / (2 * e);
    const gl = Math.hypot(gx, gz);
    if (gl < 1e-5) break;
    gx /= gl; gz /= gl;
    if (Math.abs(d) < 0.003) break;
    let sx = gx * d, sz = gz * d;
    const sl = Math.hypot(sx, sz);
    if (sl > 0.6) { sx *= 0.6 / sl; sz *= 0.6 / sl; }
    p.x -= sx; p.z -= sz;
  }
  p.nx = gx; p.nz = gz;   // toward increasing d = into the block
}

/**
 * Closed curb-line loop around block (ix, jz): 4 straights + 4 fillet arcs
 * generated in GRID space, then each point is mapped through the street-
 * curvature warp and projected onto the exact d=0 contour — the band bends
 * with the streets. u = accumulated WORLD arc length (texture continuity).
 */
function buildBlockLoop(ix, jz) {
  const w = ix * PERIOD_X, e = (ix + 1) * PERIOD_X;
  const s = jz * PERIOD_Z, n = (jz + 1) * PERIOD_Z;
  const fS = rowFace(jz), fN = rowFace(jz + 1), fC = CURB_FACE;
  const R = CORNER_R;
  const sides = [
    { x0: w + fC + R, z0: s + fS, x1: e - fC - R, z1: s + fS, nx: 0, nz: 1 },
    { x0: e - fC, z0: s + fS + R, x1: e - fC, z1: n - fN - R, nx: -1, nz: 0 },
    { x0: e - fC - R, z0: n - fN, x1: w + fC + R, z1: n - fN, nx: 0, nz: -1 },
    { x0: w + fC, z0: n - fN - R, x1: w + fC, z1: s + fS + R, nx: 1, nz: 0 },
  ];
  const gridPts = [];
  let gu = 0;
  for (let k = 0; k < 4; k++) {
    const sd = sides[k];
    gu = addStraight(gridPts, sd.x0, sd.z0, sd.x1, sd.z1, sd.nx, sd.nz, gu, gridPts.length > 0);
    const nxt = sides[(k + 1) % 4];
    const ccx = sd.x1 + sd.nx * R, ccz = sd.z1 + sd.nz * R;
    const a0 = Math.atan2(sd.z1 - ccz, sd.x1 - ccx);
    const a1 = Math.atan2(nxt.z0 - ccz, nxt.x0 - ccx);
    gu = addArc(gridPts, ccx, ccz, a0, a1, gu, true);
  }
  const raw = [];
  const pw = { x: 0, z: 0, nx: 0, nz: 1 };
  for (let i = 0; i < gridPts.length; i++) {
    const g = gridPts[i];
    gridToWorld(g.x, g.z, pw);
    projectToContour(pw);
    raw.push({ x: pw.x, z: pw.z, nx: pw.nx, nz: pw.nz, u: 0 });
  }
  // the projection can pull neighbouring points past each other around the
  // corner fillets (the strip then folds into serrated fins): keep only
  // monotonically advancing points, then rebuild u as world arc length
  const pts = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const q = raw[i];
    const l = pts[pts.length - 1];
    const dx = q.x - l.x, dz = q.z - l.z;
    const seg = Math.hypot(dx, dz);
    if (seg < 0.05) continue;
    if (pts.length > 1) {
      const p2 = pts[pts.length - 2];
      if ((l.x - p2.x) * dx + (l.z - p2.z) * dz < 0) continue;   // backtrack
    }
    pts.push(q);
  }
  let u = 0;
  for (let i = 1; i < pts.length; i++) {
    u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].u = u;
  }
  // smooth the normals along the path: the numeric SDF gradients jitter a
  // little under the curvature warp, and the 3 m outer station amplifies
  // any angular noise into edge fringing at the corners
  const np = pts.length;
  for (let pass = 0; pass < 2; pass++) {
    let prevNx = pts[np - 1].nx, prevNz = pts[np - 1].nz;
    for (let i = 0; i < np; i++) {
      const nxt = pts[(i + 1) % np];
      const cur = pts[i];
      const sx = prevNx * 0.25 + cur.nx * 0.5 + nxt.nx * 0.25;
      const sz = prevNz * 0.25 + cur.nz * 0.5 + nxt.nz * 0.25;
      const il = 1 / (Math.hypot(sx, sz) || 1);
      prevNx = cur.nx; prevNz = cur.nz;
      cur.nx = sx * il; cur.nz = sz * il;
    }
  }
  return pts;
}

/** Emit strip rows [from, to) plus the quads linking them to the prior row. */
function emitRowsRange(b, stripBase, pts, from, to, stations, isCurb) {
  const s = stations.length;
  for (let i = from; i < to; i++) {
    const p = pts[i];
    for (let j = 0; j < s; j++) {
      const d = stations[j];
      emitGroundVertex(b, p.x + p.nx * d, p.z + p.nz * d, d, p.u, isCurb ? CURB_V[j] : d, isCurb);
    }
  }
  for (let i = Math.max(1, from); i < to; i++) {
    for (let j = 0; j + 1 < s; j++) {
      b.quad(stripBase + (i - 1) * s + j, stripBase + i * s + j,
        stripBase + i * s + j + 1, stripBase + (i - 1) * s + j + 1);
    }
  }
}

/** Cooperative block-band build: yields between row slices. */
function* blockBandGen(qc, qw, ix, jz, country) {
  const pts = buildBlockLoop(ix, jz);
  const baseC = qc.vcount();
  const baseW = qw.vcount();
  let i = 0;
  while (i < pts.length) {
    const end = Math.min(pts.length, i + ROWS_PER_SLICE);
    emitRowsRange(qc, baseC, pts, i, end, CURB_STATIONS, true);
    emitRowsRange(qw, baseW, pts, i, end, WALK_STATIONS, false);
    i = end;
    yield;
  }
  if (country) yield* fieldGen(qw, ix, jz);
}

/**
 * Countryside interior: a coarse grid meadow filling the block beyond the
 * verge band. Grid-space rect inset by CURB_FACE+2.85 maps through the warp
 * to a curve just inside the band's d=3 edge; sitting 4 mm below the band
 * hides the overlap seam (grass-on-grass, band renders on top).
 */
function* fieldGen(qw, ix, jz) {
  const fC = CURB_FACE, inset = 2.85, sink = 0.004;
  const x0 = ix * PERIOD_X + fC + inset, x1 = (ix + 1) * PERIOD_X - fC - inset;
  const z0 = jz * PERIOD_Z + rowFace(jz) + inset;
  const z1 = (jz + 1) * PERIOD_Z - rowFace(jz + 1) - inset;
  const nx = Math.max(2, Math.ceil((x1 - x0) / 9));
  const nz = Math.max(2, Math.ceil((z1 - z0) / 9));
  const base = qw.vcount();
  for (let iz = 0; iz <= nz; iz++) {
    for (let jx = 0; jx <= nx; jx++) {
      const gx = x0 + (x1 - x0) * (jx / nx);
      const gz = z0 + (z1 - z0) * (iz / nz);
      gridToWorld(gx, gz, _gw);
      const y = groundHeight(_gw.x, _gw.z) - sink;
      groundNormal(_gw.x, _gw.z, 0.3, _gn);
      const g = grimeAt(_gw.x, _gw.z, 3, false);
      qw.vert(_gw.x, y, _gw.z, _gn.x, _gn.y, _gn.z, _gw.x, _gw.z, g, g * 0.985, g * 0.955);
    }
    if ((iz & 3) === 3) yield;
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let jx = 0; jx < nx; jx++) {
      const a = base + iz * (nx + 1) + jx;
      qw.quad(a, a + 1, a + nx + 2, a + nx + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Manhole cover — lathe profile (r, y, grime), 48 segments. Machined rings and
// a dark cover/frame gap groove; the rim stands ~9 mm proud.
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
// Storm-drain grate 0.7×0.4, geometric slots (real depth, near-black floors).
// Long axis local +x; instances yaw 90° on N-S streets.
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
  drQuad(b, [[-0.35, 0, 0.17], [0.35, 0, 0.17], [0.35, 0, 0.20], [-0.35, 0, 0.20]], 0, 1, 0, 1.0);
  drQuad(b, [[-0.35, 0, -0.20], [0.35, 0, -0.20], [0.35, 0, -0.17], [-0.35, 0, -0.17]], 0, 1, 0, 1.0);
  drQuad(b, [[-0.35, 0, -0.17], [-0.32, 0, -0.17], [-0.32, 0, 0.17], [-0.35, 0, 0.17]], 0, 1, 0, 1.0);
  drQuad(b, [[0.32, 0, -0.17], [0.35, 0, -0.17], [0.35, 0, 0.17], [0.32, 0, 0.17]], 0, 1, 0, 1.0);
  for (let i = 0; i < DR_BARS.length; i++) {
    const [z0, z1] = DR_BARS[i];
    drQuad(b, [[-0.32, 0, z0], [0.32, 0, z0], [0.32, 0, z1], [-0.32, 0, z1]], 0, 1, 0, 0.96);
  }
  for (let i = 0; i < DR_SLOTS.length; i++) {
    const [z0, z1] = DR_SLOTS[i];
    const yb = -DR_DEPTH;
    drQuad(b, [[-0.32, yb, z0], [0.32, yb, z0], [0.32, yb, z1], [-0.32, yb, z1]], 0, 1, 0, 0.10);
    drQuad(b, [[-0.32, yb, z0], [0.32, yb, z0], [0.32, 0, z0], [-0.32, 0, z0]], 0, 0, 1, 0.35);
    drQuad(b, [[-0.32, yb, z1], [0.32, yb, z1], [0.32, 0, z1], [-0.32, 0, z1]], 0, 0, -1, 0.35);
    drQuad(b, [[-0.32, yb, z0], [-0.32, yb, z1], [-0.32, 0, z1], [-0.32, 0, z0]], 1, 0, 0, 0.30);
    drQuad(b, [[0.32, yb, z0], [0.32, yb, z1], [0.32, 0, z1], [0.32, 0, z0]], -1, 0, 0, 0.30);
  }
  const ay = -0.022, an = 0.91, at = 0.41;
  drQuad(b, [[-0.35, 0, 0.20], [0.35, 0, 0.20], [0.40, ay, 0.25], [-0.40, ay, 0.25]], 0, an, at, 0.80);
  drQuad(b, [[-0.35, 0, -0.20], [0.35, 0, -0.20], [0.40, ay, -0.25], [-0.40, ay, -0.25]], 0, an, -at, 0.80);
  drQuad(b, [[0.35, 0, -0.20], [0.35, 0, 0.20], [0.40, ay, 0.25], [0.40, ay, -0.25]], at, an, 0, 0.80);
  drQuad(b, [[-0.35, 0, -0.20], [-0.35, 0, 0.20], [-0.40, ay, 0.25], [-0.40, ay, -0.25]], -at, an, 0, 0.80);
}

// ---------------------------------------------------------------------------
// Thin-instance matrix: local +y aligned to the ground normal, yaw around it.
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

// ---------------------------------------------------------------------------
// Materials — PBRMaterial + vendored texture sets. Missing textures fail
// loudly magenta.
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
   * @param {import('./roadMaterial.js').RoadMaterial} roadMat street-light buffer owner
   */
  constructor(scene, env, roadMat) {
    this.scene = scene;
    this._env = env;
    this._roadMat = roadMat;
    /** bumped whenever meshes stream in/out (render-list refresh hook) */
    this.generation = 0;

    // curb + sidewalk use the road-grade ground-band shader (street-light
    // pools, shadowed sun, wet response, matching fog) so the quality never
    // steps down at the asphalt's edge
    if (!ShaderStore.IncludesShadersStoreWGSL['nlCommon']) {
      ShaderStore.IncludesShadersStoreWGSL['nlCommon'] = commonWgsl;
    }
    ShaderStore.ShadersStoreWGSL['nlGroundBandVertexShader'] = groundBandVertex;
    ShaderStore.ShadersStoreWGSL['nlGroundBandFragmentShader'] = groundBandFragment;
    this._matWalk = this._makeBandMaterial('nlSidewalkPaving', '/assets/textures/paving/', 1 / 2.7, 0.95, 0.95, 0.94);
    this._matCurb = this._makeBandMaterial('nlCurbConcrete', '/assets/textures/concrete/', 1 / 0.75, 0.84, 0.84, 0.83);
    // countryside verge/meadow: same band shader, procedural grass albedo
    this._matGrass = this._makeBandMaterial('nlVergeGrass', '/assets/textures/paving/', 1 / 2.7, 1, 1, 1);
    this._matGrass.setFloat('grassMode', 1);

    // Moderate metallic: there is no IBL env texture, full metals would read black.
    this._matManhole = makePbrSet(scene, 'nlManholeSteel', '/assets/textures/metal/', 1 / 0.8, 0.45);
    this._matDrain = makePbrSet(scene, 'nlDrainIron', '/assets/textures/metal/', 1 / 0.4, 0.55);

    /** @type {Map<string, {mc: Mesh|null, mw: Mesh|null}>} */
    this._blocks = new Map();
    /** @type {Array<{key: string, ix: number, jz: number}>} */
    this._queue = [];
    this._task = null;   // {key, ix, jz, gen, qc, qw}
    this._scanX = Infinity; this._scanZ = Infinity;
    this._instX = Infinity; this._instZ = Infinity;

    // manhole + drain masters (instance buffers rebuilt per region)
    {
      const b = new GeoBuilder();
      buildManholeGeometry(b);
      this._manholes = finalizeMesh(scene, 'nlManhole', b, this._matManhole);
      this._manholes.alwaysSelectAsActiveMesh = true;
      this._manholes.metadata = { nlNoShadow: true };
    }
    {
      const b = new GeoBuilder();
      buildDrainGeometry(b);
      this._drains = finalizeMesh(scene, 'nlDrain', b, this._matDrain);
      this._drains.alwaysSelectAsActiveMesh = true;
      this._drains.metadata = { nlNoShadow: true };
    }

    if (env) this.applyEnvironment(env);
  }

  /** Road-grade band material: textures + shadow map + street-light buffer. */
  _makeBandMaterial(name, folder, tile, tr, tg, tb) {
    const scene = this.scene;
    const m = new ShaderMaterial(name, scene, { vertex: 'nlGroundBand', fragment: 'nlGroundBand' }, {
      attributes: ['position', 'normal', 'uv', 'color'],
      uniformBuffers: ['Scene', 'Mesh'],
      storageBuffers: ['roadLights'],
      shaderLanguage: ShaderLanguage.WGSL,
    });
    const tex = (file) => {
      const t = new Texture(folder + file, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      t.wrapU = Texture.WRAP_ADDRESSMODE;
      t.wrapV = Texture.WRAP_ADDRESSMODE;
      t.anisotropicFilteringLevel = 8;
      return t;
    };
    m.setTexture('albedoTex', tex('color.jpg'));
    m.setTexture('normalTex', tex('normal.jpg'));
    m.setTexture('roughTex', tex('roughness.jpg'));
    m.setTexture('aoTex', tex('ao.jpg'));
    m.setFloat('tile', tile);
    // ShaderMaterial stores REFERENCES: dedicated objects per uniform
    const u = {
      tint: new Vector3(tr, tg, tb),
      sunDir: new Vector3(0, -1, 0),
      sunColor: new Vector3(1, 1, 1),
      ambientSky: new Vector3(0.3, 0.35, 0.5),
      ambientGround: new Vector3(0.15, 0.14, 0.13),
      fogColor: new Vector3(0.2, 0.2, 0.25),
      shadowDV: new Vector2(this._env.sun.shadowMinZ, this._env.sun.shadowMaxZ),
    };
    m._nl = u;
    m.setVector3('albedoTint', u.tint);
    m.setVector3('sunDir', u.sunDir);
    m.setVector3('sunColor', u.sunColor);
    m.setVector3('ambientSky', u.ambientSky);
    m.setVector3('ambientGround', u.ambientGround);
    m.setVector3('fogColor', u.fogColor);
    m.setFloat('ambientIntensity', 0.85);
    m.setFloat('fogDensity', 0.003);
    m.setFloat('fogHeightFalloff', 0.05);
    m.setFloat('wetness', 0.5);
    m.setTexture('sunShadowMap', this._env.shadow.getShadowMap());
    m.setFloat('shadowMapSize', quality.shadowSize);
    m.setVector2('shadowDV', u.shadowDV);
    m.setMatrix('sunShadowMatrix', this._env.shadow.getTransformMatrix());
    m.setStorageBuffer('roadLights', this._roadMat.lightBuffer);
    m.setFloat('lightCount', 0);
    m.setFloat('grassMode', 0);
    return m;
  }

  _rescan(cx, cz) {
    this._scanX = cx; this._scanZ = cz;
    for (const bl of blocksInRegion(cx - R_BUILD, cx + R_BUILD, cz - R_BUILD, cz + R_BUILD)) {
      const key = `${bl.ix}:${bl.jz}`;
      if (this._blocks.has(key)) continue;
      const bcx = (bl.x0 + bl.x1) * 0.5, bcz = (bl.z0 + bl.z1) * 0.5;
      const hx = (bl.x1 - bl.x0) * 0.5 + 8, hz = (bl.z1 - bl.z0) * 0.5 + 8;
      const dx = Math.max(0, Math.abs(cx - bcx) - hx);
      const dz = Math.max(0, Math.abs(cz - bcz) - hz);
      if (Math.hypot(dx, dz) > R_BUILD) continue;
      this._blocks.set(key, null); // reserved: queued
      this._queue.push({
        key, ix: bl.ix, jz: bl.jz,
        country: districtOf(bl.ix, bl.jz) === DISTRICT_COUNTRYSIDE,
      });
    }
    // evict far blocks
    for (const [key, entry] of this._blocks) {
      if (this._task && this._task.key === key) continue;
      const [ix, jz] = key.split(':').map(Number);
      const bcx = (ix + 0.5) * PERIOD_X, bcz = (jz + 0.5) * PERIOD_Z;
      const hx = PERIOD_X * 0.5 + 8, hz = PERIOD_Z * 0.5 + 8;
      const dx = Math.max(0, Math.abs(cx - bcx) - hx);
      const dz = Math.max(0, Math.abs(cz - bcz) - hz);
      if (Math.hypot(dx, dz) > R_DROP) {
        if (entry) {
          if (entry.mc) entry.mc.dispose(false, false);
          if (entry.mw) entry.mw.dispose(false, false);
          this.generation++;
        }
        this._blocks.delete(key);
      }
    }
  }

  _rebuildInstances(cx, cz) {
    this._instX = cx; this._instZ = cz;
    // manholes: hashed per street segment, wheel-path lane offsets
    {
      const items = [];
      for (const seg of segmentsInRegion(cx - R_INST, cx + R_INST, cz - R_INST, cz + R_INST)) {
        if (seg.mway) continue;                       // none on the motorway
        const len = seg.s1 - seg.s0;
        if (len < 40) continue;
        {   // no drainage infra on rural stretches (both flanking blocks fields)
          const cell = Math.floor(((seg.s0 + seg.s1) * 0.5) / (seg.axis === 0 ? PERIOD_Z : PERIOD_X));
          const dA = seg.axis === 0 ? districtOf(seg.line - 1, cell) : districtOf(cell, seg.line - 1);
          const dB = seg.axis === 0 ? districtOf(seg.line, cell) : districtOf(cell, seg.line);
          if (dA === DISTRICT_COUNTRYSIDE && dB === DISTRICT_COUNTRYSIDE) continue;
        }
        const h0 = cellSeed(seg.axis * 7919 + seg.line, Math.round(seg.s0), 3);
        const nMh = h0 < 0.55 ? 1 : 0;
        for (let k = 0; k < nMh; k++) {
          const hs = cellSeed(seg.axis * 7919 + seg.line, Math.round(seg.s0), 11 + k);
          const ht = cellSeed(seg.axis * 7919 + seg.line, Math.round(seg.s0), 17 + k);
          const s = seg.s0 + len * (0.18 + 0.64 * hs);
          const t = (ht > 0.5 ? 1 : -1) * (1.2 + (ht * 7919 % 1) * 1.6);
          const gx = seg.axis === 0 ? seg.center + t : s;
          const gz = seg.axis === 0 ? s : seg.center + t;
          gridToWorld(gx, gz, _gw);
          items.push({ x: _gw.x, z: _gw.z, yaw: hs * Math.PI * 2 });
        }
      }
      const buf = new Float32Array(Math.max(1, items.length) * 16);
      for (let i = 0; i < items.length; i++) {
        writeInstance(buf, i, items[i].x, items[i].z, 0.004, items[i].yaw, 0.25);
      }
      if (items.length > 0) {
        this._manholes.thinInstanceSetBuffer('matrix', buf.subarray(0, items.length * 16), 16, true);
        this._manholes.thinInstanceRefreshBoundingInfo();
      }
      this._manholes.setEnabled(items.length > 0);
    }
    // drains: 4 per crossing in the gutters, generalised for wide rows
    {
      const crossings = crossingsInRegion(cx - R_INST, cx + R_INST, cz - R_INST, cz + R_INST);
      const buf = new Float32Array(Math.max(1, crossings.length * 4) * 16);
      let k = 0;
      for (const it of crossings) {
        if (districtOf(it.i - 1, it.j - 1) === DISTRICT_COUNTRYSIDE &&
            districtOf(it.i, it.j - 1) === DISTRICT_COUNTRYSIDE &&
            districtOf(it.i - 1, it.j) === DISTRICT_COUNTRYSIDE &&
            districtOf(it.i, it.j) === DISTRICT_COUNTRYSIDE) continue;
        const fB = rowFace(it.j);
        for (let sx = -1; sx <= 1; sx += 2) {
          for (let sz = -1; sz <= 1; sz += 2) {
            const onNS = sx * sz > 0;      // alternate arms around each corner
            const gx = onNS ? it.x + sx * (CURB_FACE - 0.25) : it.x + sx * (CURB_FACE + CORNER_R + 0.9);
            const gz = onNS ? it.z + sz * (fB + CORNER_R + 0.9) : it.z + sz * (fB - 0.25);
            gridToWorld(gx, gz, _gw);
            writeInstance(buf, k, _gw.x, _gw.z, 0.010, onNS ? Math.PI / 2 : 0, 0.2);
            k++;
          }
        }
      }
      if (k > 0) {
        this._drains.thinInstanceSetBuffer('matrix', buf.subarray(0, k * 16), 16, true);
        this._drains.thinInstanceRefreshBoundingInfo();
      }
      this._drains.setEnabled(k > 0);
    }
  }

  _finishTask() {
    const t = this._task;
    const mc = finalizeMesh(this.scene, `nlCurb_${t.key}`, t.qc, t.country ? this._matGrass : this._matCurb);
    const mw = finalizeMesh(this.scene, `nlSidewalk_${t.key}`, t.qw, t.country ? this._matGrass : this._matWalk);
    this._blocks.set(t.key, { mc, mw });
    this._task = null;
    this.generation++;
  }

  /** Per-frame streaming under the shared build budget. Allocation-light. */
  update(dt, camX, camZ) {
    // live uniforms: follow-shadow matrix, road wetness, light-buffer count
    const lc = this._roadMat.lightCount;
    const sm = this._env.shadow.getTransformMatrix();
    for (const m of [this._matWalk, this._matCurb, this._matGrass]) {
      m.setMatrix('sunShadowMatrix', sm);
      m.setFloat('wetness', params.roadWetness);
      m.setFloat('lightCount', lc);
    }

    if (Math.hypot(camX - this._scanX, camZ - this._scanZ) > RESCAN_DIST) {
      this._rescan(camX, camZ);
    }
    if (Math.hypot(camX - this._instX, camZ - this._instZ) > INST_RESCAN) {
      this._rebuildInstances(camX, camZ);
    }

    const deadline = buildBudget.deadline();
    if (performance.now() >= deadline) return;
    const t0 = performance.now();

    while (performance.now() < deadline) {
      if (!this._task) {
        const next = this._queue.shift();
        if (!next) break;
        if (this._blocks.get(next.key) !== null) continue; // evicted while queued
        this._task = {
          key: next.key, ix: next.ix, jz: next.jz, country: next.country,
          qc: new GeoBuilder(), qw: new GeoBuilder(),
          gen: null,
        };
        this._task.gen = blockBandGen(this._task.qc, this._task.qw, next.ix, next.jz, next.country);
      }
      if (this._task.gen.next().done) this._finishTask();
    }
    buildBudget.report(performance.now() - t0);
  }

  /** Build every queued block synchronously (loading-screen warmup). */
  prewarm(camX, camZ) {
    this._rescan(camX, camZ);
    this._rebuildInstances(camX, camZ);
    let next;
    while ((next = this._queue.shift())) {
      if (this._blocks.get(next.key) !== null) continue;
      this._task = {
        key: next.key, ix: next.ix, jz: next.jz, country: next.country,
        qc: new GeoBuilder(), qw: new GeoBuilder(), gen: null,
      };
      this._task.gen = blockBandGen(this._task.qc, this._task.qw, next.ix, next.jz, next.country);
      while (!this._task.gen.next().done) { /* run to completion */ }
      this._finishTask();
    }
  }

  /**
   * Weather push. The band materials get the same environment uniforms as
   * the road; manholes/drains stay simple PBR with a wet-tightened finish.
   */
  applyEnvironment(env) {
    const p = env.params;
    const si = env.sun.intensity;
    for (const m of [this._matWalk, this._matCurb, this._matGrass]) {
      const u = m._nl;
      u.sunDir.copyFrom(env.sunDir);
      u.sunColor.set(p.sunColor[0] * si, p.sunColor[1] * si, p.sunColor[2] * si);
      u.ambientSky.set(p.ambientSky[0], p.ambientSky[1], p.ambientSky[2]);
      u.ambientGround.set(p.ambientGround[0], p.ambientGround[1], p.ambientGround[2]);
      u.fogColor.set(p.fogColor[0], p.fogColor[1], p.fogColor[2]);
      m.setVector3('sunDir', u.sunDir);
      m.setVector3('sunColor', u.sunColor);
      m.setVector3('ambientSky', u.ambientSky);
      m.setVector3('ambientGround', u.ambientGround);
      m.setVector3('fogColor', u.fogColor);
      m.setFloat('ambientIntensity', p.ambientIntensity);
      m.setFloat('fogDensity', p.fogDensity);
      m.setFloat('fogHeightFalloff', p.fogHeightFalloff);
    }

    let w = p.wetnessTarget + p.rainRate * 0.25;
    if (w < 0) w = 0; else if (w > 1) w = 1;
    const amb = Math.min(1, Math.max(0, p.ambientIntensity));
    const dim = 0.32 + 0.68 * amb * amb;
    const mm = this._matManhole, md = this._matDrain;
    if (!mm.unlit) {
      mm.roughness = 1 - 0.55 * w;
      const s = (1 - 0.25 * w) * dim;
      mm.albedoColor.copyFromFloats(0.62 * s, 0.63 * s, 0.66 * s);
    }
    if (!md.unlit) {
      md.roughness = 1 - 0.50 * w;
      const s = (1 - 0.20 * w) * dim;
      md.albedoColor.copyFromFloats(0.30 * s, 0.31 * s, 0.33 * s);
    }
  }

  /** Touch the band pipelines once during load. */
  warmup() {
    for (const entry of this._blocks.values()) {
      if (!entry) continue;
      if (entry.mc) this._matCurb.forceCompilation(entry.mc);
      if (entry.mw) this._matWalk.forceCompilation(entry.mw);
      return;
    }
  }
}
