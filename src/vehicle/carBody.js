/**
 * NIGHTLOOP — procedural coupe body shell (M4 visuals).
 *
 * Lofted 90s fastback coupe: long hood, rounded dropping nose, gentle wedge
 * beltline with a crease, fastback greenhouse, short ducktail. Built as a
 * section loft (ring per z station) so the wheel-arch openings are clean ring
 * boundaries, not ragged triangle cuts.
 *
 * Everything measurable is pure math (section/profile evaluation on plain
 * numbers) so it can be validated headless in Node — see __selftest() at the
 * bottom (run: `node -e "import('./src/vehicle/carBody.js').then(m=>m.__selftest())"`).
 * Babylon usage is confined to buildCarBody(), which only wraps the already
 * validated vertex data into meshes.
 *
 * Car frame: forward = +Z, up = +Y, right = +X. Ground y=0 at rest.
 * No materials are assigned here — the integrator paints every mesh.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';

// ---------------------------------------------------------------------------
// Hard dimensions
// ---------------------------------------------------------------------------
const LENGTH = 4.35;
const WIDTH = 1.78;            // over fenders
const W2 = WIDTH / 2;
const WHEELBASE = 2.62;
const TRACK = 1.52;
const WHEEL_R = 0.325;
const ARCH_R = 0.40;           // opening radius (longitudinal, at hub height)
const ARCH_B = 0.36;           // opening vertical semi-axis
const ZN = LENGTH / 2;         // nose tip z = +2.175
const ZT = -LENGTH / 2;        // tail tip z = -2.175
const ZAF = 1.31;              // front axle z
const ZAR = -1.31;             // rear axle z
const HUB_Y = WHEEL_R;         // wheel centre height at rest

// ---------------------------------------------------------------------------
// Monotone cubic (Fritsch–Carlson) — smooth, overshoot-free profile curves
// ---------------------------------------------------------------------------
function mono(pairs) {
  const p = [...pairs].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let lo = 0, hi = n - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x && x <= xs[mid + 1]) { i = mid; break; }
      if (x < xs[mid]) hi = mid - 1; else lo = mid + 1;
    }
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ---------------------------------------------------------------------------
// Longitudinal profiles (metres). z runs tail (−) → nose (+).
// ---------------------------------------------------------------------------
/** body top surface at centreline: ducktail lip → deck → tonneau → cowl → hood → nose */
const yTopC = mono([
  [ZT, 0.796], [-2.05, 0.820], [-1.80, 0.802], [-1.40, 0.796], [-1.00, 0.800],
  [-0.40, 0.806], [0.20, 0.790], [0.60, 0.775], [1.00, 0.745], [1.50, 0.700],
  [1.90, 0.648], [ZN, 0.600],
]);
/** beltline height — gentle wedge, dives with the nose */
const yBelt = mono([
  [ZT, 0.826], [-1.60, 0.844], [ZAR, 0.848], [-0.60, 0.836], [0.00, 0.822],
  [0.60, 0.808], [ZAF, 0.795], [1.75, 0.778], [2.00, 0.735], [ZN, 0.640],
]);
/** sill / underbody bottom (ride height ≈ 0.145) with approach/departure lift */
const yBot = mono([
  [ZT, 0.300], [-2.00, 0.225], [-1.75, 0.158], [-1.40, 0.130], [0.00, 0.126],
  [1.40, 0.130], [1.80, 0.148], [2.05, 0.198], [ZN, 0.295],
]);
/** plan half-width at the beltline, before fender bulge */
const wBase = mono([
  [ZT, 0.700], [-1.95, 0.790], [-1.70, 0.828], [ZAR, 0.856], [-0.90, 0.864],
  [-0.30, 0.868], [0.30, 0.864], [0.90, 0.850], [ZAF, 0.842], [1.70, 0.812],
  [2.00, 0.742], [ZN, 0.560],
]);
/** shoulder rise above the beltline (kept small — real tumblehome is the canopy) */
const riseAB = mono([
  [ZT, 0.010], [-1.50, 0.012], [-0.50, 0.015], [0.50, 0.014], [1.20, 0.010], [ZN, 0.007],
]);
/** top-band crown amplitude */
const crownAmp = mono([
  [ZT, 0.008], [-1.30, 0.008], [0.00, 0.006], [0.62, 0.012], [1.20, 0.014], [ZN, 0.010],
]);
/** side cross-section shape: x/w as function of t = (y−yBot)/(yBelt−yBot).
 *  Sill tucked in at the bottom, near-vertical upper bodyside, widest at belt. */
const sideShape = mono([[0, 0.858], [0.18, 0.938], [0.45, 0.975], [0.75, 0.994], [1, 1.0]]);

function bulge(z) {
  const q = (u) => (u < 1 ? (1 - u * u) * (1 - u * u) : 0);
  return 0.034 * q(Math.abs(z - ZAR) / 0.60) + 0.028 * q(Math.abs(z - ZAF) / 0.58);
}
/** plan half-width including fender bulge, clamped to the hard 1.78 m envelope */
function halfWidth(z) {
  return Math.min(W2, wBase(z) + bulge(z));
}
/** wheel-arch opening upper edge at longitudinal position z, or −Inf outside spans */
function archEdge(z) {
  for (const za of [ZAF, ZAR]) {
    const dz = z - za;
    if (Math.abs(dz) <= ARCH_R + 1e-12) {
      const s = Math.sqrt(Math.max(0, 1 - (dz / ARCH_R) * (dz / ARCH_R)));
      return HUB_Y + ARCH_B * s;
    }
  }
  return -Infinity;
}
/** bodyside x at (y, z) */
function sideX(y, z) {
  const yB = yBot(z), belt = yBelt(z);
  let t = (y - yB) / (belt - yB);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return halfWidth(z) * sideShape(t);
}

