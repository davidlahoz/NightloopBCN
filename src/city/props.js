/**
 * NIGHTLOOP street props — streetlights, traffic signals, bollards, motorway
 * median barriers, dumpsters. The city is endless, so every prop kind is a
 * thin-instanced master mesh whose instance buffer is REBUILT from the
 * periodic plan every ~48 m of car travel (placement is deterministic per
 * street segment / crossing / block, so revisited places look identical).
 *
 * Draw calls: lamp steel, lamp lens, signal steel, signal red/green/dark
 * lenses, bollards, Jersey barriers, dumpsters = 9 total.
 *
 * All emissives are scaled through applyEnvironment(env) from
 * env.params.streetlightIntensity. getStreetlightHeads() exposes the sodium
 * head positions/colours for the road-shader light buffer; the list changes
 * on rebuild (watch lightsGen).
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
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
  CURB_FACE, CORNER_R, PERIOD_X, PERIOD_Z,
  rowFace, rowSwEdge, rowIsMotorway, segmentsInRegion, crossingsInRegion,
  blocksInRegion, cellSeed, SIDEWALK_EDGE, gridToWorld, streetYawDelta,
} from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import { hash2, fbm3, valueNoise } from './noise.js';

const DEG = Math.PI / 180;

const R_PROPS = 300;              // instancing radius
const RESCAN_DIST = 52;           // offset vs other streamers: rebuilds don't stack

// -- streetlights ------------------------------------------------------------
const POLE_H = 7.5;
const LIGHT_SPACING = 24;
const SODIUM_R = 1.0, SODIUM_G = 0.72, SODIUM_B = 0.38;
const HEAD_RADIUS = 22;
const HEAD_LOCAL_X = 1.62;                // lens centre in pole-local space
const HEAD_LOCAL_Y = 7.46;
const LENS_BASE_EMISSIVE = 3.5;
const SIGNAL_BASE_EMISSIVE = 2.4;
const SIG_INSET = 2.62;                   // corner pole pull-in from the fillet arc

// ---------------------------------------------------------------------------
// crisp-edged prism: extrudes a closed 2D profile (CCW, [x, y] pairs) along Z.
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
  mesh.alwaysSelectAsActiveMesh = true;   // props span the region; skip culling test
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Push {x,z,yaw} onto a list. */
function it(list, x, z, yaw) { list.push({ x, z, yaw }); }

const _gw = { x: 0, z: 0 };
/** Push a GRID-space point through the street-curvature warp. */
function itG(list, gx, gz, yaw) {
  gridToWorld(gx, gz, _gw);
  list.push({ x: _gw.x, z: _gw.z, yaw });
}

/** Bake an {x,z,yaw} list into a fresh instance buffer on a master mesh. */
function setInstances(mesh, list, lift) {
  if (list.length === 0) {
    mesh.setEnabled(false);
    return;
  }
  const f = new Float32Array(list.length * 16);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    writeYawT(f, i * 16, p.yaw, p.x, groundHeight(p.x, p.z) + lift, p.z);
  }
  mesh.thinInstanceSetBuffer('matrix', f, 16, true);
  mesh.thinInstanceRefreshBoundingInfo();
  mesh.setEnabled(true);
}

