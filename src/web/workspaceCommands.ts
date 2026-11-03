import type { Dispatch, SetStateAction, RefObject } from 'react';
import type { RuntimeState } from '../cad/runtime';
import type { ViewName } from '../shared/protocol';
import type { Section } from './Viewport';
import type { PaletteItem } from './CommandPalette';
import type { IconName } from './icons';
import { featureName, tools, unavailableReason, type Tool } from './modeling';
import { views } from './views';
import { modifierLabel as mod } from './useKeyboardShortcuts';

interface WorkspaceCommands {
  state: RuntimeState;
  disabled: boolean;
  snap: boolean;
  step: number | null;
  section: Section | null;
  measuring: boolean;
  chooseTool: (tool: Tool | null) => void;
  action: (action: 'undo' | 'redo' | 'reset') => Promise<void>;
  setCamera: (view: ViewName) => void;
  toggleReplay: () => void;
  viewStep: (step: number | null) => void;
  toggleSection: () => void;
  setMeasuring: Dispatch<SetStateAction<boolean>>;
  setFitKey: Dispatch<SetStateAction<number>>;
  setSnap: Dispatch<SetStateAction<boolean>>;
  selectIds: (ids: string[]) => void;
  exportFile: (format: 'json' | 'step' | 'stl', id?: string) => Promise<void>;
  fileInput: RefObject<HTMLInputElement | null>;
  demo: () => Promise<void>;
  reset: () => void;
  setLeftTab: (tab: 'build' | 'parameters' | 'agents') => void;
  setSheet: (sheet: 'build' | 'inspect' | null) => void;
  setHelp: (open: boolean) => void;
}

