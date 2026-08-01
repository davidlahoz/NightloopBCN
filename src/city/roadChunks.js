/**
 * Road surface geometry — endless streamed LOD chunks around the car.
 *
 * The periodic city plan means chunk definitions are generated on demand:
 * every ~24 m of car travel the wanted set of street pieces / intersection
 * patches inside RING1 is recomputed; missing chunks are queued and built
 * incrementally under a strict per-frame time budget, chunks far outside the
 * ring are disposed. LOD0 (fine) streams inside RING0 exactly as before,
 * cached until the chunk itself is evicted.
 *
 * The carriageway (SDF d < 0) is meshed as world-space-baked grids:
 *   - street pieces: rectangles in road space (s along, t across ±face)
 *   - intersection patches: xz grids covering the crossing incl. curb fillets,
 *     with off-road cells dropped and boundary verts projected onto d = 0.
 * All chunks get skirts, so LOD seams can never open visible cracks.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {
  CURB_FACE, CORNER_R, sampleRoadSpace, segmentsInRegion, crossingsInRegion,
  rowFace, rowIsMotorway, warpOf, WARP_MAX,
} from './cityPlan.js';
import { groundHeight } from './roadProfile.js';
import { quality } from '../core/quality.js';
import { buildBudget } from '../core/buildBudget.js';

const LOD0_STEP = quality.lod0Step;    // 0 disables LOD0 entirely
const LOD0_STEP_MWAY = LOD0_STEP * 2;  // wide carriageway is flatter — coarser is fine
const LOD1_STEP = 0.30;
const RING0 = quality.lod0Ring;        // build LOD0 inside this distance
const RING0_DROP = quality.lod0Ring + 16;
const RING1 = 430;                     // chunks exist inside this distance…
const RING1_DROP = 470;                // …and are disposed beyond this
const RESCAN_DIST = 24;                // region recompute cadence (m of travel)
const PIECE_LEN = 28;                  // street chunk length target
const SKIRT = 0.06;                    // skirt drop (m)

const _rs = { iA: 0, tA: 0, dA: 0, iB: 0, tB: 0, dB: 0, d: 0, wB: 0 };
const _wp = { x: 0, z: 0 };

/** Range of the street-curvature offset along a grid interval (world ≈ grid − warp). */
function warpRange(axis, s0, s1) {
  let mn = Infinity, mx = -Infinity;
  const step = Math.max(4, (s1 - s0) / 8);
  for (let s = s0; s <= s1 + 0.001; s += step) {
    const v = axis === 0 ? warpOf(0, s, _wp).x : warpOf(s, 0, _wp).z;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { mn, mx };
}

export class RoadChunks {
  /**
   * @param {import('@babylonjs/core').Scene} scene
   * @param {import('@babylonjs/core').Material} material
   */
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();
    /** @type {Chunk|null} chunk currently being built incrementally */
    this._building = null;
    /** @type {Chunk[]} */
    this._buildQueue = [];
    this._scanX = Infinity;
    this._scanZ = Infinity;
    this.maxBuildMs = 0;
    /** bumped whenever meshes are created/disposed (render-list refresh hook) */
    this.generation = 0;
  }

  /** Recompute the wanted chunk set around (cx, cz). */
  _rescan(cx, cz) {
    this._scanX = cx; this._scanZ = cz;
    const minX = cx - RING1, maxX = cx + RING1;
    const minZ = cz - RING1, maxZ = cz + RING1;

    for (const seg of segmentsInRegion(minX, maxX, minZ, maxZ)) {
      const len = seg.s1 - seg.s0;
      const n = Math.max(1, Math.round(len / PIECE_LEN));
      const step = len / n;
      for (let i = 0; i < n; i++) {
        const key = `st:${seg.axis}:${seg.line}:${Math.round(seg.s0)}:${i}`;
        if (this.chunks.has(key)) continue;
        const c = new Chunk(this, {
          kind: 'street', axis: seg.axis, center: seg.center,
          s0: seg.s0 + i * step, s1: seg.s0 + (i + 1) * step,
          face: seg.axis === 1 ? rowFace(seg.line) : CURB_FACE,
          mway: seg.mway,
        });
        if (c.distanceTo(cx, cz) > RING1) continue;
        c.key = key;
        this.chunks.set(key, c);
        c.wantLod = 1;
        this._buildQueue.push(c);
      }
    }
    for (const cr of crossingsInRegion(minX, maxX, minZ, maxZ)) {
      const key = `x:${cr.i}:${cr.j}`;
      if (this.chunks.has(key)) continue;
      const c = new Chunk(this, {
        kind: 'intersection', x: cr.x, z: cr.z,
        halfX: CURB_FACE + CORNER_R,
        halfZ: rowFace(cr.j) + CORNER_R,
        mway: cr.mway,
      });
      if (c.distanceTo(cx, cz) > RING1) continue;
      c.key = key;
      this.chunks.set(key, c);
      c.wantLod = 1;
      this._buildQueue.push(c);
    }

    // evict chunks far outside the ring (geometry is deterministic — it can
    // always be rebuilt when the car comes back)
    for (const [key, c] of this.chunks) {
      if (c.distanceTo(cx, cz) > RING1_DROP && c !== this._building) {
        c.disposeAll();
        this.chunks.delete(key);
      }
    }
  }

  /** Per-frame streaming + LOD management under the shared build budget. */
  update(dt, carX, carZ) {
    const t0 = performance.now();
    const deadline = buildBudget.deadline();
    if (Math.hypot(carX - this._scanX, carZ - this._scanZ) > RESCAN_DIST) {
      this._rescan(carX, carZ);
    }

    // continue an in-progress build first
    if (this._building && performance.now() < deadline) {
      if (this._building.buildSlice(deadline)) {
        this._building = null;
        this.generation++;
      }
    }

    // LOD promotion/demotion by distance. LOD0 geometry is cached until the
    // chunk is evicted and merely toggled — no dispose/rebuild churn.
    if (LOD0_STEP > 0) {
      for (const c of this.chunks.values()) {
        if (!c.mesh1) continue; // still awaiting its initial LOD1 build
        const d = c.distanceTo(carX, carZ);
        if (d < RING0 && c.lod === 1 && !c.building) {
          if (c.mesh0) {
            c.mesh0.setEnabled(true);
            if (c.mesh1) c.mesh1.setEnabled(false);
            c.lod = 0;
            this.generation++;
          } else {
            c.building = true;
            c.wantLod = 0;
            this._buildQueue.push(c);
          }
        } else if (d > RING0_DROP && c.lod === 0) {
          c.dropLOD0();
          this.generation++;
        }
      }
    }

    // start next build if idle and time remains: nearest first
    if (!this._building && this._buildQueue.length > 0 && performance.now() < deadline) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < this._buildQueue.length; i++) {
        const d = this._buildQueue[i].distanceTo(carX, carZ);
        if (d < bd) { bd = d; bi = i; }
      }
      const c = this._buildQueue[bi];
      this._buildQueue[bi] = this._buildQueue[this._buildQueue.length - 1];
      this._buildQueue.pop();
      const alive = this.chunks.get(c.key) === c;
      if (alive && (c.wantLod === 1 || c.distanceTo(carX, carZ) < RING0_DROP)) {
        c.beginBuild(c.buildStep());
        this._building = c;
        if (c.buildSlice(deadline)) {
          this._building = null;
          this.generation++;
        }
      } else {
        c.building = false;
      }
    }

    const spent = performance.now() - t0;
    buildBudget.report(spent);
    if (spent > this.maxBuildMs) this.maxBuildMs = spent;
  }

  /** Populate + build the whole ring synchronously (loading-screen warmup). */
  prewarm(carX, carZ) {
    this._rescan(carX, carZ);
    this._buildQueue.length = 0;
    for (const c of this.chunks.values()) {
      c.setMesh(1, c.build(LOD1_STEP));
      if (LOD0_STEP > 0 && c.distanceTo(carX, carZ) < RING0) {
        c.setMesh(0, c.build(c.def.mway ? LOD0_STEP_MWAY : LOD0_STEP));
      }
      c.wantLod = c.lod;
      c.building = false;
    }
    this.generation++;
  }
}

