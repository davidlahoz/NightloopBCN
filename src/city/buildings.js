/**
 * NIGHTLOOP buildings — the street wall around every block plus the neon
 * signage that the road shader smears into the wet asphalt. STREAMED per
 * block: the city is endless, so each block cell (ix, jz) bakes its own
 * world-space mesh from a deterministic per-cell seed and is disposed when
 * the car drives away. All blocks share ONE WGSL ShaderMaterial.
 *
 * Each vertex carries:
 *   uv     — facade-local metres (u along facade from its left edge,
 *            v = height above the building's ground line)
 *   color  — (buildingSeed, flagBits, facadeWidth_m, wallTopV_m)
 * The fragment shader builds window grids / storefronts / roofs / neon
 * entirely from those metres, so detail is resolution-independent.
 *
 * Build cost per block is a few ms, so blocks build cooperatively (one
 * building per generator step) under the shared build budget.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import {
  PERIOD_X, PERIOD_Z, blocksInRegion, cellSeed, gridToWorld, streetYawDelta,
  districtOf, districtHeightBias,
} from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import { buildBudget } from '../core/buildBudget.js';
import facadeVertex from '../shaders/facade.vertex.wgsl?raw';
import facadeFragment from '../shaders/facade.fragment.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';

const R_BUILD = 340;
const R_DROP = 384;
const RESCAN_DIST = 26;   // staggered vs roads (24) / curbs (22)

// flag bits packed into color.y (styles occupy bits 0..2)
const F_ROOF = 8;
const F_FRONT = 16;
const F_NEON = 32;
const F_FLICK = 64;
const F_TRIM = 128;

// must stay numerically identical to the palette in facade.fragment.wgsl
const NEON_PAL = [
  [0.10, 1.00, 0.85], // teal
  [1.00, 0.16, 0.72], // magenta
  [1.00, 0.42, 0.10], // orange
  [1.00, 0.10, 0.12], // red
];

const NO_FRONTS = Object.freeze({ xm: false, xp: false, zm: false, zp: false });

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split an edge length into frontage widths. mode 0 = normal (1-4 mid
 * parcels), 1 = industrial (1-3 huge warehouse frontages), 2 = residential
 * (up to 12 narrow house parcels).
 */
function splitSpan(len, rng, mode) {
  let target = 20 + rng() * 9, minW = 9, cap = 4;
  if (mode === 1) { target = 40 + rng() * 20; minW = 22; cap = 3; }
  else if (mode === 2) { target = 10.5 + rng() * 3; minW = 7; cap = 12; }
  let n = Math.round(len / target);
  if (n < 1) n = 1;
  if (n > cap) n = cap;
  while (n > 1 && len / n < minW) n--;
  const ws = [];
  let sum = 0;
  for (let i = 0; i < n; i++) { const w = 0.72 + rng() * 0.56; ws.push(w); sum += w; }
  for (let i = 0; i < n; i++) ws[i] = (ws[i] / sum) * len;
  return ws;
}

// per-district character — heights, façade style pool, sign density, vacant
// lot chance, parcel split mode, wall tint (bits 8-9 of the facade flags)
const DISTRICTS = [
  { hLo: 24, hHi: 60, styles: [2, 4, 2, 3, 4], signs: 1.6, lot: 0.02, split: 0, tint: 2 << 8, towers: 0.5 },  // downtown
  { hLo: 13, hHi: 40, styles: [0, 1, 2, 3, 4, 5], signs: 1.7, lot: 0.05, split: 0, tint: 0, towers: 0.35 },   // commercial: the shopping strip
  { hLo: 9, hHi: 21, styles: [0, 1, 5, 0, 5], signs: 0.35, lot: 0.07, split: 2, tint: 1 << 8, towers: 0.10 }, // residential: houses + apartments
  { hLo: 8, hHi: 17, styles: [3, 5, 3, 1], signs: 0.15, lot: 0.14, split: 1, tint: 3 << 8, towers: 0.06 },    // industrial: big brick warehouses
];

/**
 * Cooperative per-block build. Yields between buildings. Fills geo arrays and
 * pushes neon light emitters ({x,y,z,r,g,b,radius,intensity,base}) to lights.
 */
