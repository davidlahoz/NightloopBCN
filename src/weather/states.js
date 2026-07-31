/**
 * Mood states 1–5 and the weather transition engine.
 *
 * One interpolatable parameter set (env.params) is blended between state
 * presets over 8–15 s — the sun actually travels, fog actually thickens.
 * The street's wetness is NOT part of the blend: it lags the weather through
 * first-order wetting/drying dynamics (rain fills, evaporation empties), so
 * the road stays soaked after a downpour ends and dries over the next minute.
 */
import { params, setParam } from '../core/params.js';

/** @typedef {import('./environment.js').Environment} Env */

const STATES = {
  1: { // Golden — low warm sun raking straight down the E-W canyon, dry street
    sunElevation: 12, sunAzimuth: 266, sunIntensity: 4.2, sunColor: [1.0, 0.66, 0.34],
    zenithColor: [0.15, 0.21, 0.36], horizonColor: [1.0, 0.60, 0.28], horizonHaze: [0.56, 0.44, 0.38],
    starAmount: 0, cloudCover: 0.20,
    ambientSky: [0.34, 0.36, 0.47], ambientGround: [0.30, 0.22, 0.15], ambientIntensity: 0.85,
    fogColor: [0.44, 0.38, 0.34], fogDensity: 0.0016, fogHeightFalloff: 0.05,
    exposure: 1.0, rainRate: 0,
    wetnessTarget: 0.06, puddleLevel: 0.10,
    streetlightIntensity: 0.12, neonIntensity: 0.45, windowLitFraction: 0.22,
    headlights: 0.1,
    steamAmount: 0.04,
  },
  2: { // Blue hour — the balance shot
    sunElevation: 6.5, sunAzimuth: 205, sunIntensity: 3.2, sunColor: [1.0, 0.62, 0.36],
    zenithColor: [0.060, 0.100, 0.235], horizonColor: [0.82, 0.46, 0.25], horizonHaze: [0.33, 0.28, 0.345],
    starAmount: 0, cloudCover: 0.35,
    ambientSky: [0.30, 0.38, 0.58], ambientGround: [0.20, 0.17, 0.16], ambientIntensity: 0.85,
    fogColor: [0.32, 0.32, 0.42], fogDensity: 0.0032, fogHeightFalloff: 0.045,
    exposure: 1.0, rainRate: 0,
    wetnessTarget: 0.45, puddleLevel: 0.50,
    streetlightIntensity: 1.0, neonIntensity: 1.0, windowLitFraction: 0.42,
    headlights: 1.0,
    steamAmount: 0.22,
  },
  3: { // Downpour — loud and alive
    sunElevation: 13, sunAzimuth: 210, sunIntensity: 0.55, sunColor: [0.72, 0.74, 0.80],
    zenithColor: [0.085, 0.095, 0.125], horizonColor: [0.21, 0.215, 0.25], horizonHaze: [0.235, 0.245, 0.285],
    starAmount: 0, cloudCover: 0.96,
    ambientSky: [0.30, 0.33, 0.40], ambientGround: [0.14, 0.14, 0.15], ambientIntensity: 0.95,
    fogColor: [0.23, 0.24, 0.28], fogDensity: 0.0095, fogHeightFalloff: 0.06,
    exposure: 1.06, rainRate: 1,
    wetnessTarget: 1.0, puddleLevel: 0.95,
    streetlightIntensity: 1.05, neonIntensity: 1.0, windowLitFraction: 0.5,
    headlights: 1.2,
    steamAmount: 0.1,
  },
  4: { // Afterglow — rain just stopped, street a mirror, the money shot
    sunElevation: -3, sunAzimuth: 242, sunIntensity: 2.0, sunColor: [1.0, 0.45, 0.25],
    zenithColor: [0.042, 0.065, 0.165], horizonColor: [0.58, 0.30, 0.20], horizonHaze: [0.29, 0.235, 0.30],
    starAmount: 0.25, cloudCover: 0.45,
    ambientSky: [0.24, 0.30, 0.48], ambientGround: [0.16, 0.14, 0.14], ambientIntensity: 0.80,
    fogColor: [0.25, 0.25, 0.33], fogDensity: 0.0042, fogHeightFalloff: 0.05,
    exposure: 1.10, rainRate: 0,
    wetnessTarget: 0.55, puddleLevel: 0.80,   // reached slowly — evaporation in real time
    streetlightIntensity: 1.3, neonIntensity: 1.45, windowLitFraction: 0.5,
    headlights: 1.0,
    steamAmount: 1,
  },
  5: { // Fogbank — the world reduced to two blocks
    sunElevation: 5, sunAzimuth: 205, sunIntensity: 0.5, sunColor: [0.76, 0.78, 0.84],
    zenithColor: [0.15, 0.17, 0.21], horizonColor: [0.25, 0.26, 0.30], horizonHaze: [0.29, 0.30, 0.34],
    starAmount: 0, cloudCover: 0.9,
    ambientSky: [0.32, 0.34, 0.40], ambientGround: [0.18, 0.18, 0.19], ambientIntensity: 1.0,
    fogColor: [0.29, 0.30, 0.34], fogDensity: 0.028, fogHeightFalloff: 0.10,
    exposure: 1.0, rainRate: 0,
    wetnessTarget: 0.5, puddleLevel: 0.55,
    streetlightIntensity: 1.2, neonIntensity: 0.85, windowLitFraction: 0.32,
    headlights: 1.1,
    steamAmount: 0.35,
  },
};

