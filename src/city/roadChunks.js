/**
 * Road surface geometry — streamed LOD chunks on a ring centred on the car.
 *
 * The carriageway (SDF d < 0) is meshed as world-space-baked grids:
 *   - street pieces: rectangles in road space (s along, t across ±CURB_FACE)
 *   - intersection patches: xz grids covering the crossing incl. curb fillets,
 *     with off-road cells dropped and boundary verts projected onto d = 0.
 *
 * LOD1 (0.3 m) is prebuilt for everything at load; LOD0 (0.075 m) streams in
 * within RING0 of the car, built incrementally under a per-frame time budget
 * so streaming never hitches. All chunks get skirts, so LOD seams and
 * neighbour mismatches can never open visible cracks.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {
  STREETS_X, STREETS_Z, CURB_FACE, CORNER_R,
  sampleRoadSpace, streetSegments,
} from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import { quality } from '../core/quality.js';

const LOD0_STEP = quality.lod0Step;   // 0 disables LOD0 entirely
const LOD1_STEP = 0.30;
const RING0 = quality.lod0Ring;       // build LOD0 inside this distance
const RING0_DROP = quality.lod0Ring + 16;
const PIECE_LEN = 22;      // street chunk length target
const SKIRT = 0.06;        // skirt drop (m)
const BUILD_BUDGET_MS = 2.6;
const INT_HALF = CURB_FACE + CORNER_R; // intersection patch half-size (9.95)

const _rs = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };

export class RoadChunks {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('@babylonjs/core').Material} material
   */
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    /** @type {Chunk[]} */
    this.chunks = [];

    // street pieces
    for (const seg of streetSegments()) {
      const len = seg.s1 - seg.s0;
      const n = Math.max(1, Math.round(len / PIECE_LEN));
      const step = len / n;
      for (let i = 0; i < n; i++) {
        this.chunks.push(new Chunk(this, {
          kind: 'street', axis: seg.axis, center: seg.center,
          s0: seg.s0 + i * step, s1: seg.s0 + (i + 1) * step,
        }));
      }
    }
    // intersection patches
    for (const sx of STREETS_X) {
      for (const sz of STREETS_Z) {
        this.chunks.push(new Chunk(this, { kind: 'intersection', x: sx, z: sz }));
      }
    }

    // prebuild LOD1 for everything (runs during the loading screen)
    for (const c of this.chunks) c.setMesh(1, c.build(LOD1_STEP));

    /** @type {Chunk|null} chunk currently being built incrementally */
    this._building = null;
    this._buildQueue = [];
  }

  /** Per-frame LOD management under a strict time budget. */
  update(dt, carX, carZ) {
    if (LOD0_STEP === 0) return; // low preset: LOD1 everywhere
    // continue an in-progress build first
    const t0 = performance.now();
    if (this._building) {
      if (this._building.buildSlice(t0)) this._building = null;
    }

    // queue scan (cheap): promote/demote by distance
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const d = c.distanceTo(carX, carZ);
      if (d < RING0 && c.lod !== 0 && !c.building) {
        c.building = true;
        this._buildQueue.push(c);
      } else if (d > RING0_DROP && c.lod === 0) {
        c.dropLOD0();
      }
    }

    // start next build if idle and budget remains
    if (!this._building && this._buildQueue.length > 0) {
      // nearest first
      let bi = 0, bd = Infinity;
      for (let i = 0; i < this._buildQueue.length; i++) {
        const d = this._buildQueue[i].distanceTo(carX, carZ);
        if (d < bd) { bd = d; bi = i; }
      }
      const c = this._buildQueue[bi];
      this._buildQueue[bi] = this._buildQueue[this._buildQueue.length - 1];
      this._buildQueue.pop();
      if (c.distanceTo(carX, carZ) < RING0_DROP) {
        c.beginBuild(LOD0_STEP);
        this._building = c;
        c.buildSlice(t0);
        if (c.buildDone) this._building = null;
      } else {
        c.building = false;
      }
    }
  }

  /** Build every LOD0 ring chunk synchronously (loading-screen warmup). */
  prewarm(carX, carZ) {
    if (LOD0_STEP === 0) return;
    for (const c of this.chunks) {
      if (c.distanceTo(carX, carZ) < RING0) {
        c.setMesh(0, c.build(LOD0_STEP));
      }
    }
  }
}

