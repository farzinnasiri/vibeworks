import {Select} from './Select';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import type { Evaluation } from '../cad/types';
import { effectiveAppearance } from '../cad/document';
import type { CadDocument, DocumentSummary, Participant } from '../shared/protocol';
import { Viewport, type ViewportView } from './Viewport';
import { AgentViewLayout, type AgentLayout } from './AgentViewLayout';
import { AgentMark } from './AgentMark';
import { Icon } from './icons';
import { agentActivity, agentLabel, participantFocus } from './participants';
import { operationLabels } from './activity';
import type { StudioNavigation } from './studio-navigation';

export const MAX_AGENT_VIEWS = 4;
export const MAX_AGENT_FOLLOWERS = MAX_AGENT_VIEWS - 1;

/** Resolve only targets owned by the current project, even when a member works elsewhere. */
export function agentViewTarget(participant: Participant | undefined, projectId: string, documents: DocumentSummary[]) {
  if (!participant) return undefined;
  const focus = participantFocus(participant);
  if (focus?.projectId && focus.projectId !== projectId) return undefined;
  return documents.find(d => d.documentId === focus?.documentId && d.projectId === projectId);
}

type Frame = { document: CadDocument; evaluation: Evaluation };
type Delivery = { frame?: Frame; loading: boolean; error?: string };
const noop = () => {};
const noTransform = async () => {};

/** A bounded set of independent displays over the same authority. Observation never navigates the editor. */
export function AgentViews({ runtime, projectId, projectName, ids, participants, documents, changeSequence, dark, navigation, onRemove, onClose, mainView, mainDocument, onFitMain }: {
  runtime: RuntimeClient; projectId: string; projectName: string; ids: string[]; participants: Participant[];
  documents: DocumentSummary[]; changeSequence: number; dark: boolean; navigation: StudioNavigation;
  onRemove: (id: string) => void; onClose: () => void;
  mainView: ReactNode; mainDocument: CadDocument; onFitMain: () => void;
}) {
  const [deliveries, setDeliveries] = useState<Record<string, Delivery>>({});
  const [expanded, setExpanded] = useState<string>();
  const [layout, setLayout] = useState<AgentLayout>('grid');
  const [retry, setRetry] = useState(0);
  const completed = useRef(new Map<string, string>());
  const bounded = ids.slice(0, MAX_AGENT_FOLLOWERS);
  const targets = bounded.map(id => agentViewTarget(participants.find(p => p.identity.agentId === id), projectId, documents));
  const targetKey = JSON.stringify([...new Set(targets.flatMap(t => t ? [t.documentId] : []))].sort());
  // A source change may refresh an assembly without advancing the assembly's own revision.
  const versions = JSON.stringify(documents.filter(d => d.projectId === projectId).map(d => [d.documentId, d.storageVersion, d.revision]).sort());
  const dataKey = JSON.stringify([versions, changeSequence, retry]);
  const observation = useRef({ targetKey, dataKey });
  observation.current = { targetKey, dataKey };
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    completed.current.clear();
    const read = async () => {
      const request = observation.current;
      const documentIds: string[] = JSON.parse(request.targetKey);
      for (const id of completed.current.keys()) if (!documentIds.includes(id)) completed.current.delete(id);
      const pending = documentIds.filter(id => completed.current.get(id) !== request.dataKey);
      if (pending.length) {
        setDeliveries(previous => Object.fromEntries(documentIds.map(id => [id, {
          ...previous[id], ...(pending.includes(id) ? { loading: true, error: undefined } : {}),
        }])));
        // One batch at a time bounds pending authority reads during rapid edits or target changes.
        await Promise.all(pending.map(async documentId => {
          try {
            const outcome = await runtime.replay({ type: 'inspect_model', params: { documentId } });
            if (!alive || observation.current.targetKey !== request.targetKey || observation.current.dataKey !== request.dataKey) return;
            if (outcome.result.status !== 'success') throw new Error(outcome.result.error?.message ?? 'Model observation failed.');
            const document = outcome.result.document;
            if (!document || document.documentId !== documentId || document.projectId !== projectId || !outcome.evaluation)
              throw new Error('The model no longer belongs to this project. Refresh the project to continue.');
            if (outcome.evaluation.referenceError || outcome.evaluation.displayError)
              throw new Error(outcome.evaluation.referenceError ?? outcome.evaluation.displayError);
            const frame = { document, evaluation: outcome.evaluation };
            completed.current.set(documentId, request.dataKey);
            setDeliveries(previous => ({ ...previous, [documentId]: { frame, loading: false } }));
          } catch (error) {
            if (alive && observation.current.targetKey === request.targetKey && observation.current.dataKey === request.dataKey) {
              completed.current.set(documentId, request.dataKey);
              setDeliveries(previous => ({ ...previous, [documentId]: { frame: previous[documentId]?.frame, loading: false, error: String(error instanceof Error ? error.message : error) } }));
            }
          }
        }));
      }
      if (alive) timer = setTimeout(read, 500);
    };
    void read();
    return () => { alive = false; clearTimeout(timer); completed.current.clear(); };
  }, [runtime, projectId]);
  const focused = expanded && (expanded === 'main' || bounded.includes(expanded)) ? expanded : undefined;
  const panes = [{ id: 'main', content: <article className="agent-view agent-main-view" aria-label="Your main view" data-document-id={mainDocument.documentId}>
    <header className="agent-view-header"><Icon name="select" size={20} /><div className="agent-view-identity"><h3>Your view</h3><span className="field-hint">Follows your navigation</span></div><button type="button" className="icon-button quiet" aria-label={focused === 'main' ? 'Restore grid for your view' : 'Expand your view'} aria-pressed={focused === 'main'} onClick={() => setExpanded(focused === 'main' ? undefined : 'main')}><Icon name={focused === 'main' ? 'layers' : 'monitor'} size={15} /></button></header>
    <div className="agent-view-canvas">{mainView}<button type="button" className="icon-button agent-view-fit" aria-label="Fit your model" onClick={onFitMain}><Icon name="fit" size={16} /></button></div>
    <footer className="agent-view-footer"><span title={mainDocument.name}>{mainDocument.name ?? 'Your part'}</span><span>r{mainDocument.revision}</span></footer>
  </article> }, ...bounded.map((id, index) => ({ id, content: <AgentPane id={id} participant={participants.find(p => p.identity.agentId === id)}
    target={targets[index]} delivery={targets[index] ? deliveries[targets[index]!.documentId] : undefined}
    dark={dark} navigation={navigation} expanded={focused === id} hidden={false}
    onExpand={() => setExpanded(focused === id ? undefined : id)} onRemove={() => onRemove(id)} onRetry={() => setRetry(n => n + 1)} /> }))];
  return <section className="agent-views" aria-label="Your view beside agent views">
    <header className="agent-views-toolbar">
      <div><h2>Side views <span>{bounded.length + 1} / {MAX_AGENT_VIEWS}</span></h2><p title={projectName}>{projectName} · Your view + {bounded.length} {bounded.length === 1 ? 'agent' : 'agents'}</p></div>
      <div className="agent-layout-actions"><label><span className="sr-only">View layout</span><Select aria-label="View layout" value={layout} onChange={event => { setLayout(event.target.value as AgentLayout); setExpanded(undefined); }}><option value="grid">Grid</option><option value="columns">Main beside agents</option><option value="rows">Main above agents</option></Select></label><button type="button" className="ghost-button small" onClick={onClose}><Icon name="close" size={14} />Close side views</button></div>
    </header>
    <AgentViewLayout panes={panes} layout={layout} expanded={focused} />
  </section>;
}