class Chunk {
  constructor(owner, def) {
    this.owner = owner;
    this.def = def;
    this.key = '';
    this.lod = -1;
    this.wantLod = 1;
    this.mesh0 = null;
    this.mesh1 = null;
    this.building = false;
    this.buildDone = false;
    this._bs = null; // incremental build state

    if (def.kind === 'street') {
      // the street meanders (domain warp): widen the cross extent by the
      // actual warp range over this piece, plus margin for the fillets
      const wr = warpRange(def.axis, def.s0, def.s1);
      if (def.axis === 0) {
        this.minX = def.center - wr.mx - def.face - 1.4;
        this.maxX = def.center - wr.mn + def.face + 1.4;
        this.minZ = def.s0 - WARP_MAX; this.maxZ = def.s1 + WARP_MAX;
      } else {
        this.minX = def.s0 - WARP_MAX; this.maxX = def.s1 + WARP_MAX;
        this.minZ = def.center - wr.mx - def.face - 1.4;
        this.maxZ = def.center - wr.mn + def.face + 1.4;
      }
    } else {
      this.minX = def.x - def.halfX - WARP_MAX; this.maxX = def.x + def.halfX + WARP_MAX;
      this.minZ = def.z - def.halfZ - WARP_MAX; this.maxZ = def.z + def.halfZ + WARP_MAX;
    }
    this.cx = (this.minX + this.maxX) * 0.5;
    this.cz = (this.minZ + this.maxZ) * 0.5;
    this.hx = (this.maxX - this.minX) * 0.5;
    this.hz = (this.maxZ - this.minZ) * 0.5;
  }

