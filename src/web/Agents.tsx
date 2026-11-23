import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import type { ActivityOperation, AgentSession, CadDocument, DocumentSummary, Participant, Project } from '../shared/protocol';
import type { ConnectionState } from './bridge';
import { Icon } from './icons';
import { operationLabels } from './activity';
import { agentActivity, agentLabel, commandName, elapsed, mergeSessions, participantFocus, relativeTime, shortDocumentName, type AgentActivity } from './participants';
import { countLabel } from '../shared/format';
import { AgentMark } from './AgentMark';
import { Popover } from './Popover';
import { agentViewTarget } from './AgentViews';

export interface ProjectWork { participants: Participant[]; operations: ActivityOperation[]; sessions: AgentSession[] }
const empty: ProjectWork = { participants: [], operations: [], sessions: [] };

/** Polls the bridge's attributed project activity. Older pages load on request and are kept while polling. */
export function useProjectWork(runtime: RuntimeClient, projectId?: string, changesOnly = false, agentId?: string, enabled = true) {
  const [state, setState] = useState<{ key: string; work: ProjectWork; error?: string }>({ key: '', work: empty });
  const key = JSON.stringify([projectId, changesOnly, agentId, enabled]), older = useRef<ActivityOperation[]>([]), current = useRef(state);
  current.current = state;
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>; older.current = [];
    if (!enabled) return;
    const load = async () => {
      try {
        const result = await runtime.execute({ type: 'activity', params: { projectId, changesOnly, agentId, limit: 100 } });
        if (result.status === 'error') throw new Error(result.error?.message ?? 'Tracking unavailable.');
        if (alive) {
          const map = new Map(older.current.map(o => [o.operationId, o]));
          for (const o of result.operations ?? []) map.set(o.operationId, o);
          setState({ key, work: { participants: result.participants ?? [], operations: [...map.values()].sort((a, b) => a.sequence - b.sequence), sessions: mergeSessions(current.current.key === key ? current.current.work.sessions : [], result.sessions ?? []) } });
        }
      } catch (error) { if (alive) setState(s => ({ key, work: s.key === key ? s.work : empty, error: error instanceof Error ? error.message : String(error) })); }
      if (alive) timer = setTimeout(load, 2000);
    };
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [runtime, key]);
  const loadEarlier = useCallback(async () => {
    const before = current.current.work.operations[0]?.sequence; if (!before) return;
    const result = await runtime.execute({ type: 'activity', params: { projectId, changesOnly, agentId, before, limit: 100 } });
    if (result.status === 'success' && current.current.key === key) {
      older.current = [...(result.operations ?? []), ...current.current.work.operations];
      const map = new Map(older.current.map(o => [o.operationId, o]));
      setState(s => ({ ...s, work: { ...s.work, operations: [...map.values()].sort((a, b) => a.sequence - b.sequence), sessions: mergeSessions(result.sessions ?? [], s.work.sessions) } }));
    }
  }, [runtime, key]);
  return { work: state.key === key ? state.work : empty, error: state.key === key ? state.error : undefined, loading: state.key !== key, loadEarlier };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const words = (value: string) => value.replaceAll('_', ' ');
const isChange = (o: ActivityOperation) => o.toVersion !== undefined;
const title = (o: ActivityOperation) => o.operation === 'legacy_revision' ? 'Saved revision'
  : o.action ? `${words(o.action)[0].toUpperCase()}${words(o.action).slice(1)}` : operationLabels[o.operation] ?? words(o.operation);

export function Avatar({ participant, size = 22 }: { participant?: Participant; size?: number }) {
  if (!participant) return <span className="avatar unknown" style={{ width: size, height: size }} aria-hidden="true">?</span>;
  return <AgentMark id={participant.identity.agentId} human={participant.identity.kind === 'human'} size={size} />;
}

/**
 * What agents and people did, newest first. Committed changes always show; reads (inspections, renders,
 * exports) are folded into one line per run so changes stay visible. Failures always show.
 */
