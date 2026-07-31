/**
 * Skyline — far-field city beyond the playable blocks.
 *
 * Three concentric (slightly elliptical) rings of procedural tower impostors
 * plus three low "city floor" ribbons so tower bases never float. Everything
 * is ONE merged mesh, one WGSL material, one draw call. Impostors are real
 * 3D-positioned boxes (4 fixed side quads, no top caps — the chase cam sits
 * ~2 m above the road so roofs are never seen), which makes lit windows
 * parallax correctly while driving.
 *
 * Per-vertex packing (consumed by skyline.fragment.wgsl):
 *   uv    — facade coordinates in METERS (u along the face from its left
 *           edge, v above the tower base). The window grid lives here.
 *   uv2   — (towerSeed 0..1, towerTotalHeight m)
 *   uv3   — (faceWidth m, ring 0|1|2, 3 = floor ribbon)
 *   color — (windowLitDensity, warmth 0..1, kind, extra)
 *           kind: 0 = facade, 3 = antenna spike; extra: crown-lit amount on
 *           facades, aviation-beacon flag on antennas.
 *
 * Geometry is built once at construction and frozen; update() only advances
 * a time uniform (beacon blink). Zero per-frame allocations.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { groundHeight } from './roadProfile.js';
import skylineVertex from '../shaders/skyline.vertex.wgsl?raw';
import skylineFragment from '../shaders/skyline.fragment.wgsl?raw';

// Tower rings. Radii keep everything well inside the sky dome and the 2000 m
// camera far plane; ring C is the barely-lit far mass.
const RINGS = [
  { n: 38, r0: 285, r1: 420, hMin: 55, hMax: 150, wMin: 16, wMax: 34, tier: 0.45, litMul: 1.0 },
  { n: 52, r0: 450, r1: 700, hMin: 70, hMax: 215, wMin: 22, wMax: 55, tier: 0.30, litMul: 0.65 },
  { n: 34, r0: 750, r1: 940, hMin: 90, hMax: 265, wMin: 36, wMax: 85, tier: 0.0, litMul: 0.28 },
];
// Continuous low-rise ribbons (closed polygonal walls) under/between the rings.
const FLOORS = [
  { n: 56, r: 275, jit: 0.04, hMin: 4, hMax: 13, lit: 0.032 },
  { n: 48, r: 430, jit: 0.10, hMin: 6, hMax: 19, lit: 0.022 },
  { n: 40, r: 705, jit: 0.10, hMin: 9, hMax: 28, lit: 0.014 },
];
// Rings are superellipses (squircle exponent 1/3), not circles: the corners
// bulge outward so the inner ring and floor ribbon clear the rectangular
// outer buildable blocks (cityPlan blockRects reach +/-260 x, +/-220 z).
const ELL_X = 1.10;
const ELL_Z = 0.94;

function ringX(ang, rad) {
  const c = Math.cos(ang);
  return Math.sign(c) * Math.pow(Math.abs(c), 1 / 3) * rad * ELL_X;
}
function ringZ(ang, rad) {
  const s = Math.sin(ang);
  return Math.sign(s) * Math.pow(Math.abs(s), 1 / 3) * rad * ELL_Z;
}
const SEED = 0x51ca7e;
const MAX_ANTENNAS = 15;
const BEACON_COUNT = 3;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the whole skyline as a single VertexData. Construction-time only. */
function buildGeometry() {
  const pos = [], nrm = [], uv = [], uv2 = [], uv3 = [], col = [], idx = [];

  // a = bottom-left, b = bottom-right, c = top-right, d = top-left (per-corner uvs
  // so ribbon panels can have sloped rooflines with correct facade meters).
  function quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz,
                nx, ny, nz, ua, va, ub, vb, uc, vc, ud, vd2,
                seed, totH, faceW, ring, lit, warm, kind, extra) {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) nrm.push(nx, ny, nz);
    uv.push(ua, va, ub, vb, uc, vc, ud, vd2);
    for (let i = 0; i < 4; i++) {
      uv2.push(seed, totH);
      uv3.push(faceW, ring);
      col.push(lit, warm, kind, extra);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // 4 side faces of a box; vBase keeps facade v (floor meters) continuous
  // across the tiers of setback towers.
  function box(cx, cz, y0, y1, wx, wz, vBase, seed, totH, ring, lit, warm, crown) {
    const hx = wx / 2, hz = wz / 2;
    const v0 = y0 - vBase, v1 = y1 - vBase;
    quad(cx - hx, y0, cz + hz, cx + hx, y0, cz + hz, cx + hx, y1, cz + hz, cx - hx, y1, cz + hz,
      0, 0, 1, 0, v0, wx, v0, wx, v1, 0, v1, seed, totH, wx, ring, lit, warm, 0, crown);
    quad(cx + hx, y0, cz - hz, cx - hx, y0, cz - hz, cx - hx, y1, cz - hz, cx + hx, y1, cz - hz,
      0, 0, -1, 0, v0, wx, v0, wx, v1, 0, v1, seed, totH, wx, ring, lit, warm, 0, crown);
    quad(cx + hx, y0, cz + hz, cx + hx, y0, cz - hz, cx + hx, y1, cz - hz, cx + hx, y1, cz + hz,
      1, 0, 0, 0, v0, wz, v0, wz, v1, 0, v1, seed, totH, wz, ring, lit, warm, 0, crown);
    quad(cx - hx, y0, cz - hz, cx - hx, y0, cz + hz, cx - hx, y1, cz + hz, cx - hx, y1, cz - hz,
      -1, 0, 0, 0, v0, wz, v0, wz, v1, 0, v1, seed, totH, wz, ring, lit, warm, 0, crown);
  }

  const rng = mulberry32(SEED);
  const towers = [];

  // ---- tower rings ----
  for (let ri = 0; ri < RINGS.length; ri++) {
    const R = RINGS[ri];
    for (let i = 0; i < R.n; i++) {
      const ang = ((i + 0.18 + rng() * 0.64) / R.n) * Math.PI * 2;
      const rad = R.r0 + (R.r1 - R.r0) * rng();
      const cx = ringX(ang, rad);
      const cz = ringZ(ang, rad);
      let h = R.hMin + (R.hMax - R.hMin) * Math.pow(rng(), 1.55);
      if (rng() < 0.10) h = Math.min(R.hMax, h + (R.hMax - R.hMin) * 0.3);
      const wx = R.wMin + (R.wMax - R.wMin) * rng();
      const wz = R.wMin + (R.wMax - R.wMin) * rng();
      const seed = rng();
      let lit = (0.06 + 0.55 * Math.pow(rng(), 1.6)) * R.litMul;
      if (rng() < 0.17) lit *= 0.10; // some towers mostly dark
      const warm = 0.22 + 0.7 * rng();
      let crown = 0;
      if (ri < 2 && h > R.hMin + (R.hMax - R.hMin) * 0.55 && rng() < 0.30) {
        crown = 0.45 + 0.55 * rng();
      }
      const y0 = groundHeight(cx, cz) - 2.5; // sunk below any local ground
      const top = y0 + h;

      if (rng() < R.tier) {
        // two-tier setback silhouette
        const h1 = h * (0.52 + 0.16 * rng());
        const w2x = wx * (0.55 + 0.22 * rng());
        const w2z = wz * (0.55 + 0.22 * rng());
        const cx2 = cx + (rng() - 0.5) * (wx - w2x) * 0.6;
        const cz2 = cz + (rng() - 0.5) * (wz - w2z) * 0.6;
        box(cx, cz, y0, y0 + h1, wx, wz, y0, seed, h, ri, lit, warm, 0);
        box(cx2, cz2, y0 + h1 - 0.5, top, w2x, w2z, y0, seed, h, ri, lit, warm, crown);
        towers.push({ cx: cx2, cz: cz2, top, w: Math.min(w2x, w2z), ring: ri, seed });
      } else {
        box(cx, cz, y0, top, wx, wz, y0, seed, h, ri, lit, warm, crown);
        towers.push({ cx, cz, top, w: Math.min(wx, wz), ring: ri, seed });
      }
    }
  }

  // ---- antenna spikes + aviation beacons (crossed thin quads, kind 3) ----
  const byTop = towers.slice().sort((a, b) => b.top - a.top);
  const picks = [];
  for (let i = 0; i < byTop.length; i++) {
    const t = byTop[i];
    if (i < BEACON_COUNT) picks.push({ t, beacon: 1 });
    else if (t.ring < 2 && t.top > 90 && picks.length < MAX_ANTENNAS && rng() < 0.14) {
      picks.push({ t, beacon: 0 });
    }
  }
  for (let i = 0; i < picks.length; i++) {
    const { t, beacon } = picks[i];
    const aH = 7 + rng() * 11;
    const ax = t.cx + (rng() - 0.5) * t.w * 0.5;
    const az = t.cz + (rng() - 0.5) * t.w * 0.5;
    const y0 = t.top - 0.5, y1 = t.top + aH;
    const totH = aH + 0.5, hw = 0.35;
    quad(ax - hw, y0, az, ax + hw, y0, az, ax + hw, y1, az, ax - hw, y1, az,
      0, 0, 1, 0, 0, hw * 2, 0, hw * 2, totH, 0, totH,
      t.seed, totH, hw * 2, t.ring, 0, 0, 3, beacon);
    quad(ax, y0, az - hw, ax, y0, az + hw, ax, y1, az + hw, ax, y1, az - hw,
      1, 0, 0, 0, 0, hw * 2, 0, hw * 2, totH, 0, totH,
      t.seed, totH, hw * 2, t.ring, 0, 0, 3, beacon);
  }

  // ---- city floor ribbons: closed low walls, watertight, bumpy rooflines ----
  for (let fi = 0; fi < FLOORS.length; fi++) {
    const F = FLOORS[fi];
    const n = F.n;
    const px = new Float64Array(n + 1);
    const pz = new Float64Array(n + 1);
    const ph = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2;
      const rad = F.r * (1 + (rng() - 0.5) * F.jit);
      px[k] = ringX(ang, rad);
      pz[k] = ringZ(ang, rad);
      ph[k] = F.hMin + (F.hMax - F.hMin) * rng();
    }
    px[n] = px[0]; pz[n] = pz[0]; ph[n] = ph[0];
    let uAcc = 0;
    for (let k = 0; k < n; k++) {
      const x0 = px[k], z0 = pz[k], x1 = px[k + 1], z1 = pz[k + 1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const nx = dz / len, nz = -dx / len; // outward for CCW loop
      const y0 = -3, h0 = ph[k], h1 = ph[k + 1];
      const seed = rng();
      const totH = (h0 + h1) * 0.5 + 3;
      quad(x0, y0, z0, x1, y0, z1, x1, h1, z1, x0, h0, z0,
        nx, 0, nz,
        uAcc, 0, uAcc + len, 0, uAcc + len, h1 - y0, uAcc, h0 - y0,
        seed, totH, len, 3, F.lit * (0.4 + 1.2 * rng()), 0.5 + 0.4 * rng(), 0, 0);
      uAcc += len;
    }
  }

  const vdata = new VertexData();
  vdata.positions = new Float32Array(pos);
  vdata.normals = new Float32Array(nrm);
  vdata.uvs = new Float32Array(uv);
  vdata.uvs2 = new Float32Array(uv2);
  vdata.uvs3 = new Float32Array(uv3);
  vdata.colors = new Float32Array(col);
  vdata.indices = pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return vdata;
}

