/**
 * carWheels.js — one detailed wheel + tyre assembly for the NIGHTLOOP hero car.
 * Instanced 4x by the integrator (car.js).
 *
 * Frame: origin at hub centre, axle along +X (left-side orientation: +X points
 * OUT of the car on the left wheels). Spin = rotation.x on `tire` and `rim`.
 * `brake` (disc + caliper) is a sibling under `root` and must NOT be spun.
 * For the right side call buildWheel(scene, -1) and rotate the root PI about Y
 * — geometry for side=-1 is built as the exact z-mirror (flipped spoke sweep,
 * flipped caliper clock position), never via negative scale.
 *
 * All profile/section evaluation is pure math (plain arrays) so it can be
 * validated in Node:  `node src/vehicle/carWheels.js`  runs __selftest() and
 * prints extremes/counts. Babylon usage is confined to buildWheel().
 *
 * Meshes carry NO material (integrator applies tyre rubber / rim alloy /
 * brake dark-slate). Names: wheelTire_L/R, wheelRim_L/R, wheelBrake_L/R.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';

// ---------------------------------------------------------------------------
// dimensions (metres)
// ---------------------------------------------------------------------------
export const TYRE_R = 0.325;        // tread crown radius
export const TYRE_W = 0.245;        // nominal section width
const TYRE_HALF_TREAD = 0.098;      // tread band half width
const TYRE_HALF_BULGE = 0.1265;     // section half width at mid-sidewall bulge
const TYRE_BEAD_R = 0.21;           // bead seat radius (tucks to the rim here)
const TYRE_REV = 128;               // revolve steps around the axle
const TREAD_RIBS = 32;              // faint radial tread ribs
const RIB_AMP = 0.0022;             // rib groove depth (cuts in, crown stays 0.325)

const RIM_LIP_R = 0.215;            // 17"-style outer lip radius
const RIM_REV = 96;
const DISH_LIP_A = 0.112;           // outboard lip plane (x)
const DISH_HUB_A = 0.0585;          // hub boss face plane (x)  => dish ~0.054 deep

const DISC_R = 0.15;
const DISC_HALF_T = 0.012;          // thickness 0.024

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------
function makeGeo() { return { pos: [], nor: [], uv: [], idx: [] }; }

function smoothstep01(t) { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); }

function crVal(a, b, c, d, t) {
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
}

/** Catmull-Rom through 2D points, clamped ends. Includes both endpoints. */
function catmull(pts, subdiv) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < subdiv; k++) {
      const t = k / subdiv;
      out.push([crVal(p0[0], p1[0], p2[0], p3[0], t), crVal(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

/** Babylon front-face normal of triangle (p0,p1,p2) = (p2-p0) x (p1-p0). */
function faceNormal(P, i0, i1, i2, out) {
  const x0 = P[i0 * 3], y0 = P[i0 * 3 + 1], z0 = P[i0 * 3 + 2];
  const ax = P[i2 * 3] - x0, ay = P[i2 * 3 + 1] - y0, az = P[i2 * 3 + 2] - z0;
  const bx = P[i1 * 3] - x0, by = P[i1 * 3 + 1] - y0, bz = P[i1 * 3 + 2] - z0;
  out[0] = ay * bz - az * by; out[1] = az * bx - ax * bz; out[2] = ax * by - ay * bx;
}

// ---------------------------------------------------------------------------
// TYRE — closed cross-section loop (a = axial, r = radius), revolved with
// faint radial rib modulation. Traversal: outboard bead -> outboard sidewall
// -> tread (a + to -) -> inboard sidewall -> inboard bead -> inner barrel.
// CCW in (a, r), so outward 2D normal = (r', -a').
// ---------------------------------------------------------------------------
const SIDEWALL_CTRL = [
  [0.0880, 0.2020],   // bead toe (hidden inside rim flange)
  [0.0930, TYRE_BEAD_R], // bead tucks to the rim at r ~ 0.21
  [0.1040, 0.2180],
  [0.1180, 0.2450],
  [TYRE_HALF_BULGE, 0.2680], // max bulge at mid sidewall
  [0.1210, 0.2920],
  [0.1120, 0.3080],   // shoulder start
  [0.1000, 0.3185],   // shoulder chamfer
  [TYRE_HALF_TREAD, 0.3215], // tread edge
];
const GROOVES = [[-0.058, 0.0018], [-0.022, 0.0018], [0.022, 0.0018], [0.058, 0.0018]];
const GROOVE_SIGMA = 0.0042;

function treadRadius(a) {
  let r = TYRE_R - 0.0035 * (a / TYRE_HALF_TREAD) * (a / TYRE_HALF_TREAD);
  for (let i = 0; i < GROOVES.length; i++) {
    const d = (a - GROOVES[i][0]) / GROOVE_SIGMA;
    r -= GROOVES[i][1] * Math.exp(-d * d);
  }
  return r;
}

/**
 * Pure: closed tyre section loop.
 * @returns {{loop:number[][], mask:number[], treadStart:number, treadEnd:number}}
 */
export function buildTyreSection() {
  const loop = [], mask = [];
  const swOut = catmull(SIDEWALL_CTRL, 3);           // 25 pts, bead -> tread edge
  for (let i = 0; i < swOut.length - 1; i++) { loop.push(swOut[i]); mask.push(0); }
  const treadStart = loop.length;
  const TREAD_N = 53;
  for (let i = 0; i < TREAD_N; i++) {
    const a = TYRE_HALF_TREAD - (2 * TYRE_HALF_TREAD * i) / (TREAD_N - 1);
    loop.push([a, treadRadius(a)]);
    mask.push(smoothstep01((TYRE_HALF_TREAD - Math.abs(a)) / 0.018));
  }
  const treadEnd = loop.length;
  for (let i = swOut.length - 2; i >= 0; i--) { loop.push([-swOut[i][0], swOut[i][1]]); mask.push(0); }
  loop.push([-0.050, 0.199], [0.0, 0.199], [0.050, 0.199]); // inner barrel (hidden, closes the solid)
  mask.push(0, 0, 0);
  return { loop, mask, treadStart, treadEnd };
}

/**
 * Pure: full tyre mesh arrays (positions/normals/uvs/indices), analytic
 * normals including the rib modulation partials.
 */
export function buildTyreGeometry(revSteps = TYRE_REV) {
  const { loop, mask } = buildTyreSection();
  const n = loop.length;
  const da = new Float64Array(n), dr = new Float64Array(n), dm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n, inx = (i + 1) % n;
    da[i] = loop[inx][0] - loop[ip][0];
    dr[i] = loop[inx][1] - loop[ip][1];
    dm[i] = mask[inx] - mask[ip];
  }
  const geo = makeGeo();
  const cols = revSteps + 1;
  for (let ii = 0; ii <= n; ii++) {           // row n duplicates row 0 (profile seam)
    const i = ii % n;
    const a = loop[i][0], r = loop[i][1], m = mask[i];
    for (let j = 0; j <= revSteps; j++) {     // col revSteps duplicates col 0 (uv seam)
      const th = (j / revSteps) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const w = 0.5 + 0.5 * Math.cos(TREAD_RIBS * th);
      const R = r - RIB_AMP * m * w;
      const Rth = RIB_AMP * m * 0.5 * TREAD_RIBS * Math.sin(TREAD_RIBS * th);
      const drEff = dr[i] - RIB_AMP * dm[i] * w;
      // N = dP/dt x dP/dtheta
      let nx = drEff * R;
      let ny = -da[i] * (Rth * s + R * c);
      let nz = da[i] * (Rth * c - R * s);
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      geo.pos.push(a, R * c, R * s);
      geo.nor.push(nx, ny, nz);
      geo.uv.push(j / revSteps, ii / n);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < revSteps; j++) {
      const A = i * cols + j, D = A + 1, B = A + cols, C = B + 1;
      geo.idx.push(A, D, C, A, C, B);
    }
  }
  return geo;
}

// ---------------------------------------------------------------------------
// generic surface of revolution around an axis parallel to X through (cy, cz).
// run = open polyline [[a, r], ...]; outward 2D normal = (r', -a') per the
// traversal conventions used below. dir=-1 reverses theta (used so the lug
// pattern z-mirrors exactly for side=-1).
// ---------------------------------------------------------------------------
function revolveRun(geo, run, steps, opts = {}) {
  const cy = opts.cy || 0, cz = opts.cz || 0, dir = opts.dir || 1;
  const n = run.length;
  const base = geo.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const p0 = run[Math.max(0, i - 1)], p1 = run[Math.min(n - 1, i + 1)];
    let ta = p1[0] - p0[0], tr = p1[1] - p0[1];
    const L = Math.hypot(ta, tr) || 1;
    const na = tr / L, nr = -ta / L;
    const a = run[i][0], r = run[i][1];
    for (let j = 0; j <= steps; j++) {
      const th = dir * (j / steps) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      geo.pos.push(a, cy + r * c, cz + r * s);
      geo.nor.push(na, nr * c, nr * s);
      geo.uv.push(j / steps, n === 1 ? 0 : i / (n - 1));
    }
  }
  const cols = steps + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < steps; j++) {
      const A = base + i * cols + j, D = A + 1, B = A + cols, C = B + 1;
      if (dir > 0) geo.idx.push(A, D, C, A, C, B);
      else geo.idx.push(A, C, D, A, B, C);
    }
  }
}

