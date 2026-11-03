import { useEffect, useRef, type RefObject } from 'react';

/** Keep keyboard focus inside an open dialog and return it to its launcher. */
export function useModalFocus(ref: RefObject<HTMLElement | null>): void {
  const previous = useRef(document.activeElement);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const top=[...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if(top&&top!==root&&!top.contains(root))return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus();
    };
  }, []);
}