export function ChangeFeed({ work, documents, includeReads, onView, loadEarlier, cancelKey = 0, onSelectAgent, deltas,onPlay,viewing }: {
  work: ProjectWork; documents: DocumentSummary[]; includeReads: boolean; cancelKey?: number;
  onView: (operation: ActivityOperation) => Promise<void>; loadEarlier: () => Promise<void>; onSelectAgent?: (agentId: string) => void;
  /** Committed volume changes this tab observed, keyed by documentId:revision. */
  deltas?: Map<string, number>;onPlay?:()=>void;viewing?:string;
}) {
  const [error, setError] = useState<string>();const position=viewing;
  const [page, setPage] = useState(0);
  const people = new Map(work.participants.map(p => [p.identity.agentId, p]));
  const newest = [...work.operations].sort((a, b) => b.sequence - a.sequence)
    .filter(o => isChange(o) || o.status !== 'success' || includeReads);
  // Fold consecutive identical reads by the same author into one row.
  const rows: { op: ActivityOperation; count: number; docs: Set<string> }[] = [];
  for (const o of newest) {
    const last = rows.at(-1);
    if (last && !isChange(o) && !isChange(last.op) && o.status === 'success' && last.op.status === 'success'
      && o.agentId === last.op.agentId && o.operation === last.op.operation && o.action === last.op.action) {
      last.count++; if (o.documentId) last.docs.add(o.documentId); continue;
    }
    rows.push({ op: o, count: 1, docs: new Set(o.documentId ? [o.documentId] : []) });
  }
  const changes = work.operations.filter(o => isChange(o) && o.documentId).sort((a, b) => (a.commitSequence ?? 0) - (b.commitSequence ?? 0));
  const view = async (o: ActivityOperation) => { try { await onView(o); setError(undefined); return true; } catch (e) { setError(String(e)); return false; } };
  const pageCount = Math.max(1, Math.ceil(rows.length / 6)), currentPage = Math.min(page, pageCount - 1);
  const delta = (o: ActivityOperation) => o.documentId && o.revision !== undefined ? deltas?.get(`${o.documentId}:${o.revision}`) : undefined;
  const docName = (id?: string) => documents.find(d => d.documentId === id)?.name ?? (id ? 'Historical document' : 'Project');
  return <div className="feed">
    <div className="feed-actions">
      <button className="ghost-button small" type="button" onClick={onPlay} disabled={!changes.length}>
        <Icon name="play" size={13}/>Replay changes
      </button>
      <span className="field-hint">{`${changes.length} loaded`}</span>
    </div>
    {error && <p role="alert" className="field-error">{error}</p>}
    {!rows.length && <p className="field-hint feed-empty">No recorded changes yet.</p>}
    <ol className="feed-list">{rows.slice(currentPage * 6, currentPage * 6 + 6).map(({ op: o, count, docs }) => {
      const person = o.agentId ? people.get(o.agentId) : undefined;
      const author = person ? (person.identity.kind === 'human' ? 'You' : agentLabel(person.identity.name)) : o.agentId ? `Agent ${o.agentId.slice(0, 8)}` : 'Unknown author';
      const read = !isChange(o);
      return <li key={o.operationId} className={`feed-row ${read ? 'read' : 'change'} ${o.status} ${position === o.operationId ? 'viewing' : ''}`}>
        <Avatar participant={person} size={read ? 16 : 22} />
        <div className="feed-body">
          <div className="feed-head">
            {person && onSelectAgent && person.identity.kind === 'agent'
              ? <button type="button" className="feed-author" onClick={() => onSelectAgent(person.identity.agentId)}>{author}</button>
              : <b className="feed-author">{author}</b>}
            {read && <span className="feed-title">{title(o).toLowerCase()}{count > 1 ? ` ×${count}` : ''}</span>}
            <time>{time(o.completedAt ?? o.startedAt)}</time>
          </div>
          {!read && <p className="feed-what"><b>{title(o)}</b> · {docName(o.documentId)}{o.revision !== undefined ? ` · r${o.revision}` : ''}
            {o.status !== 'success' && <span className={`feed-status ${o.status}`}> {o.status}</span>}
            {delta(o) !== undefined && <span className={`delta ${delta(o)! > 0 ? 'up' : ''}`}>{delta(o)! > 0 ? '+' : '−'}{Math.abs(delta(o)!).toLocaleString('en', { maximumFractionDigits: 1 })} mm³</span>}</p>}
          {read && (o.status !== 'success' || count > 1) && <p className="feed-where">{count > 1 && docs.size > 1 ? `${docs.size} documents` : docName(o.documentId)}
            {o.status !== 'success' && <span className={`feed-status ${o.status}`}>{o.status}</span>}</p>}
          {o.intent && !read && <details className="change-intent"><summary>Intent</summary><p className="declared">{o.intent.purpose}</p></details>}
          {o.handoff && <details className="handoff"><summary>Handoff note</summary><p className="declared handoff-text">{o.handoff}</p></details>}
          {o.error && <p className="field-error feed-error" title={o.error.message}>{o.error.code}: {o.error.message}</p>}
          {o.toVersion && o.status !== 'success' && <p className="field-hint">A commit is recorded despite this delivery outcome. Inspect it before retrying.</p>}
          {o.documentId && o.toVersion && <button type="button" className="link-button feed-view" onClick={() => { void view(o); }}>
            {position === o.operationId ? 'Viewing this snapshot' : o.action === 'delete' ? 'View before deletion' : 'Review change'}</button>}
        </div>
      </li>;
    })}</ol>
    <div className="feed-pagination"><button type="button" className="icon-button quiet" disabled={currentPage === 0} aria-label="Newer changes" onClick={() => setPage(currentPage - 1)}><Icon name="chevron-left" size={14} /></button><span>{currentPage + 1} / {pageCount}</span>{currentPage + 1 < pageCount ? <button type="button" className="ghost-button small" onClick={() => setPage(currentPage + 1)}>Older</button> : <button type="button" className="ghost-button small" onClick={() => void loadEarlier()}>Load earlier</button>}</div>
  </div>;
}

