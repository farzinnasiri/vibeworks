import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type AppearanceMode = 'system' | 'light' | 'dark';
const KEY = 'vibeworks.appearance';
const listeners = new Set<() => void>();
let mode: AppearanceMode = 'system';
try { const saved = localStorage.getItem(KEY); if (saved === 'light' || saved === 'dark') mode = saved; } catch {}
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
const resolved = () => mode === 'system' ? media?.matches ? 'dark' : 'light' : mode;
let snapshot = { mode, thumbMode: mode, theme: resolved() };
function publish() {
  snapshot = { mode, thumbMode: mode, theme: resolved() };
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = snapshot.theme;
    document.documentElement.style.colorScheme = snapshot.theme;
  }
  listeners.forEach(listener => listener());
}
media?.addEventListener('change', publish);
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== KEY) return;
  mode = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : 'system'; publish();
});
publish();
let transition: ViewTransition | undefined;
export function setAppearance(value: AppearanceMode, origin?: Element) {
  if (mode === value) return;
  mode = value; try { localStorage.setItem(KEY, value); } catch {}
  // Native radios respond immediately; the thumb moves after the old snapshot is captured.
  snapshot = { ...snapshot, mode };
  listeners.forEach(listener => listener());
  transition?.skipTransition();
  if (typeof document === 'undefined' || !document.startViewTransition || document.hidden || snapshot.theme === resolved()) {
    publish(); return;
  }
  const root = document.documentElement;
  const rect = origin?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : innerHeight / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.dataset.themeTransition = '';
  // Commit React's theme consumers, including the WebGL viewport, before the new snapshot.
  const current = document.startViewTransition(() => { flushSync(publish); });
  transition = current;
  void current.ready.then(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.animate(reduce ? [{ opacity: 0 }, { opacity: 1 }] : [
      { clipPath: `circle(0px at ${x}px ${y}px)` },
      { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
    ], {
      duration: reduce ? 120 : 420,
      easing: getComputedStyle(root).getPropertyValue('--ease').trim(),
      pseudoElement: '::view-transition-new(root)',
      fill: 'both',
    });
  }).catch(() => { /* A newer choice or a hidden tab can skip the snapshot. */ });
  void current.finished.finally(() => {
    if (transition !== current) return;
    transition = undefined;
    delete root.dataset.themeTransition;
  }).catch(() => {});
}
export function useAppearance() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