// ---------------------------------------------------------------------------
// generic chamfered-prism sweep. stations: [{ c:[x,y,z], pts:[[x,y,z] x P] }].
// Each section edge becomes its own strip (crisp bevels), normals outward
// (sign-fixed against the centreline), winding fixed against Babylon's
// front-face convention. Both ends get flat caps.
// ---------------------------------------------------------------------------
function sweepPrism(geo, stations) {
  const S = stations.length, P = stations[0].pts.length;
  const F = [0, 0, 0];
  const tang = [];
  for (let k = 0; k < S; k++) {
    const c0 = stations[Math.max(0, k - 1)].c, c1 = stations[Math.min(S - 1, k + 1)].c;
    const t = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    const L = Math.hypot(t[0], t[1], t[2]) || 1;
    tang.push([t[0] / L, t[1] / L, t[2] / L]);
  }
  for (let e = 0; e < P; e++) {
    const e1 = (e + 1) % P;
    const base = geo.pos.length / 3;
    for (let k = 0; k < S; k++) {
      const A = stations[k].pts[e], B = stations[k].pts[e1], c = stations[k].c, t = tang[k];
      const Ex = B[0] - A[0], Ey = B[1] - A[1], Ez = B[2] - A[2];
      let ox = Ey * t[2] - Ez * t[1], oy = Ez * t[0] - Ex * t[2], oz = Ex * t[1] - Ey * t[0];
      const mx = (A[0] + B[0]) / 2 - c[0], my = (A[1] + B[1]) / 2 - c[1], mz = (A[2] + B[2]) / 2 - c[2];
      if (ox * mx + oy * my + oz * mz < 0) { ox = -ox; oy = -oy; oz = -oz; }
      const L = Math.hypot(ox, oy, oz) || 1;
      ox /= L; oy /= L; oz /= L;
      geo.pos.push(A[0], A[1], A[2], B[0], B[1], B[2]);
      geo.nor.push(ox, oy, oz, ox, oy, oz);
      geo.uv.push(k / (S - 1), e / P, k / (S - 1), (e + 1) / P);
    }
    for (let k = 0; k < S - 1; k++) {
      const iA = base + 2 * k, iB2 = base + 2 * k + 1, iA1 = base + 2 * k + 2, iB1 = base + 2 * k + 3;
      // quad corners: A=A_k, D=B_k, C=B_{k+1}, B=A_{k+1}
      faceNormal(geo.pos, iA, iB2, iB1, F);
      const nx = geo.nor[iA * 3], ny = geo.nor[iA * 3 + 1], nz = geo.nor[iA * 3 + 2];
      if (F[0] * nx + F[1] * ny + F[2] * nz >= 0) geo.idx.push(iA, iB2, iB1, iA, iB1, iA1);
      else geo.idx.push(iA, iB1, iB2, iA, iA1, iB1);
    }
  }
  // caps
  for (const end of [0, S - 1]) {
    const sgn = end === 0 ? -1 : 1;
    const t = tang[end];
    const N = [sgn * t[0], sgn * t[1], sgn * t[2]];
    const st = stations[end];
    const base = geo.pos.length / 3;
    geo.pos.push(st.c[0], st.c[1], st.c[2]);
    geo.nor.push(N[0], N[1], N[2]);
    geo.uv.push(0.5, 0.5);
    for (let e = 0; e < P; e++) {
      const p = st.pts[e];
      geo.pos.push(p[0], p[1], p[2]);
      geo.nor.push(N[0], N[1], N[2]);
      geo.uv.push(e / P, 0);
    }
    for (let e = 0; e < P; e++) {
      const i1 = base + 1 + e, i2 = base + 1 + ((e + 1) % P);
      faceNormal(geo.pos, base, i1, i2, F);
      if (F[0] * N[0] + F[1] * N[1] + F[2] * N[2] >= 0) geo.idx.push(base, i1, i2);
      else geo.idx.push(base, i2, i1);
    }
  }
}