/** Re-render on a clock so relative ages and observed elapsed times stay current. */
export function useNow(interval = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

/** Stable team order: joining order, never latest focus or contact, so rows do not move while agents work. */
export const joinedOrder = (a: Participant, b: Participant) => a.identity.createdAt.localeCompare(b.identity.createdAt) || a.identity.agentId.localeCompare(b.identity.agentId);

/** Latest recorded commit per agent within the loaded committed history. */
export function latestCommits(operations: ActivityOperation[]) {
  const map = new Map<string, ActivityOperation>();
  for (const o of operations) if (o.agentId && o.toVersion !== undefined && (map.get(o.agentId)?.commitSequence ?? -1) < (o.commitSequence ?? 0)) map.set(o.agentId, o);
  return map;
}

export function StatusLabel({ activity, now }: { activity: AgentActivity; now: number }) {
  return <span className={`agent-state ${activity.tone}`} title={activity.reported ? 'Reported by the agent' : 'Observed from recorded commands and contact'}>
    {(activity.tone === 'error' || activity.tone === 'attention') && <Icon name="warning" size={12} />}
    <span className="agent-state-text">{activity.label}{activity.since ? ` · ${elapsed(activity.since, now)}` : ''}</span>
  </span>;
}

/** The left-panel Activity tab: a stable team list first; operational log and sessions are secondary. */
export function AgentsTab({ deltas, runtime, changes, work, error, documents, projects, projectId, connection, doc, selected, onSelect, following, followPaused, sideViews, canAddSide, onToggleFollow, onToggleSide, onView, loadEarlier, cancelKey, reconnect, onPlayChanges, viewing }: {
  deltas?: Map<string, number>; runtime: RuntimeClient; changes: { work: ProjectWork; loadEarlier: () => Promise<void> }; work: ProjectWork; error?: string; documents: DocumentSummary[]; projects: Project[]; projectId?: string; connection: ConnectionState;
  doc: CadDocument; selected?: string; onSelect: (agentId?: string) => void; following?: string; sideViews: string[]; cancelKey: number;
  onView: (operation: ActivityOperation) => Promise<void>; loadEarlier: () => Promise<void>; reconnect: () => void;
  followPaused: boolean; canAddSide: boolean; onToggleFollow: (participant: Participant) => void; onToggleSide: (agentId: string) => void;
  onPlayChanges?: (agentId?: string) => void; viewing?: string;
}) {
  const [includeReads, setIncludeReads] = useState(true), [mode, setMode] = useState<'team' | 'changes' | 'sessions'>('team');
  const now = useNow(5000);
  const agentHistory = useProjectWork(runtime, projectId, true, selected, !!selected && mode === 'changes');
  const feed: ProjectWork = selected ? { ...agentHistory.work, participants: work.participants } : includeReads ? work : {
    ...work, operations: [...new Map([...changes.work.operations, ...work.operations.filter(o => o.status !== 'success')].map(o => [o.operationId, o])).values()],
  };
  const agents = work.participants.filter(p => p.identity.kind === 'agent').sort(joinedOrder);
  const present = agents.filter(p => p.connected || p.running > 0 || p.queued > 0);
  const earlier = agents.filter(p => !present.includes(p));
  const running = present.filter(p => p.running > 0).length;
  const commits = useMemo(() => latestCommits(changes.work.operations), [changes.work.operations]);
  const projectName = projects.find(p => p.projectId === projectId)?.name;
  const sessions = [...work.sessions].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const row = (p: Participant) => {
    const id = p.identity.agentId, name = agentLabel(p.identity.name), activity = agentActivity(p), focus = participantFocus(p);
    const target = projectId ? agentViewTarget(p, projectId, documents) : undefined;
    const design = target ? shortDocumentName(target.name, projectName) : focus?.documentId ? 'Outside this project' : 'No design yet';
    const relation = following === id ? 'following' : target?.documentId === doc.documentId ? 'in your view' : sideViews.includes(id) ? 'beside your view' : '';
    const commit = commits.get(id), phase = p.session?.phase;
    const progress = [phase ? `“${phase}”` : '', commit ? `committed ${relativeTime(commit.completedAt ?? commit.startedAt, now)}` : ''].filter(Boolean).join(' · ');
    const progressTitle = [phase ? `Phase reported by the agent: ${phase}` : '', commit ? `Latest recorded commit: ${shortDocumentName(documents.find(d => d.documentId === commit.documentId)?.name ?? 'a document', projectName)} r${commit.revision ?? '?'}` : ''].filter(Boolean).join('\n');
    const followed = following === id, side = sideViews.includes(id);
    const followLabel = followed ? followPaused ? 'Resume following' : 'Pause following' : 'Follow in main view';
    return <li key={id} className={`team-member ${selected === id ? 'selected' : ''}`}>
      <button type="button" className={`agent-row team-row tone-${activity.tone}`} aria-pressed={selected === id} onClick={() => onSelect(selected === id ? undefined : id)}>
        <Avatar participant={p} size={30} />
        <span className="team-row-text">
          <span className="team-row-head"><b title={name}>{name}</b></span>
          <StatusLabel activity={activity} now={now} />
          <span className="team-row-design" title={target?.name}><Icon name={target?.kind === 'assembly' ? 'layers' : 'box'} size={13} /><span>{design}</span></span>
          <span className="team-row-progress" title={progressTitle}>{relation || progress || 'No recorded change'}</span>
        </span>
      </button>
      <div className="team-row-actions" role="group" aria-label={`View ${name}`}>
        <button type="button" className="icon-button quiet" aria-label={`${followLabel} for ${name}`} title={followLabel} aria-pressed={followed && !followPaused} disabled={!p.connected || !target} onClick={() => onToggleFollow(p)}><Icon name={followed ? followPaused ? 'play' : 'pause' : 'eye'} size={15} /></button>
        <button type="button" className="icon-button quiet" aria-label={`${side ? 'Close' : 'Open'} side view for ${name}`} title={side ? 'Close side view' : !canAddSide ? 'Three side views are already open' : 'Open beside my view'} aria-pressed={side} disabled={!side && (!canAddSide || !p.connected || !target)} onClick={() => onToggleSide(id)}><Icon name="monitor" size={15} /></button>
      </div>
    </li>;
  };
  if (mode !== 'team') return <div className="agents-tab work-hub">
    <div className="activity-subhead">
      <button type="button" className="ghost-button small" onClick={() => setMode('team')}><Icon name="chevron-left" size={14} />Team</button>
      <h3>{mode === 'changes' ? 'Activity log' : 'Sessions'}</h3>
    </div>
    {error && <p className="warn-text" role="status">Activity unavailable: {error}. Showing the last known records.</p>}
    {mode === 'changes' && <section className="agents-section" aria-label="Project activity log"><div className="section-heading"><h3>{selected ? agentLabel(agents.find(p => p.identity.agentId === selected)?.identity.name ?? 'Agent') : 'Everyone'}</h3>{selected ? <button type="button" className="link-button" onClick={() => onSelect(undefined)}>Everyone</button> : <label className="list-toggle"><input type="checkbox" checked={includeReads} onChange={e => setIncludeReads(e.target.checked)} />Reads</label>}</div>
      {agentHistory.error && selected && <p className="field-error" role="alert">{agentHistory.error}</p>}
      <ChangeFeed viewing={viewing} onPlay={() => onPlayChanges?.(selected)} key={selected ?? 'all'} work={feed} documents={documents} includeReads={!selected && includeReads} onView={onView} loadEarlier={selected ? agentHistory.loadEarlier : includeReads ? loadEarlier : changes.loadEarlier} cancelKey={cancelKey} onSelectAgent={onSelect} deltas={deltas} />
    </section>}
    {mode === 'sessions' && <section className="session-list" aria-label="Project sessions">{sessions.slice(0, 20).map(session => { const p = agents.find(p => p.identity.agentId === session.agentId); return <details key={session.sessionId} className="session-card"><summary><Avatar participant={p} size={24} /><span>{p ? agentLabel(p.identity.name) : session.client}<small>{session.endedAt ? 'Ended' : p?.session?.sessionId === session.sessionId && p.connected ? 'Connected' : 'Past session'} · {new Date(session.startedAt).toLocaleDateString()}</small></span></summary><p>{session.task ?? 'No task reported'}</p><small className="field-hint">{session.client}{session.model ? ` · ${session.model} · reported` : ''}</small>{session.handoff && <details className="method"><summary>Handoff</summary><p>{session.handoff}</p></details>}<button type="button" className="ghost-button small" onClick={() => { onSelect(session.agentId); setMode('changes'); }}>View activity</button></details>; })}{!sessions.length && <p className="field-hint">No recorded sessions.</p>}{sessions.length > 20 && <p className="field-hint">Showing the 20 most recent sessions.</p>}</section>}
  </div>;
  return <div className="agents-tab work-hub">
    <div className="team-heading"><h3>Team</h3><span>{present.length} connected{running ? ` · ${running} running` : ''}</span></div>
    {error && <p className="warn-text" role="status">Activity unavailable: {error}. Showing the last known state.</p>}
    {present.length ? <ul className="team-list" aria-label="Connected agents">{present.map(row)}</ul>
      : <div className="work-empty"><Icon name="agent" size={26} /><p>No connected agents</p><small>Connect Codex or Claude to work on this project.</small></div>}
    {earlier.length > 0 && <details className="team-earlier"><summary><Icon name="chevron" size={14} />Earlier in this project <span>{earlier.length}</span></summary><ul className="team-list" aria-label="Agents no longer connected">{earlier.map(row)}</ul></details>}
    <div className="team-secondary" role="group" aria-label="Operational records">
      <button type="button" className="ghost-button small" onClick={() => setMode('changes')}><Icon name="history" size={14} />Activity log<Icon name="arrow-right" size={14} /></button>
      <button type="button" className="ghost-button small" onClick={() => setMode('sessions')}><Icon name="agent" size={14} />Sessions<Icon name="arrow-right" size={14} /></button>
    </div>
    <AgentLink connection={connection} doc={doc} reconnect={reconnect} />
  </div>;
}

/** Connection to the local bridge, and the handle an agent needs to edit this exact document. */
function AgentLink({ connection, doc, reconnect }: { connection: ConnectionState; doc: CadDocument; reconnect: () => void }) {
  const connected = connection.phase === 'connected';
  return <details className={`agent-link ${connection.phase}`}>
    <summary>
      <span className={`link-dot ${connected ? 'ok' : connection.phase === 'connecting' ? 'pending' : connection.phase === 'rejected' ? 'warn' : 'off'}`} />
      <span>{connected ? 'Service connection' : connection.phase === 'connecting' ? 'Connecting…' : 'Service connection offline'}</span>
      <Icon name="chevron" size={13} />
    </summary>
    <div className="agent-link-body">
      <p className="field-hint">{connected
        ? 'Codex or Claude Code can inspect, edit, render and export this document through MCP. Every edit names the document and revision, so a stale call is rejected instead of overwriting your work.'
        : connection.phase === 'rejected' ? 'The Node authority rejected the connection. Follow the details below, then reconnect.'
          : 'The Node authority is unavailable. The last model stays visible; editing resumes after reconnection. Start pnpm run headless.'}</p>
      {!connected && <p className="mono-small muted">{connection.message}</p>}
      <dl className="handle">
        <div><dt>documentId</dt><dd><code>{doc.documentId}</code>
          <button type="button" className="icon-button quiet" aria-label="Copy document ID" title="Copy" onClick={() => void navigator.clipboard?.writeText(doc.documentId)}><Icon name="copy" size={14} /></button></dd></div>
        <div><dt>expectedRevision</dt><dd><code>{doc.revision}</code></dd></div>
        <div><dt>units · axes</dt><dd><code>mm · Z up</code></dd></div>
      </dl>
      {!connected && <button type="button" className="primary-button" onClick={reconnect}>Reconnect</button>}
    </div>
  </details>;
}


const changeTitle = (o: ActivityOperation) => o.operation === 'legacy_revision' ? 'Saved revision' : o.action ? `${words(o.action)[0].toUpperCase()}${words(o.action).slice(1)}` : operationLabels[o.operation] ?? words(o.operation);

/** Connection evidence stays separate from the agent's reported work state. */
function AgentConnection({ participant: p }: { participant: Participant }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [keyboard, setKeyboard] = useState(false);
  const [copied, setCopied] = useState(false), [fallback, setFallback] = useState<string>();
  const session = p.session, connected = p.connected;
  const label = connected ? 'Connected' : session?.endedAt ? 'Session ended' : 'Disconnected';
  return <>
    <button ref={anchor} type="button" className={`agent-connection-trigger ${connected ? 'connected' : 'disconnected'}`} aria-label={`${label}. Session and connection details`} aria-haspopup="dialog" aria-expanded={open} onClick={event => { setKeyboard(event.detail === 0); setOpen(!open); }}>
      <span className="agent-contact-dot" /><span>{label}</span><Icon name="chevron" size={13} />
    </button>
    <Popover open={open} anchor={anchor} onClose={() => setOpen(false)} role="dialog" label="Session and connection" className="agent-connection-popover" keyboard={keyboard}>
      <div className="agent-connection-heading"><h3>Session and connection</h3><button type="button" className="icon-button quiet" aria-label="Close connection details" onClick={() => { setOpen(false); anchor.current?.focus(); }}><Icon name="close" size={15} /></button></div>
      <p className={connected ? 'contact-online' : 'muted'}>{label}</p>
      <dl className="fact-list">
        <div><dt>Client</dt><dd>{session?.client ?? 'Unknown client'}</dd></div>
        {session?.model && <div><dt>Model</dt><dd>{session.model} (reported)</dd></div>}
        {session && <><div><dt>Last contact</dt><dd>{time(session.lastSeenAt)}</dd></div><div><dt>Started</dt><dd>{new Date(session.startedAt).toLocaleString()}</dd></div>{session.endedAt && <div><dt>Ended</dt><dd>{new Date(session.endedAt).toLocaleString()}</dd></div>}</>}
      </dl>
      <button type="button" className="ghost-button small" onClick={async () => {
        const prompt = `Use the CAD MCP tools. ${connected ? 'Join a new agent with continuedFrom' : 'Resume agent'} ${p.identity.name}. Inspect its activity and handoff before continuing. Preserve other participants’ edits.`;
        try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(prompt); setCopied(true); }
        catch { setFallback(prompt); }
      }}><Icon name="copy" size={14} />{connected ? 'Copy continuation prompt' : 'Copy resume prompt'}</button>
      {copied && <p className="field-hint" role="status">Prompt copied.</p>}
      {fallback && <label className="field-hint">Copy this prompt<textarea readOnly value={fallback} /></label>}
      <details className="agent-disclosure"><summary><Icon name="chevron" size={14} />Identity</summary><p className="work-session">{p.identity.name}<br />{p.identity.agentId}<br />Session {session?.sessionId ?? 'none'}{p.identity.continuedFrom && <><br />Continued from {p.identity.continuedFrom}</>}</p></details>
      <p className="field-hint">Connection shows adapter contact, not whether the agent is working.</p>
    </Popover>
  </>;
}