// ---------------------------------------------------------------------------
// Body cross-section ring
// Fixed topology: H=29 points per half ring, R=56 per full ring.
//  0..2   floor (centre → floor edge)
//  3..4   floor→side connectors (arch inner wall when inside an arch span)
//  5..14  side band (arch edge / sill bottom → just below belt)   [10 pts]
//  15..17 beltline crease chamfer
//  18     shoulder
//  19..28 top band (Hermite shoulder → centre, crowned)           [10 pts]
// ---------------------------------------------------------------------------
const SIDE_LO = 5, SIDE_HI = 14, H_HALF = 29, RING_N = 2 * H_HALF - 2;

function bodyHalfSection(z) {
  const w = halfWidth(z);
  const yB = yBot(z);
  const belt = yBelt(z);
  const top = yTopC(z);
  const rise = riseAB(z);
  const crown = crownAmp(z);
  const edge = archEdge(z);
  const yTerm = Math.max(yB, edge);
  const pts = [];
  const xF = Math.min(0.58, 0.82 * w);
  pts.push([0, yB], [0.5 * xF, yB], [xF, yB]);
  const yTopSide = belt - 0.016;
  const xSB = sideX(yTerm, z);
  pts.push([xF + (xSB - xF) * 0.45, yB + (yTerm - yB) * 0.45]);
  pts.push([xF + (xSB - xF) * 0.82, yB + (yTerm - yB) * 0.82]);
  for (let i = 0; i < 10; i++) {                       // side band, clustered low
    const u = Math.pow(i / 9, 1.25);
    const y = yTerm + (yTopSide - yTerm) * u;
    pts.push([sideX(y, z), y]);
  }
  pts.push([w, belt - 0.004]);                          // crease chamfer A
  pts.push([w - 0.001, belt + 0.003]);                  // crease chamfer B
  pts.push([w - 0.010, belt + 0.010]);                  // crease chamfer C
  const sx = w - 0.020, sy = belt + 0.010 + rise;       // shoulder
  pts.push([sx, sy]);
  // top band: cubic Hermite shoulder → centre, tangent-continuing the tumble
  const cx = w - 0.010, cy2 = belt + 0.010;
  let dx = sx - cx, dy = sy - cy2;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl; dy /= dl;
  const ex = 0, ey = top;
  const span = Math.hypot(ex - sx, ey - sy);
  const t0x = dx * span * 0.42, t0y = dy * span * 0.42;
  const t1x = -span * 0.95, t1y = 0;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    let px = h00 * sx + h10 * t0x + h01 * ex + h11 * t1x;
    let py = h00 * sy + h10 * t0y + h01 * ey + h11 * t1y;
    if (px < 0) px = 0;
    const s = Math.sin(Math.PI * t);
    py += crown * s * s;
    if (i === 10) { px = 0; py = top; }
    pts.push([px, py]);
  }
  return pts; // length H_HALF
}

/** full closed ring, exact mirror: k=0 bottom centre → +x side up → top centre → −x side down */
function bodyRing(z) {
  const half = bodyHalfSection(z);
  const ring = new Array(RING_N);
  for (let k = 0; k < H_HALF; k++) ring[k] = half[k];
  for (let k = H_HALF; k < RING_N; k++) {
    const s = half[2 * H_HALF - 2 - k];
    ring[k] = [-s[0], s[1]];
  }
  return ring;
}

/** z stations: cosine-clustered base + dense exact stations across each arch */
function bodyStations() {
  const raw = [];
  const NZ = 56;
  for (let i = 0; i < NZ; i++) {
    raw.push({ z: ZT + (ZN - ZT) * (0.5 - 0.5 * Math.cos((Math.PI * i) / (NZ - 1))), pri: i === 0 || i === NZ - 1 ? 2 : 0 });
  }
  for (const za of [ZAF, ZAR]) {
    for (let k = 0; k <= 20; k++) raw.push({ z: za + ARCH_R * Math.cos((Math.PI * k) / 20), pri: 1 });
    raw.push({ z: za + ARCH_R + 0.014, pri: 1 });
    raw.push({ z: za - ARCH_R - 0.014, pri: 1 });
  }
  raw.sort((a, b) => a.z - b.z);
  const out = [];
  for (const st of raw) {
    if (out.length && Math.abs(st.z - out[out.length - 1].z) < 0.006) {
      if (st.pri > out[out.length - 1].pri) out[out.length - 1] = st;
      continue;
    }
    out.push(st);
  }
  return out.map((s) => s.z);
}

// ---------------------------------------------------------------------------
// Greenhouse canopy (superellipse sections; split into glass / painted roof)
// ---------------------------------------------------------------------------
const CAB_R = -1.74, CAB_F = 0.62;   // canopy z range (fastback flows to the deck)
const NJ = 18;                        // half stations base→top; full ring 2*NJ+1
const SE_N = 2.6, SE_M = 2.1;         // superellipse exponents (side lean / roof crown)
const Z_ROOF_F = -0.10, Z_ROOF_R = -0.98, Z_CPIL = -1.24;
const J_CORNER = NJ * 0.62;

const roofC = mono([
  [CAB_F, 0.812], [0.30, 0.958], [0.02, 1.132], [-0.22, 1.230], [-0.48, 1.254],
  [-0.85, 1.236], [-1.10, 1.150], [-1.38, 1.030], [-1.60, 0.922],
  [CAB_R, 0.842],
]);
const planTaper = mono([
  [CAB_R, 0.990], [-1.20, 0.992], [-0.50, 1.0], [0.10, 0.995], [CAB_F, 0.925],
]);