/** chamfered rectangle section, half-width w2 x half-height h2, chamfer ch */
function octagon(w2, h2, ch) {
  return [
    [w2 - ch, h2], [-w2 + ch, h2], [-w2, h2 - ch], [-w2, -h2 + ch],
    [-w2 + ch, -h2], [w2 - ch, -h2], [w2, -h2 + ch], [w2, h2 - ch],
  ];
}

// ---------------------------------------------------------------------------
// RIM — barrel + rolled lip + hub boss + centre cap + 5 lug nuts + 5 double
// spokes (10 chamfered prisms swept outward into the dish). ONE merged geo.
// Runs follow the (r', -a') outward convention; hints are used by __selftest.
// ---------------------------------------------------------------------------
export const RIM_RUNS = [
  // outer flange + barrel (radial-out): traversal +a -> -a
  { pts: [[DISH_LIP_A, RIM_LIP_R], [0.088, RIM_LIP_R], [0.0835, 0.2065], [0.079, 0.205], [-0.088, 0.205], [-0.095, 0.2035]], hint: [0, 1] },
  // inboard end face
  { pts: [[-0.095, 0.2035], [-0.095, 0.165]], hint: [-1, 0] },
  // inner well (visible between spokes, faces the axle)
  { pts: [[-0.095, 0.165], [-0.030, 0.1625], [0.040, 0.164], [0.075, 0.171]], hint: [0, -1] },
  // rolled lip: underside overhang -> outboard lip ring face (the light-catcher)
  { pts: [[0.075, 0.171], [0.090, 0.180], [0.098, 0.1835], [0.1045, 0.1875], [0.1085, 0.194], [0.1112, 0.2035], [DISH_LIP_A, RIM_LIP_R]], hint: [0.8, -0.2] },
  // hub boss face (outboard)
  { pts: [[DISH_HUB_A, 0.0330], [DISH_HUB_A, 0.0525]], hint: [1, 0] },
  // boss chamfer
  { pts: [[DISH_HUB_A, 0.0525], [0.0540, 0.0580]], hint: [0.7, 0.7] },
  // boss side
  { pts: [[0.0540, 0.0580], [0.0180, 0.0580]], hint: [0, 1] },
  // centre cap dome (pole -> boss face edge)
  { pts: [[0.0710, 0.0015], [0.0705, 0.0090], [0.0685, 0.0180], [0.0640, 0.0270], [DISH_HUB_A, 0.0330]], hint: [0.9, 0.3] },
];

