/**
 * NIGHTLOOP buildings — the street wall around every block plus the neon
 * signage that the road shader smears into the wet asphalt.
 *
 * Geometry strategy: every building on every block edge is baked in world
 * space into ONE merged mesh (1 draw call) rendered with one WGSL
 * ShaderMaterial. Each vertex carries:
 *   uv     — facade-local metres (u along facade from its left edge,
 *            v = height above the building's ground line)
 *   color  — (buildingSeed, flagBits, facadeWidth_m, wallTopV_m)
 * The fragment shader builds window grids / storefronts / roofs / neon
 * entirely from those metres, so detail is resolution-independent and holds
 * up from 10 m to 300 m.
 *
 * Layout comes from cityPlan.blockRects(); everything sits on
 * roadProfile.groundHeight(). Street-facing block edges are split into 2-4
 * frontages with varying width/height/setback; corner buildings claim the
 * corner and present storefronts to both streets. Outer blocks additionally
 * get a sparse back row of taller towers for the skyline.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { blockRects, intersections } from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import facadeVertex from '../shaders/facade.vertex.wgsl?raw';
import facadeFragment from '../shaders/facade.fragment.wgsl?raw';
import commonWgsl from '../shaders/common.wgsl?raw';

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

/** Split an edge length into 1-4 frontage widths of pleasing variety. */
function splitSpan(len, rng) {
  let n = Math.round(len / (20 + rng() * 9));
  if (n < 1) n = 1;
  if (n > 4) n = 4;
  while (n > 1 && len / n < 9) n--;
  const ws = [];
  let sum = 0;
  for (let i = 0; i < n; i++) { const w = 0.72 + rng() * 0.56; ws.push(w); sum += w; }
  for (let i = 0; i < n; i++) ws[i] = (ws[i] / sum) * len;
  return ws;
}

export class Buildings {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    this.scene = scene;

    // shader registration (idempotent; main.js registers nlCommon first, but
    // guard so this module also works standalone)
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

    /** @type {Array<{x:number,y:number,z:number,r:number,g:number,b:number,radius:number,intensity:number}>} */
    this._neonLights = [];
    this._neonBase = [];

    this.mesh = new Mesh('nlBuildings', scene);
    this._build();
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.freezeWorldMatrix();
    this.mesh.doNotSyncBoundingInfo = true;

    // long dusk shadows from the street wall across the road (cheap: one
    // caster mesh per cascade). Remove this line if the CSM budget is tight.
    if (env && env.csm) env.csm.addShadowCaster(this.mesh);

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
    this._env = env;
    if (env && env.shadow) {
      this.material.setTexture('sunShadowMap', env.shadow.getShadowMap());
      this._shadowDV = new Vector2(env.sun.shadowMinZ, env.sun.shadowMaxZ);
      this.material.setVector2('shadowDV', this._shadowDV);
      this.material.setFloat('shadowMapSize', env.shadow.getShadowMap().getSize().width);
      this.material.setMatrix('sunShadowMatrix', env.shadow.getTransformMatrix());
    }

