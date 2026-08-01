/**
 * Mobile detection — touch-first devices (phones/tablets) get the on-screen
 * controls; desktops never do. `?touch=1` forces it on for development.
 */
export const isMobile = (() => {
  try {
    if (new URLSearchParams(location.search).has('touch')) return true;
    return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
})();