  buildStep() {
    if (this.wantLod === 1) return LOD1_STEP;
    return this.def.mway ? LOD0_STEP_MWAY : LOD0_STEP;
  }

  distanceTo(x, z) {
    const dx = Math.max(0, Math.abs(x - this.cx) - this.hx);
    const dz = Math.max(0, Math.abs(z - this.cz) - this.hz);
    return Math.hypot(dx, dz);
  }

  /** Synchronous build (used for warmup). */
  build(step) {
    this.beginBuild(step);
    while (!this.stepBuild(Infinity)) { /* run to completion */ }
    const vd = this._vd;
    this._vd = null;
    return vd;
  }

  beginBuild(step) {
    const nx = Math.max(2, Math.round((this.maxX - this.minX) / step) + 1);
    const nz = Math.max(2, Math.round((this.maxZ - this.minZ) / step) + 1);
    // every chunk is a masked grid now: the curved streets need their edges
    // trimmed to the true (warped) d=0 contour, streets included
    const isInt = true;
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

  /** Returns true when the build completed. Budgeted by wall-clock deadline. */
  buildSlice(deadline) {
    const done = this.stepBuild(deadline);
    if (done) {
      this.setMesh(this.wantLod, this._vd);
      this._vd = null;
      this.building = false;
      this.buildDone = true;
    }
    return done;
  }

  _over(deadline) {
    return performance.now() > deadline;
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
    const isInt = true;   // all chunks masked (curved street edges)

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

  disposeAll() {
    if (this.mesh0) { this.mesh0.dispose(false, false); this.mesh0 = null; }
    if (this.mesh1) { this.mesh1.dispose(false, false); this.mesh1 = null; }
    this._bs = null;
    this._vd = null;
    this.lod = -1;
    this.building = false;
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