export class Skyline {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    if (!ShaderStore.ShadersStoreWGSL['nlSkylineVertexShader']) {
      ShaderStore.ShadersStoreWGSL['nlSkylineVertexShader'] = skylineVertex;
      ShaderStore.ShadersStoreWGSL['nlSkylineFragmentShader'] = skylineFragment;
    }

    this.material = new ShaderMaterial('nlSkyline', scene,
      { vertex: 'nlSkyline', fragment: 'nlSkyline' }, {
        attributes: ['position', 'normal', 'uv', 'uv2', 'uv3', 'color'],
        uniformBuffers: ['Scene', 'Mesh'],
        shaderLanguage: ShaderLanguage.WGSL,
      });
    // crossed antenna quads read from both sides; box overdraw cost is trivial
    this.material.backFaceCulling = false;

    this.mesh = new Mesh('nlSkyline', scene);
    buildGeometry().applyToMesh(this.mesh, false);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true; // ring surrounds the player; skip culling
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.receiveShadows = false;
    this.mesh.freezeWorldMatrix();

    // ShaderMaterial.setColor3 stores the *reference*: register one dedicated
    // Color3 per uniform once, then mutate them in applyEnvironment.
    this._cFog = new Color3();
    this._cHaze = new Color3();
    this._cBody = new Color3();
    this._cSun = new Color3();
    const m = this.material;
    m.setColor3('fogColor', this._cFog);
    m.setColor3('hazeColor', this._cHaze);
    m.setColor3('bodyColor', this._cBody);
    m.setColor3('sunTint', this._cSun);
    m.setFloat('time', 0);
    this._time = 0;

