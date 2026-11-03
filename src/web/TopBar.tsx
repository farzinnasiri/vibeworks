import { ServiceMonitor } from './ServiceMonitor';
import { Brand } from './Brand';
import type { RefObject,ReactNode } from 'react';
import type { RuntimeState } from '../cad/runtime';
import type { Participant } from '../shared/protocol';
import { analysisStatus } from '../cad/health';
import { countLabel } from '../shared/format';
import type { ConnectionState } from './bridge';
import { Menu, MenuItem } from './Menu';
import { Icon } from './icons';
import { AgentMark } from './AgentMark';
import { agentActivity, agentLabel } from './participants';

import { modifierLabel as mod } from './useKeyboardShortcuts';

interface TopBarProps {
  studio?: boolean; onStudio?: () => void;
  projectControl:ReactNode;
  selectionPath?:ReactNode;
  agents: Participant[];
  onAgents: () => void;
  projectId?: string;
  history?: boolean;
  state: RuntimeState;
  connection: ConnectionState;
  disabled: boolean;
  working: boolean;
  menu: string | null;
  setMenu: (id: string | null) => void;
  sheet: 'build' | 'inspect' | null;
  setSheet: (sheet: 'build' | 'inspect' | null) => void;
  documentNavigation: {canBack:boolean;canForward:boolean;back:()=>Promise<void>;forward:()=>Promise<void>};
  onSettings:()=>void;
  onBrowse:()=>void;
  setNotice: (notice: { kind: 'info' | 'error'; text: string } | null) => void;
  openAnalysis: () => Promise<void>;
  action: (action: 'undo' | 'redo' | 'reset') => Promise<void>;
  undoTarget?:string;redoTarget?:string;manualHistory?:boolean;
  exportFile: (format: 'json' | 'step' | 'stl', featureId?: string) => Promise<void>;
  fileInput: RefObject<HTMLInputElement | null>;
  loadFile: (file?: File) => Promise<void>;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  name: (id: string) => string;
}

/**
 * Read-only location, navigation/undo, commands and workspace controls.
 * Project switching, the document tree and creation/management live in the sidebar.
 */