class Chunk {
  constructor(owner, def) {
    this.owner = owner;
    this.def = def;
    this.lod = -1;
    this.mesh0 = null;
    this.mesh1 = null;
    this.building = false;
    this.buildDone = false;
    this._bs = null; // incremental build state

    if (def.kind === 'street') {
      if (def.axis === 0) {
        this.minX = def.center - CURB_FACE; this.maxX = def.center + CURB_FACE;
        this.minZ = def.s0; this.maxZ = def.s1;
      } else {
        this.minX = def.s0; this.maxX = def.s1;
        this.minZ = def.center - CURB_FACE; this.maxZ = def.center + CURB_FACE;
      }
    } else {
      this.minX = def.x - INT_HALF; this.maxX = def.x + INT_HALF;
      this.minZ = def.z - INT_HALF; this.maxZ = def.z + INT_HALF;
    }
    this.cx = (this.minX + this.maxX) * 0.5;
    this.cz = (this.minZ + this.maxZ) * 0.5;
    this.hx = (this.maxX - this.minX) * 0.5;
    this.hz = (this.maxZ - this.minZ) * 0.5;
  }

  distanceTo(x, z) {
    const dx = Math.max(0, Math.abs(x - this.cx) - this.hx);
    const dz = Math.max(0, Math.abs(z - this.cz) - this.hz);
    return Math.hypot(dx, dz);
  }

  /** Synchronous build (used for LOD1 prebuild and warmup). */
  build(step) {
    this.beginBuild(step);
    while (!this.buildSliceRaw(Infinity)) { /* run to completion */ }
    return this._finishBuild();
  }

  beginBuild(step) {
    const nx = Math.max(2, Math.round((this.maxX - this.minX) / step) + 1);
    const nz = Math.max(2, Math.round((this.maxZ - this.minZ) / step) + 1);
    this._bs = {
      step, nx, nz,
      // heights with a 1-ring margin for normal computation
      h: new Float32Array((nx + 2) * (nz + 2)),
      keep: this.def.kind === 'intersection' ? new Uint8Array(nx * nz) : null,
      px: this.def.kind === 'intersection' ? new Float32Array(nx * nz) : null,
      pz: this.def.kind === 'intersection' ? new Float32Array(nx * nz) : null,
      row: 0,      // next height row to fill (0..nz+1 inclusive margin)
      phase: 0,    // 0 = heights, 1 = assemble
    };
    this.buildDone = false;
  }

  /** Returns true when the build completed. Budgeted by wall-clock. */
  buildSlice(tStart) {
    const done = this.buildSliceRaw(tStart);
    if (done) {
      const vd = this._finishBuild();
      this.setMesh(0, vd);
      this.building = false;
      this.buildDone = true;
    }
    return done;
  }

  buildSliceRaw(tStart) {
    const bs = this._bs;
    const { step, nx, nz } = bs;
    const isInt = this.def.kind === 'intersection';
    while (bs.row < nz + 2) {
      if (performance.now() - tStart > BUILD_BUDGET_MS) return false;
      const j = bs.row;
      const z = this.minZ + (j - 1) * step;
      const base = j * (nx + 2);
      for (let i = 0; i < nx + 2; i++) {
        const x = this.minX + (i - 1) * step;
        if (isInt && i > 0 && i <= nx && j > 0 && j <= nz) {
          const vi = (j - 1) * nx + (i - 1);
          sampleRoadSpace(x, z, _rs);
          if (_rs.d < 0.02) {
            bs.keep[vi] = 1;
            if (_rs.d > -0.001) {
              // project onto the d≈0 contour so the edge matches the curb ring
              const p = projectToRoadEdge(x, z);
              bs.px[vi] = p.x; bs.pz[vi] = p.z;
            } else {
              bs.px[vi] = x; bs.pz[vi] = z;
            }
          } else {
            // pull outside verts onto the contour; cell-level keep decides use
            const p = projectToRoadEdge(x, z);
            bs.keep[vi] = 0;
            bs.px[vi] = p.x; bs.pz[vi] = p.z;
          }
          bs.h[base + i] = groundHeight(bs.px[vi], bs.pz[vi]);
        } else {
          bs.h[base + i] = groundHeight(x, z);
        }
      }
      bs.row++;
    }
    return true;
  }

