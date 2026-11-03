import { countLabel } from '../shared/format';
import { InstanceSourceFields } from './InstanceSourceFields';
import { AppearanceFields, lastMaterial, rememberMaterial } from './AppearanceFields';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { RuntimeClient } from '../cad/runtime';
import { context } from '../cad/demo';
import { deletionIds } from '../cad/document';
import type { CadCommand, CadDocument, Feature, GeometryInfo, Vector3 } from '../shared/protocol';
import { FeatureFields } from './FeatureFields';
import { HolePattern } from './HolePattern';
import { Icon } from './icons';
import { draftAppearance, featureCommand, featureName, toolFeature, toolSpec, type Tool } from './modeling';
import type { Edit } from '../shared/protocol';
import { track } from './activity';
import { extentsOf, totalVolume, useLivePreview, type LivePreview, type PreviewState } from './preview';
import { fmt } from './modeling';

export interface PickEvent { seq: number; point: Vector3; axis?: 'X' | 'Y' | 'Z' }
export const describeError = (error: unknown) => error instanceof z.ZodError
  ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join(' · ')
  : error instanceof Error ? error.message : String(error);

/** The exact MCP call a form would send, so humans and agents share one vocabulary. */
export function CommandPreview({ build }: { build: () => CadCommand }) {
  const [copied, setCopied] = useState(false);
  let text: string;
  try { const command = build(); text = JSON.stringify({ tool: command.type, arguments: command.params }, null, 2); }
  catch (error) { text = `// Not sendable yet: ${describeError(error)}`; }
  return <details className="command-preview"><summary><Icon name="agent" size={14} />Same call over MCP</summary>
    <pre>{text}</pre>
    <button type="button" className="ghost-button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}><Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}</button>
  </details>;
}

/**
 * Exact kernel result of the uncommitted draft compared with the committed model.
 * A failing draft says so before anything is applied.
 */
