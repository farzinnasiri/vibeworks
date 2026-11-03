import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type StudioNavigation = 'trackpad' | 'mouse';
const PREFERENCE = 'vibeworks.studio.navigation';

export function readStudioNavigation(): StudioNavigation {
  try {
    const saved = localStorage.getItem(PREFERENCE);
    if (saved === 'trackpad' || saved === 'mouse') return saved;
  } catch { /* A navigation preference must not prevent opening Studio. */ }
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'trackpad' : 'mouse';
}

export function saveStudioNavigation(value: StudioNavigation) {
  try { localStorage.setItem(PREFERENCE, value); } catch { /* Page-local fallback. */ }
}

export const studioNavigationHelp = (mode: StudioNavigation) => mode === 'trackpad'
  ? 'Two-finger scroll to pan, pinch to zoom, Shift + two fingers to orbit. Double-click a part to focus. F fits the model.'
  : 'Drag to orbit, right-drag or Shift-drag to pan, scroll to zoom toward the pointer. Double-click a part to focus. F fits the model.';

/** Leave mouse-wheel and browser pinch zoom to OrbitControls; route trackpad scroll as pan/orbit. */
export function studioWheelIntent(mode: StudioNavigation, event: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'deltaX' | 'deltaY' | 'deltaMode'>, height: number) {
  if (mode === 'mouse' || event.ctrlKey || event.metaKey) return { kind: 'native' as const, x: 0, y: 0 };
  const pixels = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  return { kind: event.shiftKey ? 'orbit' as const : 'pan' as const, x: -event.deltaX * pixels, y: -event.deltaY * pixels };
}

export function configureStudioNavigation(controls: OrbitControls, radius: number) {
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = radius * 0.005;
  controls.maxDistance = radius * 100;
  controls.minZoom = 0.01;
  controls.maxZoom = 1000;
}