  _finishBuild() {
    const bs = this._bs;
    this._bs = null;
    const { step, nx, nz, h, keep, px, pz } = bs;
    const isInt = this.def.kind === 'intersection';

    // vertex usage mask for intersections: keep a vert if any adjacent cell kept
    let used = null;
    if (isInt) {
      used = new Uint8Array(nx * nz);
      for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i, b = a + 1, c = a + nx, d2 = c + 1;
          // a cell is road if at least 3 corners are in-road
          const cnt = keep[a] + keep[b] + keep[c] + keep[d2];
          if (cnt >= 3) { used[a] = used[b] = used[c] = used[d2] = 1; }
        }
      }
    }

    const idxMap = isInt ? new Int32Array(nx * nz).fill(-1) : null;
    let vcount = 0;
    if (isInt) {
      for (let v = 0; v < nx * nz; v++) if (used[v]) idxMap[v] = vcount++;
    } else {
      vcount = nx * nz;
    }

    const positions = new Float32Array(vcount * 3 * 2); // ×2 head room for skirts (trimmed later)
    const normals = new Float32Array(vcount * 3 * 2);
    const inv2s = 1 / (2 * step);

    let w = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const vi = j * nx + i;
        if (isInt && !used[vi]) continue;
        const x = isInt ? px[vi] : this.minX + i * step;
        const z = isInt ? pz[vi] : this.minZ + j * step;
        const hb = (j + 1) * (nx + 2) + (i + 1);
        const y = h[hb];
        const nxv = -(h[hb + 1] - h[hb - 1]) * inv2s;
        const nzv = -(h[hb + nx + 2] - h[hb - nx - 2]) * inv2s;
        const il = 1 / Math.hypot(nxv, 1, nzv);
        positions[w * 3] = x; positions[w * 3 + 1] = y; positions[w * 3 + 2] = z;
        normals[w * 3] = nxv * il; normals[w * 3 + 1] = il; normals[w * 3 + 2] = nzv * il;
        w++;
      }
    }

    // indices (typed, pre-sized — no JS array garbage)
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let iw = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let a, b, c, d2;
        if (isInt) {
          const va = j * nx + i, vb = va + 1, vc = va + nx, vd = vc + 1;
          const cnt = keep[va] + keep[vb] + keep[vc] + keep[vd];
          if (cnt < 3) continue;
          a = idxMap[va]; b = idxMap[vb]; c = idxMap[vc]; d2 = idxMap[vd];
          if (a < 0 || b < 0 || c < 0 || d2 < 0) continue;
        } else {
          a = j * nx + i; b = a + 1; c = a + nx; d2 = c + 1;
        }
        idx[iw++] = a; idx[iw++] = b; idx[iw++] = c;
        idx[iw++] = b; idx[iw++] = d2; idx[iw++] = c;
      }
    }

    // skirts around the border: duplicate border verts dropped by SKIRT
    const borderPairs = []; // pairs of vertex indices forming border edges
    if (!isInt) {
      for (let i = 0; i < nx - 1; i++) {
        borderPairs.push(i, i + 1);                                   // j = 0 edge
        borderPairs.push((nz - 1) * nx + i + 1, (nz - 1) * nx + i);   // j = nz-1
      }
      for (let j = 0; j < nz - 1; j++) {
        borderPairs.push((j + 1) * nx, j * nx);                       // i = 0
        borderPairs.push(j * nx + nx - 1, (j + 1) * nx + nx - 1);     // i = nx-1
      }
    } else {
      // intersection: any cell edge that borders a dropped cell
      collectIntersectionBorder(keep, idxMap, nx, nz, borderPairs);
    }
    const skirtBase = w;
    let sw = w;
    const skirtIdx = [];
    const skirtOf = new Map();
    for (let e = 0; e < borderPairs.length; e += 2) {
      const a = isInt ? borderPairs[e] : borderPairs[e];
      const b = isInt ? borderPairs[e + 1] : borderPairs[e + 1];
      const ra = isInt ? a : a, rb = isInt ? b : b;
      let sa = skirtOf.get(ra);
      if (sa === undefined) {
        positions[sw * 3] = positions[ra * 3];
        positions[sw * 3 + 1] = positions[ra * 3 + 1] - SKIRT;
        positions[sw * 3 + 2] = positions[ra * 3 + 2];
        normals[sw * 3] = normals[ra * 3]; normals[sw * 3 + 1] = normals[ra * 3 + 1]; normals[sw * 3 + 2] = normals[ra * 3 + 2];
        sa = sw; skirtOf.set(ra, sw); sw++;
      }
      let sb = skirtOf.get(rb);
      if (sb === undefined) {
        positions[sw * 3] = positions[rb * 3];
        positions[sw * 3 + 1] = positions[rb * 3 + 1] - SKIRT;
        positions[sw * 3 + 2] = positions[rb * 3 + 2];
        normals[sw * 3] = normals[rb * 3]; normals[sw * 3 + 1] = normals[rb * 3 + 1]; normals[sw * 3 + 2] = normals[rb * 3 + 2];
        sb = sw; skirtOf.set(rb, sw); sw++;
      }
      skirtIdx.push(ra, rb, sa, rb, sb, sa);
    }

    const vd = new VertexData();
    const USE_SKIRTS = true;
    vd.positions = positions.subarray(0, sw * 3);
    vd.normals = normals.subarray(0, sw * 3);
    const allIdx = new Uint32Array(iw + (USE_SKIRTS ? skirtIdx.length : 0));
    allIdx.set(idx.subarray(0, iw), 0);
    if (USE_SKIRTS) allIdx.set(skirtIdx, iw);
    vd.indices = allIdx;
    return vd;
  }

  setMesh(lod, vd) {
    const name = `road_${this.def.kind}_${this.cx | 0}_${this.cz | 0}_l${lod}`;
    const mesh = new Mesh(name, this.owner.scene);
    vd.applyToMesh(mesh, false);
    mesh.material = this.owner.material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = false;
    mesh.alwaysSelectAsActiveMesh = false;
    if (lod === 0) {
      if (this.mesh0) this.mesh0.dispose(false, false);
      this.mesh0 = mesh;
      if (this.mesh1) this.mesh1.setEnabled(false);
      this.lod = 0;
    } else {
      if (this.mesh1) this.mesh1.dispose(false, false);
      this.mesh1 = mesh;
      if (this.lod !== 0) this.lod = 1;
      if (this.mesh0) mesh.setEnabled(false);
    }
  }

  dropLOD0() {
    if (this.mesh0) { this.mesh0.dispose(false, false); this.mesh0 = null; }
    if (this.mesh1) this.mesh1.setEnabled(true);
    this.lod = 1;
  }
}

