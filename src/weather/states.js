/**
 * Time-of-day states 1–3 (day / afternoon / night) and the transition engine.
 *
 * One interpolatable parameter set (env.params) is blended between state
 * presets over ~4 s. The street's wetness is NOT part of the blend: it lags
 * the state through first-order wetting/drying dynamics, so the night
 * street's damp look fades in physically rather than popping.
 */
import { params, setParam } from '../core/params.js';

/** @typedef {import('./environment.js').Environment} Env */

const STATES = {
  1: { // Day — high sun, dry clean streets, lights off
    sunElevation: 38, sunAzimuth: 225, sunIntensity: 3.6, sunColor: [1.0, 0.95, 0.85],
    zenithColor: [0.30, 0.46, 0.72], horizonColor: [0.62, 0.72, 0.86], horizonHaze: [0.55, 0.60, 0.70],
    starAmount: 0, cloudCover: 0.30,
    ambientSky: [0.52, 0.58, 0.70], ambientGround: [0.36, 0.34, 0.32], ambientIntensity: 1.3,
    fogColor: [0.52, 0.56, 0.65], fogDensity: 0.0018, fogHeightFalloff: 0.05,
    exposure: 1.05, rainRate: 0,
    wetnessTarget: 0.05, puddleLevel: 0.08,
    streetlightIntensity: 0, neonIntensity: 0.22, windowLitFraction: 0.06,
    headlights: 0,
    steamAmount: 0.02,
  },
  2: { // Afternoon — low warm sun raking down the canyons (golden hour)
    sunElevation: 10, sunAzimuth: 248, sunIntensity: 4.2, sunColor: [1.0, 0.66, 0.34],
    zenithColor: [0.15, 0.21, 0.36], horizonColor: [1.0, 0.60, 0.28], horizonHaze: [0.56, 0.44, 0.38],
    starAmount: 0, cloudCover: 0.25,
    ambientSky: [0.34, 0.36, 0.47], ambientGround: [0.30, 0.22, 0.15], ambientIntensity: 0.85,
    fogColor: [0.44, 0.38, 0.34], fogDensity: 0.0022, fogHeightFalloff: 0.05,
    exposure: 1.0, rainRate: 0,
    wetnessTarget: 0.15, puddleLevel: 0.22,
    streetlightIntensity: 0.35, neonIntensity: 0.6, windowLitFraction: 0.25,
    headlights: 0.35,
    steamAmount: 0.06,
  },
  3: { // Night — the hero look: dark sky, neon, streetlights, damp street
    sunElevation: -8, sunAzimuth: 205, sunIntensity: 0, sunColor: [0.5, 0.55, 0.7],
    zenithColor: [0.015, 0.022, 0.050], horizonColor: [0.10, 0.09, 0.14], horizonHaze: [0.12, 0.115, 0.16],
    starAmount: 0.7, cloudCover: 0.40,
    ambientSky: [0.10, 0.13, 0.22], ambientGround: [0.05, 0.05, 0.06], ambientIntensity: 0.55,
    fogColor: [0.10, 0.105, 0.145], fogDensity: 0.0048, fogHeightFalloff: 0.05,
    exposure: 1.12, rainRate: 0,
    wetnessTarget: 0.55, puddleLevel: 0.75,   // "rain earlier tonight" street
    streetlightIntensity: 1.35, neonIntensity: 1.5, windowLitFraction: 0.5,
    headlights: 1.2,
    steamAmount: 0.5,
  },
};

const TRANSITION_S = 4;

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
    this.stateId = 3;
    this.headlights = 1;
    this._from = null;
    this._to = null;
    this._t = 1;
    /** 0..1 scrub override from the overlay (NaN = live) */
    this.scrub = NaN;
    // start at night: the demo's hero look
    this._applyInstant(STATES[3]);
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

  /** Begin an eased transition to state id (1..3). */
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
    // wetness: wets fast (τ ≈ 7 s); drying is slow (τ ≈ 45 s / evaporation)
    const wetTarget = Math.max(this._wetTarget, rain);
    const wetRate = wetTarget > params.roadWetness ? (0.15 + rain * 0.35) : (0.022 * (0.5 + evap));
    params.roadWetness += (wetTarget - params.roadWetness) * (1 - Math.exp(-wetRate * dt));
    // puddles: fill (τ ≈ 18 s), drain slower (τ ≈ 70 s)
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