function* buildBlockGen(ix, jz, rect, geo, lights) {
  const { pos, nor, uvs, col, idx } = geo;
  const rng = mulberry32((cellSeed(ix, jz, 101) * 4294967296) | 0);
  const district = districtOf(ix, jz);
  const DIST = DISTRICTS[district];
  const hBias = districtHeightBias(ix, jz);   // clusters tall cores at macro scale
  const corners = [
    [rect.x0, rect.z0], [rect.x1, rect.z0], [rect.x0, rect.z1], [rect.x1, rect.z1],
  ];
  const frontCands = [];
  const roofCands = [];

  // -- rigid per-building transform (street curvature) ----------------------
  // Buildings are laid out in GRID space; each is rotated to its street's
  // local tangent around its front-centre pivot and shifted by the warp.
  const _gw = { x: 0, z: 0 };
  let xfOn = false, xfC = 1, xfS = 0, xfPX = 0, xfPZ = 0, xfOX = 0, xfOZ = 0;
  function setXform(pivotGX, pivotGZ, yaw) {
    gridToWorld(pivotGX, pivotGZ, _gw);
    xfPX = pivotGX; xfPZ = pivotGZ;
    xfOX = _gw.x - pivotGX; xfOZ = _gw.z - pivotGZ;
    xfC = Math.cos(yaw); xfS = Math.sin(yaw);
    xfOn = true;
  }
  function clearXform() { xfOn = false; }
  const _xp = { x: 0, z: 0 };
  function xfPoint(x, z) {
    const dx = x - xfPX, dz = z - xfPZ;
    _xp.x = xfPX + dx * xfC + dz * xfS + xfOX;
    _xp.z = xfPZ - dx * xfS + dz * xfC + xfOZ;
    return _xp;
  }

  // -- low-level emitters ---------------------------------------------------
  // Babylon front faces satisfy cross(eU, eV) == -normal (see planeBuilder).
  function quad(px, py, pz, ux, uy, uz, vx, vy, vz, nx, ny, nz, ua, ub, va, vb, seed, flags, w, top) {
    if (xfOn) {
      const p = xfPoint(px, pz); px = p.x; pz = p.z;
      let t = ux * xfC + uz * xfS; uz = -ux * xfS + uz * xfC; ux = t;
      t = vx * xfC + vz * xfS; vz = -vx * xfS + vz * xfC; vx = t;
      t = nx * xfC + nz * xfS; nz = -nx * xfS + nz * xfC; nx = t;
    }
    const b = pos.length / 3;
    pos.push(
      px, py, pz,
      px + ux, py + uy, pz + uz,
      px + ux + vx, py + uy + vy, pz + uz + vz,
      px + vx, py + vy, pz + vz,
    );
    for (let k = 0; k < 4; k++) { nor.push(nx, ny, nz); col.push(seed, flags + DIST.tint, w, top); }
    uvs.push(ua, va, ub, va, ub, vb, ua, vb);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  function wallFace(axis, sgn, plane, a0, a1, y0, y1, seed, flags, top, vOff) {
    const L = a1 - a0, H = y1 - y0;
    if (L <= 0.01 || H <= 0.01) return;
    const va = y0 - vOff, vb = y1 - vOff;
    if (axis === 0) {
      if (sgn > 0) quad(plane, y0, a0, 0, 0, L, 0, H, 0, 1, 0, 0, 0, L, va, vb, seed, flags, L, top);
      else quad(plane, y0, a1, 0, 0, -L, 0, H, 0, -1, 0, 0, 0, L, va, vb, seed, flags, L, top);
    } else {
      if (sgn > 0) quad(a1, y0, plane, -L, 0, 0, 0, H, 0, 0, 0, 1, 0, L, va, vb, seed, flags, L, top);
      else quad(a0, y0, plane, L, 0, 0, 0, H, 0, 0, 0, -1, 0, L, va, vb, seed, flags, L, top);
    }
  }

  function upFace(x0, z0, x1, z1, y, seed, flags) {
    if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) return;
    quad(x0, y, z0, x1 - x0, 0, 0, 0, 0, z1 - z0, 0, 1, 0, 0, x1 - x0, 5, 5, seed, flags, x1 - x0, 1);
  }

  /** Single triangle (gable ends). Vertex order must satisfy cross = -normal. */
  function tri(ax, ay, az, bx2, by2, bz2, cx2, cy2, cz2, nx, ny, nz, seed, flags, w, top) {
    if (xfOn) {
      let p = xfPoint(ax, az); ax = p.x; az = p.z;
      p = xfPoint(bx2, bz2); bx2 = p.x; bz2 = p.z;
      p = xfPoint(cx2, cz2); cx2 = p.x; cz2 = p.z;
      const t = nx * xfC + nz * xfS; nz = -nx * xfS + nz * xfC; nx = t;
    }
    const b = pos.length / 3;
    pos.push(ax, ay, az, bx2, by2, bz2, cx2, cy2, cz2);
    for (let k = 0; k < 3; k++) { nor.push(nx, ny, nz); col.push(seed, flags + DIST.tint, w, top); }
    uvs.push(0, 0, w, 0, w * 0.5, top);
    idx.push(b, b + 1, b + 2);
  }

  function downFace(x0, z0, x1, z1, y, seed, flags) {
    if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) return;
    quad(x0, y, z0, 0, 0, z1 - z0, x1 - x0, 0, 0, 0, -1, 0, 0, z1 - z0, 5, 5, seed, flags, z1 - z0, 1);
  }

  /** Parapet lip: 0.16 m outward cornice band with cap + underside. */
  function cornice(x0, z0, x1, z1, top, seed, style, vOff) {
    const o = 0.16, capIn = 0.14;
    const yb = top - 0.06, yt = top + 0.30;
    const fl = style | F_TRIM;
    const topRel = yt - vOff;
    wallFace(1, -1, z0 - o, x0 - o, x1 + o, yb, yt, seed, fl, topRel, vOff);
    wallFace(1, 1, z1 + o, x0 - o, x1 + o, yb, yt, seed, fl, topRel, vOff);
    wallFace(0, -1, x0 - o, z0 - o, z1 + o, yb, yt, seed, fl, topRel, vOff);
    wallFace(0, 1, x1 + o, z0 - o, z1 + o, yb, yt, seed, fl, topRel, vOff);
    downFace(x0 - o, z0 - o, x1 + o, z0, yb, seed, fl);
    downFace(x0 - o, z1, x1 + o, z1 + o, yb, seed, fl);
    downFace(x0 - o, z0, x0, z1, yb, seed, fl);
    downFace(x1, z0, x1 + o, z1, yb, seed, fl);
    upFace(x0 - o, z0 - o, x1 + o, z0 + capIn, yt, seed, fl);
    upFace(x0 - o, z1 - capIn, x1 + o, z1 + o, yt, seed, fl);
    upFace(x0 - o, z0 + capIn, x0 + capIn, z1 - capIn, yt, seed, fl);
    upFace(x1 - capIn, z0 + capIn, x1 + o, z1 - capIn, yt, seed, fl);
  }

  /** One building mass: 4 facade walls + parapet cornice + roof plane. */
  function mass(x0, z0, x1, z1, yBase, yTop, vOff, seed, style, fronts) {
    const topRel = yTop - vOff;
    wallFace(0, -1, x0, z0, z1, yBase, yTop, seed, style | (fronts.xm ? F_FRONT : 0), topRel, vOff);
    wallFace(0, 1, x1, z0, z1, yBase, yTop, seed, style | (fronts.xp ? F_FRONT : 0), topRel, vOff);
    wallFace(1, -1, z0, x0, x1, yBase, yTop, seed, style | (fronts.zm ? F_FRONT : 0), topRel, vOff);
    wallFace(1, 1, z1, x0, x1, yBase, yTop, seed, style | (fronts.zp ? F_FRONT : 0), topRel, vOff);
    cornice(x0, z0, x1, z1, yTop, seed, style, vOff);
    upFace(x0, z0, x1, z1, yTop, seed, style | F_ROOF);
  }

  /** Dark roof-clutter box (AC unit, bulkhead, sign post…). */
  function box(x0, z0, x1, z1, y0, h, seed) {
    wallFace(0, -1, x0, z0, z1, y0, y0 + h, seed, F_ROOF, h, y0);
    wallFace(0, 1, x1, z0, z1, y0, y0 + h, seed, F_ROOF, h, y0);
    wallFace(1, -1, z0, x0, x1, y0, y0 + h, seed, F_ROOF, h, y0);
    wallFace(1, 1, z1, x0, x1, y0, y0 + h, seed, F_ROOF, h, y0);
    upFace(x0, z0, x1, z1, y0 + h, seed, F_ROOF);
  }

  /** Octagonal water tank. */
  function tank(cx, cz, y0, r, h, seed) {
    const nS = 8, step = (Math.PI * 2) / nS;
    const sideLen = 2 * r * Math.sin(step / 2);
    let pxp = cx + r, pzp = cz;
    for (let k = 1; k <= nS; k++) {
      const a = k * step;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const am = (k - 0.5) * step;
      quad(pxp, y0, pzp, x - pxp, 0, z - pzp, 0, h, 0, Math.cos(am), 0, Math.sin(am),
        0, sideLen, 0, h, seed, F_ROOF, sideLen, h);
      pxp = x; pzp = z;
    }
    const bc = pos.length / 3;
    let fcx = cx, fcz = cz;
    if (xfOn) { const p = xfPoint(cx, cz); fcx = p.x; fcz = p.z; }
    pos.push(fcx, y0 + h, fcz); nor.push(0, 1, 0); uvs.push(0, 5); col.push(seed, F_ROOF + DIST.tint, r * 2, 1);
    for (let k = 0; k < nS; k++) {
      const a = k * step;
      let vx0 = cx + Math.cos(a) * r, vz0 = cz + Math.sin(a) * r;
      if (xfOn) { const p = xfPoint(vx0, vz0); vx0 = p.x; vz0 = p.z; }
      pos.push(vx0, y0 + h, vz0);
      nor.push(0, 1, 0); uvs.push(Math.cos(a) * r, 5 + Math.sin(a) * r);
      col.push(seed, F_ROOF + DIST.tint, r * 2, 1);
    }
    for (let k = 0; k < nS; k++) idx.push(bc, bc + 1 + k, bc + 1 + ((k + 1) % nS));
  }

  /** Skyline clutter on a roof: AC units, stair bulkheads, water tanks. */
  function roofClutter(x0, z0, x1, z1, y, seed) {
    const w = x1 - x0, d = z1 - z0;
    if (w < 7 || d < 7 || rng() < 0.25) return;
    const count = 1 + (rng() < 0.4 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const kind = (rng() * 3) | 0;
      if (kind === 0) {
        const s = 1.5 + rng() * 0.7, hh = 0.9 + rng() * 0.4;
        const px = x0 + 1.8 + rng() * Math.max(0.1, w - 3.6 - s);
        const pz = z0 + 1.8 + rng() * Math.max(0.1, d - 3.6 - s);
        box(px, pz, px + s, pz + s * (0.7 + rng() * 0.5), y - 0.05, hh, seed);
      } else if (kind === 1) {
        const bw = 2.6 + rng() * 1.0, bd = 2.2 + rng() * 0.6, hh = 2.5 + rng() * 0.5;
        if (bw > w - 3.6 || bd > d - 3.6) continue;
        const px = x0 + 1.8 + rng() * (w - 3.6 - bw);
        const pz = z0 + 1.8 + rng() * (d - 3.6 - bd);
        box(px, pz, px + bw, pz + bd, y - 0.05, hh, seed);
      } else {
        const r = 1.2 + rng() * 0.35, hh = 2.4 + rng() * 0.5;
        if (2 * r > w - 4.4 || 2 * r > d - 4.4) continue;
        const px = x0 + 2.2 + r + rng() * (w - 4.4 - 2 * r);
        const pz = z0 + 2.2 + r + rng() * (d - 4.4 - 2 * r);
        box(px - r * 0.8, pz - r * 0.8, px + r * 0.8, pz + r * 0.8, y - 0.05, 0.4, seed);
        tank(px, pz, y + 0.3, r, hh, seed);
      }
    }
  }

  // -- one street-wall building --------------------------------------------
  function addBuilding(o) {
    const seed = rng();
    const style = DIST.styles[(rng() * DIST.styles.length) | 0];
    const setback = rng() < 0.22 ? 0.5 + rng() * 1.5 : 0;
    const depth = district === 3 ? 15 + rng() * 7 : 11 + rng() * 8;   // warehouses run deep
    const gap = 0.03;
    let bx0, bx1, bz0, bz1, frontPlane;
    const fronts = { xm: false, xp: false, zm: false, zp: false };
    if (o.nx !== 0) {
      frontPlane = o.plane + (o.nx < 0 ? setback : -setback);
      if (o.nx < 0) { bx0 = frontPlane; bx1 = frontPlane + depth; fronts.xm = true; }
      else { bx1 = frontPlane; bx0 = frontPlane - depth; fronts.xp = true; }
      bz0 = o.a0 + gap; bz1 = o.a1 - gap;
      if (o.frontLow) fronts.zm = true;
      if (o.frontHigh) fronts.zp = true;
    } else {
      frontPlane = o.plane + (o.nz < 0 ? setback : -setback);
      if (o.nz < 0) { bz0 = frontPlane; bz1 = frontPlane + depth; fronts.zm = true; }
      else { bz1 = frontPlane; bz0 = frontPlane - depth; fronts.zp = true; }
      bx0 = o.a0 + gap; bx1 = o.a1 - gap;
      if (o.frontLow) fronts.xm = true;
      if (o.frontHigh) fronts.xp = true;
    }
    const cx = (bx0 + bx1) * 0.5, cz = (bz0 + bz1) * 0.5;
    const fx = o.nx !== 0 ? frontPlane : cx;
    const fz = o.nx !== 0 ? cz : frontPlane;
    // street curvature: rotate this building to its street's local tangent
    // and shift it by the warp — the frontage follows the curved sidewalk
    const line = o.nx !== 0 ? Math.round(o.plane / PERIOD_X) : Math.round(o.plane / PERIOD_Z);
    const dyaw = o.nx !== 0 ? streetYawDelta(0, line, fz) : streetYawDelta(1, line, fx);
    setXform(fx, fz, dyaw);
    const wf = xfPoint(fx, fz);
    const wfx = wf.x, wfz = wf.z;
    const vOff = groundHeight(wfx, wfz);
    const yBase = vOff - 0.9;

    // ---- residential houses: narrow parcels become gabled row houses ----
    const width = o.nx !== 0 ? bz1 - bz0 : bx1 - bx0;
    if (district === 2 && width < 14.5 && rng() < 0.72) {
      // pull the back edge in — houses are shallower than tenements
      const hDepth = 8 + rng() * 3;
      if (o.nx < 0) bx1 = bx0 + hDepth;
      else if (o.nx > 0) bx0 = bx1 - hDepth;
      else if (o.nz < 0) bz1 = bz0 + hDepth;
      else bz0 = bz1 - hDepth;
      const eaveY = vOff + 6.0 + rng() * 3.0;
      const ridgeY = eaveY + 1.7 + rng() * 1.1;
      const topRel = eaveY - vOff;
      wallFace(0, -1, bx0, bz0, bz1, yBase, eaveY, seed, style | (fronts.xm ? F_FRONT : 0), topRel, vOff);
      wallFace(0, 1, bx1, bz0, bz1, yBase, eaveY, seed, style | (fronts.xp ? F_FRONT : 0), topRel, vOff);
      wallFace(1, -1, bz0, bx0, bx1, yBase, eaveY, seed, style | (fronts.zm ? F_FRONT : 0), topRel, vOff);
      wallFace(1, 1, bz1, bx0, bx1, yBase, eaveY, seed, style | (fronts.zp ? F_FRONT : 0), topRel, vOff);
      const rf = style | F_ROOF;
      const H = ridgeY - eaveY;
      if (o.nx !== 0) {
        // ridge runs along z
        const xm = (bx0 + bx1) / 2, D = xm - bx0, W = bz1 - bz0;
        const L = Math.hypot(H, D);
        quad(bx0, eaveY, bz1, 0, 0, -W, D, H, 0, -H / L, D / L, 0, 0, W, 0, L, seed, rf, W, H);
        quad(bx1, eaveY, bz0, 0, 0, W, -D, H, 0, H / L, D / L, 0, 0, W, 0, L, seed, rf, W, H);
        tri(bx0, eaveY, bz0, bx1, eaveY, bz0, xm, ridgeY, bz0, 0, 0, -1, seed, style, bx1 - bx0, H);
        tri(bx1, eaveY, bz1, bx0, eaveY, bz1, xm, ridgeY, bz1, 0, 0, 1, seed, style, bx1 - bx0, H);
      } else {
        // ridge runs along x
        const zm = (bz0 + bz1) / 2, D = zm - bz0, L2 = bx1 - bx0;
        const L = Math.hypot(H, D);
        quad(bx0, eaveY, bz0, L2, 0, 0, 0, H, D, 0, D / L, -H / L, 0, L2, 0, L, seed, rf, L2, H);
        quad(bx1, eaveY, bz1, -L2, 0, 0, 0, H, -D, 0, D / L, H / L, 0, L2, 0, L, seed, rf, L2, H);
        tri(bx0, eaveY, bz1, bx0, eaveY, bz0, bx0, ridgeY, zm, -1, 0, 0, seed, style, bz1 - bz0, H);
        tri(bx1, eaveY, bz0, bx1, eaveY, bz1, bx1, ridgeY, zm, 1, 0, 0, seed, style, bz1 - bz0, H);
      }
      clearXform();
      frontCands.push({
        nx: o.nx, nz: o.nz, plane: frontPlane,
        a0: o.nx !== 0 ? bz0 : bx0,
        w: width, vOff, h1: topRel, fx: wfx, fz: wfz, dInt: Infinity,
        xfPX: fx, xfPZ: fz, xfYaw: dyaw,
      });
      return setback + hDepth + 0.15;
    }

    const span = DIST.hHi - DIST.hLo;
    let h = DIST.hLo + hBias * span * 0.65 + rng() * span * 0.35;
    if (h > 60) h = 60;
    let h1 = h;
    const hasUpper = h >= 22 && rng() < 0.45;
    if (hasUpper) h1 = h * (0.52 + rng() * 0.18);

    mass(bx0, bz0, bx1, bz1, yBase, vOff + h1, vOff, seed, style, fronts);
    let tx0 = bx0, tz0 = bz0, tx1 = bx1, tz1 = bz1, topY = vOff + h1;
    if (hasUpper) {
      const fIn = 1.6 + rng() * 1.2, sIn = 1.0 + rng() * 0.8, bIn = 0.6;
      const ux0 = bx0 + (o.nx < 0 ? fIn : o.nx > 0 ? bIn : sIn);
      const ux1 = bx1 - (o.nx > 0 ? fIn : o.nx < 0 ? bIn : sIn);
      const uz0 = bz0 + (o.nz < 0 ? fIn : o.nz > 0 ? bIn : sIn);
      const uz1 = bz1 - (o.nz > 0 ? fIn : o.nz < 0 ? bIn : sIn);
      if (ux1 - ux0 > 4.5 && uz1 - uz0 > 4.5) {
        mass(ux0, uz0, ux1, uz1, vOff + h1 - 0.4, vOff + h, vOff, seed, style, fronts);
        tx0 = ux0; tz0 = uz0; tx1 = ux1; tz1 = uz1; topY = vOff + h;
      }
    }
    roofClutter(tx0, tz0, tx1, tz1, topY, seed);
    clearXform();

    // sign candidates: distance to the nearest block corner (≈ the crossing)
    let dInt = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const d = Math.hypot(fx - corners[i][0], fz - corners[i][1]);
      if (d < dInt) dInt = d;
    }
    frontCands.push({
      nx: o.nx, nz: o.nz, plane: frontPlane,
      a0: o.nx !== 0 ? bz0 : bx0,
      w: o.nx !== 0 ? bz1 - bz0 : bx1 - bx0,
      vOff, h1, fx: wfx, fz: wfz, dInt,
      xfPX: fx, xfPZ: fz, xfYaw: dyaw,
    });
    if (h >= 20 && h <= 44) {
      roofCands.push({ x0: tx0, z0: tz0, x1: tx1, z1: tz1, topY, nx: o.nx, nz: o.nz, xfPX: fx, xfPZ: fz, xfYaw: dyaw });
    }
    return setback + depth + 0.15;
  }

  // -- vacant lot: a fenced flat slab breaks the street wall ----------------
  function emitLot(o) {
    const seed = rng();
    const depth = 11 + rng() * 5;
    const gap = 0.03;
    let bx0, bx1, bz0, bz1, frontPlane;
    if (o.nx !== 0) {
      frontPlane = o.plane;
      if (o.nx < 0) { bx0 = frontPlane; bx1 = frontPlane + depth; }
      else { bx1 = frontPlane; bx0 = frontPlane - depth; }
      bz0 = o.a0 + gap; bz1 = o.a1 - gap;
    } else {
      frontPlane = o.plane;
      if (o.nz < 0) { bz0 = frontPlane; bz1 = frontPlane + depth; }
      else { bz1 = frontPlane; bz0 = frontPlane - depth; }
      bx0 = o.a0 + gap; bx1 = o.a1 - gap;
    }
    const fx = o.nx !== 0 ? frontPlane : (bx0 + bx1) * 0.5;
    const fz = o.nx !== 0 ? (bz0 + bz1) * 0.5 : frontPlane;
    const line = o.nx !== 0 ? Math.round(o.plane / PERIOD_X) : Math.round(o.plane / PERIOD_Z);
    const dyaw = o.nx !== 0 ? streetYawDelta(0, line, fz) : streetYawDelta(1, line, fx);
    setXform(fx, fz, dyaw);
    const wf = xfPoint(fx, fz);
    const vOff = groundHeight(wf.x, wf.z);
    // cracked asphalt slab (roof material reads as old blacktop)
    upFace(bx0, bz0, bx1, bz1, vOff + 0.04, seed, F_ROOF);
    // low perimeter wall, knee-high at the street, taller at the back
    const wallFlags = 5 | F_TRIM;
    const frontH = 0.5, backH = 1.1;
    const sides = [
      { axis: 0, plane: bx0, a0: bz0, a1: bz1, front: o.nx < 0 },
      { axis: 0, plane: bx1, a0: bz0, a1: bz1, front: o.nx > 0 },
      { axis: 1, plane: bz0, a0: bx0, a1: bx1, front: o.nz < 0 },
      { axis: 1, plane: bz1, a0: bx0, a1: bx1, front: o.nz > 0 },
    ];
    for (const sd of sides) {
      const hW = sd.front ? frontH : backH;
      wallFace(sd.axis, 1, sd.plane, sd.a0, sd.a1, vOff, vOff + hW, seed, wallFlags, hW, vOff);
      wallFace(sd.axis, -1, sd.plane, sd.a0, sd.a1, vOff, vOff + hW, seed, wallFlags, hW, vOff);
    }
    clearXform();
  }

  // -- sparse back-row towers in the block interior -------------------------
  function backRow() {
    const fx0 = rect.x0 + 27, fx1 = rect.x1 - 27;
    const fz0 = rect.z0 + 27, fz1 = rect.z1 - 27;
    const fw = fx1 - fx0, fd = fz1 - fz0;
    if (fw < 18 || fd < 16) return;
    const nT = Math.min(3, Math.max(1, Math.round((fw * fd) / 3400)));
    const placed = [];
    for (let tries = 0; tries < nT * 4 && placed.length < nT; tries++) {
      const tw = 16 + rng() * 10, td = 14 + rng() * 9;
      if (tw > fw || td > fd) continue;
      const tx = fx0 + rng() * (fw - tw);
      const tz = fz0 + rng() * (fd - td);
      let ok = true;
      for (const p of placed) {
        if (tx < p.x1 + 3 && tx + tw > p.x0 - 3 && tz < p.z1 + 3 && tz + td > p.z0 - 3) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push({ x0: tx, z0: tz, x1: tx + tw, z1: tz + td });
      const seed = rng();
      const style = Math.min(5, (rng() * 6) | 0);
      let h = DIST.hLo + (DIST.hHi - DIST.hLo) * (0.7 + hBias * 0.5) + rng() * 8;
      if (h > 60) h = 60;
      setXform(tx + tw / 2, tz + td / 2, 0);   // interior towers: warp shift only
      const wc = xfPoint(tx + tw / 2, tz + td / 2);
      const vOff = groundHeight(wc.x, wc.z);
      let h1 = h;
      const hasUpper = rng() < 0.5;
      if (hasUpper) h1 = h * (0.55 + rng() * 0.15);
      mass(tx, tz, tx + tw, tz + td, vOff - 0.9, vOff + h1, vOff, seed, style, NO_FRONTS);
      if (hasUpper) {
        const inx = 1.5 + rng(), inz = 1.5 + rng();
        mass(tx + inx, tz + inz, tx + tw - inx, tz + td - inz, vOff + h1 - 0.4, vOff + h, vOff, seed, style, NO_FRONTS);
        roofClutter(tx + inx, tz + inz, tx + tw - inx, tz + td - inz, vOff + h, seed);
      } else {
        roofClutter(tx, tz, tx + tw, tz + td, vOff + h1, seed);
      }
      clearXform();
    }
  }

  // -- walk the block edges (every side faces a street) ---------------------
  const ins = { swx: 0, nwx: 0, sex: 0, nex: 0 };

  // N-S facing edges first — their corner buildings claim the corners
  for (const sgn of [-1, 1]) {
    const plane = sgn < 0 ? rect.x0 : rect.x1;
    const ws = splitSpan(rect.z1 - rect.z0, rng, DIST.split);
    let a = rect.z0;
    for (let i = 0; i < ws.length; i++) {
      const corner = i === 0 || i === ws.length - 1;
      const o = {
        nx: sgn, nz: 0, plane, a0: a, a1: a + ws[i],
        frontLow: i === 0,
        frontHigh: i === ws.length - 1,
      };
      // mid-slot vacant lots break the street wall (corners stay built)
      if (!corner && rng() < DIST.lot) {
        emitLot(o);
      } else {
        const d = addBuilding(o);
        if (i === 0) { if (sgn < 0) ins.swx = d; else ins.sex = d; }
        if (i === ws.length - 1) { if (sgn < 0) ins.nwx = d; else ins.nex = d; }
      }
      a += ws[i];
      yield;
    }
  }
  // E-W facing edges, inset past the corner buildings
  for (const sgn of [-1, 1]) {
    const plane = sgn < 0 ? rect.z0 : rect.z1;
    const insLow = sgn < 0 ? ins.swx : ins.nwx;
    const insHigh = sgn < 0 ? ins.sex : ins.nex;
    const s0 = rect.x0 + insLow, s1 = rect.x1 - insHigh;
    if (s1 - s0 < 9) continue;
    const ws = splitSpan(s1 - s0, rng, DIST.split);
    let a = s0;
    for (const w of ws) {
      const o = { nx: 0, nz: sgn, plane, a0: a, a1: a + w, frontLow: false, frontHigh: false };
      if (rng() < DIST.lot) emitLot(o);
      else addBuilding(o);
      a += w;
      yield;
    }
  }
  if (cellSeed(ix, jz, 11) < DIST.towers) {
    backRow();
    yield;
  }

  // -- neon signs on facades near the crossings -----------------------------
  function pushLight(x, y, z, pal, radius, base) {
    if (xfOn) { const p = xfPoint(x, z); x = p.x; z = p.z; }
    lights.push({ x, y, z, r: pal[0], g: pal[1], b: pal[2], radius, intensity: base, base });
  }

  const nSignsRoll = cellSeed(ix, jz, 9);
  const nSigns = nSignsRoll < 0.45 * DIST.signs ? 1 : nSignsRoll < 0.72 * DIST.signs ? 2 : 0;
  const flick = cellSeed(ix, jz, 13) < 0.18;
  frontCands.sort((a, b) => a.dInt - b.dInt);
  const picked = [];
  for (const c of frontCands) {
    if (picked.length >= nSigns) break;
    if (c.h1 < 11.5 || c.w < 12 || c.dInt > 60) continue;
    let ok = true;
    for (const p of picked) {
      if (Math.hypot(c.fx - p.fx, c.fz - p.fz) < 24) { ok = false; break; }
    }
    if (ok) picked.push(c);
  }
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    setXform(c.xfPX, c.xfPZ, c.xfYaw);   // signs follow their building's warp
    const seed = rng();
    const pal = NEON_PAL[Math.min(3, Math.floor(seed * 3.999))];
    const flags = F_NEON | (flick && i === 0 ? F_FLICK : 0);
    const blade = i === 1;
    if (blade) {
      // blade sign sticking out perpendicular to the facade
      const bw = 1.1 + rng() * 0.3, bh = 3.0 + rng() * 1.2;
      const yb = c.vOff + 5.4 + rng() * 1.4;
      const ac = c.a0 + c.w * (0.22 + rng() * 0.2);
      if (c.nx !== 0) {
        const e0 = c.plane + c.nx * 0.12, e1 = c.plane + c.nx * (0.12 + bw);
        const xlo = Math.min(e0, e1), xhi = Math.max(e0, e1);
        wallFace(1, 1, ac + 0.05, xlo, xhi, yb, yb + bh, seed, flags, bh, yb);
        wallFace(1, -1, ac - 0.05, xlo, xhi, yb, yb + bh, seed, flags, bh, yb);
        pushLight((xlo + xhi) / 2, yb + bh / 2, ac, pal, 9, 1.9);
      } else {
        const e0 = c.plane + c.nz * 0.12, e1 = c.plane + c.nz * (0.12 + bw);
        const zlo = Math.min(e0, e1), zhi = Math.max(e0, e1);
        wallFace(0, 1, ac + 0.05, zlo, zhi, yb, yb + bh, seed, flags, bh, yb);
        wallFace(0, -1, ac - 0.05, zlo, zhi, yb, yb + bh, seed, flags, bh, yb);
        pushLight(ac, yb + bh / 2, (zlo + zhi) / 2, pal, 9, 1.9);
      }
    } else {
      // flat wall sign over the facade, with a dark backing panel
      const vertical = rng() < 0.4 && c.h1 >= 13;
      const sw = vertical ? 1.15 + rng() * 0.4 : 2.6 + rng() * 2.0;
      const sh = vertical ? 3.2 + rng() * 1.8 : 1.15 + rng() * 0.8;
      let yb = c.vOff + 5.1 + rng() * 2.0;
      if (yb + sh > c.vOff + c.h1 - 1.2) yb = c.vOff + c.h1 - 1.2 - sh;
      const uc = Math.min(c.w - sw / 2 - 1, Math.max(sw / 2 + 1, c.w * (0.3 + rng() * 0.4)));
      const lo = c.a0 + uc - sw / 2, hi = c.a0 + uc + sw / 2;
      const axis = c.nx !== 0 ? 0 : 1;
      const s = c.nx !== 0 ? c.nx : c.nz;
      wallFace(axis, s, c.plane + s * 0.10, lo - 0.15, hi + 0.15, yb - 0.15, yb + sh + 0.15, seed, F_ROOF, sh + 0.3, yb - 0.15);
      wallFace(axis, s, c.plane + s * 0.17, lo, hi, yb, yb + sh, seed, flags, sh, yb);
      const lx = axis === 0 ? c.plane + s * 0.7 : c.a0 + uc;
      const lz = axis === 0 ? c.a0 + uc : c.plane + s * 0.7;
      pushLight(lx, yb + sh / 2, lz, pal, Math.min(14, 6 + sw * sh * 0.9), Math.min(3.2, 1.4 + sw * sh * 0.18));
    }
    clearXform();
  }

  // -- rooftop sign frame on some blocks ------------------------------------
  if (cellSeed(ix, jz, 17) < 0.18 * DIST.signs) {
    const roofOk = roofCands.filter((c) => {
      const span = c.nx !== 0 ? c.z1 - c.z0 : c.x1 - c.x0;
      return span >= 8 && (c.nx !== 0 || c.nz !== 0);
    });
    if (roofOk.length > 0) {
      const c = roofOk[(rng() * roofOk.length) | 0];
      setXform(c.xfPX, c.xfPZ, c.xfYaw);
      const seed = rng();
      const pal = NEON_PAL[Math.min(3, Math.floor(seed * 3.999))];
      const axis = c.nx !== 0 ? 0 : 1;
      const s = axis === 0 ? c.nx : c.nz;
      const spanLo = axis === 0 ? c.z0 : c.x0;
      const spanHi = axis === 0 ? c.z1 : c.x1;
      const rw = Math.min(9, spanHi - spanLo - 1.6);
      const rh = 2.4 + rng() * 0.6;
      const mid = (spanLo + spanHi) / 2;
      const yb = c.topY + 1.1;
      const plane = axis === 0
        ? (s < 0 ? c.x0 + 0.9 : c.x1 - 0.9)
        : (s < 0 ? c.z0 + 0.9 : c.z1 - 0.9);
      wallFace(axis, s, plane, mid - rw / 2, mid + rw / 2, yb, yb + rh, seed, F_NEON, rh, yb);
      wallFace(axis, -s, plane - s * 0.10, mid - rw / 2, mid + rw / 2, yb, yb + rh, seed, F_ROOF, rh, yb);
      for (let i = 0; i < 4; i++) {
        const pc = mid - rw / 2 + 0.5 + (rw - 1.0) * (i / 3);
        if (axis === 0) box(plane - 0.10, pc - 0.07, plane + 0.02, pc + 0.07, c.topY - 0.1, 1.3, seed);
        else box(pc - 0.07, plane - 0.10, pc + 0.07, plane + 0.02, c.topY - 0.1, 1.3, seed);
      }
      const lx = axis === 0 ? plane + s * 0.8 : mid;
      const lz = axis === 0 ? mid : plane + s * 0.8;
      pushLight(lx, yb + rh / 2, lz, pal, 16, 3.0);
      clearXform();
    }
  }
}

