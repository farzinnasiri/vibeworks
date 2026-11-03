import type { CadDocument } from '../shared/protocol';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';
import { featureName, toolSpec, unavailableReason, type Tool } from './modeling';
import { modifierLabel as mod } from './useKeyboardShortcuts';

const dockGroups: Tool[][] = [
  ['move', 'rotate', 'scale'],
  ['drill_holes', 'fillet', 'chamfer', 'shell'],
  ['duplicate', 'mirror', 'pattern'],
];
const combineTools: Tool[] = ['union', 'subtract', 'intersect'];
const createTools: Tool[] = ['extrude', 'loft', 'sweep', 'box', 'cylinder', 'rod', 'revolve'];

interface OperationDockProps {
  addMode: boolean;
  setAddMode: (update: (on: boolean) => boolean) => void;
  replayLabel?: { title: string; detail: string };
  doc: CadDocument;
  tool: Tool | null;
  disabled: boolean;
  menu: string | null;
  setMenu: (id: string | null) => void;
  chooseTool: (tool: Tool | null) => void;
  name: (id: string) => string;
  selectIds: (ids: string[]) => void;
  notice: { kind: 'info' | 'error'; text: string } | null;
  setNotice: (notice: null) => void;
  measuring: boolean;
  previewing: boolean;
  step: number | null;
  replaying: boolean;
  agentTouched: Map<string, number>;
  toggleReplay: () => void;
  replaySpeed: number;
  cycleSpeed: () => void;
  viewStep: (step: number | null) => void;
}

export function OperationDock({
  replayLabel,
  doc,
  tool,
  disabled,
  menu,
  setMenu,
  chooseTool,
  name,
  selectIds,
  notice,
  setNotice,
  measuring,
  previewing,
  step,
  replaying,
  agentTouched,
  toggleReplay,
  replaySpeed,
  cycleSpeed,
  viewStep,
  addMode,
  setAddMode,
}: OperationDockProps) {
  const selected = doc.selectedFeatureIds;
  const assembly = doc.kind === 'assembly' || doc.features.some((f) => f.kind === 'instance');
  const historyStep = step !== null ? doc.features[step - 1] : undefined;
  const toolButton = (t: Tool) => {
    const spec = toolSpec(t);
    const reason = disabled ? undefined : unavailableReason(spec, selected.length);
    return (
      <button
        key={t}
        type="button"
        className={`dock-button${spec.label.length > 9 ? " wide" : ""}`}
        aria-pressed={tool === t}
        disabled={disabled || !!reason}
        onClick={() => chooseTool(tool === t ? null : t)}
        title={`${spec.label}${spec.shortcut ? ` · ${spec.shortcut}` : ''} — ${reason ?? spec.hint}`}
      >
        <Icon name={spec.icon} size={20} />
        <span>{spec.label}</span>
      </button>
    );
  };

  return (
    <div className="dock-wrap" data-inset="bottom">
      {notice && (
        <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={notice.kind === 'error' ? 'warning' : 'check'} size={16} />
          <span>{notice.text}</span>
          <button
            type="button"
            className="icon-button quiet"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {measuring && (
        <div className="mode-chip measure" role="status">
          <Icon name="ruler" size={14} />
          Measure · click two points, corners snap · Esc to finish
        </div>
      )}
      {previewing && (
        <div className="mode-chip preview" role="status">
          <span className="spinner-dot" />
          Exact preview · not applied
        </div>
      )}
      {step !== null || replayLabel ? (
        <div className="history-bar" role="status">
          <Icon name="history" size={18} />
          <span className="history-text">
            <b>
              {replayLabel?.title ?? `Step ${step} of ${doc.features.length}`}
            </b>
            <span>
              {replayLabel?.detail ?? (historyStep ? `${featureName(historyStep)} · ${historyStep.kind.replaceAll('_', ' ')}` : '')}
              {historyStep && agentTouched.has(historyStep.id) ? ' · by agent' : ''}
            </span>
          </span>
          <span className="history-keys">
            <kbd>[</kbd>
            <kbd>]</kbd>
          </span>
          <button type="button" className="ghost-button" onClick={toggleReplay}>
            <Icon name={replaying ? 'pause' : 'play'} size={14} />
            {replaying ? 'Pause' : 'Replay'}
          </button>
          <button
            type="button"
            className="ghost-button speed"
            aria-label={`Replay speed ${replaySpeed}×`}
            title="Replay speed"
            onClick={cycleSpeed}
          >
            {replaySpeed}×
          </button>
          <button type="button" className="primary-button" onClick={() => viewStep(null)}>
            Back to latest<kbd>Esc</kbd>
          </button>
        </div>
      ) : (
        <>
          {selected.length > 0 && !tool && (
            <div className="selection-chip">
              <b>{selected.length === 1 ? name(selected[0]) : `${selected.length} selected`}</b>
              {selected.length > 1 && <span>first is target</span>}
              <button
                type="button"
                className="icon-button quiet"
                aria-label="Clear selection"
                title="Clear · Esc"
                disabled={disabled}
                onClick={() => selectIds([])}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
          <nav className="dock" aria-label="Operations">
            <button type="button" className="dock-button toggle touch-only" aria-pressed={addMode} onClick={() => setAddMode(on => !on)}
              title="Multi-select: taps add or remove results, like Shift-click">
              <Icon name="multi" size={20} />
              <span>Multi</span>
            </button>
            <span className="dock-sep touch-only" />
            {assembly && toolButton('instance')}
            {selected.length === 0 ? (
              createTools.map(toolButton)
            ) : (
              <>
                <Menu
                  id="new"
                  open={menu === 'new'}
                  onToggle={setMenu}
                  label={<span>New</span>}
                  icon="plus"
                  align="up"
                  className="dock-menu"
                >
                  {createTools.map((t) => (
                    <MenuItem
                      key={t}
                      icon={toolSpec(t).icon}
                      label={toolSpec(t).label}
                      hint={toolSpec(t).shortcut}
                      disabled={disabled}
                      onClick={() => chooseTool(t)}
                    />
                  ))}
                </Menu>
                <span className="dock-sep" />
                {selected.length === 1 ? (
                  dockGroups.map((group, i) => (
                    <span className="dock-group" key={i}>
                      {group.map(toolButton)}
                    </span>
                  ))
                ) : (
                  <span className="dock-group">{combineTools.map(toolButton)}</span>
                )}
                <span className="dock-sep" />
                {toolButton('delete')}
              </>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
