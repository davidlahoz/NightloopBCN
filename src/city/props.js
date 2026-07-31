/**
 * NIGHTLOOP street props — streetlights, traffic signals, bollards,
 * street-end closures (Jersey barriers + striped boards), dumpsters.
 *
 * Everything is built once in the constructor, merged per material, thin
 * instanced for repeats and frozen. 10 draw calls total:
 *   1 streetlight steel (thin inst)     2 streetlight lens (thin inst)
 *   3 signal steel (merged static)      4 signal red lenses
 *   5 signal green lenses               6 signal dark lenses
 *   7 bollards (thin inst)              8 Jersey barriers (thin inst)
 *   9 barrier boards (thin inst)       10 dumpsters (thin inst)
 *
 * All emissives are scaled through applyEnvironment(env) from
 * env.params.streetlightIntensity. getStreetlightHeads() exposes the sodium
 * head positions/colours for the deferred street-lighting integrator.
 */
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { CreateTube } from '@babylonjs/core/Meshes/Builders/tubeBuilder.js';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import { CreateLathe } from '@babylonjs/core/Meshes/Builders/latheBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
  STREETS_X, STREETS_Z, CURB_FACE, EXTENT_X, EXTENT_Z, CORNER_R,
  streetSegments,
} from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import { hash2, fbm3, valueNoise } from './noise.js';

const DEG = Math.PI / 180;

// -- streetlights ------------------------------------------------------------
const POLE_H = 7.5;
const LIGHT_SPACING = 24;
const LIGHT_LATERAL = CURB_FACE + 0.55;   // 0.55 m behind the curb face
const SODIUM_R = 1.0, SODIUM_G = 0.72, SODIUM_B = 0.38;
const HEAD_RADIUS = 22;
const HEAD_LOCAL_X = 1.62;                // lens centre in pole-local space
const HEAD_LOCAL_Y = 7.46;
const LENS_BASE_EMISSIVE = 3.5;
const SIGNAL_BASE_EMISSIVE = 2.4;

// -- traffic signals ---------------------------------------------------------
const SIG_DIAG = 7.33;                    // corner pole diagonal offset (sidewalk arc)

// ---------------------------------------------------------------------------
// crisp-edged prism: extrudes a closed 2D profile (CCW, [x, y] pairs) along Z,
// duplicated verts per face for hard edges. Winding is verified against the
// analytic outward normal and flipped if the engine convention differs.
function prism(name, scene, profile, length, caps, uScale, vScale) {
  const n = profile.length;
  const pos = [], uvs = [], idx = [];
  const hl = length / 2;
  let perim = 0;
  let onx = 0, ony = 1;
  let first = true;
  for (let i = 0; i < n; i++) {
    const p0 = profile[i], p1 = profile[(i + 1) % n];
    const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
    const el = Math.hypot(ex, ey);
    if (el < 1e-6) continue;
    if (first) { onx = ey / el; ony = -ex / el; first = false; }
    const b = pos.length / 3;
    pos.push(p0[0], p0[1], -hl, p1[0], p1[1], -hl, p1[0], p1[1], hl, p0[0], p0[1], hl);
    const u0 = perim * uScale, u1 = (perim + el) * uScale;
    uvs.push(u0, 0, u1, 0, u1, length * vScale, u0, length * vScale);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    perim += el;
  }
  if (caps) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += profile[i][0]; cy += profile[i][1]; }
    cx /= n; cy /= n;
    for (let s = 1; s >= -1; s -= 2) {
      const b = pos.length / 3;
      pos.push(cx, cy, s * hl);
      uvs.push(cx * uScale + 0.5, cy * vScale + 0.5);
      for (let i = 0; i < n; i++) {
        pos.push(profile[i][0], profile[i][1], s * hl);
        uvs.push(profile[i][0] * uScale + 0.5, profile[i][1] * vScale + 0.5);
      }
      for (let i = 0; i < n; i++) {
        const a = b + 1 + i, c = b + 1 + ((i + 1) % n);
        if (s > 0) idx.push(b, a, c);
        else idx.push(b, c, a);
      }
    }
  }
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  VertexData.ComputeNormals(positions, idx, normals);
  if (normals[0] * onx + normals[1] * ony < 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
    VertexData.ComputeNormals(positions, idx, normals);
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = new Float32Array(uvs);
  vd.indices = idx;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  return mesh;
}

