/**
 * Quality presets — chosen once at boot (URL ?q= or localStorage), consumed by
 * system constructors. Switching from the overlay stores the choice and
 * reloads; per-frame toggles stay live in the overlay's own sections.
 *
 * Defaults target mid-range hardware ("medium"); "high" restores the original
 * RTX-class targets; "low" runs on integrated GPUs.
 */

const PRESETS = {
  low: {
    name: 'low',
    renderScale: 1.25,       // engine hardware scaling (1/scale resolution)
    mirrorRatio: 0.22,
    shadowSize: 1024,
    lod0Step: 0,             // 0 = LOD0 disabled, LOD1 everywhere
    lod0Ring: 0,
    stateSize: 1024,
    glintDefault: 0,         // glints off
    bloomKernel: 32,
    maxLights: 48,
  },
  medium: {
    name: 'medium',
    renderScale: 1,
    mirrorRatio: 0.35,
    shadowSize: 2048,
    lod0Step: 0.09,
    lod0Ring: 42,
    stateSize: 2048,
    glintDefault: 0.7,
    bloomKernel: 48,
    maxLights: 72,
  },
  high: {
    name: 'high',
    renderScale: 1,
    mirrorRatio: 0.5,
    shadowSize: 4096,
    lod0Step: 0.075,
    lod0Ring: 52,
    stateSize: 2048,
    glintDefault: 0.7,
    bloomKernel: 64,
    maxLights: 96,
  },
};

function detect() {
  try {
    const url = new URLSearchParams(location.search).get('q');
    if (url && PRESETS[url]) return url;
    const stored = localStorage.getItem('nl-quality');
    if (stored && PRESETS[stored]) return stored;
  } catch { /* ignore */ }
  // phones/tablets default to low: mobile GPUs and thermal budgets
  try {
    if (matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0) return 'low';
  } catch { /* ignore */ }
  return 'medium';
}

export const quality = PRESETS[detect()];

export function setQualityAndReload(name) {
  try { localStorage.setItem('nl-quality', name); } catch { /* ignore */ }
  location.reload();
}