export function PreviewReadout({ state, committed }: { state: PreviewState; committed: GeometryInfo[] }) {
  const result = state.result;
  if (!state.pending && !result) return null;
  if (result?.status === 'error' && !state.pending) return <div className="preview-readout fail" role="status">
    <Icon name="warning" size={15} /><span><b>Applying this would fail.</b> {result.error!.message}<details><summary>Measured failure · {result.error!.code}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(result.error!.details,(key,value)=>['candidate','outline','previewLines','patches'].includes(key)?undefined:value,2)?.slice(0,8000)}</pre></details></span>
  </div>;
  const before = totalVolume(committed), after = totalVolume(result?.geometry);
  const delta = after - before;
  const extents = extentsOf(result?.geometry);
  return <div className={`preview-readout ${state.pending ? 'pending' : 'ready'}`} role="status" aria-live="polite">
    <span className="preview-tag">{state.pending ? <><span className="spinner" />Computing exact preview</> : <><Icon name="check" size={13} />Exact preview · not applied</>}</span>
    {result?.status === 'success' && <dl>
      <div><dt>Volume</dt><dd>{fmt(after, 1)}<small>mm³</small>{Math.abs(delta) > 1e-6 && <span className={`delta ${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? '+' : '−'}{fmt(Math.abs(delta), 1)}{before > 0 && ` · ${fmt(Math.abs(delta) / before * 100, 1)}%`}</span>}</dd></div>
      {extents && <div><dt>Extents</dt><dd className="xyz-readout">{extents.map((v, i) => <span key={i} className={`axis-${'xyz'[i]}`}>{fmt(v, 2)}</span>)}<small>mm</small></dd></div>}
    </dl>}
    {result?.status === 'success' && result.warnings.filter(w => !w.startsWith('Dry run')).map(w => <p key={w} className="field-hint warn-text">{w}</p>)}
  </div>;
}

/** Report a preview evaluation upward while mounted, and clear it when the form goes away. */
export function usePreviewReport(state: PreviewState, focus: string[], onPreview?: (preview?: LivePreview) => void) {
  const focusKey = focus.join(',');
  useEffect(() => { onPreview?.(state.evaluation ? { evaluation: state.evaluation, focus } : undefined); }, [state.evaluation, focusKey]);
  useEffect(() => () => onPreview?.(undefined), []);
}

const GIZMO_TOOLS: Tool[] = ['move', 'rotate', 'scale'];

/** Picked edges for a fillet or chamfer: the points that select them, and the switch for clicking more in the viewport. */
function EdgePicker({ points, picking, onPicking, onPoints }: { points: Vector3[]; picking: boolean; onPicking: (on: boolean) => void; onPoints: (points: Vector3[]) => void }) {
  return <div className="edge-picker">
    <button type="button" className={picking ? 'primary-button' : 'ghost-button'} aria-pressed={picking} onClick={() => onPicking(!picking)}><Icon name="target" size={14} />{picking ? 'Done picking' : 'Pick edges in the viewport'}</button>
    {points.length ? <ol>{points.map((p, i) => <li key={i}><span className="mono-small">near {p.map(v => fmt(v, 2)).join(', ')}</span><button type="button" className="icon-button quiet" aria-label={`Remove picked edge ${i + 1}`} onClick={() => onPoints(points.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button></li>)}</ol>
      : <p className="field-hint warn-text">No edges picked yet. Click edges of the part; each click selects the edges passing near that point.</p>}
  </div>;
}

export function ToolCard({ runtime, document, geometry, tool, disabled, pick, onDone, onDraft, onPreview, edgePicking = false, onEdgePicking }: {
  runtime: RuntimeClient; document: CadDocument; geometry: GeometryInfo[]; tool: Tool; disabled: boolean;
  pick?: PickEvent; onDone: (created?: string[]) => void; onDraft?: (feature?: Feature) => void; onPreview?: (preview?: LivePreview) => void;
  edgePicking?: boolean; onEdgePicking?: (on: boolean) => void;
}) {
  const spec = toolSpec(tool);
  // Values and context come from the revision at opening; a newer revision requires a refresh.
  const [base, setBase] = useState(document);
  const [feature, setFeature] = useState(() => toolFeature(tool, document, geometry, lastMaterial(runtime)));
  const [cascade, setCascade] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const picked = useRef(0);
  const lastPick = useRef(pick?.seq ?? 0);
  const stale = document.revision !== base.revision;
  const needsSource=feature?.kind==='instance'&&!feature.params.document;
  const refresh = () => { setBase(document); setFeature(toolFeature(tool, document, geometry, lastMaterial(runtime))); setError(''); picked.current = 0; };
  useEffect(() => { onDraft?.(feature); }, [feature]);
  useEffect(() => () => onDraft?.(undefined), []);
  useEffect(() => {
    if (!pick || pick.seq === lastPick.current) return;
    lastPick.current = pick.seq;
    setFeature(current => {
      if ((current?.kind === 'fillet' || current?.kind === 'chamfer') && typeof current.params.edges === 'object') {
        const near = [...(current.params.edges.near ?? []), pick.point].slice(0, 64);
        return { ...current, params: { ...current.params, edges: { ...current.params.edges, near } } } as Feature;
      }
      if (current?.kind !== 'drill_holes') return current;
      const axis = pick.axis ?? current.params.axis;
      const restart = picked.current === 0 || axis !== current.params.axis;
      const centers = restart ? [pick.point] : [...current.params.centers, pick.point].slice(0, 32);
      picked.current = centers.length;
      return { ...current, params: { ...current.params, axis, centers } };
    });
  }, [pick]);
  const removing = tool === 'delete' ? deletionIds(base, base.selectedFeatureIds, true) : [];
  const dependents = removing.filter(id => !base.selectedFeatureIds.includes(id));
  const name = (id: string) => featureName(base.features.find(f => f.id === id)) || id;
  const build = (): CadCommand => tool === 'delete'
    ? { type: 'apply_edits', params: { ...context(base), edits: [{ op: 'delete', featureIds: base.selectedFeatureIds, cascade }] } }
    : featureCommand(base, feature!, base.features.some(f => f.id === feature!.id));
  const apply = async () => {
    if (disabled || stale || pending || needsSource) return;
    setError(''); setPending(true);
    try {
      const command = build();
      const result = await track(command.type, () => runtime.execute(command));
      if (result.status === 'error') { setError(result.error!.message); return; }
      onDone(result.created);
    } catch (error) { setError(describeError(error)); }
    finally { setPending(false); }
  };
  // Handles already preview transforms directly; every other tool previews its exact result.
  const edits: Edit[] | undefined = stale || needsSource || (GIZMO_TOOLS.includes(tool) && !(feature?.kind === 'instance' && feature.params.attachment)) ? undefined
    : tool === 'delete' ? base.selectedFeatureIds.length && (cascade || !dependents.length) ? [{ op: 'delete', featureIds: base.selectedFeatureIds, cascade }] : undefined
    : feature ? [{ op: base.features.some(f => f.id === feature.id) ? 'update' : 'add', feature }] : undefined;
  const preview = useLivePreview(runtime, base, edits);
  usePreviewReport(preview, feature ? [feature.id] : [], onPreview);
  const committed = runtime.getSnapshot().evaluation;
  const submitLabel = tool === 'delete' ? `Delete ${cascade ? removing.length : base.selectedFeatureIds.length}` : tool === 'duplicate' ? 'Create copy' : `Apply ${spec.label.toLowerCase()}`;
  return <section className="tool-card" aria-label={`${spec.label} tool`}>
    <header className="card-head">
      <span className="tool-glyph"><Icon name={spec.icon} size={20} /></span>
      <div><h2>{spec.label}</h2><p>{spec.hint}</p></div>
      <button className="icon-button quiet" type="button" aria-label="Close tool" title="Close · Esc" onClick={() => onDone()}><Icon name="close" size={16} /></button>
    </header>
    {stale && <div className="notice warn" role="status"><Icon name="warning" size={16} /><span>The model changed since this tool opened{tool === 'delete' ? '' : ' (maybe by an agent)'}. Refresh to work from revision {document.revision}.</span><button type="button" className="ghost-button" onClick={refresh}>Refresh</button></div>}
    {tool === 'drill_holes' && !stale && <div className="notice pick" role="status"><Icon name="target" size={16} /><span>Click faces of <b>{name(base.selectedFeatureIds[0] ?? '')}</b> to place holes. Each one drills straight through along the face's axis.</span></div>}
    <form className="card-body" onSubmit={event => { event.preventDefault(); void apply(); }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void apply(); } }}>
      <fieldset disabled={disabled || stale || pending} className="fields">
        {feature?.kind==='instance'&&needsSource&&<div className="insertion-start"><h3>Choose a source</h3><p className="field-hint">Select the part or assembly to place. Nothing is inserted until you apply the preview.</p><InstanceSourceFields runtime={runtime} document={base} feature={feature} onChange={setFeature}/></div>}
        {feature && !needsSource && <FeatureFields runtime={runtime} feature={feature} document={base} onChange={setFeature} mode={tool} showName={false}
          extra={feature.kind === 'drill_holes' ? change => <HolePattern feature={feature} geometry={geometry} onCenters={centers => change({ centers })} />
            : (feature.kind === 'fillet' || feature.kind === 'chamfer') && typeof feature.params.edges === 'object' && feature.params.edges.near !== undefined
              ? change => <EdgePicker points={(feature.params as { edges: { near?: Vector3[] } }).edges.near ?? []} picking={edgePicking} onPicking={on => onEdgePicking?.(on)} onPoints={near => change({ edges: { ...(feature.params as { edges: object }).edges, near } })} />
              : undefined} />}
        {feature && !needsSource && <details className="appearance inspector-disclosure" aria-label="Appearance">
          <summary>{feature.kind === 'instance' ? 'Appearance override' : 'Appearance'}</summary>
          <AppearanceFields value={draftAppearance(feature, base, geometry)} noneLabel={feature.kind === 'instance' ? 'Use part material' : 'None (neutral)'} onChange={appearance => {
            rememberMaterial(runtime, appearance.material);
            setFeature({ ...feature, appearance });
          }} />
          {feature.kind === 'instance' && feature.appearance && <button type="button" className="link-button" onClick={() => { const { appearance: _own, ...rest } = feature; setFeature(rest); }}>Use part appearance</button>}
        </details>}
        {tool === 'delete' && <>
          <p className="lede">Delete {base.selectedFeatureIds.length === 1 ? <b>{name(base.selectedFeatureIds[0])}</b> : countLabel(base.selectedFeatureIds.length, 'feature')}?</p>
          {dependents.length > 0 ? <div className="dependents">
            <p><Icon name="warning" size={15} />{countLabel(dependents.length, 'later feature depends', 'later features depend')} on this:</p>
            <ul>{dependents.map(id => <li key={id}>{name(id)}</li>)}</ul>
            <label className="check-row"><input type="checkbox" checked={cascade} onChange={e => setCascade(e.target.checked)} /><span>Also delete the dependent features</span></label>
          </div> : <p className="field-hint">Nothing else depends on this selection.</p>}
          <p className="field-hint">Undo restores deleted features. Deleting a result can reveal the construction inputs it consumed.</p>
        </>}
      </fieldset>
      {error && <p role="alert" className="notice error"><Icon name="warning" size={16} /><span>{error} The committed model is unchanged.</span></p>}
      {!error && <PreviewReadout state={preview} committed={committed.geometry.filter(g => committed.visibleFeatureIds.includes(g.featureId))} />}
      <details className="tool-advanced"><summary>Names and command details</summary><label className="id-field"><span>Feature ID</span>{feature ? <input value={feature.id} onChange={e => setFeature({ ...feature, id: e.target.value })} disabled={disabled || stale || pending} spellCheck={false} aria-label="New feature ID" /> : <code>{base.selectedFeatureIds.join(', ')}</code>}</label>
      {feature && <label className="id-field"><span>Name</span><input value={feature.label ?? ''} placeholder="Optional" maxLength={120} onChange={e => setFeature({ ...feature, label: e.target.value || undefined })} disabled={disabled || stale || pending} /></label>}
      <CommandPreview build={build} /></details>
      <div className="card-actions">
        <button type="button" className="ghost-button" onClick={() => onDone()}>Cancel</button>
        <button className={tool === 'delete' ? 'danger-button' : 'primary-button'} disabled={disabled || stale || pending || needsSource || (tool === 'delete' ? !base.selectedFeatureIds.length || (!!dependents.length && !cascade) : !feature)} type="submit">{pending ? 'Computing…' : submitLabel}<kbd>⏎</kbd></button>
      </div>
    </form>
  </section>;
}