function canopyParams(z) {
  const base = yBelt(z) + 0.004;
  const w = halfWidth(z) * planTaper(z) - 0.045;
  const h = Math.max(0.004, roofC(z) - base);
  return { base, w, h };
}
/** canopy point at fractional station jf ∈ [0, 2NJ]; exact mirror for jf > NJ */
function canopyPoint(z, jf) {
  if (jf > NJ) {
    const p = canopyPoint(z, 2 * NJ - jf);
    return [-p[0], p[1]];
  }
  const { base, w, h } = canopyParams(z);
  const phi = (jf / NJ) * (Math.PI / 2);
  const x = jf >= NJ ? 0 : w * Math.pow(Math.cos(phi), 2 / SE_N);
  const y = base + (jf <= 0 ? 0 : h * Math.pow(Math.sin(phi), 2 / SE_M));
  return [x, y];
}
/** canopy top surface height at (x, z) — used for wipers; even in x */
function canopyTopY(x, z) {
  const { base, w, h } = canopyParams(z);
  const c = Math.min(1, Math.abs(x) / w);
  const phi = Math.acos(Math.pow(c, SE_N / 2));
  return base + h * Math.pow(Math.sin(phi), 2 / SE_M);
}
function canopyStations() {
  const raw = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    raw.push(CAB_R + (CAB_F - CAB_R) * (0.5 - 0.5 * Math.cos((Math.PI * i) / (N - 1))));
  }
  raw.push(Z_ROOF_F, Z_ROOF_R, Z_CPIL);
  raw.sort((a, b) => a - b);
  const out = [];
  for (const z of raw) {
    if (out.length && Math.abs(z - out[out.length - 1]) < 0.005) continue;
    out.push(z);
  }
  return out;
}
function canopyClass(zc, jm) {
  const inTop = jm > J_CORNER && jm < 2 * NJ - J_CORNER;
  if (zc > Z_ROOF_R && zc < Z_ROOF_F && inTop) return 'roof';
  if (zc < Z_CPIL && !(jm > NJ * 0.70 && jm < 2 * NJ - NJ * 0.70)) return 'roof'; // C-pillar, painted
  return 'glass';
}