/** prism() rotated upright: profile is the footprint, extrusion becomes +Y. */
function vprism(name, scene, profile, height, baseY, uScale, vScale) {
  const m = prism(name, scene, profile, height, true, uScale, vScale);
  m.rotation.x = -Math.PI / 2;
  m.position.y = height / 2 + baseY;
  m.bakeCurrentTransformIntoVertices();
  return m;
}

/** chamfered rectangle footprint, CCW. */
function chamferRect(w, d, c) {
  const hw = w / 2, hd = d / 2;
  return [
    [-hw + c, -hd], [hw - c, -hd], [hw, -hd + c], [hw, hd - c],
    [hw - c, hd], [-hw + c, hd], [-hw, hd - c], [-hw, -hd + c],
  ];
}

/** yaw-rotate a part's local offset around (px, pz) and orient it. Keeps any
 *  pre-set rotation.x as local pitch (Babylon applies pitch before yaw). */
function placeRot(mesh, lx, ly, lz, yaw, px, py, pz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  mesh.rotation.y = yaw;
  mesh.position.set(px + lx * c + lz * s, py + ly, pz - lx * s + lz * c);
}

/** RotationY * Translation into a thin-instance matrix slot. */
function writeYawT(f32, off, yaw, x, y, z) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  f32[off] = c; f32[off + 1] = 0; f32[off + 2] = -s; f32[off + 3] = 0;
  f32[off + 4] = 0; f32[off + 5] = 1; f32[off + 6] = 0; f32[off + 7] = 0;
  f32[off + 8] = s; f32[off + 9] = 0; f32[off + 10] = c; f32[off + 11] = 0;
  f32[off + 12] = x; f32[off + 13] = y; f32[off + 14] = z; f32[off + 15] = 1;
}