    if (env) this.applyEnvironment(env);
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
    for (let i = 0; i < this._neonLights.length; i++) {
      this._neonLights[i].intensity = this._neonBase[i] * p.neonIntensity;
    }
  }

  /** Per-frame: flicker clock + follow-shadow matrix. Zero allocations. */
  update(dt, _camX, _camZ) {
    this._time += dt;
    this.material.setFloat('time', this._time);
    if (this._env && this._env.shadow) {
      this.material.setMatrix('sunShadowMatrix', this._env.shadow.getTransformMatrix());
    }
  }

  /** Touch the pipeline once during loading. */
  warmup() {
    this.material.forceCompilation(this.mesh);
  }

  /**
   * Neon sign emitters for the road shader's wet reflections. Returns the same
   * array every call; intensities are refreshed by applyEnvironment().
   * @returns {Array<{x:number,y:number,z:number,r:number,g:number,b:number,radius:number,intensity:number}>}
   */
  getNeonLights() {
    return this._neonLights;
  }

  // ------------------------------------------------------------------ build

  _build() {
    const pos = [], nor = [], uvs = [], col = [], idx = [];
    const rng = mulberry32(0x517C17);
    const inters = intersections();
    const frontCands = [];
    const roofCands = [];
    const neonLights = this._neonLights;
    const neonBase = this._neonBase;

    // -- low-level emitters -------------------------------------------------
    // Babylon front faces satisfy cross(eU, eV) == -normal (see planeBuilder).
    function quad(px, py, pz, ux, uy, uz, vx, vy, vz, nx, ny, nz, ua, ub, va, vb, seed, flags, w, top) {
      const b = pos.length / 3;
      pos.push(
        px, py, pz,
        px + ux, py + uy, pz + uz,
        px + ux + vx, py + uy + vy, pz + uz + vz,
        px + vx, py + vy, pz + vz,
      );
      for (let k = 0; k < 4; k++) { nor.push(nx, ny, nz); col.push(seed, flags, w, top); }
      uvs.push(ua, va, ub, va, ub, vb, ua, vb);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }

    /**
     * Vertical wall. axis 0 → normal along X (span a0..a1 is z);
     * axis 1 → normal along Z (span is x). sgn = normal sign.
     * v texcoord = worldY - vOff; u runs 0..(a1-a0) from the face's left edge.
     */
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
      // underside ring
      downFace(x0 - o, z0 - o, x1 + o, z0, yb, seed, fl);
      downFace(x0 - o, z1, x1 + o, z1 + o, yb, seed, fl);
      downFace(x0 - o, z0, x0, z1, yb, seed, fl);
      downFace(x1, z0, x1 + o, z1, yb, seed, fl);
      // cap ring (non-overlapping strips)
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
      // flat cap fan
      const bc = pos.length / 3;
      pos.push(cx, y0 + h, cz); nor.push(0, 1, 0); uvs.push(0, 5); col.push(seed, F_ROOF, r * 2, 1);
      for (let k = 0; k < nS; k++) {
        const a = k * step;
        pos.push(cx + Math.cos(a) * r, y0 + h, cz + Math.sin(a) * r);
        nor.push(0, 1, 0); uvs.push(Math.cos(a) * r, 5 + Math.sin(a) * r);
        col.push(seed, F_ROOF, r * 2, 1);
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

    // -- one street-wall building ------------------------------------------
    // o = {nx, nz, plane, a0, a1, inner, frontLow, frontHigh}
    // returns depth claimed from the block edge (for corner insets)
    function addBuilding(o) {
      const seed = rng();
      const style = Math.min(5, (rng() * 6) | 0);
      const setback = rng() < 0.22 ? 0.5 + rng() * 1.5 : 0;
      const depth = o.inner ? 9 + rng() * 6 : 13 + rng() * 8;
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
      const vOff = groundHeight(fx, fz);
      const yBase = vOff - 0.9;

      let h;
      if (o.inner) {
        h = 12 + rng() * 18;                       // inner blocks 12-30 m
      } else {
        const dc = Math.hypot(cx, cz);             // outer 18-60 m, taller out
        const t = Math.min(1, Math.max(0, (dc - 90) / 160));
        h = 18 + t * 26 + rng() * (6 + t * 10);
        if (h > 60) h = 60;
      }
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

      // sign candidates
      let dInt = Infinity;
      for (let i = 0; i < inters.length; i++) {
        const d = Math.hypot(fx - inters[i].x, fz - inters[i].z);
        if (d < dInt) dInt = d;
      }
      frontCands.push({
        nx: o.nx, nz: o.nz, plane: frontPlane,
        a0: o.nx !== 0 ? bz0 : bx0,
        w: o.nx !== 0 ? bz1 - bz0 : bx1 - bx0,
        vOff, h1, fx, fz, dInt, dCen: Math.hypot(fx, fz),
      });
      if (h >= 20 && h <= 44) {
        roofCands.push({ x0: tx0, z0: tz0, x1: tx1, z1: tz1, topY, nx: o.nx, nz: o.nz, dCen: Math.hypot(cx, cz) });
      }
      return setback + depth + 0.15;
    }

    // -- back-row towers on outer blocks (skyline transition) ---------------
    function backRow(rect, faceW, faceE, faceS, faceN) {
      const fx0 = rect.x0 + (faceW ? 27 : 8);
      const fx1 = rect.x1 - (faceE ? 27 : 8);
      const fz0 = rect.z0 + (faceS ? 27 : 8);
      const fz1 = rect.z1 - (faceN ? 27 : 8);
      const fw = fx1 - fx0, fd = fz1 - fz0;
      if (fw < 18 || fd < 16) return;
      const nT = Math.min(4, Math.max(1, Math.round((fw * fd) / 2800)));
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
        const ccx = tx + tw / 2, ccz = tz + td / 2;
        const t = Math.min(1, Math.max(0, (Math.hypot(ccx, ccz) - 90) / 160));
        let h = 24 + t * 28 + rng() * 8;
        if (h > 60) h = 60;
        const vOff = groundHeight(ccx, ccz);
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
      }
    }

    // -- walk every block ---------------------------------------------------
    for (const rect of blockRects()) {
      const faceW = rect.x0 > -259, faceE = rect.x1 < 259;
      const faceS = rect.z0 > -219, faceN = rect.z1 < 219;
      const ins = { swx: 0, nwx: 0, sex: 0, nex: 0 };

      // N-S facing edges first — their corner buildings claim the corners
      for (const sgn of [-1, 1]) {
        if ((sgn < 0 && !faceW) || (sgn > 0 && !faceE)) continue;
        const plane = sgn < 0 ? rect.x0 : rect.x1;
        const ws = splitSpan(rect.z1 - rect.z0, rng);
        let a = rect.z0;
        for (let i = 0; i < ws.length; i++) {
          const d = addBuilding({
            nx: sgn, nz: 0, plane, a0: a, a1: a + ws[i], inner: rect.inner,
            frontLow: i === 0 && faceS,
            frontHigh: i === ws.length - 1 && faceN,
          });
          if (i === 0) { if (sgn < 0) ins.swx = d; else ins.sex = d; }
          if (i === ws.length - 1) { if (sgn < 0) ins.nwx = d; else ins.nex = d; }
          a += ws[i];
        }
      }
      // E-W facing edges, inset past the corner buildings
      for (const sgn of [-1, 1]) {
        if ((sgn < 0 && !faceS) || (sgn > 0 && !faceN)) continue;
        const plane = sgn < 0 ? rect.z0 : rect.z1;
        const insLow = sgn < 0 ? (faceW ? ins.swx : 0) : (faceW ? ins.nwx : 0);
        const insHigh = sgn < 0 ? (faceE ? ins.sex : 0) : (faceE ? ins.nex : 0);
        const s0 = rect.x0 + insLow, s1 = rect.x1 - insHigh;
        if (s1 - s0 < 9) continue;
        const ws = splitSpan(s1 - s0, rng);
        let a = s0;
        for (const w of ws) {
          addBuilding({ nx: 0, nz: sgn, plane, a0: a, a1: a + w, inner: rect.inner, frontLow: false, frontHigh: false });
          a += w;
        }
      }
      if (!rect.inner) backRow(rect, faceW, faceE, faceS, faceN);
    }

    // -- neon signs on facades near the intersections -----------------------
    function pushLight(x, y, z, pal, radius, base) {
      neonLights.push({ x, y, z, r: pal[0], g: pal[1], b: pal[2], radius, intensity: base });
      neonBase.push(base);
    }

    frontCands.sort((a, b) => (a.dInt + a.dCen * 0.15) - (b.dInt + b.dCen * 0.15));
    const picked = [];
    for (const c of frontCands) {
      if (picked.length >= 8) break;
      if (c.h1 < 11.5 || c.w < 12 || c.dInt > 55) continue;
      let ok = true;
      for (const p of picked) {
        if (Math.hypot(c.fx - p.fx, c.fz - p.fz) < 24) { ok = false; break; }
      }
      if (ok) picked.push(c);
    }
    for (let i = 0; i < picked.length; i++) {
      const c = picked[i];
      const seed = rng();
      const pal = NEON_PAL[Math.min(3, Math.floor(seed * 3.999))];
      const flags = F_NEON | (i === 2 ? F_FLICK : 0);   // exactly ONE flickers
      const blade = i === 1 || i === 4;
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
    }

    // -- 2 rooftop sign frames ---------------------------------------------
    const roofOk = roofCands.filter((c) => {
      const span = c.nx !== 0 ? c.z1 - c.z0 : c.x1 - c.x0;
      return span >= 8 && c.dCen > 30 && c.dCen < 160 && (c.nx !== 0 || c.nz !== 0);
    });
    roofOk.sort((a, b) => Math.abs(a.dCen - 75) - Math.abs(b.dCen - 75));
    const roofPicked = [];
    for (const c of roofOk) {
      if (roofPicked.length >= 2) break;
      let ok = true;
      for (const p of roofPicked) {
        if (Math.hypot((c.x0 + c.x1) / 2 - (p.x0 + p.x1) / 2, (c.z0 + c.z1) / 2 - (p.z0 + p.z1) / 2) < 60) { ok = false; break; }
      }
      if (ok) roofPicked.push(c);
    }
    for (const c of roofPicked) {
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
    }

    // -- upload -------------------------------------------------------------
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.normals = new Float32Array(nor);
    vd.uvs = new Float32Array(uvs);
    vd.colors = new Float32Array(col);
    vd.indices = new Uint32Array(idx);
    vd.applyToMesh(this.mesh, false);
  }
}
