import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** One tooltip outlet also upgrades existing title attributes without dozens of wrappers. */
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean }>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, target: HTMLElement | undefined, lastClosed = 0;
    let focused = false, keyboard = true;
    const close = () => {
      clearTimeout(timer);
      if (target) {
        const ids = target.getAttribute('aria-describedby')?.split(' ').filter(id => id !== 'workspace-tooltip');
        if (ids?.length) target.setAttribute('aria-describedby', ids.join(' ')); else target.removeAttribute('aria-describedby');
      }
      target = undefined; setTip(undefined); lastClosed = Date.now();
      focused = false;
    };
    const show = (event: Event) => {
      if (event.type === 'focusin' && !keyboard) { close(); return; }
      if (event.type === 'pointerover' && focused && target === document.activeElement) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[title], [data-tooltip], button[aria-label], select[aria-label]') : null;
      if (element instanceof HTMLSelectElement) { close(); return; }
      if (element === target) return;
      if (!element) { close(); return; }
      const text = element.getAttribute('title') || element.dataset.tooltip || element.getAttribute('aria-label');
      const quick = Date.now() - lastClosed < 300 && !!target;
      close(); if (!text) return;
      focused = event.type === 'focusin' && keyboard;
      element.dataset.tooltip = text; element.removeAttribute('title'); target = element;
      const open = () => {
        if (target !== element || !element.isConnected) return;
        const rect = element.getBoundingClientRect(), above = rect.top > 90;
        const ids = new Set((element.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)); ids.add('workspace-tooltip');
        element.setAttribute('aria-describedby', [...ids].join(' '));
        setTip({ text, x: Math.max(150, Math.min(innerWidth - 150, rect.left + rect.width / 2)), y: above ? rect.top - 10 : rect.bottom + 10, above });
      };
      timer = setTimeout(open, event.type === 'focusin' ? 0 : quick ? 80 : 400);
    };
    const leave = (event: PointerEvent) => { if (!focused && target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) close(); };
    const scroll = () => { if (!focused) close(); };
    const escape = (event: KeyboardEvent) => { keyboard = true; if (event.key === 'Escape') close(); };
    const pointerDown = () => { keyboard = false; close(); };
    const pointerMove = (event: PointerEvent) => { if (keyboard && (event.movementX || event.movementY)) { keyboard = false; focused = false; show(event); } };
    document.addEventListener('pointerover', show, true); document.addEventListener('focusin', show, true);
    document.addEventListener('pointerout', leave, true); document.addEventListener('focusout', close, true);
    document.addEventListener('pointerdown', pointerDown, true); document.addEventListener('pointermove', pointerMove, true); document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true); window.addEventListener('resize', close); window.addEventListener('blur', close);
    return () => {
      clearTimeout(timer); document.removeEventListener('pointerover', show, true); document.removeEventListener('focusin', show, true);
      document.removeEventListener('pointerout', leave, true); document.removeEventListener('focusout', close, true);
      document.removeEventListener('pointerdown', pointerDown, true); document.removeEventListener('pointermove', pointerMove, true); document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close);
    };
  }, []);
  return tip ? createPortal(<div id="workspace-tooltip" className="workspace-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.above ? '-100%' : '0'})` }}>{tip.text}</div>, document.body) : null;
}