const LUG_RUNS = [
  { pts: [[0.0660, 0.0018], [0.0660, 0.0068]] },            // face
  { pts: [[0.0660, 0.0068], [0.0630, 0.0092]] },            // chamfer
  { pts: [[0.0630, 0.0092], [0.0540, 0.0092]] },            // side
];
const LUG_CIRCLE_R = 0.043;

const SPOKE_PAIRS = 5;
const SPOKE_BASE_DEG = 36;          // {36+72k} is invariant under negation => exact mirror
const SPOKE_STATIONS = 7;

/** Pure: spoke centreline + section params at s in [0,1]. Exported for tests. */
export function spokeStation(s, pairSign, side) {
  const rs = 0.050 + 0.146 * s;                       // hub boss -> under the lip
  const as = 0.044 + 0.049 * Math.pow(s, 1.6);        // concave dish (negative-camber look)
  const deltaDeg = 6 + 4.5 * s;                       // pair splits toward the lip
  const sweepDeg = 6 * s;                             // directional swirl, flips with side
  const w2 = (0.034 - 0.008 * s) / 2;
  const h2 = (0.026 - 0.007 * s) / 2;
  const ch = 0.007 - 0.002 * s;
  return { rs, as, deltaDeg, sweepDeg, w2, h2, ch };
}