const TRANSITION_S = 11;

export class WeatherSystem {
  /**
   * @param {Env} env
   * @param {Array<{applyEnvironment:Function}>} modules
   * @param {import('../post/postChain.js').PostChain} post
   * @param {() => void} onLightsChanged re-push light intensities to the road buffer
   */
  constructor(env, modules, post, onLightsChanged) {
    this.env = env;
    this.modules = modules;
    this.post = post;
    this.onLightsChanged = onLightsChanged;
    this.stateId = 2;
    this.headlights = 1;
    this._from = null;
    this._to = null;
    this._t = 1;
    /** 0..1 scrub override from the overlay (NaN = live) */
    this.scrub = NaN;
    // start in blue hour: copy state 2 over env defaults
    this._applyInstant(STATES[2]);
  }

  _applyInstant(s) {
    const p = this.env.params;
    for (const k in s) {
      if (k === 'wetnessTarget' || k === 'puddleLevel' || k === 'headlights') continue;
      if (Array.isArray(s[k])) { p[k] = s[k].slice(); } else { p[k] = s[k]; }
    }
    this.headlights = s.headlights;
    this._wetTarget = s.wetnessTarget;
    this._puddleTarget = s.puddleLevel;
    this._push();
  }

  /** Jump instantly (boot / capture tooling). */
  jumpTo(id) {
    const s = STATES[id];
    if (!s) return;
    this.stateId = id;
    this._from = null;
    this._to = null;
    this._t = 1;
    this._applyInstant(s);
    // snap the physical surface to the state too
    params.roadWetness = s.wetnessTarget;
    params.roadPuddles = s.puddleLevel;
  }

  /** Begin an eased physical transition to state id (1..5). */
  goTo(id) {
    const s = STATES[id];
    if (!s) return;
    this.stateId = id;
    // snapshot current live params as the blend source
    const p = this.env.params;
    const from = {};
    for (const k in s) {
      if (k === 'wetnessTarget' || k === 'puddleLevel') continue;
      if (k === 'headlights') { from[k] = this.headlights; continue; }
      from[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
    }
    this._from = from;
    this._to = s;
    this._t = 0;
  }

  /** @param {number} dt @param {import('../core/input.js').Input} input */
  update(dt, input) {
    if (input.moodKey) this.goTo(input.moodKey);

    if (this._to) {
      if (Number.isNaN(this.scrub)) {
        this._t = Math.min(1, this._t + dt / TRANSITION_S);
      } else {
        this._t = this.scrub;
      }
      const e = this._t * this._t * (3 - 2 * this._t); // smoothstep ease
      const p = this.env.params;
      const from = this._from, to = this._to;
      for (const k in to) {
        if (k === 'wetnessTarget' || k === 'puddleLevel') continue;
        if (k === 'headlights') {
          this.headlights = from[k] + (to[k] - from[k]) * e;
          continue;
        }
        if (Array.isArray(to[k])) {
          const a = from[k], b = to[k], out = p[k];
          for (let i = 0; i < b.length; i++) out[i] = a[i] + (b[i] - a[i]) * e;
        } else if (k === 'sunAzimuth') {
          let d = to[k] - from[k];
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          p[k] = from[k] + d * e;
        } else {
          p[k] = from[k] + (to[k] - from[k]) * e;
        }
      }
      this._wetTarget = to.wetnessTarget;
      this._puddleTarget = to.puddleLevel;
      // throttle the material pushes to ~15 Hz during the transition
      this._pushAccum = (this._pushAccum || 0) + dt;
      if (this._pushAccum > 0.066 || this._t >= 1) {
        this._pushAccum = 0;
        this._push();
      }
      if (this._t >= 1 && Number.isNaN(this.scrub)) { this._from = null; this._to = null; }
    }

    // ---- physical wetting/drying lag (never blended, always integrated) ----
    const p = this.env.params;
    const rain = p.rainRate;
    const evap = params.stateEvaporation;
    // wetness: rain wets fast (τ ≈ 7 s); drying is slow (τ ≈ 45 s / evaporation)
    const wetTarget = Math.max(this._wetTarget, rain);
    const wetRate = wetTarget > params.roadWetness ? (0.15 + rain * 0.35) : (0.022 * (0.5 + evap));
    params.roadWetness += (wetTarget - params.roadWetness) * (1 - Math.exp(-wetRate * dt));
    // puddles: fill during rain (τ ≈ 18 s), drain slower (τ ≈ 70 s)
    const pudTarget = Math.max(this._puddleTarget, rain * 0.95);
    const pudRate = pudTarget > params.roadPuddles ? (0.055 + rain * 0.12) : (0.014 * (0.5 + evap));
    params.roadPuddles += (pudTarget - params.roadPuddles) * (1 - Math.exp(-pudRate * dt));

    this.post.setExposure(p.exposure);
  }

  _push() {
    this.env.apply();
    for (let i = 0; i < this.modules.length; i++) this.modules[i].applyEnvironment(this.env);
    if (this.onLightsChanged) this.onLightsChanged();
  }
}
