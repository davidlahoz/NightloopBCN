/**
 * World seed — every load gets a different city. All deterministic hashing
 * (districts, street thinning, buildings, props) mixes this in, so the map,
 * skyline and street topology reshuffle per visit while staying perfectly
 * coherent within a session (revisited streets are identical until reload).
 *
 * Pin a city with ?seed=N — the current seed is logged on boot and exposed
 * as window.__NIGHTLOOP__.seed.
 */
const qp = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('seed')
  : null;

export const WORLD_SEED = qp !== null && qp !== '' && Number.isFinite(+qp)
  ? (+qp >>> 0)
  : (Math.random() * 4294967296) >>> 0;

if (typeof console !== 'undefined') {
  console.log(`[NIGHTLOOP] world seed ${WORLD_SEED} — revisit this city with ?seed=${WORLD_SEED}`);
}