function spokeStations(baseDeg, pairSign, side) {
  const stations = [];
  for (let k = 0; k < SPOKE_STATIONS; k++) {
    const s = k / (SPOKE_STATIONS - 1);
    const st = spokeStation(s, pairSign, side);
    const phi = side * (baseDeg + pairSign * st.deltaDeg + st.sweepDeg) * DEG;
    const cph = Math.cos(phi), sph = Math.sin(phi);
    const c = [st.as, st.rs * cph, st.rs * sph];
    const dt = [0, -sph, cph];                        // tangential
    const sec = octagon(st.w2, st.h2, st.ch);
    const pts = [];
    for (let p = 0; p < sec.length; p++) {
      // tangential coord scaled by side so side=-1 is an exact elementwise
      // z-mirror of side=+1 (winding is re-resolved inside sweepPrism)
      const t = side * sec[p][0], v = sec[p][1];
      pts.push([c[0] + v, c[1] + t * dt[1], c[2] + t * dt[2]]);
    }
    stations.push({ c, pts });
  }
  return stations;
}

/**
 * Pure: full rim mesh arrays. side=+1 left, side=-1 exact z-mirror.
 * @returns {{pos:number[],nor:number[],uv:number[],idx:number[],sideDepStart:number}}
 */
export function buildRimGeometry(side = 1) {
  const geo = makeGeo();
  for (const run of RIM_RUNS) revolveRun(geo, run.pts, run.hint ? RIM_REV : RIM_REV, {});
  const sideDepStart = geo.pos.length / 3;
  for (let k = 0; k < SPOKE_PAIRS; k++) {
    const ang = side * (SPOKE_BASE_DEG + 72 * k) * DEG;
    const cy = LUG_CIRCLE_R * Math.cos(ang), cz = LUG_CIRCLE_R * Math.sin(ang);
    for (const run of LUG_RUNS) revolveRun(geo, run.pts, 14, { cy, cz, dir: side });
  }
  for (let k = 0; k < SPOKE_PAIRS; k++) {
    const baseDeg = SPOKE_BASE_DEG + 72 * k;
    sweepPrism(geo, spokeStations(baseDeg, +1, side));
    sweepPrism(geo, spokeStations(baseDeg, -1, side));
  }
  geo.sideDepStart = sideDepStart;
  return geo;
}

// ---------------------------------------------------------------------------
// BRAKE — disc (with hat) + caliper. Static: the integrator parents this
// un-spun. Caliper at 10 o'clock (up-rear) as seen from outboard on side=+1.
// ---------------------------------------------------------------------------
export const DISC_RUNS = [
  { pts: [[0.024, 0.0180], [0.024, 0.0750]], hint: [1, 0] },        // hat face
  { pts: [[0.024, 0.0750], [DISC_HALF_T, 0.0750]], hint: [0, 1] },  // hat side
  { pts: [[DISC_HALF_T, 0.0750], [DISC_HALF_T, DISC_R]], hint: [1, 0] },   // outboard face
  { pts: [[DISC_HALF_T, DISC_R], [-DISC_HALF_T, DISC_R]], hint: [0, 1] },  // rim edge
  { pts: [[-DISC_HALF_T, DISC_R], [-DISC_HALF_T, 0.0500]], hint: [-1, 0] },// inboard face
  { pts: [[-DISC_HALF_T, 0.0500], [DISC_HALF_T, 0.0500]], hint: [0, -1] }, // bore edge
];