function finalize(mesh, mat) {
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.doNotSyncBoundingInfo = true;
  mesh.alwaysSelectAsActiveMesh = true;   // props span the map; skip culling test
  mesh.freezeWorldMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------
// procedural build-time textures (texture sets are not vendored yet, and props
// only need subtle breakup, so everything here is generated once on a canvas)

function fillNoise(tex, base, amp, scale, speckle) {
  const size = tex.getSize().width;
  const ctx = tex.getContext();
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = base + (fbm3(x * scale, y * scale) - 0.5) * 2 * amp;
      v += (valueNoise(x * 0.61 + 43.1, y * 0.61 + 17.7) - 0.5) * amp * 0.6;
      if (speckle && hash2(x + size * 7, y + 3) > 0.94) v -= 26;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const i = (y * size + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
}

function makeNoiseTexture(scene, name, base, amp, scale, speckle) {
  const tex = new DynamicTexture(name, { width: 128, height: 128 }, scene, true);
  fillNoise(tex, base, amp, scale, speckle);
  return tex;
}

/** red/white diagonal stripes in v 0..0.72, grey steel band in v 0.78..1. */
function makeStripeTexture(scene, name, emissive) {
  const W = 256, H = 128;
  const tex = new DynamicTexture(name, { width: W, height: H }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r, g, b;
      if (y < 92) {
        const red = (Math.floor((x + y) / 26) & 1) === 0;
        const dirt = (valueNoise(x * 0.09, y * 0.09) - 0.5) * 24;
        if (emissive) { r = red ? 235 : 0; g = red ? 34 : 0; b = red ? 22 : 0; }
        else if (red) { r = 196 + dirt; g = 36 + dirt * 0.4; b = 30 + dirt * 0.4; }
        else { r = 228 + dirt; g = 226 + dirt; b = 220 + dirt; }
      } else if (emissive) {
        r = 0; g = 0; b = 0;
      } else {
        const n = (valueNoise(x * 0.2, y * 0.2) - 0.5) * 18;
        r = 96 + n; g = 98 + n; b = 100 + n;
      }
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

const STRIPE_UV = new Vector4(0, 0, 1, 0.72);
const GREY_UV = new Vector4(0.05, 0.80, 0.45, 0.98);

// ---------------------------------------------------------------------------

export class Props {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('../weather/environment.js').Environment} env
   */
  constructor(scene, env) {
    this.scene = scene;
    /** @type {Array<{x:number,y:number,z:number,r:number,g:number,b:number,radius:number,intensity:number}>} */
    this._heads = [];

    // shared build-time textures
    const roughTex = makeNoiseTexture(scene, 'nlPropRough', 190, 46, 0.085, false);
    const mottleTex = makeNoiseTexture(scene, 'nlPropMottle', 236, 16, 0.11, false);
    const concreteTex = makeNoiseTexture(scene, 'nlPropConcrete', 152, 34, 0.055, true);

    // -- materials ----------------------------------------------------------
    const steel = new PBRMaterial('nlPropSteel', scene);
    steel.albedoColor.copyFromFloats(0.075, 0.089, 0.078);  // dark grey-green paint
    steel.albedoTexture = mottleTex;
    steel.metallic = 0.24;
    steel.roughness = 0.62;
    steel.metallicTexture = roughTex;
    steel.useRoughnessFromMetallicTextureGreen = true;
    steel.useRoughnessFromMetallicTextureAlpha = false;
    steel.useMetallnessFromMetallicTextureBlue = true;
    this._steelMat = steel;

    const lens = new PBRMaterial('nlPropLens', scene);
    lens.albedoColor.copyFromFloats(0.30, 0.27, 0.20);      // milky sodium glass when off
    lens.metallic = 0;
    lens.roughness = 0.35;
    lens.emissiveColor.copyFromFloats(SODIUM_R, SODIUM_G, SODIUM_B);
    lens.emissiveIntensity = 0;
    this._lensMat = lens;

    const red = new PBRMaterial('nlPropSigRed', scene);
    red.albedoColor.copyFromFloats(0.05, 0.01, 0.01);
    red.metallic = 0; red.roughness = 0.25;
    red.emissiveColor.copyFromFloats(1.0, 0.06, 0.03);
    this._redMat = red;

    const green = new PBRMaterial('nlPropSigGreen', scene);
    green.albedoColor.copyFromFloats(0.01, 0.05, 0.02);
    green.metallic = 0; green.roughness = 0.25;
    green.emissiveColor.copyFromFloats(0.10, 1.0, 0.30);
    this._greenMat = green;

    const dark = new PBRMaterial('nlPropSigDark', scene);
    dark.albedoColor.copyFromFloats(0.022, 0.022, 0.026);   // unlit glass
    dark.metallic = 0; dark.roughness = 0.12;
    this._darkMat = dark;

    const concrete = new PBRMaterial('nlPropConcreteM', scene);
    concrete.albedoColor.copyFromFloats(0.80, 0.79, 0.76);
    concrete.albedoTexture = concreteTex;
    concrete.metallic = 0;
    concrete.roughness = 0.95;
    this._concreteMat = concrete;

    const stripe = new PBRMaterial('nlPropStripe', scene);
    stripe.albedoTexture = makeStripeTexture(scene, 'nlPropStripeA', false);
    stripe.emissiveTexture = makeStripeTexture(scene, 'nlPropStripeE', true);
    stripe.emissiveColor.copyFromFloats(1, 1, 1);
    stripe.emissiveIntensity = 0;
    stripe.metallic = 0.1;
    stripe.roughness = 0.5;
    this._stripeMat = stripe;

    const dgreen = new PBRMaterial('nlPropDumpster', scene);
    dgreen.albedoColor.copyFromFloats(0.036, 0.105, 0.052); // deep green
    dgreen.albedoTexture = mottleTex;
    dgreen.metallic = 0.22;
    dgreen.roughness = 0.52;
    dgreen.metallicTexture = roughTex;
    dgreen.useRoughnessFromMetallicTextureGreen = true;
    dgreen.useRoughnessFromMetallicTextureAlpha = false;
    dgreen.useMetallnessFromMetallicTextureBlue = true;
    this._dumpsterMat = dgreen;

    // -- geometry -----------------------------------------------------------
    this._buildStreetlights(scene);
    this._buildSignals(scene);
    this._buildBollards(scene);
    this._buildClosures(scene);
    this._buildDumpsters(scene);

    this.applyEnvironment(env);

    // static materials never change after this point
    steel.freeze();
    dark.freeze();
    concrete.freeze();
    dgreen.freeze();
  }

  // -- streetlights ---------------------------------------------------------
  _buildStreetlights(scene) {
    const parts = [];

    const plinth = CreateCylinder('nlLpPlinth', {
      height: 0.85, diameterBottom: 0.32, diameterTop: 0.24, tessellation: 16,
    }, scene);
    plinth.position.y = 0.395;
    parts.push(plinth);

    const collar = CreateTorus('nlLpCollar', { diameter: 0.245, thickness: 0.026, tessellation: 18 }, scene);
    collar.position.y = 0.815;
    parts.push(collar);

    const pole = CreateCylinder('nlLpPole', {
      height: POLE_H - 0.8, diameterBottom: 0.18, diameterTop: 0.11, tessellation: 16,
    }, scene);
    pole.position.y = 0.8 + (POLE_H - 0.8) / 2;
    parts.push(pole);

    const hatch = CreateBox('nlLpHatch', { width: 0.06, height: 0.42, depth: 0.13 }, scene);
    hatch.position.set(0.075, 1.35, 0);
    parts.push(hatch);

    const finial = CreateCylinder('nlLpFinial', {
      height: 0.14, diameterBottom: 0.13, diameterTop: 0.05, tessellation: 12,
    }, scene);
    finial.position.y = POLE_H + 0.06;
    parts.push(finial);

    // gently curved arm: quadratic bezier, 14 segments, tapering tube
    const armPath = [];
    const p0x = 0.02, p0y = 6.95, cxq = 0.62, cyq = 7.74, p1x = 1.60, p1y = 7.58;
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, u = 1 - t;
      armPath.push(new Vector3(
        u * u * p0x + 2 * u * t * cxq + t * t * p1x,
        u * u * p0y + 2 * u * t * cyq + t * t * p1y,
        0
      ));
    }
    const arm = CreateTube('nlLpArm', {
      path: armPath,
      radiusFunction: (i) => 0.048 - (i / 14) * 0.012,
      tessellation: 12,
      cap: Mesh.CAP_ALL,
    }, scene);
    parts.push(arm);

    const housing = CreateBox('nlLpHead', { width: 0.74, height: 0.15, depth: 0.32 }, scene);
    housing.position.set(HEAD_LOCAL_X, 7.60, 0);
    parts.push(housing);

    const ridge = CreateBox('nlLpRidge', { width: 0.52, height: 0.05, depth: 0.24 }, scene);
    ridge.position.set(HEAD_LOCAL_X, 7.695, 0);
    parts.push(ridge);

    const frame = CreateBox('nlLpFrame', { width: 0.64, height: 0.06, depth: 0.27 }, scene);
    frame.position.set(HEAD_LOCAL_X, 7.515, 0);
    parts.push(frame);

    const cell = CreateCylinder('nlLpCell', { height: 0.05, diameter: 0.07, tessellation: 10 }, scene);
    cell.position.set(1.33, 7.70, 0);
    parts.push(cell);

    const lampMaster = Mesh.MergeMeshes(parts, true, true);
    lampMaster.name = 'nlStreetlights';

    // domed underside sodium lens (separate emissive mesh, same instance buffer)
    const lensMaster = CreateSphere('nlStreetlightLens', { diameter: 1, segments: 10, slice: 0.5 }, scene);
    lensMaster.scaling.set(0.55, 0.18, 0.25);
    lensMaster.rotation.x = Math.PI;                 // dome faces down
    lensMaster.position.set(HEAD_LOCAL_X, 7.492, 0);
    lensMaster.bakeCurrentTransformIntoVertices();

    // placement: every ~24 m along every segment, alternating sides, clear of
    // intersection corners (arc reach ~9.95 m from cross centerline) and ends
    const items = [];
    const segs = streetSegments();
    let k = 0;
    for (let sI = 0; sI < segs.length; sI++) {
      const seg = segs[sI];
      const extent = seg.axis === 0 ? EXTENT_Z : EXTENT_X;
      const mA = seg.s0 <= -extent + 0.5 ? 5.5 : CORNER_R + 0.4;
      const mB = seg.s1 >= extent - 0.5 ? 5.5 : CORNER_R + 0.4;
      const a = seg.s0 + mA, b = seg.s1 - mB;
      if (b - a < 4) continue;
      const nL = Math.max(1, Math.round((b - a) / LIGHT_SPACING));
      const step = (b - a) / nL;
      for (let i = 0; i < nL; i++) {
        const s = a + step * (i + 0.5);
        const side = (k & 1) === 0 ? 1 : -1;
        k++;
        if (seg.axis === 0) {
          items.push({ x: seg.center + side * LIGHT_LATERAL, z: s, yaw: side > 0 ? Math.PI : 0 });
        } else {
          items.push({ x: s, z: seg.center + side * LIGHT_LATERAL, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
        }
      }
    }

    const f = new Float32Array(items.length * 16);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = groundHeight(it.x, it.z) - 0.02;
      writeYawT(f, i * 16, it.yaw, it.x, y, it.z);
      const c = Math.cos(it.yaw), s = Math.sin(it.yaw);
      this._heads.push({
        x: it.x + HEAD_LOCAL_X * c,
        y: y + HEAD_LOCAL_Y,
        z: it.z - HEAD_LOCAL_X * s,
        r: SODIUM_R, g: SODIUM_G, b: SODIUM_B,
        radius: HEAD_RADIUS,
        intensity: 1,
      });
    }
    lampMaster.thinInstanceSetBuffer('matrix', f, 16, true);
    lensMaster.thinInstanceSetBuffer('matrix', f, 16, true);
    finalize(lampMaster, this._steelMat);
    finalize(lensMaster, this._lensMat);
  }

  // -- traffic signals at the central intersection --------------------------
  _buildSignals(scene) {
    // hood: half-annulus profile extruded along the facing axis
    const visorProfile = [];
    for (let i = 0; i <= 12; i++) {
      const a2 = (-12 + (204 * i) / 12) * DEG;
      visorProfile.push([Math.cos(a2) * 0.165, Math.sin(a2) * 0.165]);
    }
    for (let i = 12; i >= 0; i--) {
      const a2 = (-12 + (204 * i) / 12) * DEG;
      visorProfile.push([Math.cos(a2) * 0.142, Math.sin(a2) * 0.142]);
    }

    const defs = [
      { px: SIG_DIAG, pz: SIG_DIAG, yaw: Math.PI, green: true },        // faces -z
      { px: -SIG_DIAG, pz: -SIG_DIAG, yaw: 0, green: true },            // faces +z
      { px: -SIG_DIAG, pz: SIG_DIAG, yaw: Math.PI / 2, green: false },  // faces +x
      { px: SIG_DIAG, pz: -SIG_DIAG, yaw: -Math.PI / 2, green: false }, // faces -x
    ];

    const steelParts = [], redParts = [], greenParts = [], darkParts = [];
    for (let di = 0; di < defs.length; di++) {
      const d = defs[di];
      const gy = groundHeight(d.px, d.pz) - 0.02;

      const collar = CreateCylinder('nlSgCol', { height: 0.28, diameterBottom: 0.22, diameterTop: 0.17, tessellation: 14 }, scene);
      placeRot(collar, 0, 0.14, 0, d.yaw, d.px, gy, d.pz);
      steelParts.push(collar);

      const pole = CreateCylinder('nlSgPole', { height: 3.75, diameterBottom: 0.15, diameterTop: 0.11, tessellation: 14 }, scene);
      placeRot(pole, 0, 1.875, 0, d.yaw, d.px, gy, d.pz);
      steelParts.push(pole);

      const cap = CreateSphere('nlSgCap', { diameter: 0.125, segments: 8, slice: 0.5 }, scene);
      placeRot(cap, 0, 3.75, 0, d.yaw, d.px, gy, d.pz);
      steelParts.push(cap);

      const bracket = CreateBox('nlSgBr', { width: 0.10, height: 0.56, depth: 0.18 }, scene);
      placeRot(bracket, 0, 2.95, 0.08, d.yaw, d.px, gy, d.pz);
      steelParts.push(bracket);

      const housing = CreateBox('nlSgHouse', { width: 0.36, height: 1.04, depth: 0.27 }, scene);
      placeRot(housing, 0, 2.95, 0.21, d.yaw, d.px, gy, d.pz);
      steelParts.push(housing);

      // lamps top->bottom: red 3.25, amber 2.95, green 2.65
      for (let j = 0; j < 3; j++) {
        const ly = 3.25 - j * 0.3;
        const lit = d.green ? j === 2 : j === 0;

        const ring = CreateCylinder('nlSgRing', { height: 0.06, diameter: 0.27, tessellation: 18 }, scene);
        ring.rotation.x = Math.PI / 2;
        placeRot(ring, 0, ly, 0.35, d.yaw, d.px, gy, d.pz);
        steelParts.push(ring);

        const visor = prism('nlSgVisor', scene, visorProfile, 0.26, false, 1, 1);
        visor.rotation.x = 0.18;                     // hood tips forward-down
        placeRot(visor, 0, ly + 0.028, 0.40, d.yaw, d.px, gy, d.pz);
        steelParts.push(visor);

        const dome = CreateSphere('nlSgLens', { diameter: 1, segments: 8, slice: 0.5 }, scene);
        dome.scaling.set(0.24, 0.07, 0.24);
        dome.rotation.x = Math.PI / 2;               // dome faces +z (recessed in ring)
        placeRot(dome, 0, ly, 0.342, d.yaw, d.px, gy, d.pz);
        if (lit) (d.green ? greenParts : redParts).push(dome);
        else darkParts.push(dome);
      }
    }

    const sigSteel = Mesh.MergeMeshes(steelParts, true, true);
    sigSteel.name = 'nlSignals';
    finalize(sigSteel, this._steelMat);
    const sigRed = Mesh.MergeMeshes(redParts, true, true);
    sigRed.name = 'nlSignalsRed';
    finalize(sigRed, this._redMat);
    const sigGreen = Mesh.MergeMeshes(greenParts, true, true);
    sigGreen.name = 'nlSignalsGreen';
    finalize(sigGreen, this._greenMat);
    const sigDark = Mesh.MergeMeshes(darkParts, true, true);
    sigDark.name = 'nlSignalsDark';
    finalize(sigDark, this._darkMat);
  }

  // -- bollards -------------------------------------------------------------
  _buildBollards(scene) {
    const shape = [
      new Vector3(0.078, 0, 0), new Vector3(0.072, 0.06, 0), new Vector3(0.062, 0.10, 0),
      new Vector3(0.062, 0.70, 0),
      new Vector3(0.053, 0.735, 0), new Vector3(0.053, 0.775, 0), new Vector3(0.062, 0.80, 0), // groove ring
      new Vector3(0.058, 0.86, 0), new Vector3(0.040, 0.895, 0), new Vector3(0.018, 0.912, 0),
      new Vector3(0.0, 0.915, 0),
    ];
    const master = CreateLathe('nlBollard', { shape, tessellation: 16 }, scene);
    // guard against inside-out lathe winding: check a mid-height normal
    const npos = master.getVerticesData('position');
    const nnor = master.getVerticesData('normal');
    for (let i = 0; i < npos.length; i += 3) {
      const rl = Math.hypot(npos[i], npos[i + 2]);
      if (npos[i + 1] > 0.05 && npos[i + 1] < 0.85 && rl > 0.03) {
        if ((nnor[i] * npos[i] + nnor[i + 2] * npos[i + 2]) / rl < 0) master.flipFaces(true);
        break;
      }
    }

    const spots = [];
    const arc = (icx, icz, sx, sz, count, a0, a1) => {
      const acx = icx + sx * (CURB_FACE + CORNER_R);
      const acz = icz + sz * (CURB_FACE + CORNER_R);
      for (let i = 0; i < count; i++) {
        const th = (a0 + ((a1 - a0) * i) / (count - 1)) * DEG;
        spots.push([acx - sx * 4.6 * Math.cos(th), acz - sz * 4.6 * Math.sin(th)]);
      }
    };
    // sidewalk arcs of the central intersection: 5 per corner
    arc(0, 0, 1, 1, 5, 18, 72);
    arc(0, 0, -1, 1, 5, 18, 72);
    arc(0, 0, 1, -1, 5, 18, 72);
    arc(0, 0, -1, -1, 5, 18, 72);
    // a few elsewhere
    arc(0, 80, -1, -1, 4, 22, 68);
    arc(-100, 0, 1, 1, 4, 22, 68);

    const f = new Float32Array(spots.length * 16);
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      writeYawT(f, i * 16, hash2(i, 101) * Math.PI * 2, x, groundHeight(x, z) - 0.015, z);
    }
    master.thinInstanceSetBuffer('matrix', f, 16, true);
    finalize(master, this._steelMat);
  }

  // -- street-end closures ---------------------------------------------------
  _buildClosures(scene) {
    // proper Jersey profile (m), CCW from bottom-left
    const jerseyProfile = [
      [-0.305, 0], [0.305, 0],
      [0.305, 0.075], [0.19, 0.33], [0.075, 0.80], [0.045, 0.84],
      [-0.045, 0.84], [-0.075, 0.80], [-0.19, 0.33], [-0.305, 0.075],
    ];
    const jersey = prism('nlJersey', scene, jerseyProfile, 2.85, true, 0.45, 0.35);

    // striped barrier board on two posts
    const boardParts = [];
    const plankUV = [STRIPE_UV, STRIPE_UV, STRIPE_UV, STRIPE_UV, STRIPE_UV, STRIPE_UV];
    const greyUV = [GREY_UV, GREY_UV, GREY_UV, GREY_UV, GREY_UV, GREY_UV];
    const plank = CreateBox('nlBoard', { width: 3.5, height: 0.32, depth: 0.045, faceUV: plankUV }, scene);
    plank.position.y = 1.18;
    boardParts.push(plank);
    for (let s = -1; s <= 1; s += 2) {
      const post = CreateBox('nlBoardPost', { width: 0.08, height: 1.38, depth: 0.06, faceUV: greyUV }, scene);
      post.position.set(s * 1.5, 0.69, -0.055);
      boardParts.push(post);
      const foot = CreateBox('nlBoardFoot', { width: 0.34, height: 0.05, depth: 0.34, faceUV: greyUV }, scene);
      foot.position.set(s * 1.5, 0.025, -0.055);
      boardParts.push(foot);
    }
    const board = Mesh.MergeMeshes(boardParts, true, true);
    board.name = 'nlBoards';

    const ends = [];
    for (let i = 0; i < STREETS_X.length; i++) {
      ends.push({ x: STREETS_X[i], z: EXTENT_Z, axis: 0, dir: 1 });
      ends.push({ x: STREETS_X[i], z: -EXTENT_Z, axis: 0, dir: -1 });
    }
    for (let i = 0; i < STREETS_Z.length; i++) {
      ends.push({ x: EXTENT_X, z: STREETS_Z[i], axis: 1, dir: 1 });
      ends.push({ x: -EXTENT_X, z: STREETS_Z[i], axis: 1, dir: -1 });
    }

    const jf = new Float32Array(ends.length * 3 * 16);
    const bf = new Float32Array(ends.length * 16);
    let ji = 0, salt = 0;
    for (let e = 0; e < ends.length; e++) {
      const end = ends[e];
      for (let i = -1; i <= 1; i++) {
        const off = i * 2.98 + (hash2(salt, 3) - 0.5) * 0.12;
        const back = 2.15 + (hash2(salt, 7) - 0.5) * 0.4;
        const jyaw = (hash2(salt, 11) - 0.5) * 0.11;
        salt++;
        let x, z, yaw;
        if (end.axis === 0) { x = end.x + off; z = end.z - end.dir * back; yaw = Math.PI / 2 + jyaw; }
        else { x = end.x - end.dir * back; z = end.z + off; yaw = jyaw; }
        writeYawT(jf, ji * 16, yaw, x, groundHeight(x, z) - 0.02, z);
        ji++;
      }
      let bx, bz, byaw;
      if (end.axis === 0) { bx = end.x; bz = end.z - end.dir * 0.8; byaw = 0; }
      else { bx = end.x - end.dir * 0.8; bz = end.z; byaw = Math.PI / 2; }
      writeYawT(bf, e * 16, byaw, bx, groundHeight(bx, bz) - 0.02, bz);
    }
    jersey.thinInstanceSetBuffer('matrix', jf, 16, true);
    board.thinInstanceSetBuffer('matrix', bf, 16, true);
    finalize(jersey, this._concreteMat);
    finalize(board, this._stripeMat);
  }

  // -- dumpsters -------------------------------------------------------------
  _buildDumpsters(scene) {
    const parts = [];
    parts.push(vprism('nlDpSkirt', scene, chamferRect(1.66, 0.93, 0.06), 0.14, 0, 0.3, 0.3));
    parts.push(vprism('nlDpBody', scene, chamferRect(1.80, 1.05, 0.10), 1.16, 0.12, 0.3, 0.3));
    parts.push(vprism('nlDpRim', scene, chamferRect(1.86, 1.11, 0.10), 0.06, 1.26, 0.3, 0.3));
    parts.push(vprism('nlDpLid', scene, chamferRect(1.90, 1.15, 0.12), 0.09, 1.315, 0.3, 0.3));
    for (let s = -1; s <= 1; s += 2) {
      const lidRib = CreateBox('nlDpLidRib', { width: 1.66, height: 0.035, depth: 0.07 }, scene);
      lidRib.position.set(0, 1.42, s * 0.27);
      parts.push(lidRib);
      for (let i = -1; i <= 1; i++) {
        const rib = CreateBox('nlDpRib', { width: 0.07, height: 1.02, depth: 0.035 }, scene);
        rib.position.set(i * 0.46, 0.70, s * 0.535);
        parts.push(rib);
      }
      const pocket = CreateBox('nlDpPocket', { width: 0.16, height: 0.22, depth: 0.32 }, scene);
      pocket.position.set(s * 0.925, 0.55, 0);
      parts.push(pocket);
    }
    const handle = CreateCylinder('nlDpHandle', { height: 0.9, diameter: 0.044, tessellation: 10 }, scene);
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0, 1.06, 0.565);
    parts.push(handle);

    const master = Mesh.MergeMeshes(parts, true, true);
    master.name = 'nlDumpsters';

    const spots = [
      { x: -100 + 6.55, z: 38, yaw: Math.PI / 2 + 0.07 },
      { x: 30, z: 80 - 6.6, yaw: -0.05 },
      { x: 100 - 6.55, z: -52, yaw: Math.PI / 2 - 0.09 },
    ];
    const f = new Float32Array(spots.length * 16);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      writeYawT(f, i * 16, s.yaw, s.x, groundHeight(s.x, s.z) - 0.025, s.z);
    }
    master.thinInstanceSetBuffer('matrix', f, 16, true);
    finalize(master, this._dumpsterMat);
  }

  // -- module contract --------------------------------------------------------

  /** Push env.params into materials. Called on every weather-state change. */
  applyEnvironment(env) {
    const p = env.params;
    const si = p.streetlightIntensity;

    // PBR props participate in scene fog (custom WGSL modules fog themselves).
    // Remove these three lines if Environment takes ownership of scene fog.
    this.scene.fogMode = Scene.FOGMODE_EXP;
    this.scene.fogDensity = p.fogDensity;
    this.scene.fogColor.copyFromFloats(p.fogColor[0], p.fogColor[1], p.fogColor[2]);

    this._lensMat.unfreeze();
    this._lensMat.emissiveIntensity = LENS_BASE_EMISSIVE * si;
    this._lensMat.freeze();

    const sig = SIGNAL_BASE_EMISSIVE * (0.30 + 0.70 * si); // signals stay lit by day
    this._redMat.unfreeze();
    this._redMat.emissiveIntensity = sig;
    this._redMat.freeze();
    this._greenMat.unfreeze();
    this._greenMat.emissiveIntensity = sig;
    this._greenMat.freeze();

    this._stripeMat.unfreeze();
    this._stripeMat.emissiveIntensity = 0.08 + 0.5 * si;   // red stripes read at night
    this._stripeMat.freeze();

    for (let i = 0; i < this._heads.length; i++) this._heads[i].intensity = si;
  }

  /** Per-frame. Props are fully static; nothing to do (allocation-free). */
  update(dt, camX, camZ) {} // eslint-disable-line no-unused-vars

  /**
   * Current streetlight head lenses in world space, for the street-lighting
   * integrator. Same array instance every call; intensity fields are updated
   * in applyEnvironment (re-read after env changes).
   * @returns {Array<{x:number,y:number,z:number,r:number,g:number,b:number,radius:number,intensity:number}>}
   */
  getStreetlightHeads() {
    return this._heads;
  }

  /** All pipeline variants are visible from the first frame; nothing extra. */
  warmup() {}
}
