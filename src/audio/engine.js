/**
 * Procedural engine audio — no samples, pure WebAudio.
 *
 * Three oscillators (fundamental saw + octave saw + sub sine) through a
 * throttle-driven lowpass, plus band-passed noise for intake/road texture.
 * RPM follows speed through fake gear ratios (the classic rise-and-drop),
 * leaning richer under throttle and while gliding. Starts on the first user
 * gesture (browser autoplay policy); fully allocation-free per frame.
 */
import { defineParam, params } from '../core/params.js';

defineParam('audioVolume', 0.4, { label: 'engine volume', section: 'audio', min: 0, max: 1, step: 0.02 });

const GEARS = [0, 7, 14, 22, 30, 41];

export class EngineAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this._rpm = 0.12;
    this.muted = false;
    this._masterSmooth = 0;
    const start = () => {
      if (!this.ctx) this._init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    };
    window.addEventListener('keydown', (e) => {
      start();
      if (e.code === 'KeyM' && !e.repeat) this.muted = !this.muted;
    }, { passive: true });
    window.addEventListener('mousedown', start, { passive: true });
  }

  _init() {
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // engine tone: fundamental + octave + sub, through a lowpass
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 300;
    this.lowpass.Q.value = 0.8;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.lowpass.connect(this.engineGain);
    this.engineGain.connect(this.master);

    const mkOsc = (type, gain) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(this.lowpass);
      osc.start();
      return osc;
    };
    this.oscFund = mkOsc('sawtooth', 0.5);
    this.oscHarm = mkOsc('sawtooth', 0.22);
    this.oscSub = mkOsc('sine', 0.65);

    // intake / road hiss: looped white noise through a bandpass
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.bandpass = ctx.createBiquadFilter();
    this.bandpass.type = 'bandpass';
    this.bandpass.frequency.value = 900;
    this.bandpass.Q.value = 0.6;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(this.bandpass);
    this.bandpass.connect(this.noiseGain);
    this.noiseGain.connect(this.master);
    noise.start();
  }

  /**
   * @param {number} dt
   * @param {import('../vehicle/car.js').Car} car
   * @param {import('../core/input.js').Input} input
   */
  update(dt, car, input) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    // ---- rpm from speed through gears, pushed by throttle ----
    const sp = Math.abs(car.vz);
    const throttle = input.throttle;
    let target;
    if (sp < 0.5 && !throttle) {
      target = 0.12; // idle
    } else {
      let g = GEARS.length - 2;
      for (let i = 0; i < GEARS.length - 1; i++) {
        if (sp < GEARS[i + 1]) { g = i; break; }
      }
      const frac = (sp - GEARS[g]) / (GEARS[g + 1] - GEARS[g]);
      target = 0.26 + 0.66 * Math.min(1, frac) + throttle * 0.08;
    }
    // engine spools faster than it winds down
    const rate = target > this._rpm ? 3.6 : 2.0;
    this._rpm += (target - this._rpm) * (1 - Math.exp(-rate * dt));

    const rpm = this._rpm;
    const f = 42 + rpm * 118;
    this.oscFund.frequency.value = f;
    this.oscHarm.frequency.value = f * 2.02;
    this.oscSub.frequency.value = f * 0.5;
    this.lowpass.frequency.value = 220 + rpm * 900 + throttle * 500;

    // ---- loudness: working engine is louder than a coasting one ----
    const load = 0.10 + throttle * 0.17 + rpm * 0.07 + car.driftAmount * 0.05;
    this.engineGain.gain.value = load;
    this.noiseGain.gain.value = (throttle * 0.02 + sp * 0.0008) * (0.5 + rpm);
    this.bandpass.frequency.value = 700 + rpm * 900;

    // click-free mute: master gain eases toward its target
    const masterTarget = this.muted ? 0 : params.audioVolume * 0.5;
    this._masterSmooth += (masterTarget - this._masterSmooth) * (1 - Math.exp(-18 * dt));
    this.master.gain.value = this._masterSmooth;
  }
}