export class Buildings {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    this.scene = scene;
    this._env = env;
    /** bumped whenever block meshes stream in/out */
    this.generation = 0;
    /** bumped whenever the neon light set changes */
    this.lightsGen = 0;

    if (!ShaderStore.IncludesShadersStoreWGSL['nlCommon']) {
      ShaderStore.IncludesShadersStoreWGSL['nlCommon'] = commonWgsl;
    }
    ShaderStore.ShadersStoreWGSL['nlFacadeVertexShader'] = facadeVertex;
    ShaderStore.ShadersStoreWGSL['nlFacadeFragmentShader'] = facadeFragment;

    this.material = new ShaderMaterial('nlFacade', scene, {
      vertex: 'nlFacade', fragment: 'nlFacade',
    }, {
      attributes: ['position', 'normal', 'uv', 'color'],
      uniformBuffers: ['Scene', 'Mesh'],
      shaderLanguage: ShaderLanguage.WGSL,
    });

    /** @type {Map<string, {mesh: Mesh|null, lights: Array}|null>} */
    this._blocks = new Map();
    this._queue = [];
    this._task = null;   // {key, ix, jz, rect, gen, geo, lights}
    this._scanX = Infinity; this._scanZ = Infinity;
    this._neonIntensity = 1;
    /** flat list rebuilt on block add/remove; same array instance forever */
    this._neonLights = [];