const CALIPER = {
  rc: 0.130,          // arc radius of the caliper body centreline
  h2: 0.030,          // radial half extent  (0.100 .. 0.160, wraps the disc edge)
  v2: 0.032,          // axial half extent   (straddles the +-0.012 disc)
  ch: 0.011,
  arc: 0.85,          // ~0.11 m wide along the arc
  clockDeg: -60,      // 10 o'clock (angle from +Y toward +Z), mirrored by side
  stations: 5,
};

/** Pure: caliper sweep stations (exported for tests). */
export function caliperStations(side = 1) {
  const stations = [];
  const sec = octagon(CALIPER.h2, CALIPER.v2, CALIPER.ch);
  for (let k = 0; k < CALIPER.stations; k++) {
    const f = k / (CALIPER.stations - 1);
    const psi = side * (CALIPER.clockDeg * DEG + (f - 0.5) * CALIPER.arc);
    const cy = Math.cos(psi), sz = Math.sin(psi);
    const c = [0, CALIPER.rc * cy, CALIPER.rc * sz];
    const pts = [];
    for (let p = 0; p < sec.length; p++) {
      const u = sec[p][0], v = sec[p][1];
      pts.push([v, (CALIPER.rc + u) * cy, (CALIPER.rc + u) * sz]);
    }
    stations.push({ c, pts });
  }
  return stations;
}

/**
 * Pure: full brake mesh arrays (disc + caliper). side mirrors the caliper.
 */
export function buildBrakeGeometry(side = 1) {
  const geo = makeGeo();
  for (const run of DISC_RUNS) revolveRun(geo, run.pts, 72, {});
  const sideDepStart = geo.pos.length / 3;
  sweepPrism(geo, caliperStations(side));
  geo.sideDepStart = sideDepStart;
  return geo;
}

// ---------------------------------------------------------------------------
// Babylon assembly
// ---------------------------------------------------------------------------
function toMesh(name, geo, scene, parent) {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = new Float32Array(geo.pos);
  vd.normals = new Float32Array(geo.nor);
  vd.uvs = new Float32Array(geo.uv);
  vd.indices = geo.pos.length / 3 > 65535 ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx);
  vd.applyToMesh(mesh, false);
  mesh.parent = parent;
  mesh.isPickable = false;
  return mesh;
}

/**
 * Build one wheel assembly. Origin at hub centre, axle along +X (left side).
 * @param {import('@babylonjs/core').Scene} scene
 * @param {1|-1} [side] +1 left (default), -1 right (z-mirrored spoke sweep +
 *   caliper). Right wheels: buildWheel(scene, -1) then rotate root PI about Y.
 * @returns {{root: TransformNode, tire: Mesh, rim: Mesh, brake: Mesh,
 *            radius: number, width: number}}
 *   Spin tire.rotation.x and rim.rotation.x; leave brake un-spun.
 */
export function buildWheel(scene, side = 1) {
  const sfx = side >= 0 ? 'L' : 'R';
  const root = new TransformNode(`wheelRoot_${sfx}`, scene);
  const tire = toMesh(`wheelTire_${sfx}`, buildTyreGeometry(), scene, root);
  const rim = toMesh(`wheelRim_${sfx}`, buildRimGeometry(side), scene, root);
  const brake = toMesh(`wheelBrake_${sfx}`, buildBrakeGeometry(side), scene, root);
  return { root, tire, rim, brake, radius: TYRE_R, width: TYRE_W };
}