export function workspaceCommands({
  state,
  disabled,
  snap,
  step,
  section,
  measuring,
  chooseTool,
  action,
  setCamera,
  toggleReplay,
  viewStep,
  toggleSection,
  setMeasuring,
  setFitKey,
  setSnap,
  selectIds,
  exportFile,
  fileInput,
  demo,
  reset,
  setLeftTab,
  setSheet,
  setHelp,
}: WorkspaceCommands): PaletteItem[] {
  const doc = state.document;
  const selected = doc.selectedFeatureIds;
  const empty = !doc.features.length;
  return [
    ...tools.map((spec) => ({
      id: `tool-${spec.tool}`,
      label: spec.label,
      group: {
        create: 'Create',
        place: 'Place & copy',
        shape: 'Shape',
        combine: 'Combine',
        manage: 'Manage',
      }[spec.group],
      icon: spec.icon,
      hint: spec.hint,
      command: 'apply_edits',
      shortcut: spec.shortcut,
      disabled: disabled ? 'Wait for the current computation' : unavailableReason(spec, selected.length),
      run: () => chooseTool(spec.tool),
    })),
    {
      id: 'undo',
      label: 'Undo',
      group: 'History',
      icon: 'undo' as IconName,
      command: 'document_action',
      shortcut: `${mod}Z`,
      disabled: disabled ? 'Model editing is unavailable' : !state.canUndo ? 'Nothing to undo' : undefined,
      run: () => void action('undo'),
    },
    {
      id: 'redo',
      label: 'Redo',
      group: 'History',
      icon: 'redo' as IconName,
      command: 'document_action',
      shortcut: `${mod}⇧Z`,
      disabled: disabled ? 'Model editing is unavailable' : !state.canRedo ? 'Nothing to redo' : undefined,
      run: () => void action('redo'),
    },
    ...views.map((v, i) => ({
      id: `view-${v.view}`,
      label: `View ${v.view}`,
      group: 'View',
      icon: 'fit' as IconName,
      shortcut: i < 7 ? String(i + 1) : undefined,
      command: 'render_views',
      hint: 'Agents see the same named cameras',
      run: () => setCamera(v.view),
    })),
    {
      id: 'replay',
      label: 'Replay the build step by step',
      group: 'View',
      icon: 'play' as IconName,
      hint: 'Watch how the part was built, by you or an agent',
      disabled: doc.features.length < 2 ? 'Needs two or more steps' : undefined,
      run: toggleReplay,
    },
    {
      id: 'history-back',
      label: 'Previous construction step',
      group: 'View',
      icon: 'history' as IconName,
      shortcut: '[',
      disabled: doc.features.length < 2 ? 'Needs two or more steps' : undefined,
      run: () => viewStep((step ?? doc.features.length) - 1),
    },
    {
      id: 'section',
      label: section ? 'Close section view' : 'Section view',
      group: 'View',
      icon: 'section' as IconName,
      shortcut: 'Q',
      hint: 'Clip the view along X, Y or Z to look inside. Display only',
      run: toggleSection,
    },
    {
      id: 'measure',
      label: measuring ? 'Stop measuring' : 'Measure distance',
      group: 'View',
      icon: 'ruler' as IconName,
      shortcut: 'G',
      hint: 'Click two points; corners snap',
      run: () => setMeasuring((on) => !on),
    },
    {
      id: 'fit',
      label: 'Fit model in view',
      group: 'View',
      icon: 'fit' as IconName,
      shortcut: 'F',
      run: () => setFitKey((k) => k + 1),
    },
    {
      id: 'snap',
      label: snap ? 'Turn snapping off' : 'Turn snapping on',
      group: 'View',
      icon: 'snap' as IconName,
      shortcut: 'S',
      hint: '1 mm · 15° · 0.1× increments for handles and picks',
      run: () => setSnap((on) => !on),
    },
    {
      id: 'select-all',
      label: 'Select all results',
      group: 'Select',
      icon: 'select' as IconName,
      command: 'select_features',
      shortcut: `${mod}A`,
      run: () => selectIds(state.evaluation.visibleFeatureIds),
    },
    ...doc.features.map((f) => ({
      id: `select-${f.id}`,
      label: `Select ${featureName(f)}`,
      group: 'Select',
      icon: 'select' as IconName,
      hint: `${f.kind} · ${f.id}`,
      command: 'select_features',
      run: () => selectIds([f.id]),
    })),
    {
      id: 'export-step',
      label: 'Export STEP',
      group: 'File',
      icon: 'export' as IconName,
      command: 'export_model',
      disabled: empty ? 'Nothing to export yet' : undefined,
      run: () => void exportFile('step'),
    },
    {
      id: 'export-stl',
      label: 'Export STL',
      group: 'File',
      icon: 'export' as IconName,
      command: 'export_model',
      disabled: empty ? 'Nothing to export yet' : undefined,
      run: () => void exportFile('stl'),
    },
    {
      id: 'save-json',
      label: 'Save editable JSON',
      group: 'File',
      icon: 'file' as IconName,
      command: 'export_model',
      run: () => void exportFile('json'),
    },
    {
      id: 'open-json',
      label: 'Open JSON…',
      group: 'File',
      icon: 'file' as IconName,
      command: 'document_action',
      run: () => fileInput.current?.click(),
    },
    {
      id: 'demo',
      label: 'Build demo plate',
      group: 'File',
      icon: 'box' as IconName,
      run: () => void demo(),
    },
    {
      id: 'reset',
      label: 'Reset document…',
      group: 'File',
      icon: 'delete' as IconName,
      command: 'document_action',
      run: reset,
    },
    {
      id: 'parameters',
      label: 'Edit design variables',
      group: 'Panels',
      icon: 'sliders' as IconName,
      command: 'apply_edits',
      hint: 'Named values that drive dimensions',
      run: () => {
        setLeftTab('parameters');
        setSheet('build');
      },
    },
    {
      id: 'agents',
      label: 'Show project agents',
      group: 'Panels',
      icon: 'agent' as IconName,
      run: () => {
        setLeftTab('agents');
        setSheet('build');
      },
    },
    {
      id: 'help',
      label: 'Keyboard shortcuts',
      group: 'Panels',
      icon: 'help' as IconName,
      shortcut: '?',
      run: () => setHelp(true),
    },
  ];
}