export interface FollowState { mode: 'show' | 'follow'; paused: boolean }

/**
 * The right panel for one selected agent. Leads with its assignment, observed progress, latest commit and
 * anything that needs attention. Agent statements are attributed and kept apart from recorded evidence.
 */
export function AgentDetail({ participant, participants, projects, projectId, documents, viewing, commits, operations, follow, sideView, canAddSide, onShowWork, onFollow, onPauseFollow, onResumeFollow, onReturn, onToggleSide, onHighlight, onReviewChange, onClose }: {
  participant: Participant; participants: Participant[]; projects: Project[]; projectId?: string; documents: DocumentSummary[];
  /** The design in the human's main view. */
  viewing: CadDocument;
  /** Loaded committed history and recent activity, both attributed by the bridge. */
  commits: ActivityOperation[]; operations: ActivityOperation[];
  /** Present only while this agent is shown or followed in the main view. */
  follow?: FollowState; sideView: boolean; canAddSide: boolean;
  onShowWork: () => void; onFollow: () => void; onPauseFollow: () => void; onResumeFollow: () => void; onReturn: () => void;
  onToggleSide: () => void; onHighlight: (featureIds: string[]) => void; onReviewChange: (operation: ActivityOperation) => void; onClose: () => void;
}) {
  const now = useNow(1000);
  const p = participant, id = p.identity.agentId, session = p.session, activity = agentActivity(p), focus = participantFocus(p), last = p.lastAction;
  const name = agentLabel(p.identity.name);
  const nameOf = (agentId: string) => agentLabel(participants.find(a => a.identity.agentId === agentId)?.identity.name ?? agentId.slice(0, 8));
  const projectName = projects.find(s => s.projectId === projectId)?.name;
  const short = (documentId?: string) => { const d = documents.find(d => d.documentId === documentId); return d ? shortDocumentName(d.name, projectName) : documentId ? 'Another document' : 'Project'; };
  const target = projectId ? agentViewTarget(p, projectId, documents) : undefined;
  const elsewhere = !!focus?.projectId && focus.projectId !== projectId;
  const viewName = shortDocumentName(viewing.name, projectName);
  const inView = target?.documentId === viewing.documentId;
  // A direct placement is established by the viewed design itself; deeper nesting is not claimed.
  const placements = target && !inView ? viewing.features.filter(f => f.kind === 'instance' && f.params.document === target.documentId).map(f => f.id) : [];
  const focusIds = inView ? (focus?.featureIds ?? []).filter(fid => viewing.features.some(f => f.id === fid)) : [];
  const mine = (o: ActivityOperation) => o.agentId === id;
  const latest = commits.filter(o => mine(o) && o.toVersion !== undefined).sort((a, b) => (b.commitSequence ?? 0) - (a.commitSequence ?? 0))[0];
  const failures = operations.filter(o => mine(o) && o.status === 'error' && o.toVersion === undefined && o.sequence > (latest?.sequence ?? -1));
  const changeTargets = (o: ActivityOperation) => o.documentId === viewing.documentId
    ? o.featureIds.filter(fid => viewing.features.some(f => f.id === fid))
    : viewing.features.filter(f => f.kind === 'instance' && f.params.document === o.documentId).map(f => f.id);
  const latestTargets = latest ? changeTargets(latest) : [];
  const attention: { key: string; text: string; reported?: boolean }[] = [];
  if (last?.status === 'error') attention.push({ key: 'error', text: `Its last ${commandName(last.operation)} failed ${relativeTime(last.completedAt ?? last.startedAt, now)}${last.error ? `: ${last.error.code} · ${last.error.message}` : '.'}` });
  if (failures.length > (last?.status === 'error' ? 1 : 0)) attention.push({ key: 'failures', text: `${countLabel(failures.length, 'failed attempt')} since its last recorded commit.` });
  if (last?.status === 'unknown') attention.push({ key: 'unknown', text: `The outcome of its last ${commandName(last.operation)} is unknown. Inspect the model before anyone retries it.` });
  if (latest && latest.status !== 'success') attention.push({ key: 'delivery', text: 'Its latest commit was recorded despite an unresolved delivery outcome. Review it before retrying.' });
  if (!p.connected && session?.workState === 'working' && !session.endedAt) attention.push({ key: 'contact', text: `Contact was lost ${relativeTime(session.lastSeenAt, now)} while it reported working.` });
  if (session?.workState === 'waiting') attention.push({ key: 'waiting', text: 'The agent reported that it is waiting.', reported: true });
  const active = p.activeWork ?? [];
  const mainLabel = !follow ? 'Follow in main view' : follow.mode === 'show' || follow.paused ? 'Resume following' : 'Pause following';
  const latestText = latest ? `${short(latest.documentId)} · r${latest.revision ?? '?'} · ${relativeTime(latest.completedAt ?? latest.startedAt, now)}` : 'No commits in the loaded history';
  const currentText = active.length ? active.map(o => `${o.status === 'queued' ? 'Queued' : 'Running'} ${commandName(o.operation)} · ${elapsed(o.startedAt, now)}`).join('; ') : p.connected ? 'No command running' : 'Not connected';
  const lastText = last ? `${changeTitle(last)} · ${relativeTime(last.completedAt ?? last.startedAt, now)} · ${last.toVersion !== undefined ? `committed r${last.revision ?? '?'}` : last.status === 'success' ? 'no committed change' : last.status}` : 'No recorded command';
  return <div className="agent-detail">
    <div className="agent-detail-top">
      <header className="card-head">
        <Avatar participant={p} size={36} />
        <div className="agent-detail-identity"><h2 title={name}>{name}</h2><StatusLabel activity={activity} now={now} /></div>
        <button type="button" className="icon-button quiet" aria-label="Close agent details" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>
      <div className="agent-view-controls">
        <AgentConnection key={id} participant={p} />
        <div className="agent-view-buttons" role="group" aria-label="View this agent">
          <button type="button" className="ghost-button" aria-pressed={!!follow && follow.mode === 'follow' && !follow.paused} disabled={!p.connected || !target} title="Following tracks the agent’s design and focus. Moving your camera pauses it." onClick={!follow ? onFollow : follow.mode === 'show' || follow.paused ? onResumeFollow : onPauseFollow}><Icon name={!follow ? 'eye' : follow.mode === 'show' || follow.paused ? 'play' : 'pause'} size={15} />{mainLabel}</button>
          <button type="button" className="ghost-button" aria-pressed={sideView} disabled={!sideView && (!canAddSide || !p.connected || !target)} title={!sideView && !canAddSide ? 'Three side views are already open.' : 'A side view leaves your own view unchanged.'} onClick={onToggleSide}><Icon name="monitor" size={15} />{sideView ? 'Close side view' : 'Open side view'}</button>
        </div>
        <div className="agent-view-return"><span>{follow ? follow.mode === 'show' ? 'Viewing their work' : follow.paused ? 'Following paused' : 'Following live' : 'Your main view is unchanged'}</span>{follow && <button type="button" className="link-button" onClick={onReturn}><Icon name="chevron-left" size={13} />Return to my view</button>}</div>
      </div>
    </div>
    <div className="card-body">
      <section className="agent-assignment" aria-label="Assignment">
        <h3 className="section-title">Working in</h3>
        <div className="agent-design-target">
          <p className="design-line" title={target?.name}><Icon name={target?.kind === 'assembly' ? 'layers' : 'box'} size={15} /><b>{target ? shortDocumentName(target.name, projectName) : elsewhere ? 'Another project' : 'No design available'}</b></p>
          <div className="inline-actions">
            <button type="button" className="icon-button quiet" aria-label="Show their work" title="Open this design once" disabled={!target || inView || !!follow} onClick={onShowWork}><Icon name="arrow-right" size={16} /></button>
            <button type="button" className="icon-button quiet" aria-label={inView ? 'Show in model' : 'Show in this assembly'} title={placements.length || focusIds.length ? 'Outline their work in your current view' : 'No geometry can be mapped to your current view'} disabled={!placements.length && !focusIds.length} onClick={() => onHighlight(inView ? focusIds : placements)}><Icon name="target" size={16} /></button>
          </div>
        </div>
        <p className="agent-location-summary">{inView ? 'In your view' : placements.length ? `In your assembly · ${countLabel(placements.length, 'component')}` : 'Outside your current view'}</p>
        <details className="agent-disclosure assignment-details"><summary><Icon name="chevron" size={14} />Location details</summary>
          <dl className="fact-list"><div><dt>Your view</dt><dd>{viewName}</dd></div><div><dt>Their design</dt><dd>{target?.name ?? (elsewhere ? projects.find(s => s.projectId === focus!.projectId)?.name : 'No design in this project')}</dd></div>
            {focus?.featureIds?.length ? <div><dt>Focus</dt><dd>{focus.featureIds.join(', ')}</dd></div> : null}
            {session?.parentAgentId && <div><dt>Coordinator</dt><dd>{nameOf(session.parentAgentId)}</dd></div>}
          </dl>
        </details>
      </section>
      <details className={`agent-disclosure agent-attention ${attention.length ? 'has-issues' : ''}`}><summary><Icon name="chevron" size={14} />{attention.length > 0 && <Icon name="warning" size={14} />}{attention.length ? 'Needs attention' : 'Recent issues'} <span>{attention.length}</span></summary>
        <ul>{attention.map(item => <li key={item.key} className={item.reported ? 'reported' : ''}><span>{item.text}{item.reported && <small>Reported by the agent</small>}</span></li>)}</ul>{!attention.length && <p className="field-hint">No issues in the loaded activity.</p>}
      </details>
      <section className="agent-progress" aria-label="Recorded progress">
        <h3 className="section-title">Recorded progress</h3>
        <dl className="agent-progress-facts">
          <div><dt>Now</dt><dd title={currentText}>{currentText}</dd></div>
          <div><dt>Last command</dt><dd title={lastText} className={last?.status === 'error' ? 'field-error' : ''}>{lastText}</dd></div>
          <div><dt>Latest commit</dt><dd className="agent-commit" title={latestText}>{latest ? <><span>{short(latest.documentId)}</span><small>r{latest.revision ?? '?'} · {relativeTime(latest.completedAt ?? latest.startedAt, now)} · {countLabel(latest.featureIds.length, 'feature')}</small></> : latestText}</dd></div>
        </dl>
        <div className="inline-actions">
          <button type="button" className="ghost-button small" disabled={!latestTargets.length} title={latestTargets.length ? 'Outline the changed geometry briefly' : 'The changed geometry cannot be mapped to this view.'} onClick={() => onHighlight(latestTargets)}><Icon name="target" size={14} />Highlight</button>
          <button type="button" className="ghost-button small" disabled={!latest} onClick={() => latest && onReviewChange(latest)}><Icon name="history" size={14} />Review change</button>
        </div>
        <details className="agent-disclosure"><summary><Icon name="chevron" size={14} />Command details</summary>
          {active.map(o => <p key={o.operationId} className="field-hint">{o.status === 'queued' ? 'Queued' : 'Running'} {commandName(o.operation)} · {short(o.documentId)} · {elapsed(o.startedAt, now)}{o.featureIds.length ? ` · ${o.featureIds.join(', ')}` : ''}</p>)}
          <p className="field-hint">{lastText}</p><p className="field-hint">{latest ? `${changeTitle(latest)} · ${latestText} · ${countLabel(latest.featureIds.length, 'feature')}` : latestText}</p>
          {latest?.intent && <p className="field-hint"><b>Stated intent: </b>{latest.intent.purpose}</p>}
        </details>
      </section>
      <details className="agent-disclosure agent-reported"><summary><Icon name="chevron" size={14} />Agent report<span title={session?.phase}>{session?.phase ? words(session.phase) : session?.task ? 'Task' : 'No report'}</span></summary>
        <p className="field-hint">Reported by {name}; not verified by Vibeworks.</p>
        <dl className="fact-list">{session?.phase && <div><dt>Phase</dt><dd>{words(session.phase)}</dd></div>}{session?.role && <div><dt>Role</dt><dd>{words(session.role)}</dd></div>}</dl>
        {session?.task && <p className="agent-report-text">{session.task}</p>}
        {session?.handoff && <details className="agent-disclosure"><summary><Icon name="chevron" size={14} />Handoff note</summary><p className="agent-report-text">{session.handoff}</p></details>}
      </details>
    </div>
  </div>;
}