// ---------------------------------------------------------------------------
// __selftest — pure validation, runnable in Node (no scene, no GPU).
// ---------------------------------------------------------------------------
function checkGeo(name, geo, report) {
  const { pos, nor, uv, idx } = geo;
  const nv = pos.length / 3;
  let nan = 0;
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) nan++;
  for (let i = 0; i < nor.length; i++) if (!Number.isFinite(nor[i])) nan++;
  for (let i = 0; i < uv.length; i++) if (!Number.isFinite(uv[i])) nan++;
  let badLen = 0;
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]);
    if (Math.abs(l - 1) > 1e-3) badLen++;
  }
  let oob = idx.length % 3;
  for (let i = 0; i < idx.length; i++) if (idx[i] < 0 || idx[i] >= nv || (idx[i] | 0) !== idx[i]) oob++;
  // winding vs normals, using Babylon's front-face convention
  const F = [0, 0, 0];
  let flipped = 0, degen = 0, faces = idx.length / 3;
  for (let f = 0; f < faces; f++) {
    faceNormal(pos, idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2], F);
    const area = Math.hypot(F[0], F[1], F[2]);
    if (area < 1e-12) { degen++; continue; }
    let dx = 0, dy = 0, dz = 0;
    for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; dx += nor[v * 3]; dy += nor[v * 3 + 1]; dz += nor[v * 3 + 2]; }
    if (F[0] * dx + F[1] * dy + F[2] * dz <= 0) flipped++;
  }
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      if (v < bb[k]) bb[k] = v;
      if (v > bb[k + 3]) bb[k + 3] = v;
    }
  }
  const ok = nan === 0 && badLen === 0 && oob === 0 && flipped === 0;
  report[name] = {
    ok, verts: nv, tris: faces, nan, badNormalLen: badLen, badIndices: oob,
    flippedFaces: flipped, degenFaces: degen,
    bbox: bb.map((v) => +v.toFixed(4)),
  };
  return ok;
}

function checkMirror(name, gp, gm, report) {
  let maxErr = 0;
  let ok = gp.pos.length === gm.pos.length;
  if (ok) {
    const start = gp.sideDepStart ?? 0;
    for (let i = 0; i < gp.pos.length / 3; i++) {
      const ex = Math.abs(gp.pos[i * 3] - gm.pos[i * 3]);
      const ey = Math.abs(gp.pos[i * 3 + 1] - gm.pos[i * 3 + 1]);
      const ez = i >= start
        ? Math.abs(gp.pos[i * 3 + 2] + gm.pos[i * 3 + 2])   // side-dependent: z negated
        : Math.abs(gp.pos[i * 3 + 2] - gm.pos[i * 3 + 2]);  // revolves: identical
      const e = Math.max(ex, ey, ez);
      if (e > maxErr) maxErr = e;
    }
    ok = maxErr < 1e-9;
  }
  report[name] = { ok, maxErr };
  return ok;
}

