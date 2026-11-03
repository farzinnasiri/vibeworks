import { useEffect } from 'react';
import type { ViewName } from '../shared/protocol';
import { tools, type Tool } from './modeling';
import { views } from './views';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modifierLabel = isMac ? '⌘' : 'Ctrl ';

interface Shortcuts {
  studio?: boolean;
  dialogOpen: boolean;
  onPalette: () => void;
  onHelp: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelectAll: () => void;
  onEscape: () => void;
  onStep: (direction: -1 | 1) => void;
  onFit: () => void;
  onSnap: () => void;
  onSection: () => void;
  onMeasure: () => void;
  onCamera: (view: ViewName) => void;
  onTool: (tool: Tool) => void;
  toolAvailable: (tool: Tool) => boolean;
}

/** Rebind after rendering so shortcuts always use the displayed document and draft state. */
export function useKeyboardShortcuts(actions: Shortcuts) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const modified = event.metaKey || event.ctrlKey;
      if (modified && key === 'k') {
        event.preventDefault();
        actions.onPalette();
        return;
      }
      if (actions.dialogOpen) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      if (actions.studio) { if (event.key === 'Escape') actions.onEscape(); return; }
      if (modified && !event.altKey) {
        if (key === 'z') {
          event.preventDefault();
          (event.shiftKey ? actions.onRedo : actions.onUndo)();
        } else if (key === 'y') {
          event.preventDefault();
          actions.onRedo();
        } else if (key === 'a') {
          event.preventDefault();
          actions.onSelectAll();
        }
        return;
      }
      if (event.altKey) return;
      if (event.key === 'Escape') {
        actions.onEscape();
        return;
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        actions.onStep(event.key === '[' ? -1 : 1);
        return;
      }
      const singleKey: Record<string, () => void> = {
        '/': actions.onPalette,
        '?': actions.onHelp,
        f: actions.onFit,
        s: actions.onSnap,
        q: actions.onSection,
        g: actions.onMeasure,
      };
      if (singleKey[key]) {
        event.preventDefault();
        singleKey[key]();
        return;
      }
      if (/^[1-7]$/.test(key)) {
        event.preventDefault();
        actions.onCamera(views[Number(key) - 1].view);
        return;
      }
      const spec = tools.find(
        (t) =>
          t.shortcut?.toLowerCase() === key ||
          (t.tool === 'delete' && (event.key === 'Delete' || event.key === 'Backspace'))
      );
      if (spec && actions.toolAvailable(spec.tool)) {
        event.preventDefault();
        actions.onTool(spec.tool);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
}
