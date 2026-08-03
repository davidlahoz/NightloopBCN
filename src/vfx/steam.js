/**
 * Steam vents — wisps lifting off manholes and grates, strongest in Afterglow
 * (warm street after rain). Static mesh, all motion in the vertex shader.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import {
  PERIOD_X, PERIOD_Z, colIndex, rowIndex, rowIsMotorway, gridToWorld,
  districtOf, DISTRICT_COUNTRYSIDE, nsSegPresent,
} from '../city/cityPlan.js';

const _gw = { x: 0, z: 0 };
import { groundHeight } from '../city/roadProfile.js';
import { hash2 } from '../city/noise.js';
import steamVertex from '../shaders/steam.vertex.wgsl?raw';
import steamFragment from '../shaders/steam.fragment.wgsl?raw';

// Vent offsets relative to the car's nearest (non-motorway) streets:
// axis 0 = on the N-S street (t across, s along z), axis 1 = on the E-W row.
const VENT_DEFS = [
  { ax: 0, t: 2.1, s: 14 }, { ax: 0, t: -1.9, s: -47 },
  { ax: 0, t: 1.8, s: 88 }, { ax: 0, t: -2.2, s: -78 },
  { ax: 1, t: 2.0, s: -62 }, { ax: 1, t: -1.7, s: 41 },
  { ax: 1, t: -2.4, s: -35 }, { ax: 1, t: 1.6, s: 99 },
];
const PUFFS_PER_VENT = 6;

export class Steam {
  /** @param {import('@babylonjs/core').Scene} scene */
  constructor(scene) {
    ShaderStore.ShadersStoreWGSL['nlSteamVertexShader'] = steamVertex;
    ShaderStore.ShadersStoreWGSL['nlSteamFragmentShader'] = steamFragment;

    const mat = new ShaderMaterial('nlSteam', scene, { vertex: 'nlSteam', fragment: 'nlSteam' }, {
      attributes: ['position', 'vent', 'phase'],
      uniformBuffers: ['Scene'],
      shaderLanguage: ShaderLanguage.WGSL,
      needAlphaBlending: true,
    });
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    this.material = mat;

    const nQ = VENT_DEFS.length * PUFFS_PER_VENT;
    const pos = new Float32Array(nQ * 4 * 3);
    this._vent = new Float32Array(nQ * 4 * 3);
    const phase = new Float32Array(nQ * 4 * 2);
    const idx = new Uint32Array(nQ * 6);
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    let q = 0;
    for (let v = 0; v < VENT_DEFS.length; v++) {
      for (let p = 0; p < PUFFS_PER_VENT; p++) {
        const rr = hash2(q, 5);
        const ph = hash2(q, 9);
        for (let c = 0; c < 4; c++) {
          const o3 = (q * 4 + c) * 3, o2 = (q * 4 + c) * 2;
          pos[o3] = corners[c][0]; pos[o3 + 1] = corners[c][1]; pos[o3 + 2] = rr;
          phase[o2] = ph; phase[o2 + 1] = 0;
        }
        const b = q * 4, j = q * 6;
        idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
        idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
        q++;
      }
    }
    const mesh = new Mesh('nlSteam', scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh);
    // 'vent' MUST be updatable: _reanchor rewrites it as the car crosses
    // cells (updating a non-updatable buffer corrupts the quads on WebGPU)
    mesh.setVerticesData('vent', this._vent, true, 3);
    mesh.setVerticesData('phase', phase, false, 2);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.metadata = { nlNoShadow: true, nlNoMirror: true };
    this.mesh = mesh;
    this._anchorI = Infinity;
    this._anchorJ = Infinity;
    this._reanchor(0, 0);

    this._time = 0;
    this._amount = 0.25;
    mat.setFloat('time', 0);
    mat.setFloat('amount', this._amount);
    mat.setVector2('wind', new Vector2(0.35, 0.2));
    mat.setVector3('tint', new Vector3(0.55, 0.58, 0.66));
  }

  /** Re-anchor the vents to the car's nearest non-motorway streets. */
  _reanchor(carX, carZ) {
    const ic = colIndex(carX);
    let jr = rowIndex(carZ);
    if (rowIsMotorway(jr)) jr += 1;      // manhole vents live on normal streets
    if (ic === this._anchorI && jr === this._anchorJ) return;
    this._anchorI = ic; this._anchorJ = jr;
    const vent = this._vent;
    let q = 0;
    for (let v = 0; v < VENT_DEFS.length; v++) {
      const d = VENT_DEFS[v];
      gridToWorld(
        d.ax === 0 ? ic * PERIOD_X + d.t : carX + d.s,
        d.ax === 0 ? carZ + d.s : jr * PERIOD_Z + d.t,
        _gw,
      );
      const vx = _gw.x, vz = _gw.z;
      // hide vents in the fields, and vents anchored to a thinned-away street
      const rural = districtOf(Math.floor(carX / PERIOD_X), Math.floor(carZ / PERIOD_Z)) === DISTRICT_COUNTRYSIDE;
      const gone = d.ax === 0 && !nsSegPresent(ic, Math.floor((carZ + d.s) / PERIOD_Z));
      const vy = rural || gone ? -60 : groundHeight(vx, vz);
      for (let p = 0; p < PUFFS_PER_VENT; p++) {
        for (let c = 0; c < 4; c++) {
          const o3 = (q * 4 + c) * 3;
          vent[o3] = vx; vent[o3 + 1] = vy; vent[o3 + 2] = vz;
        }
        q++;
      }
    }
    this.mesh.updateVerticesData('vent', vent, false, false);
  }

  applyEnvironment(env) {
    const p = env.params;
    // steam is a physical response: warm street + high wetness + no rain
    const amount = Math.max(0, p.steamAmount ?? 0.25);
    this._amount = amount;
    const on = amount > 0.02;
    if (this.mesh.isEnabled() !== on) this.mesh.setEnabled(on);
    this.material.setFloat('amount', amount);
  }

  update(dt, camX, camZ) {
    this._time += dt;
    this.material.setFloat('time', this._time);
    if (camX !== undefined) this._reanchor(camX, camZ);
  }
}