export function TopBar({
  projectControl,selectionPath, studio = false, onStudio,
  projectId, history = false, state, disabled, agents, onAgents,
  working, menu, setMenu, sheet, setSheet, documentNavigation, onSettings, onBrowse, setNotice, openAnalysis,
  action, exportFile, fileInput, loadFile, setPalette, setHelp, name,undoTarget,redoTarget,manualHistory,
}: TopBarProps) {
  const doc = state.document;
  const selected = doc.selectedFeatureIds;
  const empty = !doc.features.length;
  const health = state.health;
  const issues = (health.floating ?? 0) + (health.interferences ?? 0) + (health.failedChecks ?? 0) + (health.partsWithoutAppearance ?? 0);
  const severe = (health.interferences ?? 0) + (health.failedChecks ?? 0) > 0 || !!health.referenceError;
  const failing = (health.interferences ?? 0) + (health.failedChecks ?? 0);
  // Unchecked and incomplete stay visibly different from passed; counts are the existing health facts only.
  const healthTone = severe ? 'error' : issues > 0 && health.analysis === 'current' ? 'warn' : health.analysis === 'current' ? 'ok' : issues > 0 ? 'warn' : 'unknown';
  const healthLabel = health.referenceError ? 'References need repair'
    : failing ? `Checks · ${failing} failing`
    : health.analysis === 'current' ? issues ? `Checks · ${issues} to review` : `Checks passed · r${health.checkedRevision}`
    : health.analysis === 'incomplete' ? `Checks incomplete${health.pendingChecks ? ` · ${health.pendingChecks} pending` : ''}`
    : health.checkedRevision === null ? 'Not checked' : `Not checked · ${countLabel(health.uncheckedChanges, 'change')}`;
  // Agent presence for this project. Separate from the service monitor's reachability measurement.
  const team = agents.filter(p => p.identity.kind === 'agent' && (p.connected || p.running > 0 || p.queued > 0));
  const teamRunning = team.filter(p => p.running > 0).length;
  const teamAttention = agents.filter(p => p.identity.kind === 'agent' && ['error', 'attention'].includes(agentActivity(p).tone)).length;
  const teamSummary = team.length ? `${countLabel(team.length, 'agent')} connected${teamRunning ? `, ${teamRunning} running a command` : ''}${teamAttention ? `, ${teamAttention} needing attention` : ''}` : 'No agents connected';
  return (
    <header className="topbar">
      <span className="brand-menu"><Brand className="header-wordmark"/><Brand markOnly className="header-mark"/></span>
      <Menu id="file" ariaLabel="File" open={menu==='file'} onToggle={setMenu} align="start" label="File">
        <MenuItem icon="file" label="Open JSON…" disabled={disabled} onClick={() => fileInput.current?.click()} />
        <MenuItem icon="export" label="Save editable JSON" hint="download" disabled={disabled} onClick={() => void exportFile('json')} />
      </Menu>
      <Menu id="export" ariaLabel="Export" open={menu==='export'} onToggle={setMenu} label="Export" icon="export" align="start">
        <MenuItem label="STEP" icon="export" disabled={disabled||empty} onClick={()=>{setMenu(null);void exportFile('step');}}/>
        <MenuItem label="STL" icon="export" disabled={disabled||empty} onClick={()=>{setMenu(null);void exportFile('stl');}}/>
        {selected.length===1&&<><hr/><MenuItem label={`Selected result · STEP`} icon="export" disabled={disabled} onClick={()=>{setMenu(null);void exportFile('step',selected[0]);}}/><MenuItem label="Selected result · STL" icon="export" disabled={disabled} onClick={()=>{setMenu(null);void exportFile('stl',selected[0]);}}/></>}
      </Menu>
      <button type="button" className="icon-button all-projects" aria-label="All projects" title="All projects" onClick={onBrowse}><Icon name="folder-open" size={17}/></button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => void loadFile(event.target.files?.[0])} />

      <div className="location-navigation"><button type="button" className="icon-button" aria-label="Back to previous document" disabled={working||!documentNavigation.canBack} onClick={()=>void documentNavigation.back().catch(error=>setNotice({kind:'error',text:String(error)}))}><Icon name="chevron" className="nav-back" size={15}/></button><button type="button" className="icon-button" aria-label="Forward to next document" disabled={working||!documentNavigation.canForward} onClick={()=>void documentNavigation.forward().catch(error=>setNotice({kind:'error',text:String(error)}))}><Icon name="chevron" className="nav-forward" size={15}/></button></div>
      <nav className="crumbs" aria-label="Location">
        {projectControl}<span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={12}/></span>
        {selectionPath??<span className="crumb"><Icon name={doc.kind==='assembly'?'layers':'box'} size={15}/><span className="crumb-name strong">{doc.name}</span><span className="rev">r{doc.revision}</span></span>}
      </nav>
      <div className="bar-group manual-history-controls">
        <button type="button" className="icon-button" aria-label="Undo" title={manualHistory&&!undoTarget?'No manual edits to undo in this tab. Open History for saved changes.':`Undo${undoTarget?` edit in ${undoTarget}`:''} · ${mod}Z`} disabled={disabled || !(manualHistory?undoTarget:state.canUndo)} onClick={() => void action('undo')}>
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-button" aria-label="Redo" title={`Redo${redoTarget?` edit in ${redoTarget}`:''} · ${mod}⇧Z`} disabled={disabled || !(manualHistory?redoTarget:state.canRedo)} onClick={() => void action('redo')}>
          <Icon name="redo" />
        </button>
      </div>

      {projectId && <button type="button" className={`bar-button team-summary ${team.length ? '' : 'no-agents'}`} aria-label={`Project team: ${teamSummary}. Open Activity`} title={`${teamSummary}${team.length ? `: ${team.map(p => agentLabel(p.identity.name)).join(', ')}` : ''}`} onClick={onAgents}>
        {team.length ? <span className="team-avatars" aria-hidden="true">{team.slice(0, 3).map(p => <AgentMark key={p.identity.agentId} id={p.identity.agentId} size={20} />)}</span> : <Icon name="agent" size={16} />}
        <span className="team-summary-text">{team.length ? countLabel(team.length, 'agent') : 'No agents'}</span>
        {teamAttention > 0 && <span className="team-attention" aria-hidden="true" />}
      </button>}
      <ServiceMonitor />
      <button type="button" className="bar-button search" onClick={() => setPalette(true)} aria-label="Search commands">
        <Icon name="search" size={16} /><span className="search-label">Commands</span>
        <kbd>{mod}K</kbd>
      </button>

      <div className="topbar-actions">
        <button type="button" className="bar-button settings-launch" aria-label="Workspace settings" onClick={onSettings}><Icon name="sliders" size={16}/><span>Settings</span></button>
        <div className="sheet-toggles" hidden={studio}>
          <button type="button" className="bar-button" aria-label="Model panel" aria-pressed={sheet === 'build'} onClick={() => setSheet(sheet === 'build' ? null : 'build')}>
            <Icon name="layers" size={17} /><span>Model</span>
          </button>
          <button type="button" className="bar-button" aria-label="Details panel" aria-pressed={sheet === 'inspect'} onClick={() => setSheet(sheet === 'inspect' ? null : 'inspect')}>
            <Icon name="inspector" size={17} /><span>Details</span>
          </button>
        </div>
        {onStudio && <button type="button" className={`bar-button studio-launch ${studio ? 'active' : ''}`} aria-label={studio ? 'Exit Studio' : 'Enter Studio'} aria-pressed={studio} disabled={!studio && (empty || working || history || !state.evaluation.meshes.length)} onClick={onStudio}><Icon name="camera" size={17} /><span>{studio ? 'Exit Studio' : 'Studio'}</span></button>}
        {!history && (
          <button type="button" className={`bar-button health-chip ${healthTone}`} disabled={disabled} onClick={() => void openAnalysis()}
            aria-label="Open design checks" aria-describedby="health-chip-status"
            title={`Open checks · ${analysisStatus(health)}${health.autoAnalysis === false ? ' · automatic analysis off' : ''}`}>
            <Icon name={healthTone === 'ok' ? 'check' : healthTone === 'unknown' ? 'help' : 'warning'} size={15} />
            <span id="health-chip-status">{healthLabel}</span>
          </button>
        )}
      </div>
    </header>
  );
}