function AgentPane({ id, participant, target, delivery, dark, navigation, expanded, hidden, onExpand, onRemove, onRetry }: {
  id: string; participant?: Participant; target?: DocumentSummary; delivery?: Delivery; dark: boolean;
  navigation: StudioNavigation; expanded: boolean; hidden: boolean; onExpand: () => void; onRemove: () => void; onRetry: () => void;
}) {
  const camera = useRef<ViewportView | null>(null);
  const name = agentLabel(participant?.identity.name ?? 'Unavailable agent');
  const status = participant ? agentActivity(participant) : undefined;
  const frame = delivery?.frame;
  const appearances = useMemo(() => frame ? new Map(frame.document.features.map(f => [f.id, effectiveAppearance(frame.document, f.id)])) : undefined, [frame]);
  const focus = participant && participantFocus(participant);
  const selected = frame && focus?.documentId === frame.document.documentId ? (focus.featureIds ?? []).filter(id => frame.document.features.some(f => f.id === id)) : [];
  const operation = participant?.activeWork?.[0]?.operation ?? participant?.lastAction?.operation;
  return <article className={`agent-view ${expanded ? 'expanded' : ''}`} hidden={hidden} aria-label={`Live view for ${name}`} data-agent-id={id} data-document-id={target?.documentId} data-revision={frame?.document.revision}>
    <header className="agent-view-header">
      <AgentMark id={id} size={26} /><div className="agent-view-identity"><h3 title={name}>{name}</h3><span className={`agent-state ${status?.tone ?? 'off'}`} title={status?.reported ? 'Reported by the agent' : undefined}>{status?.label ?? 'Unavailable'}</span></div>
      <button type="button" className="icon-button quiet" aria-label={`${expanded ? 'Restore grid for' : 'Expand'} ${name}`} aria-pressed={expanded} onClick={onExpand}><Icon name={expanded ? 'layers' : 'monitor'} size={15} /></button>
      <button type="button" className="icon-button quiet" aria-label={`Remove live view for ${name}`} onClick={onRemove}><Icon name="close" size={15} /></button>
    </header>
    <div className="agent-view-canvas">
      {frame && <Viewport key={frame.document.documentId} api={camera} fitOnResize evaluation={frame.evaluation} documentId={frame.document.documentId} revision={frame.document.revision}
        selected={selected} ghosts={[]} view="isometric" fitKey={0} snap={false} dark={dark} navigation={navigation} appearances={appearances}
        name={id => frame.document.features.find(f => f.id === id)?.label ?? id} onSelect={noop} onTransform={noTransform} />}
      {!frame && <div className="agent-view-empty" role="status"><Icon name={target ? 'box' : 'agent'} size={28} /><p>{!participant ? 'This agent is no longer in the project.' : !target ? focus?.documentId ? 'This agent is focused outside this project.' : 'Waiting for a part in this project.' : delivery?.error ? 'Model unavailable' : 'Preparing model…'}</p></div>}
      {frame && <button type="button" className="icon-button agent-view-fit" aria-label={`Fit model for ${name}`} onClick={() => camera.current?.fit()}><Icon name="fit" size={16} /></button>}
      {delivery?.error && <div className="agent-view-error" role="alert"><span>{frame ? 'Showing previous geometry. ' : ''}{delivery.error}</span><button type="button" className="link-button" onClick={onRetry}>Retry</button></div>}
    </div>
    <footer className="agent-view-footer"><span title={target?.name}>{target?.name ?? 'No project part in focus'}</span><span>{frame ? `r${frame.document.revision}` : ''}{delivery?.loading ? ' · Updating…' : ''}</span></footer>
    {operation && <p className="agent-view-action">{participant?.activeWork?.length ? 'Current' : 'Last command'} · {operationLabels[operation] ?? operation.replaceAll('_', ' ')}</p>}
  </article>;
}