// ---------------------------------------------------------------------------
// body top surface y at (x, z) — for the cowl / trunk-seam skirts; even in x
// ---------------------------------------------------------------------------
function bodyTopY(x, z) {
  const half = bodyHalfSection(z);
  const ax = Math.abs(x);
  // walk top band (indices 18..28), x decreasing from shoulder to 0
  for (let k = 18; k < H_HALF - 1; k++) {
    const a = half[k], b = half[k + 1];
    if (ax <= a[0] && ax >= b[0]) {
      const t = a[0] === b[0] ? 0 : (a[0] - ax) / (a[0] - b[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  if (ax >= half[18][0]) return half[18][1];
  return half[H_HALF - 1][1];
}

// ---------------------------------------------------------------------------
// Face probes (bisection on the pure section math) — used to place flush
// details on the nose / tail / bodyside without any ragged intersections.
// ---------------------------------------------------------------------------
function insideAtZ(x, y, z) {
  if (z < ZT || z > ZN) return false;
  if (y < yBot(z) || y > yBelt(z) - 0.02) return false;
  return Math.abs(x) <= sideX(y, z);
}
function zFaceFront(x, y) {
  if (insideAtZ(x, y, ZN)) return ZN;
  let lo = 1.55, hi = ZN;
  if (!insideAtZ(x, y, lo)) return NaN;
  for (let i = 0; i < 36; i++) {
    const mid = 0.5 * (lo + hi);
    if (insideAtZ(x, y, mid)) lo = mid; else hi = mid;
  }
  return lo;
}
function zFaceRear(x, y) {
  if (insideAtZ(x, y, ZT)) return ZT;
  let lo = -1.55, hi = ZT;
  if (!insideAtZ(x, y, lo)) return NaN;
  for (let i = 0; i < 36; i++) {
    const mid = 0.5 * (lo + hi);
    if (insideAtZ(x, y, mid)) lo = mid; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Geometry accumulator + normals (Babylon winding: faceN = cross(p1−p2, p3−p2))
// ---------------------------------------------------------------------------
function newGeo() { return { p: [], i: [] }; }
function pushV(g, x, y, z) { g.p.push(x, y, z); return g.p.length / 3 - 1; }
/** stitch a rows×cols grid of vertex indices into quads (two tris each) */
function stitchRows(g, rows, flip, wrap) {
  const R = rows.length;
  for (let r = 0; r < R - 1; r++) {
    const C = rows[r].length;
    const lim = wrap ? C : C - 1;
    for (let c = 0; c < lim; c++) {
      const c1 = (c + 1) % C;
      const a = rows[r][c], b = rows[r][c1], cc = rows[r + 1][c], d = rows[r + 1][c1];
      if (flip) g.i.push(a, b, cc, b, d, cc);
      else g.i.push(a, cc, b, b, cc, d);
    }
  }
}
function mergeGeos(list) {
  const g = newGeo();
  for (const s of list) {
    const off = g.p.length / 3;
    for (let k = 0; k < s.p.length; k++) g.p.push(s.p[k]);
    for (let k = 0; k < s.i.length; k++) g.i.push(s.i[k] + off);
  }
  return g;
}
function mirrorGeo(s) {
  const g = newGeo();
  for (let k = 0; k < s.p.length; k += 3) g.p.push(-s.p[k], s.p[k + 1], s.p[k + 2]);
  for (let k = 0; k < s.i.length; k += 3) g.i.push(s.i[k], s.i[k + 2], s.i[k + 1]);
  return g;
}
/** area-weighted smooth normals, Babylon LH convention */
function computeNormals(g) {
  const n = new Float64Array(g.p.length);
  const p = g.p, idx = g.i;
  for (let f = 0; f < idx.length; f += 3) {
    const i1 = idx[f] * 3, i2 = idx[f + 1] * 3, i3 = idx[f + 2] * 3;
    const ax = p[i1] - p[i2], ay = p[i1 + 1] - p[i2 + 1], az = p[i1 + 2] - p[i2 + 2];
    const bx = p[i3] - p[i2], by = p[i3 + 1] - p[i2 + 1], bz = p[i3 + 2] - p[i2 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    n[i1] += nx; n[i1 + 1] += ny; n[i1 + 2] += nz;
    n[i2] += nx; n[i2 + 1] += ny; n[i2 + 2] += nz;
    n[i3] += nx; n[i3 + 1] += ny; n[i3 + 2] += nz;
  }
  const out = new Float32Array(g.p.length);
  for (let k = 0; k < n.length; k += 3) {
    const l = Math.hypot(n[k], n[k + 1], n[k + 2]);
    if (l > 1e-12) { out[k] = n[k] / l; out[k + 1] = n[k + 1] / l; out[k + 2] = n[k + 2] / l; }
    else { out[k] = 0; out[k + 1] = 1; out[k + 2] = 0; }
  }
  return out;
}
/** signed volume (right-handed convention) — Babylon-outward closed meshes come out negative */
function signedVolume(g) {
  const p = g.p, idx = g.i;
  let v = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
       + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// ---------------------------------------------------------------------------
// Builders (all pure — return geos)
// ---------------------------------------------------------------------------
function buildBodyLoft() {
  const zs = bodyStations();
  const g = newGeo();
  const rows = [];
  for (const z of zs) {
    const ring = bodyRing(z);
    const row = new Array(RING_N);
    for (let k = 0; k < RING_N; k++) row[k] = pushV(g, ring[k][0], ring[k][1], z);
    rows.push(row);
  }
  stitchRows(g, rows, false, true);
  // nose cap (faces +Z): fan (v_k, centre, v_{k+1})
  {
    const z = zs[zs.length - 1];
    const c = pushV(g, 0, (yBot(z) + yBelt(z)) * 0.5, z);
    const row = rows[rows.length - 1];
    for (let k = 0; k < RING_N; k++) g.i.push(row[k], c, row[(k + 1) % RING_N]);
  }
  // tail cap (faces −Z): reversed fan
  {
    const z = zs[0];
    const c = pushV(g, 0, (yBot(z) + yBelt(z)) * 0.5, z);
    const row = rows[0];
    for (let k = 0; k < RING_N; k++) g.i.push(row[(k + 1) % RING_N], c, row[k]);
  }
  return { geo: g, zs, rows };
}

function buildCanopy() {
  const zs = canopyStations();
  const secs = zs.map((z) => {
    const pts = new Array(2 * NJ + 1);
    for (let j = 0; j <= 2 * NJ; j++) pts[j] = canopyPoint(z, j);
    return pts;
  });
  const glass = newGeo(), roof = newGeo();
  const cacheG = new Map(), cacheR = new Map();
  const getV = (geo, cache, s, j) => {
    const key = s * 100 + j;
    let v = cache.get(key);
    if (v === undefined) {
      const p = secs[s][j];
      v = pushV(geo, p[0], p[1], zs[s]);
      cache.set(key, v);
    }
    return v;
  };
  for (let s = 0; s < zs.length - 1; s++) {
    const zc = 0.5 * (zs[s] + zs[s + 1]);
    for (let j = 0; j < 2 * NJ; j++) {
      const cls = canopyClass(zc, j + 0.5);
      const geo = cls === 'roof' ? roof : glass;
      const cache = cls === 'roof' ? cacheR : cacheG;
      const a = getV(geo, cache, s, j), b = getV(geo, cache, s, j + 1);
      const c = getV(geo, cache, s + 1, j), d = getV(geo, cache, s + 1, j + 1);
      geo.i.push(a, c, b, b, c, d); // same outward orientation as the body loft
    }
  }
  return { glass, roof };
}

/** ribbon lying on the canopy surface, offset outward — pillar bands / rubber lines */
function canopyRibbon(z0, z1, j0, j1, offset, nz, njr) {
  const g = newGeo();
  const rows = [];
  for (let r = 0; r <= nz; r++) {
    const z = z0 + (z1 - z0) * (r / nz);
    const { base, h } = canopyParams(z);
    const cy = base + h * 0.4;
    const row = [];
    for (let c = 0; c <= njr; c++) {
      const jf = j0 + (j1 - j0) * (c / njr);
      const p = canopyPoint(z, jf);
      const q = canopyPoint(z, Math.min(2 * NJ, jf + 0.05));
      let tx = q[0] - p[0], ty = q[1] - p[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      let nx = ty, ny = -tx;                       // 2D perp
      if (nx * p[0] + ny * (p[1] - cy) < 0) { nx = -nx; ny = -ny; } // outward
      row.push(pushV(g, p[0] + nx * offset, p[1] + ny * offset, z));
    }
    rows.push(row);
  }
  stitchRows(g, rows, false, false);
  return g;
}

/** symmetric x column positions (bit-exact left/right) */
function symCols(maxX, halfN) {
  const cols = [];
  for (let i = halfN; i >= 1; i--) cols.push(-(maxX * i) / halfN);
  cols.push(0);
  for (let i = 1; i <= halfN; i++) cols.push((maxX * i) / halfN);
  return cols;
}

/** stadium (rounded-ends) patch flush on the nose or tail face.
 *  When x0 === -x1 columns are generated as bit-exact mirrored pairs. */
function facePatch(rear, x0, x1, yC, yH, rFrac, offset, nu, nv, flip) {
  const g = newGeo();
  const rows = [];
  const sym = x0 === -x1;
  const hn = nu >> 1;
  const rF2 = rFrac * 2; // end-rounding fraction in |u| space for the symmetric path
  const addRow = (x, a) => {
    // a in [0,1]: 0 at patch centreline of the length axis, 1 at the ends
    let sc = 1;
    if (a > 1 - rF2) sc = Math.sqrt(Math.max(0, 1 - ((a - (1 - rF2)) / rF2) ** 2));
    sc = Math.max(sc, 0.12);
    const row = [];
    for (let iv = 0; iv <= nv; iv++) {
      const y = yC + ((iv / nv) * 2 - 1) * yH * sc;
      const zf = rear ? zFaceRear(x, y) : zFaceFront(x, y);
      const z = rear ? zf - offset : zf + offset;
      row.push(pushV(g, x, y, z));
    }
    rows.push(row);
  };
  if (sym) {
    for (let iu = -hn; iu <= hn; iu++) {
      const a = Math.abs(iu) / hn;
      addRow((iu / hn) * x1, a);
    }
  } else {
    for (let iu = 0; iu <= nu; iu++) {
      const u = iu / nu;
      addRow(x0 + (x1 - x0) * u, Math.abs(2 * u - 1));
    }
  }
  stitchRows(g, rows, flip, false);
  return g;
}

/** stadium patch flush on the +x bodyside (mirror separately for the left) */
function sidePatch(z0, z1, yC, yH, rFrac, offset, nu, nv) {
  const g = newGeo();
  const rows = [];
  for (let iu = 0; iu <= nu; iu++) {
    const u = iu / nu;
    const z = z0 + (z1 - z0) * u;
    let sc = 1;
    if (u < rFrac) sc = Math.sqrt(Math.max(0, 1 - ((rFrac - u) / rFrac) ** 2));
    else if (u > 1 - rFrac) sc = Math.sqrt(Math.max(0, 1 - ((u - (1 - rFrac)) / rFrac) ** 2));
    sc = Math.max(sc, 0.12);
    const row = [];
    for (let iv = 0; iv <= nv; iv++) {
      const y = yC + ((iv / nv) * 2 - 1) * yH * sc;
      row.push(pushV(g, sideX(y, z) + offset, y, z));
    }
    rows.push(row);
  }
  stitchRows(g, rows, false, false);
  return g;
}

/** rocker strip on the +x sill between the arches */
function rockerStrip() {
  const g = newGeo();
  const rows = [];
  for (let r = 0; r <= 14; r++) {
    const z = -0.85 + 1.70 * (r / 14);
    const row = [];
    for (let c = 0; c <= 2; c++) {
      const y = 0.147 + 0.055 * (c / 2);
      row.push(pushV(g, sideX(y, z) + 0.004, y, z));
    }
    rows.push(row);
  }
  stitchRows(g, rows, false, false);
  return g;
}

/** skirt bridging the canopy base edge down/out to the body surface (+x side) */
function beltSkirt() {
  const g = newGeo();
  const rows = [];
  for (let r = 0; r <= 22; r++) {
    const z = CAB_R + 0.02 + (CAB_F - 0.02 - (CAB_R + 0.02)) * (r / 22);
    const belt = yBelt(z);
    const row = [
      pushV(g, sideX(belt - 0.004, z) + 0.003, belt - 0.004, z),
      pushV(g, canopyPoint(z, 0.6)[0] + 0.004, canopyPoint(z, 0.6)[1] + 0.002, z),
    ];
    rows.push(row);
  }
  stitchRows(g, rows, false, false);
  return g;
}

/** cowl panel bridging hood rear edge → windscreen base (full width, dark) */
function cowlSkirt() {
  const g = newGeo();
  const cols = symCols(0.72, 8);
  const rowsPts = [
    cols.map((x) => [x * 1.02, bodyTopY(x * 1.02, 0.70) + 0.003, 0.70]),
    cols.map((x) => [x, canopyTopY(x, 0.585) + 0.004, 0.585]),
  ];
  const rows = rowsPts.map((pts) => pts.map((p) => pushV(g, p[0], p[1], p[2])));
  stitchRows(g, rows, true, false);
  return g;
}
/** trunk seam panel bridging rear glass base → deck (full width, dark) */
function trunkSkirt() {
  const g = newGeo();
  const cols = symCols(0.70, 8);
  const rowsPts = [
    cols.map((x) => [x * 1.03, bodyTopY(x * 1.03, -1.46) + 0.003, -1.46]),
    cols.map((x) => [x, canopyTopY(x, -1.335) + 0.004, -1.335]),
  ];
  const rows = rowsPts.map((pts) => pts.map((p) => pushV(g, p[0], p[1], p[2])));
  stitchRows(g, rows, false, false);
  return g;
}

/** parked wiper: thin strip lying on the windscreen */
function wiperStrip(x0, z0, x1, z1) {
  const g = newGeo();
  let dx = x1 - x0, dz = z1 - z0;
  const l = Math.hypot(dx, dz) || 1;
  const px = -dz / l, pz = dx / l;       // perp in plan
  const wHalf = 0.009;
  const rows = [];
  for (let r = 0; r <= 8; r++) {
    const t = r / 8;
    const cx = x0 + dx * t, cz = z0 + dz * t;
    const row = [];
    for (const s of [-wHalf, wHalf]) {
      const x = cx + px * s, z = cz + pz * s;
      row.push(pushV(g, x, canopyTopY(x, z) + 0.006, z));
    }
    rows.push(row);
  }
  stitchRows(g, rows, true, false);
  return g;
}

/** wheel-arch liner: inward-facing half-cylinder + inboard cap (+x side) */
function linerGeo(zAxle) {
  const g = newGeo();
  const rows = [];
  const NA = 18, NX = 3;
  const xIn = 0.54, xOut = 0.85;
  for (let ia = 0; ia <= NA; ia++) {
    const th = -0.14 + (Math.PI + 0.28) * (ia / NA);
    const row = [];
    for (let ix = 0; ix <= NX; ix++) {
      const u = ix / NX;
      const x = xIn + (xOut - xIn) * u;
      const r = 0.368 + 0.052 * u;
      row.push(pushV(g, x, HUB_Y + r * Math.sin(th), zAxle + r * Math.cos(th)));
    }
    rows.push(row);
  }
  stitchRows(g, rows, true, false); // flipped: normals face the axis (visible side)
  // inboard cap, facing outboard (+x)
  const c = pushV(g, xIn, HUB_Y, zAxle);
  for (let ia = 0; ia < NA; ia++) {
    g.i.push(rows[ia][0], c, rows[ia + 1][0]);
  }
  return g;
}

/** door mirror (+x side): ellipsoid head + tapered stalk, one geo */
function mirrorSideGeo() {
  const g = newGeo();
  // head
  const cx = 0.935, cy = 0.895, cz = 0.44;
  const ax = 0.078, ay = 0.050, az = 0.038;
  const NLat = 8, NLon = 14;
  const rows = [];
  for (let i = 0; i <= NLat; i++) {
    const th = (Math.PI * i) / NLat;
    const row = [];
    for (let j = 0; j <= NLon; j++) {
      const ph = (2 * Math.PI * j) / NLon;
      row.push(pushV(g,
        cx + ax * Math.sin(th) * Math.cos(ph),
        cy + ay * Math.cos(th),
        cz + az * Math.sin(th) * Math.sin(ph)));
    }
    rows.push(row);
  }
  stitchRows(g, rows, false, false);
  // stalk: body shoulder → head underside
  const p0 = [0.845, 0.836, 0.465], p1 = [0.915, 0.885, 0.445];
  let axv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const al = Math.hypot(...axv); axv = axv.map((v) => v / al);
  let u = [axv[1], -axv[0], 0];
  const ul = Math.hypot(...u) || 1; u = u.map((v) => v / ul);
  const v = [axv[1] * u[2] - axv[2] * u[1], axv[2] * u[0] - axv[0] * u[2], axv[0] * u[1] - axv[1] * u[0]];
  const srows = [];
  for (let e = 0; e <= 1; e++) {
    const c = e ? p1 : p0;
    const r = e ? 0.014 : 0.020;
    const row = [];
    for (let j = 0; j <= 10; j++) {
      const ph = (2 * Math.PI * j) / 10;
      row.push(pushV(g,
        c[0] + (u[0] * Math.cos(ph) + v[0] * Math.sin(ph)) * r,
        c[1] + (u[1] * Math.cos(ph) + v[1] * Math.sin(ph)) * r,
        c[2] + (u[2] * Math.cos(ph) + v[2] * Math.sin(ph)) * r));
    }
    row.push(row[0]);
    srows.push(row);
  }
  stitchRows(g, srows, true, false);
  return g;
}

// ---------------------------------------------------------------------------
// Assemble all geometry (pure)
// ---------------------------------------------------------------------------
function buildAllGeometry() {
  const loft = buildBodyLoft();
  const canopy = buildCanopy();
  const bodyGeo = mergeGeos([loft.geo, canopy.roof]);
  const glassGeo = canopy.glass;

  // ---- trim ----
  const trimParts = [];
  const drip = canopyRibbon(CAB_R + 0.01, CAB_F - 0.02, J_CORNER - 1.4, J_CORNER + 1.7, 0.005, 26, 3);
  trimParts.push(drip, mirrorGeo(drip));
  const bpil = canopyRibbon(-0.36, -0.28, 0.4, J_CORNER + 0.8, 0.005, 3, 8);
  trimParts.push(bpil, mirrorGeo(bpil));
  const srear = canopyRibbon(-1.00, -0.92, 0.4, J_CORNER + 0.4, 0.005, 3, 8);
  trimParts.push(srear, mirrorGeo(srear));
  const skirt = beltSkirt();
  trimParts.push(skirt, mirrorGeo(skirt));
  const rocker = rockerStrip();
  trimParts.push(rocker, mirrorGeo(rocker));
  trimParts.push(cowlSkirt(), trunkSkirt());
  trimParts.push(facePatch(false, -0.64, 0.64, 0.3475, 0.0475, 0.18, 0.003, 20, 3, true)); // front lower fascia
  trimParts.push(facePatch(false, -0.30, 0.30, 0.4475, 0.0275, 0.22, 0.004, 14, 2, true)); // grille slot
  trimParts.push(facePatch(true, -0.63, 0.63, 0.3650, 0.0550, 0.18, 0.003, 20, 3, false)); // rear lower fascia
  trimParts.push(facePatch(true, -0.685, 0.685, 0.7450, 0.0500, 0.10, 0.003, 24, 3, false)); // rear light bezel
  const handle = sidePatch(0.06, 0.24, 0.789, 0.014, 0.30, 0.006, 8, 2);
  trimParts.push(handle, mirrorGeo(handle));
  const wiper = wiperStrip(-0.50, 0.595, -0.08, 0.555);
  trimParts.push(wiper, mirrorGeo(wiper)); // opposed-pattern parked wipers, exact mirror
  const trimGeo = mergeGeos(trimParts);

  // ---- lights ----
  const drl = facePatch(false, 0.20, 0.62, 0.5225, 0.0225, 0.28, 0.005, 12, 2, true);
  const lightsFrontGeo = mergeGeos([drl, mirrorGeo(drl)]);
  const lightsRearGeo = facePatch(true, -0.655, 0.655, 0.7450, 0.0300, 0.10, 0.006, 24, 2, false);

  // ---- liners ----
  const linF = linerGeo(ZAF), linR = linerGeo(ZAR);
  const linersGeo = mergeGeos([linF, linR, mirrorGeo(linF), mirrorGeo(linR)]);

  // ---- mirrors ----
  const mirR = mirrorSideGeo();
  const mirrorsGeo = mergeGeos([mirR, mirrorGeo(mirR)]);

  const dims = {
    length: LENGTH,
    width: WIDTH,
    wheelbase: WHEELBASE,
    track: TRACK,
    wheelRadius: WHEEL_R,
    archRadius: ARCH_R,
    wheelCenters: [
      { x: -TRACK / 2, y: HUB_Y, z: ZAF }, // FL
      { x: TRACK / 2, y: HUB_Y, z: ZAF },  // FR
      { x: -TRACK / 2, y: HUB_Y, z: ZAR }, // RL
      { x: TRACK / 2, y: HUB_Y, z: ZAR },  // RR
    ],
  };
  return {
    bodyGeo, glassGeo, trimGeo, linersGeo, lightsFrontGeo, lightsRearGeo, mirrorsGeo, dims,
    meta: { sections: loft.zs.length, ringN: RING_N, loftZs: loft.zs },
  };
}

// ---------------------------------------------------------------------------
// Babylon assembly
// ---------------------------------------------------------------------------
function toMesh(name, scene, geo) {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = new Float32Array(geo.p);
  vd.indices = new Uint32Array(geo.i);
  vd.normals = computeNormals(geo);
  vd.applyToMesh(mesh, false);
  mesh.isPickable = false;
  return mesh;
}

/**
 * Build the coupe body shell. All meshes are in the LOCAL car frame with
 * identity transforms — the integrator parents and paints them.
 * @param {import('@babylonjs/core').Scene} scene
 */
export function buildCarBody(scene) {
  const g = buildAllGeometry();
  return {
    body: toMesh('carBodyShell', scene, g.bodyGeo),
    glass: toMesh('carGlass', scene, g.glassGeo),
    trim: toMesh('carTrim', scene, g.trimGeo),
    liners: toMesh('carArchLiners', scene, g.linersGeo),
    lightsFront: toMesh('carLightsFront', scene, g.lightsFrontGeo),
    lightsRear: toMesh('carLightsRear', scene, g.lightsRearGeo),
    mirrors: toMesh('carMirrors', scene, g.mirrorsGeo),
    dims: g.dims,
  };
}

/** Validation hook: raw geometry without touching Babylon (Node-safe). */
export function __geometry() {
  return buildAllGeometry();
}

// ---------------------------------------------------------------------------
// Node validation harness (no Babylon objects constructed — pure data checks)
// ---------------------------------------------------------------------------
export function __selftest() {
  const g = buildAllGeometry();
  const report = [];
  const fail = [];
  const geos = {
    body: g.bodyGeo, glass: g.glassGeo, trim: g.trimGeo, liners: g.linersGeo,
    lightsFront: g.lightsFrontGeo, lightsRear: g.lightsRearGeo, mirrors: g.mirrorsGeo,
  };
  // 1. NaN scan + counts
  for (const [name, geo] of Object.entries(geos)) {
    let nan = 0;
    for (const v of geo.p) if (!Number.isFinite(v)) nan++;
    const n = computeNormals(geo);
    let nnan = 0;
    for (const v of n) if (!Number.isFinite(v)) nnan++;
    if (nan || nnan) fail.push(`${name}: ${nan} NaN positions, ${nnan} NaN normals`);
    report.push(`${name}: ${geo.p.length / 3} verts, ${geo.i.length / 3} tris`);
  }
  // 2. exact left/right symmetry (bit-exact partner for every vertex)
  for (const [name, geo] of Object.entries(geos)) {
    const set = new Map();
    for (let k = 0; k < geo.p.length; k += 3) {
      const key = `${geo.p[k]}|${geo.p[k + 1]}|${geo.p[k + 2]}`;
      set.set(key, (set.get(key) || 0) + 1);
    }
    let bad = 0;
    for (let k = 0; k < geo.p.length; k += 3) {
      const mk = `${-geo.p[k]}|${geo.p[k + 1]}|${geo.p[k + 2]}`;
      if (!set.has(mk)) bad++;
    }
    if (bad) fail.push(`${name}: ${bad} vertices without mirrored partner`);
  }
  // 3. bbox + landmarks
  const bb = (geo) => {
    const b = { x: [1e9, -1e9], y: [1e9, -1e9], z: [1e9, -1e9] };
    for (let k = 0; k < geo.p.length; k += 3) {
      b.x[0] = Math.min(b.x[0], geo.p[k]); b.x[1] = Math.max(b.x[1], geo.p[k]);
      b.y[0] = Math.min(b.y[0], geo.p[k + 1]); b.y[1] = Math.max(b.y[1], geo.p[k + 1]);
      b.z[0] = Math.min(b.z[0], geo.p[k + 2]); b.z[1] = Math.max(b.z[1], geo.p[k + 2]);
    }
    return b;
  };
  const bbB = bb(g.bodyGeo), bbG = bb(g.glassGeo);
  report.push(`body bbox x[${bbB.x[0].toFixed(4)},${bbB.x[1].toFixed(4)}] y[${bbB.y[0].toFixed(4)},${bbB.y[1].toFixed(4)}] z[${bbB.z[0].toFixed(4)},${bbB.z[1].toFixed(4)}]`);
  if (Math.abs(bbB.x[1] - W2) > 1e-6 || Math.abs(bbB.x[0] + W2) > 1e-6) fail.push(`body width ${bbB.x[1] - bbB.x[0]} != ${WIDTH}`);
  if (Math.abs(bbB.z[1] - ZN) > 1e-9 || Math.abs(bbB.z[0] - ZT) > 1e-9) fail.push(`body length ${bbB.z[1] - bbB.z[0]} != ${LENGTH}`);
  if (Math.abs(bbB.y[0] - 0.145) > 2e-3) fail.push(`body sill bottom ${bbB.y[0]} != 0.145`);
  // max-width location
  let wMaxZ = 0;
  for (let k = 0; k < g.bodyGeo.p.length; k += 3) {
    if (g.bodyGeo.p[k] > W2 - 1e-7) { wMaxZ = g.bodyGeo.p[k + 2]; break; }
  }
  report.push(`max half-width ${bbB.x[1].toFixed(4)} reached near z=${wMaxZ.toFixed(3)} (rear arch at ${ZAR})`);
  // roof peak from glass+roof
  let peakY = -1, peakZ = 0;
  for (const geo of [g.glassGeo, g.bodyGeo]) {
    for (let k = 0; k < geo.p.length; k += 3) {
      if (geo.p[k + 1] > peakY) { peakY = geo.p[k + 1]; peakZ = geo.p[k + 2]; }
    }
  }
  report.push(`roof peak y=${peakY.toFixed(4)} at z=${peakZ.toFixed(3)} (target 1.31 @ -0.15)`);
  if (Math.abs(peakY - 1.31) > 0.02) fail.push(`roof peak ${peakY} off target 1.31`);
  if (Math.abs(peakZ + 0.15) > 0.12) fail.push(`roof peak z ${peakZ} off target -0.15`);
  // 4. loft orientation: closed body loft volume must be negative (Babylon-outward) and car-sized
  const loft = buildBodyLoft();
  const vol = signedVolume(loft.geo);
  report.push(`body loft signed volume ${vol.toFixed(3)} m^3 (expect ~ -4..-7)`);
  if (!(vol < -3 && vol > -8)) fail.push(`body loft volume ${vol} out of range — winding or shape broken`);
  // 5. arch cleanliness: side-band ring points must sit on/above the opening edge
  let archBad = 0;
  const edgeExtF = [ZAF - ARCH_R, ZAF + ARCH_R], edgeExtR = [ZAR - ARCH_R, ZAR + ARCH_R];
  for (const z of loft.zs) {
    const e = archEdge(z);
    if (e === -Infinity) continue;
    const half = bodyHalfSection(z);
    for (let k = SIDE_LO; k <= SIDE_HI; k++) {
      if (half[k][1] < e - 1e-6) archBad++;
    }
  }
  if (archBad) fail.push(`${archBad} side-band points below arch edge`);
  report.push(`arch spans F[${edgeExtF[0].toFixed(2)},${edgeExtF[1].toFixed(2)}] R[${edgeExtR[0].toFixed(2)},${edgeExtR[1].toFixed(2)}], top edge y=${(HUB_Y + ARCH_B).toFixed(3)}`);
  // 6. per-part normal orientation
  const meanDot = (geo, refFn) => {
    const n = computeNormals(geo);
    let s = 0, c = 0;
    for (let k = 0; k < geo.p.length; k += 3) {
      const r = refFn(geo.p[k], geo.p[k + 1], geo.p[k + 2]);
      const l = Math.hypot(...r) || 1;
      s += (n[k] * r[0] + n[k + 1] * r[1] + n[k + 2] * r[2]) / l;
      c++;
    }
    return s / c;
  };
  const dF = meanDot(g.lightsFrontGeo, () => [0, 0, 1]);
  const dR = meanDot(g.lightsRearGeo, () => [0, 0, -1]);
  const dGl = meanDot(g.glassGeo, (x, y, z) => [x, y - 0.70, 0]);
  const dLin = meanDot(g.linersGeo, (x, y, z) => {
    const za = z > 0 ? ZAF : ZAR;
    return [0, HUB_Y - y, za - z]; // toward the axis = visible side
  });
  const volM = signedVolume(g.mirrorsGeo);
  report.push(`normals: DRL·+Z=${dF.toFixed(2)} rear·-Z=${dR.toFixed(2)} glass·out=${dGl.toFixed(2)} liners·in=${dLin.toFixed(2)} mirrors vol=${volM.toFixed(5)}`);
  if (dF < 0.7) fail.push(`front lights normals not facing +Z (${dF})`);
  if (dR < 0.7) fail.push(`rear lights normals not facing -Z (${dR})`);
  if (dGl < 0.5) fail.push(`glass normals not outward (${dGl})`);
  if (dLin < 0.3) fail.push(`liner normals not inward-facing (${dLin})`);
  if (!(volM < 0)) fail.push(`mirrors winding inverted (vol ${volM})`);
  // 7. probes all resolved (facePatch would have produced NaN otherwise — rechecked in scan 1)
  report.push(`loft: ${g.meta.sections} sections x ${g.meta.ringN} ring points`);
  const out = report.join('\n');
  if (fail.length) {
    console.log(out);
    console.error('SELFTEST FAILURES:\n' + fail.join('\n'));
    if (typeof process !== 'undefined') process.exitCode = 1;
    return false;
  }
  console.log(out + '\nSELFTEST OK');
  return true;
}
