/**
 * Settings + performance overlay. Hidden by default, toggled with ` or F1.
 * Auto-builds controls from the param registry. All per-frame text updates
 * are throttled and reuse DOM nodes; nothing allocates in the render loop.
 */
import { paramDefs, params, setParam } from '../core/params.js';

const GRAPH_W = 300, GRAPH_H = 84;
const BUDGET_MS = 11.1; // 90 fps

export class Overlay {
  /**
   * @param {import('../core/stats.js').FrameStats} stats
   * @param {() => {draws:number, tris:number, meshes:number}} counters
   */
  constructor(stats, counters) {
    this.stats = stats;
    this.counters = counters;
    this.visible = false;
    this._lastRefresh = 0;
    this._buildDOM();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' || e.code === 'F1' || e.code === 'Digit0') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle() {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  _buildDOM() {
    const root = document.createElement('div');
    root.id = 'overlay';
    root.style.cssText = `
      position:fixed; top:12px; right:12px; z-index:50; display:none;
      width:340px; max-height:calc(100vh - 24px); overflow-y:auto;
      background:rgba(10,12,16,0.82); backdrop-filter:blur(12px);
      border:1px solid rgba(216,222,233,0.08); border-radius:8px;
      color:#c8cede; font:11px/1.5 ui-monospace,Menlo,monospace;
      padding:14px 16px; user-select:none;
    `;
    document.body.appendChild(root);
    this.root = root;

    // Header
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;';
    head.innerHTML = `<span style="letter-spacing:0.3em;color:#8a93a6;">NIGHTLOOP</span>`;
    this.fpsEl = document.createElement('span');
    this.fpsEl.style.cssText = 'font-size:20px;color:#e8edf5;';
    head.appendChild(this.fpsEl);
    root.appendChild(head);

    // Frame graph
    const cv = document.createElement('canvas');
    cv.width = GRAPH_W; cv.height = GRAPH_H;
    cv.style.cssText = `width:100%;height:${GRAPH_H}px;border-radius:4px;background:rgba(0,0,0,0.35);`;
    root.appendChild(cv);
    this.gctx = cv.getContext('2d');

    // Counters row
    this.countersEl = document.createElement('div');
    this.countersEl.style.cssText = 'margin:8px 0 4px;color:#8a93a6;white-space:pre;';
    root.appendChild(this.countersEl);

    // Param sections
    this._sections = new Map();
    for (const def of paramDefs) this._addControl(def);
  }

  _sectionEl(name) {
    let s = this._sections.get(name);
    if (s) return s;
    const wrap = document.createElement('div');
    const h = document.createElement('div');
    h.textContent = name;
    h.style.cssText = 'margin:12px 0 4px;color:#f2c078;letter-spacing:0.18em;text-transform:uppercase;font-size:10px;cursor:pointer;';
    const body = document.createElement('div');
    h.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });
    wrap.appendChild(h); wrap.appendChild(body);
    this.root.appendChild(wrap);
    this._sections.set(name, body);
    return body;
  }

  /** Add a control for a param def (called for registry entries present at construction). */
  _addControl(def) {
    const body = this._sectionEl(def.section);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:2px 0;';
    const label = document.createElement('span');
    label.textContent = def.label;
    label.style.cssText = 'flex:0 0 128px;color:#9aa2b4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    row.appendChild(label);

    if (def.type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = params[def.key];
      cb.addEventListener('change', () => setParam(def.key, cb.checked));
      row.appendChild(cb);
    } else if (def.type === 'enum') {
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1;background:#14181f;color:#c8cede;border:1px solid rgba(216,222,233,0.12);border-radius:3px;font:inherit;';
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.appendChild(o);
      }
      sel.value = params[def.key];
      sel.addEventListener('change', () => setParam(def.key, sel.value));
      row.appendChild(sel);
    } else {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = def.min; slider.max = def.max; slider.step = def.step;
      slider.value = params[def.key];
      slider.style.cssText = 'flex:1;accent-color:#7aa2f7;height:12px;';
      const val = document.createElement('span');
      val.style.cssText = 'flex:0 0 44px;text-align:right;color:#c8cede;';
      val.textContent = (+params[def.key]).toFixed(decimals(def.step));
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        setParam(def.key, v);
        val.textContent = v.toFixed(decimals(def.step));
      });
      row.appendChild(slider); row.appendChild(val);
      // keep slider in sync when code changes the param externally
      this._syncFns ??= [];
      this._syncFns.push(() => {
        const v = params[def.key];
        if (Math.abs(parseFloat(slider.value) - v) > 1e-6) {
          slider.value = v;
          val.textContent = (+v).toFixed(decimals(def.step));
        }
      });
    }
    body.appendChild(row);
  }

  /** Called every frame; internally throttled to 4 Hz for text, 10 Hz for graph. */
  update(nowMs) {
    if (!this.visible) return;
    if (nowMs - this._lastRefresh < 100) return;
    this._lastRefresh = nowMs;

    const st = this.stats;
    st.refresh();
    this.fpsEl.textContent = st.fps.toFixed(0);
    const c = this.counters();
    this.countersEl.textContent =
      `med ${st.median.toFixed(2)}ms   1%low ${(1000 / st.p99).toFixed(0)}fps   worst ${st.worst.toFixed(1)}ms\n` +
      `draws ${c.draws}   tris ${fmtK(c.tris)}   meshes ${c.meshes}`;

    // graph
    const g = this.gctx;
    g.clearRect(0, 0, GRAPH_W, GRAPH_H);
    const n = Math.min(st.count, GRAPH_W);
    const scale = GRAPH_H / 33.3; // 33.3ms full scale
    for (let i = 0; i < n; i++) {
      const idx = (st.head - n + i + st.samples.length) % st.samples.length;
      const ms = st.samples[idx];
      const h = Math.min(GRAPH_H, ms * scale);
      g.fillStyle = ms <= BUDGET_MS ? '#4c9e6a' : ms <= 16.7 ? '#c9a05a' : '#c95a5a';
      g.fillRect(i, GRAPH_H - h, 1, h);
    }
    // budget line
    g.fillStyle = 'rgba(216,222,233,0.35)';
    g.fillRect(0, GRAPH_H - BUDGET_MS * scale, GRAPH_W, 1);

    if (this._syncFns) for (let i = 0; i < this._syncFns.length; i++) this._syncFns[i]();
  }
}

function decimals(step) {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
}
function fmtK(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : '' + n;
}
