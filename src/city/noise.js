/**
 * JS mirror of the WGSL noise in src/shaders/common.wgsl.
 * MUST stay numerically identical (same pcg2d hash, same interpolation) so the
 * CPU wheel-contact heightfield matches what the GPU renders.
 */

/** pcg2d on two u32 lanes; returns x lane scaled to [0,1). */
export function hash2(ix, iz) {
  let vx = (Math.imul(ix, 1664525) + 1013904223) >>> 0;
  let vy = (Math.imul(iz, 1664525) + 1013904223) >>> 0;
  vx = (vx + Math.imul(vy, 1664525)) >>> 0;
  vy = (vy + Math.imul(vx, 1664525)) >>> 0;
  vx = (vx ^ (vx >>> 16)) >>> 0;
  vy = (vy ^ (vy >>> 16)) >>> 0;
  vx = (vx + Math.imul(vy, 1664525)) >>> 0;
  vy = (vy + Math.imul(vx, 1664525)) >>> 0;
  vx = (vx ^ (vx >>> 16)) >>> 0;
  return vx * 2.3283064365386963e-10;
}

/** value noise, [0,1) */
export function valueNoise(px, pz) {
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix | 0, iz | 0);
  const b = hash2((ix + 1) | 0, iz | 0);
  const c = hash2(ix | 0, (iz + 1) | 0);
  const d = hash2((ix + 1) | 0, (iz + 1) | 0);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** 3-octave fbm matching nlFbm3 */
export function fbm3(px, pz) {
  let f = 0, w = 0.5;
  let x = px, z = pz;
  for (let i = 0; i < 3; i++) {
    f += w * valueNoise(x, z);
    const nx = x * 2.03 + 17.13, nz = z * 2.03 + 9.71;
    x = nx; z = nz;
    w *= 0.5;
  }
  return f;
}
