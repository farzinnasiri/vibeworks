import { countLabel } from '../shared/format';
import { useState } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import { parameterUsage } from '../cad/parameters';
import { parameterNameSchema, type CadDocument, type Edit, type Parameter } from '../shared/protocol';
import { context } from '../cad/demo';
import { NumberField, plainField } from './FeatureFields';
import { Icon } from './icons';
import { featureName } from './modeling';
import { track } from './activity';
import { PreviewReadout, usePreviewReport } from './ToolCard';
import { useLivePreview, type LivePreview } from './preview';

/** The edits that turn one parameter list into another: set new or changed values, delete removed names. */
function parameterEdits(before: Parameter[], after: Parameter[]): Edit[] {
  const sets = after.filter(p => {
    const old = before.find(b => b.name === p.name);
    return !old || old.value !== p.value || old.description !== p.description;
  }).map(p => ({ op: 'set_parameter' as const, ...p }));
  const deletes = before.filter(b => !after.some(p => p.name === b.name)).map(b => ({ op: 'delete_parameter' as const, name: b.name }));
  return [...deletes, ...sets];
}

/**
 * Named design values. Dragging or typing a value previews the whole part exactly before anything is applied;
 * Apply commits all changed values as one transaction and one undo step.
 */
export function ParametersPanel({ runtime, document, disabled, onPreview }: { runtime: RuntimeClient; document: CadDocument; disabled: boolean; onPreview: (preview?: LivePreview) => void }) {
  const [draft, setDraft] = useState<Parameter[] | null>(null);
  const [base, setBase] = useState<CadDocument | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState(10);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const from = base ?? document;
  const current = draft ?? document.parameters ?? [];
  const stale = !!draft && !!base && base.revision !== document.revision;
  const edits = draft ? parameterEdits(from.parameters ?? [], draft) : [];
  const preview = useLivePreview(runtime, from, edits.length && !stale && !pending ? edits : undefined);
  usePreviewReport(preview, [], onPreview);
  const change = (next: Parameter[]) => { if (!draft) setBase(document); setDraft(next); setError(''); };
  const discard = () => { setDraft(null); setBase(null); setError(''); };
  const apply = async () => {
    if (!edits.length || disabled || pending || stale) return;
    setPending(true); setError('');
    try {
      const result = await track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(from), edits } }));
      if (result.status === 'error') setError(result.error!.message); else discard();
    } finally { setPending(false); }
  };
  const nameProblem = !name ? '' : !parameterNameSchema.safeParse(name).success ? 'Use letters, digits and _; start with a letter.'
    : current.some(p => p.name === name) ? 'That name exists.' : '';
  const add = () => {
    if (!name || nameProblem || !Number.isFinite(value)) return;
    change([...current, { name, value }]); setName('');
  };
  const committed = runtime.getSnapshot().evaluation;
  const label = (id: string) => featureName(document.features.find(f => f.id === id)) || id;
  return <form className="parameters" aria-label="Design variables" onSubmit={event => { event.preventDefault(); void apply(); }}>
    <div className="section-heading"><h3>Design variables</h3><button type="button" className="icon-button quiet" title="Add a named dimension" aria-label="Add variable" onClick={() => setAdding(!adding)}><Icon name={adding ? 'close' : 'plus'} size={16} /></button></div>
    {!current.length && <div className="variables-empty"><Icon name="sliders" size={28} /><p>One value. Every linked dimension.</p><div className="variable-example" aria-hidden="true"><code>thickness</code><span>5 mm</span><Icon name="arrow-right" size={14} /><span>3 features</span></div><button type="button" className="ghost-button small" onClick={() => setAdding(true)}>Add a variable</button></div>}
    <details className="method"><summary>How variables work</summary><p>Name a value, then use its name in a dimension field. Changing it updates every feature that uses it. Preview before applying.</p></details>
    <fieldset className="param-list" disabled={disabled || pending || stale}>
      {current.map((parameter, i) => {
        const uses = parameterUsage(from, parameter.name);
        const users = [...new Set(uses.map(u => u.featureId))];
        const changed = !!draft && (from.parameters ?? []).find(p => p.name === parameter.name)?.value !== parameter.value;
        return <div className={`param-row ${changed ? 'changed' : ''}`} key={parameter.name}>
          <NumberField label={parameter.name} unit="" className="param-value" field={plainField(parameter.value, v => change(current.map((p, j) => j === i ? { ...p, value: v } : p)))} />
          <span className="param-uses" title={uses.length ? `Drives ${uses.map(u => `${label(u.featureId)} · ${u.path}`).join(', ')}` : 'Not used yet'}>{users.length ? countLabel(users.length, 'feature') : 'unused'}</span>
          <button type="button" className="icon-button quiet" aria-label={`Delete parameter ${parameter.name}`} title={uses.length ? 'In use: unbind its fields first' : 'Delete parameter'} disabled={uses.length > 0} onClick={() => change(current.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
          {parameter.description && <p className="param-description">{parameter.description}</p>}
        </div>;
      })}
      {adding && <div className="param-add">
        <label className="select-field"><span className="field-label">Name</span><input className="text-input mono-input" value={name} placeholder="thickness" spellCheck={false} autoComplete="off" aria-invalid={!!nameProblem} onChange={e => setName(e.target.value.trim())} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /></label>
        <NumberField label="Value" unit="" field={plainField(value, setValue)} />
        <button type="button" className="ghost-button" disabled={!name || !!nameProblem || !Number.isFinite(value)} onClick={add}><Icon name="plus" size={14} />Add</button>
      </div>}
      {nameProblem && <p className="field-hint warn-text">{nameProblem}</p>}
    </fieldset>
    {stale && <div className="notice warn" role="status"><Icon name="warning" size={16} /><span>The model changed while you were editing parameters.</span><button type="button" className="ghost-button" onClick={discard}>Reload values</button></div>}
    {error && <p role="alert" className="notice error"><Icon name="warning" size={16} /><span>{error} The committed model is unchanged.</span></p>}
    {edits.length > 0 && !error && <PreviewReadout state={preview} committed={committed.geometry.filter(g => committed.visibleFeatureIds.includes(g.featureId))} />}
    {draft && <div className="apply-bar">
      <span>{countLabel(edits.length, 'parameter change')}</span>
      <button type="button" className="ghost-button" onClick={discard}>Discard</button>
      <button type="submit" className="primary-button" disabled={!edits.length || disabled || pending || stale}>{pending ? 'Rebuilding…' : 'Apply'}<kbd>⏎</kbd></button>
    </div>}
  </form>;
}
