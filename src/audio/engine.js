/**
 * Engine audio — a real recorded engine loop (CC-BY, see ASSETS.md) revved by
 * playbackRate. RPM follows speed through fake gear ratios (rise-and-drop),
 * spools with throttle, leans richer while gliding. A quiet sub-oscillator
 * adds low-end body and band-passed noise adds road/intake texture.
 * Starts on the first user gesture (autoplay policy); M toggles mute
 * (click-free ramp); allocation-free per frame.
 */
import { defineParam, params } from '../core/params.js';

defineParam('audioVolume', 0.4, { label: 'engine volume', section: 'audio', min: 0, max: 1, step: 0.02 });

const GEARS = [0, 7, 14, 22, 30, 41];
// playbackRate span: the loop was recorded at working revs, so idle plays it
// slowed right down and full song pushes it past native pitch
const RATE_IDLE = 0.52;
const RATE_MAX = 1.62;

export class EngineAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this._rpm = 0.12;
    this.muted = false;
    this._masterSmooth = 0;
    this._rate = RATE_IDLE;
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

    // ---- recorded engine loop → lowpass → gain ----
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 900;
    this.lowpass.Q.value = 0.5;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.lowpass.connect(this.engineGain);
    this.engineGain.connect(this.master);

    this.loopSource = null;
    fetch('/assets/audio/engine-loop.wav')
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buffer) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = this._rate;
        src.connect(this.lowpass);
        src.start();
        this.loopSource = src;
      })
      .catch(() => { /* stay silent if the sample is missing */ });

    // ---- sub-oscillator: low-end weight under the recording ----
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = 'sine';
    this.oscSub.frequency.value = 45;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.oscSub.connect(this.subGain);
    this.subGain.connect(this.master);
    this.oscSub.start();

    // ---- road/intake hiss: looped noise through a bandpass ----
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

    // ---- rev the recording ----
    this._rate = RATE_IDLE + (RATE_MAX - RATE_IDLE) * rpm;
    if (this.loopSource) this.loopSource.playbackRate.value = this._rate;
    // closed throttle muffles the engine; open throttle lets it breathe
    this.lowpass.frequency.value = 500 + rpm * 2600 + throttle * 1800;

    // ---- loudness: working engine louder than a coasting one ----
    this.engineGain.gain.value = 0.30 + throttle * 0.34 + rpm * 0.12 + car.driftAmount * 0.10;
    this.oscSub.frequency.value = 34 + rpm * 62;
    this.subGain.gain.value = 0.10 + throttle * 0.08 + rpm * 0.05;
    this.noiseGain.gain.value = (throttle * 0.015 + sp * 0.0007) * (0.5 + rpm);
    this.bandpass.frequency.value = 700 + rpm * 900;

    // click-free mute: master gain eases toward its target
    const masterTarget = this.muted ? 0 : params.audioVolume * 0.5;
    this._masterSmooth += (masterTarget - this._masterSmooth) * (1 - Math.exp(-18 * dt));
    this.master.gain.value = this._masterSmooth;
  }
}