export function __selftest() {
  const report = { ok: true };
  const fail = (m) => { report.ok = false; (report.failures ??= []).push(m); };

  // ---- tyre section (pure profile) ----
  const sec = buildTyreSection();
  const { loop, mask, treadStart, treadEnd } = sec;
  let minR = Infinity, maxR = -Infinity, maxHalfW = 0;
  for (const [a, r] of loop) {
    if (!Number.isFinite(a) || !Number.isFinite(r)) fail('tyre section NaN');
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (Math.abs(a) > maxHalfW) maxHalfW = Math.abs(a);
  }
  // star-shaped w.r.t. section centroid => outward-consistent loop
  const cen = [0, 0.2655];
  for (let i = 0; i < loop.length; i++) {
    const ip = (i - 1 + loop.length) % loop.length, inx = (i + 1) % loop.length;
    const ta = loop[inx][0] - loop[ip][0], tr = loop[inx][1] - loop[ip][1];
    const na = tr, nr = -ta;
    const d = na * (loop[i][0] - cen[0]) + nr * (loop[i][1] - cen[1]);
    if (d <= 0) fail(`tyre section normal not outward at sample ${i}`);
  }
  // sidewall radii strictly increasing bead -> tread edge
  for (let i = 1; i < treadStart; i++) {
    if (loop[i][1] <= loop[i - 1][1]) fail(`outboard sidewall r not monotonic at ${i}`);
  }
  for (let i = treadEnd + 1; i < loop.length - 3; i++) {
    if (loop[i][1] >= loop[i - 1][1]) fail(`inboard sidewall r not monotonic at ${i}`);
  }
  if (Math.abs(maxR - TYRE_R) > 1e-9) fail(`tyre max radius ${maxR} != ${TYRE_R}`);
  if (Math.abs(maxHalfW - TYRE_HALF_BULGE) > 6e-4) fail(`tyre bulge half-width ${maxHalfW}`);
  report.tyreSection = {
    samples: loop.length, minR: +minR.toFixed(4), maxR: +maxR.toFixed(4),
    maxHalfWidth: +maxHalfW.toFixed(4), treadSamples: treadEnd - treadStart,
    maskPeak: Math.max(...mask),
  };

  // ---- generated geometries ----
  const tyre = buildTyreGeometry();
  const rimP = buildRimGeometry(1), rimM = buildRimGeometry(-1);
  const brkP = buildBrakeGeometry(1), brkM = buildBrakeGeometry(-1);
  if (!checkGeo('tyreGeo', tyre, report)) fail('tyreGeo');
  if (!checkGeo('rimGeoL', rimP, report)) fail('rimGeoL');
  if (!checkGeo('rimGeoR', rimM, report)) fail('rimGeoR');
  if (!checkGeo('brakeGeoL', brkP, report)) fail('brakeGeoL');
  if (!checkGeo('brakeGeoR', brkM, report)) fail('brakeGeoR');

  // tyre z-mirror symmetry: ring j <-> ring REV-j
  {
    const cols = TYRE_REV + 1;
    const rows = tyre.pos.length / 3 / cols;
    let maxErr = 0;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j <= TYRE_REV; j++) {
        const a = (i * cols + j) * 3, b = (i * cols + (TYRE_REV - j)) * 3;
        maxErr = Math.max(maxErr,
          Math.abs(tyre.pos[a] - tyre.pos[b]),
          Math.abs(tyre.pos[a + 1] - tyre.pos[b + 1]),
          Math.abs(tyre.pos[a + 2] + tyre.pos[b + 2]));
      }
    }
    report.tyreZSymmetry = { ok: maxErr < 1e-9, maxErr };
    if (maxErr >= 1e-9) fail('tyre z-symmetry');
  }
  if (!checkMirror('rimMirrorLR', rimP, rimM, report)) fail('rim L/R mirror');
  if (!checkMirror('brakeMirrorLR', brkP, brkM, report)) fail('brake L/R mirror');

  // revolve-run orientation hints (rim + disc)
  const hintCheck = (runs, tag) => {
    runs.forEach((run, ri) => {
      if (!run.hint) return;
      const pts = run.pts;
      const i = pts.length >> 1;
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
      const ta = p1[0] - p0[0], tr = p1[1] - p0[1];
      const L = Math.hypot(ta, tr) || 1;
      const d = (tr / L) * run.hint[0] + (-ta / L) * run.hint[1];
      if (d < 0.2) fail(`${tag} run ${ri} normal hint dot ${d.toFixed(2)}`);
    });
  };
  hintCheck(RIM_RUNS, 'rim');
  hintCheck(DISC_RUNS, 'disc');

  // headline extremes
  report.extremes = {
    tyreRadius: TYRE_R, tyreNominalWidth: TYRE_W,
    tyreBulgeWidth: +(2 * maxHalfW).toFixed(4),
    rimLipRadius: RIM_LIP_R,
    dishDepth: +(DISH_LIP_A - DISH_HUB_A).toFixed(4),
    discRadius: DISC_R, discThickness: 2 * DISC_HALF_T,
    spokes: SPOKE_PAIRS * 2,
    totalTris: (tyre.idx.length + rimP.idx.length + brkP.idx.length) / 3,
  };
  return report;
}

// Node CLI harness:  node src/vehicle/carWheels.js
if (typeof process !== 'undefined' && typeof process.argv?.[1] === 'string'
  && /carWheels\.js$/.test(process.argv[1])) {
  const r = __selftest();
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