    this.applyEnvironment(env);
    // NOTE: material left unfrozen — `time` changes every frame and env
    // uniforms on every weather change (see MODULE_NOTES). One material total.
  }

  /** Push env.params into uniforms. Called on every weather-state change. */
  applyEnvironment(env) {
    const p = env.params;
    const m = this.material;

    this._cFog.copyFromFloats(p.fogColor[0], p.fogColor[1], p.fogColor[2]);
    this._cHaze.copyFromFloats(p.horizonHaze[0], p.horizonHaze[1], p.horizonHaze[2]);

    // near-silhouette body mass: dark blend of zenith + fog so the skyline is
    // made of the same atmosphere it sits in
    const z = p.zenithColor, f = p.fogColor;
    const amb = 0.5 + 0.7 * p.ambientIntensity;
    this._cBody.copyFromFloats(
      Math.max(0.012, (z[0] * 0.26 + f[0] * 0.14) * amb),
      Math.max(0.013, (z[1] * 0.26 + f[1] * 0.14) * amb),
      Math.max(0.016, (z[2] * 0.28 + f[2] * 0.14) * amb),
    );

    // warm kiss on sun-facing facades at dusk; goes to zero below the horizon
    const el = (p.sunElevation * Math.PI) / 180;
    const sAmp = Math.min(1, Math.max(0, Math.sin(el) * 5 + 0.2)) * p.sunIntensity * 0.045;
    this._cSun.copyFromFloats(p.sunColor[0] * sAmp, p.sunColor[1] * sAmp, p.sunColor[2] * sAmp);

    m.setVector3('sunDir', env.sunDir);
    m.setFloat('fogDensity', p.fogDensity);
    m.setFloat('fogHeightFalloff', p.fogHeightFalloff);
    m.setFloat('windowLitFraction', p.windowLitFraction);
    m.setFloat('windowEmission', 0.45 + 0.85 * p.neonIntensity);
    m.setFloat('beaconIntensity', 0.5 + 0.7 * p.neonIntensity);
    m.setFloat('exposure', p.exposure);
  }

  /** Per-frame: beacon blink only. Allocation-free. */
  update(dt, camX, camZ) {
    this._time += dt;
    this.material.setFloat('time', this._time);
  }

  /** Touch the single pipeline variant once during load. */
  warmup() {
    this.material.forceCompilation(this.mesh);
  }
}