/** Newton-ish projection of an outside point onto the road edge contour d=0. */
const _prs = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };
const _proj = { x: 0, z: 0 };
function projectToRoadEdge(x, z) {
  let cx = x, cz = z;
  for (let it = 0; it < 4; it++) {
    sampleRoadSpace(cx, cz, _prs);
    const d = _prs.d;
    if (Math.abs(d) < 0.002) break;
    // numeric gradient
    const e = 0.02;
    sampleRoadSpace(cx + e, cz, _prs); const dx1 = _prs.d;
    sampleRoadSpace(cx - e, cz, _prs); const dx0 = _prs.d;
    sampleRoadSpace(cx, cz + e, _prs); const dz1 = _prs.d;
    sampleRoadSpace(cx, cz - e, _prs); const dz0 = _prs.d;
    const gx = (dx1 - dx0) / (2 * e), gz = (dz1 - dz0) / (2 * e);
    const gl = gx * gx + gz * gz;
    if (gl < 1e-6) break;
    // clamped Newton step — the SDF gradient can degenerate near fillet centres
    let sx = (d * gx) / gl, sz = (d * gz) / gl;
    const sl = Math.hypot(sx, sz);
    if (sl > 0.25) { sx *= 0.25 / sl; sz *= 0.25 / sl; }
    cx -= sx;
    cz -= sz;
  }
  // safety: never let a projected vertex stray far from its grid cell
  const mx = cx - x, mz = cz - z;
  if (mx * mx + mz * mz > 0.36 || !Number.isFinite(cx) || !Number.isFinite(cz)) {
    cx = x; cz = z;
  }
  _proj.x = cx; _proj.z = cz;
  return _proj;
}

function collectIntersectionBorder(keep, idxMap, nx, nz, outPairs) {
  // for each kept cell, emit edges adjacent to non-kept cells
  const cellKept = (i, j) => {
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return false;
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    return keep[a] + keep[b] + keep[c] + keep[d] >= 3;
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (!cellKept(i, j)) continue;
      const a = idxMap[j * nx + i], b = idxMap[j * nx + i + 1];
      const c = idxMap[(j + 1) * nx + i], d = idxMap[(j + 1) * nx + i + 1];
      if (!cellKept(i, j - 1) && a >= 0 && b >= 0) outPairs.push(a, b);
      if (!cellKept(i, j + 1) && d >= 0 && c >= 0) outPairs.push(d, c);
      if (!cellKept(i - 1, j) && c >= 0 && a >= 0) outPairs.push(c, a);
      if (!cellKept(i + 1, j) && b >= 0 && d >= 0) outPairs.push(b, d);
    }
  }
}
