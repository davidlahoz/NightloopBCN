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

    // intersections get permanent LOD0 at load — they are the big patches
    // whose finalisation would otherwise be the one streaming hitch left
    if (LOD0_STEP > 0) {
      for (const c of this.chunks) {
        if (c.def.kind === 'intersection') {
          c.setMesh(0, c.build(LOD0_STEP));
          c.permanent = true;
        }
      }
    }

    /** @type {Chunk|null} chunk currently being built incrementally */
    this._building = null;
    this._buildQueue = [];
    this.maxBuildMs = 0;
  }

  /** Per-frame LOD management under a strict time budget. */
  update(dt, carX, carZ) {
    if (LOD0_STEP === 0) return; // low preset: LOD1 everywhere
    // continue an in-progress build first
    const t0 = performance.now();
    if (this._building) {
      if (this._building.buildSlice(t0)) this._building = null;
      const spent = performance.now() - t0;
      if (spent > this.maxBuildMs) this.maxBuildMs = spent;
    }

    // queue scan (cheap): promote/demote by distance. LOD0 geometry is
    // deterministic, so once built it is cached forever and merely toggled —
    // no dispose/rebuild churn, no GC spikes on revisits.
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c.permanent) continue;
      const d = c.distanceTo(carX, carZ);
      if (d < RING0 && c.lod !== 0 && !c.building) {
        if (c.mesh0) {
          c.mesh0.setEnabled(true);
          if (c.mesh1) c.mesh1.setEnabled(false);
          c.lod = 0;
        } else {
          c.building = true;
          this._buildQueue.push(c);
        }
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
    while (!this.stepBuild(Infinity)) { /* run to completion */ }
    return this._vd;
  }

  beginBuild(step) {
    const nx = Math.max(2, Math.round((this.maxX - this.minX) / step) + 1);
    const nz = Math.max(2, Math.round((this.maxZ - this.minZ) / step) + 1);
    const isInt = this.def.kind === 'intersection';
    this._bs = {
      step, nx, nz,
      h: new Float32Array((nx + 2) * (nz + 2)),
      keep: isInt ? new Uint8Array(nx * nz) : null,
      px: isInt ? new Float32Array(nx * nz) : null,
      pz: isInt ? new Float32Array(nx * nz) : null,
      used: null, idxMap: null,
      positions: null, normals: null, idx: null,
      iw: 0, w: 0, vcount: 0,
      row: 0, phase: 0,
    };
    this._vd = null;
    this.buildDone = false;
  }

  /** Returns true when the build completed. Budgeted by wall-clock. */
  buildSlice(tStart) {
    const done = this.stepBuild(tStart);
    if (done) {
      this.setMesh(0, this._vd);
      this._vd = null;
      this.building = false;
      this.buildDone = true;
    }
    return done;
  }

  _over(tStart) {
    return performance.now() - tStart > BUILD_BUDGET_MS;
  }

  /**
   * Incremental build state machine — every phase slices by rows so no single
   * frame ever swallows a whole intersection patch.
   * Phases: 0 heights · 1 cell-usage (int) · 2 verts+normals · 3 indices ·
   * 4 skirts + VertexData assembly.
   */
  stepBuild(tStart) {
    const bs = this._bs;
    const { step, nx, nz } = bs;
    const isInt = this.def.kind === 'intersection';

    if (bs.phase === 0) {
      while (bs.row < nz + 2) {
        if (this._over(tStart)) return false;
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
                const p = projectToRoadEdge(x, z);
                bs.px[vi] = p.x; bs.pz[vi] = p.z;
              } else {
                bs.px[vi] = x; bs.pz[vi] = z;
              }
            } else {
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
      bs.phase = 1;
      bs.row = 0;
    }

    if (bs.phase === 1) {
      if (isInt) {
        if (!bs.used) bs.used = new Uint8Array(nx * nz);
        while (bs.row < nz - 1) {
          if (this._over(tStart)) return false;
          const j = bs.row;
          for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, d2 = c + 1;
            if (bs.keep[a] + bs.keep[b] + bs.keep[c] + bs.keep[d2] >= 3) {
              bs.used[a] = bs.used[b] = bs.used[c] = bs.used[d2] = 1;
            }
          }
          bs.row++;
        }
        // sequential vertex numbering (single fast pass)
        bs.idxMap = new Int32Array(nx * nz).fill(-1);
        let vc = 0;
        for (let v = 0; v < nx * nz; v++) if (bs.used[v]) bs.idxMap[v] = vc++;
        bs.vcount = vc;
      } else {
        bs.vcount = nx * nz;
      }
      bs.positions = new Float32Array(bs.vcount * 3 * 2);
      bs.normals = new Float32Array(bs.vcount * 3 * 2);
      bs.idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
      bs.phase = 2;
      bs.row = 0;
      bs.w = 0;
    }

    if (bs.phase === 2) {
      const inv2s = 1 / (2 * step);
      while (bs.row < nz) {
        if (this._over(tStart)) return false;
        const j = bs.row;
        for (let i = 0; i < nx; i++) {
          const vi = j * nx + i;
          if (isInt && !bs.used[vi]) continue;
          const x = isInt ? bs.px[vi] : this.minX + i * step;
          const z = isInt ? bs.pz[vi] : this.minZ + j * step;
          const hb = (j + 1) * (nx + 2) + (i + 1);
          const y = bs.h[hb];
          const nxv = -(bs.h[hb + 1] - bs.h[hb - 1]) * inv2s;
          const nzv = -(bs.h[hb + nx + 2] - bs.h[hb - nx - 2]) * inv2s;
          const il = 1 / Math.hypot(nxv, 1, nzv);
          const w3 = bs.w * 3;
          bs.positions[w3] = x; bs.positions[w3 + 1] = y; bs.positions[w3 + 2] = z;
          bs.normals[w3] = nxv * il; bs.normals[w3 + 1] = il; bs.normals[w3 + 2] = nzv * il;
          bs.w++;
        }
        bs.row++;
      }
      bs.phase = 3;
      bs.row = 0;
    }

    if (bs.phase === 3) {
      while (bs.row < nz - 1) {
        if (this._over(tStart)) return false;
        const j = bs.row;
        for (let i = 0; i < nx - 1; i++) {
          let a, b, c, d2;
          if (isInt) {
            const va = j * nx + i, vb = va + 1, vc2 = va + nx, vd = vc2 + 1;
            const cnt = bs.keep[va] + bs.keep[vb] + bs.keep[vc2] + bs.keep[vd];
            if (cnt < 3) continue;
            a = bs.idxMap[va]; b = bs.idxMap[vb]; c = bs.idxMap[vc2]; d2 = bs.idxMap[vd];
            if (a < 0 || b < 0 || c < 0 || d2 < 0) continue;
          } else {
            a = j * nx + i; b = a + 1; c = a + nx; d2 = c + 1;
          }
          bs.idx[bs.iw++] = a; bs.idx[bs.iw++] = b; bs.idx[bs.iw++] = c;
          bs.idx[bs.iw++] = b; bs.idx[bs.iw++] = d2; bs.idx[bs.iw++] = c;
        }
        bs.row++;
      }
      bs.phase = 4;
      bs.row = 0;
    }

    // phase 4: skirts + assembly (bounded work: border ring only + GPU upload)
    {
      const { positions, normals, idx, iw } = bs;
      const borderPairs = [];
      if (!isInt) {
        for (let i = 0; i < nx - 1; i++) {
          borderPairs.push(i, i + 1);
          borderPairs.push((nz - 1) * nx + i + 1, (nz - 1) * nx + i);
        }
        for (let j = 0; j < nz - 1; j++) {
          borderPairs.push((j + 1) * nx, j * nx);
          borderPairs.push(j * nx + nx - 1, (j + 1) * nx + nx - 1);
        }
      } else {
        collectIntersectionBorder(bs.keep, bs.idxMap, nx, nz, borderPairs);
      }
      let sw = bs.w;
      const skirtIdx = [];
      const skirtOf = new Map();
      for (let e = 0; e < borderPairs.length; e += 2) {
        const ra = borderPairs[e];
        const rb = borderPairs[e + 1];
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
      vd.positions = positions.subarray(0, sw * 3);
      vd.normals = normals.subarray(0, sw * 3);
      const allIdx = new Uint32Array(iw + skirtIdx.length);
      allIdx.set(idx.subarray(0, iw), 0);
      allIdx.set(skirtIdx, iw);
      vd.indices = allIdx;
      this._vd = vd;
      this._bs = null;
      return true;
    }
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
    // keep the mesh — geometry is deterministic and will be needed again
    if (this.mesh0) this.mesh0.setEnabled(false);
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