// ---------------------------------------------------------------------------
// procedural build-time textures
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
    /** bumped whenever the streetlight head list changes */
    this.lightsGen = 0;
    this._si = 1;
    this._scanX = Infinity; this._scanZ = Infinity;

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

    // -- master meshes ------------------------------------------------------
    this._buildLampMasters(scene);
    this._buildSignalMasters(scene);
    this._buildBollardMaster(scene);
    this._buildJerseyMaster(scene);
    this._buildDumpsterMaster(scene);

    this.applyEnvironment(env);

    // static materials never change after this point
    steel.freeze();
    dark.freeze();
    concrete.freeze();
    dgreen.freeze();
  }

  // -- masters ---------------------------------------------------------------
  _buildLampMasters(scene) {
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

    this._lampMaster = Mesh.MergeMeshes(parts, true, true);
    this._lampMaster.name = 'nlStreetlights';

    // domed underside sodium lens (separate emissive mesh, same instance buffer)
    const lensMaster = CreateSphere('nlStreetlightLens', { diameter: 1, segments: 10, slice: 0.5 }, scene);
    lensMaster.scaling.set(0.55, 0.18, 0.25);
    lensMaster.rotation.x = Math.PI;                 // dome faces down
    lensMaster.position.set(HEAD_LOCAL_X, 7.492, 0);
    lensMaster.bakeCurrentTransformIntoVertices();
    this._lensMaster = lensMaster;

    finalize(this._lampMaster, this._steelMat);
    finalize(this._lensMaster, this._lensMat);
  }

  _buildSignalMasters(scene) {
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

    // one signal pole assembly at the origin facing +z, merged into a master
    const steelParts = [];
    const collar = CreateCylinder('nlSgCol', { height: 0.28, diameterBottom: 0.22, diameterTop: 0.17, tessellation: 14 }, scene);
    collar.position.set(0, 0.14, 0);
    steelParts.push(collar);
    const pole = CreateCylinder('nlSgPole', { height: 3.75, diameterBottom: 0.15, diameterTop: 0.11, tessellation: 14 }, scene);
    pole.position.set(0, 1.875, 0);
    steelParts.push(pole);
    const cap = CreateSphere('nlSgCap', { diameter: 0.125, segments: 8, slice: 0.5 }, scene);
    cap.position.set(0, 3.75, 0);
    steelParts.push(cap);
    const bracket = CreateBox('nlSgBr', { width: 0.10, height: 0.56, depth: 0.18 }, scene);
    bracket.position.set(0, 2.95, 0.08);
    steelParts.push(bracket);
    const housing = CreateBox('nlSgHouse', { width: 0.36, height: 1.04, depth: 0.27 }, scene);
    housing.position.set(0, 2.95, 0.21);
    steelParts.push(housing);
    for (let j = 0; j < 3; j++) {
      const ly = 3.25 - j * 0.3;
      const ring = CreateCylinder('nlSgRing', { height: 0.06, diameter: 0.27, tessellation: 18 }, scene);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, ly, 0.35);
      ring.bakeCurrentTransformIntoVertices();
      steelParts.push(ring);
      const visor = prism('nlSgVisor', scene, visorProfile, 0.26, false, 1, 1);
      visor.rotation.x = 0.18;                     // hood tips forward-down
      visor.position.set(0, ly + 0.028, 0.40);
      visor.bakeCurrentTransformIntoVertices();
      steelParts.push(visor);
    }
    this._sigSteel = Mesh.MergeMeshes(steelParts, true, true);
    this._sigSteel.name = 'nlSignals';
    finalize(this._sigSteel, this._steelMat);

    // lens dome master (instances distributed across dark/red/green meshes)
    const makeDome = (name) => {
      const dome = CreateSphere(name, { diameter: 1, segments: 8, slice: 0.5 }, scene);
      dome.scaling.set(0.24, 0.07, 0.24);
      dome.rotation.x = Math.PI / 2;               // dome faces +z (recessed in ring)
      dome.bakeCurrentTransformIntoVertices();
      return dome;
    };
    this._sigDark = makeDome('nlSignalsDark');
    this._sigRed = makeDome('nlSignalsRed');
    this._sigGreen = makeDome('nlSignalsGreen');
    finalize(this._sigDark, this._darkMat);
    finalize(this._sigRed, this._redMat);
    finalize(this._sigGreen, this._greenMat);
  }

  _buildBollardMaster(scene) {
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
    this._bollards = master;
    finalize(master, this._steelMat);
  }

  _buildJerseyMaster(scene) {
    // proper Jersey profile (m), CCW from bottom-left — now the motorway
    // median barrier (street dead-ends no longer exist in the endless city)
    const jerseyProfile = [
      [-0.305, 0], [0.305, 0],
      [0.305, 0.075], [0.19, 0.33], [0.075, 0.80], [0.045, 0.84],
      [-0.045, 0.84], [-0.075, 0.80], [-0.19, 0.33], [-0.305, 0.075],
    ];
    this._jerseys = prism('nlJersey', scene, jerseyProfile, 2.85, true, 0.45, 0.35);
    finalize(this._jerseys, this._concreteMat);
  }

  _buildDumpsterMaster(scene) {
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

    this._dumpsters = Mesh.MergeMeshes(parts, true, true);
    this._dumpsters.name = 'nlDumpsters';
    finalize(this._dumpsters, this._dumpsterMat);
  }

  // -- region rebuild ---------------------------------------------------------
  _rebuild(cx, cz) {
    this._scanX = cx; this._scanZ = cz;
    const minX = cx - R_PROPS, maxX = cx + R_PROPS;
    const minZ = cz - R_PROPS, maxZ = cz + R_PROPS;
    const segs = segmentsInRegion(minX, maxX, minZ, maxZ);
    const crossings = crossingsInRegion(minX, maxX, minZ, maxZ);

    // ---- streetlights: every ~24 m along every segment, alternating sides
    const lamps = [];
    this._heads.length = 0;
    for (const seg of segs) {
      const face = seg.axis === 1 ? rowFace(seg.line) : CURB_FACE;
      const lateral = face + 0.55;
      const m = CORNER_R + 0.4;
      const a = seg.s0 + m, b = seg.s1 - m;
      if (b - a < 4) continue;
      const segId = seg.axis * 7919 + seg.line;
      const segS0 = Math.round(seg.s0);
      const nL = Math.max(1, Math.round((b - a) / LIGHT_SPACING));
      const step = (b - a) / nL;
      for (let i = 0; i < nL; i++) {
        const s = a + step * (i + 0.5);
        const side = cellSeed(segId, segS0, 31 + i) > 0.5 ? 1 : -1;
        const dyaw = streetYawDelta(seg.axis, seg.line, s);
        if (seg.axis === 0) {
          itG(lamps, seg.center + side * lateral, s, (side > 0 ? Math.PI : 0) + dyaw);
        } else {
          itG(lamps, s, seg.center + side * lateral, (side > 0 ? Math.PI / 2 : -Math.PI / 2) + dyaw);
        }
      }
    }
    setInstances(this._lampMaster, lamps, -0.02);
    setInstances(this._lensMaster, lamps, -0.02);
    for (const p of lamps) {
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const y = groundHeight(p.x, p.z) - 0.02;
      this._heads.push({
        x: p.x + HEAD_LOCAL_X * c,
        y: y + HEAD_LOCAL_Y,
        z: p.z - HEAD_LOCAL_X * s,
        r: SODIUM_R, g: SODIUM_G, b: SODIUM_B,
        radius: HEAD_RADIUS,
        intensity: this._si,
      });
    }
    this.lightsGen++;

    // ---- traffic signals: all motorway junctions + ~half of the rest
    const poles = [];
    const dark = [], redL = [], greenL = [];
    for (const cr of crossings) {
      const signalised = cr.mway || cellSeed(cr.i, cr.j, 41) < 0.5;
      if (!signalised) continue;
      const ox = CURB_FACE + CORNER_R - SIG_INSET;
      const oz = rowFace(cr.j) + CORNER_R - SIG_INSET;
      const nsGreen = cellSeed(cr.i, cr.j, 43) < 0.5;
      const dA = streetYawDelta(0, cr.i, cr.z);   // N-S street heading here
      const dB = streetYawDelta(1, cr.j, cr.x);   // E-W row heading here
      const defs = [
        { gx: cr.x + ox, gz: cr.z + oz, yaw: Math.PI + dA, green: nsGreen },        // faces -z
        { gx: cr.x - ox, gz: cr.z - oz, yaw: 0 + dA, green: nsGreen },              // faces +z
        { gx: cr.x - ox, gz: cr.z + oz, yaw: Math.PI / 2 + dB, green: !nsGreen },   // faces +x
        { gx: cr.x + ox, gz: cr.z - oz, yaw: -Math.PI / 2 + dB, green: !nsGreen },  // faces -x
      ];
      for (const d of defs) {
        gridToWorld(d.gx, d.gz, _gw);
        const px = _gw.x, pz = _gw.z;
        it(poles, px, pz, d.yaw);
        const gy = groundHeight(px, pz) - 0.02;
        const cyaw = Math.cos(d.yaw), syaw = Math.sin(d.yaw);
        for (let j = 0; j < 3; j++) {
          const ly = 3.25 - j * 0.3;
          const lit = d.green ? j === 2 : j === 0;
          const x = px + 0.342 * syaw;
          const z = pz + 0.342 * cyaw;
          (lit ? (d.green ? greenL : redL) : dark).push({ x, z, y: gy + ly, yaw: d.yaw });
        }
      }
    }
    setInstances(this._sigSteel, poles, -0.02);
    const setDomes = (mesh, list) => {
      if (list.length === 0) { mesh.setEnabled(false); return; }
      const f = new Float32Array(list.length * 16);
      for (let i = 0; i < list.length; i++) {
        writeYawT(f, i * 16, list[i].yaw, list[i].x, list[i].y, list[i].z);
      }
      mesh.thinInstanceSetBuffer('matrix', f, 16, true);
      mesh.thinInstanceRefreshBoundingInfo();
      mesh.setEnabled(true);
    };
    setDomes(this._sigDark, dark);
    setDomes(this._sigRed, redL);
    setDomes(this._sigGreen, greenL);

    // ---- bollards: sidewalk arcs on some non-motorway crossing corners
    const bollards = [];
    for (const cr of crossings) {
      if (cr.mway) continue;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const roll = cellSeed(cr.i * 2 + (sx > 0 ? 1 : 0), cr.j * 2 + (sz > 0 ? 1 : 0), 47);
          if (roll > 0.25) continue;
          const acx = cr.x + sx * (CURB_FACE + CORNER_R);
          const acz = cr.z + sz * (rowFace(cr.j) + CORNER_R);
          const count = 5;
          for (let i = 0; i < count; i++) {
            const th = (18 + ((72 - 18) * i) / (count - 1)) * DEG;
            itG(bollards,
              acx - sx * 4.6 * Math.cos(th),
              acz - sz * 4.6 * Math.sin(th),
              roll * 251 % (Math.PI * 2));
          }
        }
      }
    }
    setInstances(this._bollards, bollards, -0.015);

    // ---- Jersey barriers along motorway medians (gap at every junction)
    const jerseys = [];
    for (const seg of segs) {
      if (seg.axis !== 1 || !seg.mway) continue;
      const a = seg.s0 + 3.4, b = seg.s1 - 3.4;
      const segS0 = Math.round(seg.s0);
      for (let s = a; s + 2.85 <= b; s += 2.98) {
        const jit = (cellSeed(seg.line, segS0, 53 + ((s / 2.98) | 0)) - 0.5) * 0.08;
        const dyaw = streetYawDelta(1, seg.line, s + 1.42);
        itG(jerseys, s + 1.42, seg.center + jit, Math.PI / 2 + dyaw + jit * 0.5);
      }
    }
    setInstances(this._jerseys, jerseys, -0.02);

    // ---- dumpsters: some blocks park one against the sidewalk edge
    const dumps = [];
    for (const bl of blocksInRegion(minX, maxX, minZ, maxZ)) {
      const roll = cellSeed(bl.ix, bl.jz, 59);
      if (roll > 0.30) continue;
      const side = (cellSeed(bl.ix, bl.jz, 61) * 4) | 0;
      const f = 0.2 + cellSeed(bl.ix, bl.jz, 67) * 0.6;
      let x, z, yaw;
      if (side === 0) {        // south sidewalk
        x = bl.x0 + (bl.x1 - bl.x0) * f;
        z = bl.jz * PERIOD_Z + rowSwEdge(bl.jz) - 0.85;
        yaw = streetYawDelta(1, bl.jz, x) + (roll - 0.15) * 0.4;
      } else if (side === 1) { // north sidewalk
        x = bl.x0 + (bl.x1 - bl.x0) * f;
        z = (bl.jz + 1) * PERIOD_Z - rowSwEdge(bl.jz + 1) + 0.85;
        yaw = streetYawDelta(1, bl.jz + 1, x) + (roll - 0.15) * 0.4;
      } else if (side === 2) { // west sidewalk
        x = bl.ix * PERIOD_X + SIDEWALK_EDGE - 0.85;
        z = bl.z0 + (bl.z1 - bl.z0) * f;
        yaw = Math.PI / 2 + streetYawDelta(0, bl.ix, z) + (roll - 0.15) * 0.4;
      } else {                 // east sidewalk
        x = (bl.ix + 1) * PERIOD_X - SIDEWALK_EDGE + 0.85;
        z = bl.z0 + (bl.z1 - bl.z0) * f;
        yaw = Math.PI / 2 + streetYawDelta(0, bl.ix + 1, z) + (roll - 0.15) * 0.4;
      }
      itG(dumps, x, z, yaw);
    }
    setInstances(this._dumpsters, dumps, -0.025);
  }

  // -- module contract --------------------------------------------------------

  /** Push env.params into materials. Called on every weather-state change. */
  applyEnvironment(env) {
    const p = env.params;
    const si = p.streetlightIntensity;
    this._si = si;

    // PBR props participate in scene fog (custom WGSL modules fog themselves).
    // NOTE: main.js flips scene.fogEnabled off once after boot — see the
    // "PBR recompile workaround" there before touching these lines.
    this.scene.fogMode = Scene.FOGMODE_EXP;
    this.scene.fogDensity = p.fogDensity;
    this.scene.fogColor.copyFromFloats(p.fogColor[0], p.fogColor[1], p.fogColor[2]);

    this._lensMat.unfreeze();
    this._lensMat.emissiveIntensity = LENS_BASE_EMISSIVE * si;
    this._lensMat.freeze();

    // pale concrete (median barriers) also tracks ambient so it doesn't glow
    const amb = Math.min(1, Math.max(0, p.ambientIntensity));
    const cdim = 0.32 + 0.68 * amb * amb;
    this._concreteMat.unfreeze();
    this._concreteMat.albedoColor.copyFromFloats(0.80 * cdim, 0.79 * cdim, 0.76 * cdim);
    this._concreteMat.freeze();

    const sig = SIGNAL_BASE_EMISSIVE * (0.30 + 0.70 * si); // signals stay lit by day
    this._redMat.unfreeze();
    this._redMat.emissiveIntensity = sig;
    this._redMat.freeze();
    this._greenMat.unfreeze();
    this._greenMat.emissiveIntensity = sig;
    this._greenMat.freeze();

    for (let i = 0; i < this._heads.length; i++) this._heads[i].intensity = si;
  }

  /** Per-frame: rebuild instance buffers when the car has moved far enough. */
  update(dt, camX, camZ) {
    if (Math.hypot(camX - this._scanX, camZ - this._scanZ) > RESCAN_DIST) {
      this._rebuild(camX, camZ);
    }
  }

  /** Populate everything synchronously (loading-screen warmup). */
  prewarm(camX, camZ) {
    this._rebuild(camX, camZ);
  }

  /**
   * Current streetlight head lenses in world space. Same array instance every
   * call; contents change on region rebuild (watch lightsGen).
   */
  getStreetlightHeads() {
    return this._heads;
  }

  /** All pipeline variants are visible from the first frame; nothing extra. */
  warmup() {}
}