    // preallocated uniform storage (ShaderMaterial stores references, so each
    // uniform needs its own object — never share a scratch across names)
    this._sunDir = new Vector3(0, -1, 0);
    this._sunColor = new Color3(1, 1, 1);
    this._ambientSky = new Color3(0.2, 0.25, 0.4);
    this._ambientGround = new Color3(0.15, 0.13, 0.12);
    this._fogColor = new Color3(0.3, 0.3, 0.38);
    this._time = 0;
    this.material.setFloat('time', 0);

    // canyon sun shadows: sample the car-follow shadow map like the road does
    if (env && env.shadow) {
      this.material.setTexture('sunShadowMap', env.shadow.getShadowMap());
      this._shadowDV = new Vector2(env.sun.shadowMinZ, env.sun.shadowMaxZ);
      this.material.setVector2('shadowDV', this._shadowDV);
      this.material.setFloat('shadowMapSize', env.shadow.getShadowMap().getSize().width);
      this.material.setMatrix('sunShadowMatrix', env.shadow.getTransformMatrix());
    }

    if (env) this.applyEnvironment(env);
  }

  _rescan(cx, cz) {
    this._scanX = cx; this._scanZ = cz;
    for (const bl of blocksInRegion(cx - R_BUILD, cx + R_BUILD, cz - R_BUILD, cz + R_BUILD)) {
      const key = `${bl.ix}:${bl.jz}`;
      if (this._blocks.has(key)) continue;
      const bcx = (bl.x0 + bl.x1) * 0.5, bcz = (bl.z0 + bl.z1) * 0.5;
      const dx = Math.max(0, Math.abs(cx - bcx) - (bl.x1 - bl.x0) * 0.5);
      const dz = Math.max(0, Math.abs(cz - bcz) - (bl.z1 - bl.z0) * 0.5);
      if (Math.hypot(dx, dz) > R_BUILD) continue;
      this._blocks.set(key, null);
      this._queue.push({ key, ix: bl.ix, jz: bl.jz, rect: bl });
    }
    for (const [key, entry] of this._blocks) {
      if (this._task && this._task.key === key) continue;
      const [ix, jz] = key.split(':').map(Number);
      const bcx = (ix + 0.5) * PERIOD_X, bcz = (jz + 0.5) * PERIOD_Z;
      const dx = Math.max(0, Math.abs(cx - bcx) - PERIOD_X * 0.5);
      const dz = Math.max(0, Math.abs(cz - bcz) - PERIOD_Z * 0.5);
      if (Math.hypot(dx, dz) > R_DROP) {
        if (entry) {
          if (entry.mesh) entry.mesh.dispose(false, false);
          this.generation++;
          if (entry.lights.length > 0) this._rebuildLightList();
        }
        this._blocks.delete(key);
      }
    }
  }

  _rebuildLightList() {
    this._neonLights.length = 0;
    for (const entry of this._blocks.values()) {
      if (!entry) continue;
      for (const L of entry.lights) this._neonLights.push(L);
    }
    this.lightsGen++;
  }

  _startTask(next) {
    const geo = { pos: [], nor: [], uvs: [], col: [], idx: [] };
    const lights = [];
    this._task = {
      key: next.key, ix: next.ix, jz: next.jz, geo, lights,
      gen: buildBlockGen(next.ix, next.jz, next.rect, geo, lights),
    };
  }

  _finishTask() {
    const t = this._task;
    const g = t.geo;
    let mesh = null;
    if (g.idx.length > 0) {
      mesh = new Mesh(`nlBuildings_${t.key}`, this.scene);
      const vd = new VertexData();
      vd.positions = new Float32Array(g.pos);
      vd.normals = new Float32Array(g.nor);
      vd.uvs = new Float32Array(g.uvs);
      vd.colors = new Float32Array(g.col);
      vd.indices = new Uint32Array(g.idx);
      vd.applyToMesh(mesh, false);
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
    }
    for (const L of t.lights) L.intensity = L.base * this._neonIntensity;
    this._blocks.set(t.key, { mesh, lights: t.lights });
    this._task = null;
    this.generation++;
    if (t.lights.length > 0) this._rebuildLightList();
  }

  /** Per-frame: flicker clock, follow-shadow matrix, streaming. */
  update(dt, camX, camZ) {
    this._time += dt;
    this.material.setFloat('time', this._time);
    if (this._env && this._env.shadow) {
      this.material.setMatrix('sunShadowMatrix', this._env.shadow.getTransformMatrix());
    }

    if (Math.hypot(camX - this._scanX, camZ - this._scanZ) > RESCAN_DIST) {
      this._rescan(camX, camZ);
    }

    const deadline = buildBudget.deadline();
    if (performance.now() >= deadline) return;
    const t0 = performance.now();
    while (performance.now() < deadline) {
      if (!this._task) {
        const next = this._queue.shift();
        if (!next) break;
        if (this._blocks.get(next.key) !== null) continue; // evicted while queued
        this._startTask(next);
      }
      if (this._task.gen.next().done) this._finishTask();
    }
    buildBudget.report(performance.now() - t0);
  }

  /** Build every queued block synchronously (loading-screen warmup). */
  prewarm(camX, camZ) {
    this._rescan(camX, camZ);
    let next;
    while ((next = this._queue.shift())) {
      if (this._blocks.get(next.key) !== null) continue;
      this._startTask(next);
      while (!this._task.gen.next().done) { /* run to completion */ }
      this._finishTask();
    }
  }

  /** Push env.params into the facade uniforms. Allocation-free. */
  applyEnvironment(env) {
    const p = env.params;
    const m = this.material;
    this._sunDir.copyFrom(env.sunDir);
    m.setVector3('sunDir', this._sunDir);
    this._sunColor.copyFromFloats(p.sunColor[0], p.sunColor[1], p.sunColor[2]);
    m.setColor3('sunColor', this._sunColor);
    this._ambientSky.copyFromFloats(p.ambientSky[0], p.ambientSky[1], p.ambientSky[2]);
    m.setColor3('ambientSky', this._ambientSky);
    this._ambientGround.copyFromFloats(p.ambientGround[0], p.ambientGround[1], p.ambientGround[2]);
    m.setColor3('ambientGround', this._ambientGround);
    this._fogColor.copyFromFloats(p.fogColor[0], p.fogColor[1], p.fogColor[2]);
    m.setColor3('fogColor', this._fogColor);
    // fade the sun exactly like Environment.apply() does, so night states work
    const sinEl = -env.sunDir.y;
    m.setFloat('sunIntensity', p.sunIntensity * Math.min(1, Math.max(0, sinEl * 8)));
    m.setFloat('ambientIntensity', p.ambientIntensity);
    m.setFloat('fogDensity', p.fogDensity);
    m.setFloat('fogHeightFalloff', p.fogHeightFalloff);
    m.setFloat('exposure', p.exposure);
    m.setFloat('neonIntensity', p.neonIntensity);
    m.setFloat('windowLitFraction', p.windowLitFraction);
    this._neonIntensity = p.neonIntensity;
    for (const entry of this._blocks.values()) {
      if (!entry) continue;
      for (const L of entry.lights) L.intensity = L.base * p.neonIntensity;
    }
  }

  /** Touch the pipeline once during loading. */
  warmup() {
    for (const entry of this._blocks.values()) {
      if (entry && entry.mesh) { this.material.forceCompilation(entry.mesh); return; }
    }
  }

  /**
   * Neon sign emitters for the road shader's wet reflections. Same array
   * instance every call; contents change when blocks stream (watch lightsGen).
   */
  getNeonLights() {
    return this._neonLights;
  }
}
