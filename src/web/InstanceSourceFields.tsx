import {Select} from './Select';
import { useEffect, useState } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import type { CadDocument, Feature, GeometryInfo } from '../shared/protocol';
import { pruneBindings } from '../cad/parameters';
import { xyFrame } from '../cad/modeling-presets';
import type { Evaluation } from '../cad/types';
import { useModelThumbnails } from './model-thumbnails';
import { Icon } from './icons';

type Instance = Extract<Feature, { kind: 'instance' }>;
const encode = (featureId: string, name: string) => JSON.stringify([featureId, name]);
const decode = (value: string) => { const [featureId, name] = JSON.parse(value) as [string, string]; return { featureId, name }; };

/** Source and mount selection use committed inspect results, including nested resolved frames. */
export function InstanceSourceFields({ runtime, document, feature, onChange }: { runtime: RuntimeClient; document: CadDocument; feature: Instance; onChange: (feature: Instance) => void }) {
  const editing=document.features.some(f=>f.id===feature.id);
  const documents = runtime.getSnapshot().documents.filter(d => d.documentId !== document.documentId);
  const source = documents.find(d => d.documentId === feature.params.document);
  const [query,setQuery]=useState(''),[allProjects,setAllProjects]=useState(!!source&&source.projectId!==document.projectId);
  const available=documents.filter(d=>(allProjects||d.projectId===document.projectId)&&d.features>0&&d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const projects=runtime.getSnapshot().projects;

  const [loaded, setLoaded] = useState<{ documentId: string; revision: number; results: Feature[]; geometry: GeometryInfo[]; evaluation?:Evaluation;error?: string }>();
  useEffect(() => {
    let alive = true;
    if (!source) return;
    void runtime.replay({ type: 'inspect_model', params: { documentId: source.documentId } }).then(({result,evaluation}) => {
      if (alive) setLoaded({ documentId: source.documentId, revision: result.revision ?? source.revision,
        results: result.document?.features.filter(f => result.visibleFeatureIds?.includes(f.id)) ?? [], geometry: result.geometry ?? [],
        evaluation,error: result.error?.message ?? result.health?.referenceError });
    });
    return () => { alive = false; };
  }, [runtime, source?.documentId, source?.revision, source?.storageVersion]);
  const current = loaded?.documentId === feature.params.document ? loaded : undefined;
  const update = (params: Instance['params']) => onChange(pruneBindings({ ...feature, params }) as Instance);
  const sourceMounts = current?.geometry.filter(g => current.results.some(f => f.id === g.featureId) && (!feature.params.featureId || g.featureId === feature.params.featureId))
    .flatMap(g => (g.mounts ?? []).map(m => ({ featureId: g.featureId, name: m.name }))) ?? [];
  const index = document.features.findIndex(f => f.id === feature.id);
  const earlier = index < 0 ? document.features : document.features.slice(0,index);
  const targetMounts = runtime.getSnapshot().evaluation.geometry.filter(g => earlier.some(f => f.id === g.featureId))
    .flatMap(g => (g.mounts ?? []).map(m => ({ featureId: g.featureId, name: m.name })));
  const thumbnails=useModelThumbnails(loaded?.documentId===source?.documentId?loaded?.evaluation:undefined,['isometric']);
  const attachment = feature.params.attachment;
  const choice = (m: {featureId:string;name:string}) => encode(m.featureId,m.name);
  const sourceValue = attachment ? choice(attachment.source) : '';
  const targetValue = attachment && 'featureId' in attachment.target ? choice(attachment.target) : '';
  return <>
    <details className="source-options" open={!editing}><summary>{editing?'Source options':'Source'}</summary><details className="source-replacement" open={!editing}><summary>{editing?'Replace source':'Choose source'}</summary><div className="source-chooser"><label className="outline-search"><Icon name="search" size={15}/><input aria-label="Find source part or assembly" placeholder="Find a part or assembly" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <label className="check-row"><input type="checkbox" checked={allProjects} onChange={e=>setAllProjects(e.target.checked)}/><span>Include other projects</span></label>
    <label className="select-field"><span className="field-label">Source part or assembly</span><span className="select-shell">
      <Select aria-label="Source part or assembly" value={feature.params.document} onChange={event => { const { featureId: _id, attachment: _attachment, ...params } = feature.params; update({ ...params, document: event.target.value }); }}>
        <option value="">Choose a part</option>
        {feature.params.document && !source && <option value={feature.params.document}>Missing document · {feature.params.document}</option>}
        {source&&!available.some(d=>d.documentId===source.documentId)&&<option value={source.documentId}>{source.name} · current source</option>}
        {projects.filter(p=>available.some(d=>d.projectId===p.projectId)).map(p=><optgroup key={p.projectId} label={p.name}>{available.filter(d=>d.projectId===p.projectId).map(d=><option key={d.documentId} value={d.documentId}>{d.name} · {d.kind??'part'}</option>)}</optgroup>)}
      </Select><Icon name="chevron" size={14} /></span></label>
    </div></details>
    {source&&<div className="chosen-source">{thumbnails.isometric&&<img src={thumbnails.isometric} alt={`Preview of ${source.name}`}/>}<div><b>{source.name}</b><small>{projects.find(p=>p.projectId===source.projectId)?.name} · r{current?.revision??source.revision}</small></div></div>}
    {source && <label className="select-field"><span className="field-label">Result</span><span className="select-shell">
      <Select value={feature.params.featureId ?? ''} onChange={event => { const { attachment: _attachment, ...params } = feature.params; update({ ...params, featureId: event.target.value || undefined }); }}>
        <option value="">All visible results as one part</option>
        {feature.params.featureId && !current?.results.some(f => f.id === feature.params.featureId) && <option value={feature.params.featureId}>{feature.params.featureId} · not visible</option>}
        {current?.results.map(f => <option key={f.id} value={f.id}>{f.label ?? f.id}</option>)}
      </Select><Icon name="chevron" size={14} /></span></label>}
    <p className="field-hint">{!documents.length ? 'Create and build a part first using the document menu.' : current?.error ?? (source ? `Follows the latest committed revision. Currently r${current?.revision ?? source.revision}.` : 'Choose a part, then place it numerically or attach its mount.')}</p>
    </details>
    {source&&<details className="mount-attachment" open={!!attachment}><summary>Mount attachment</summary>
    {source && <label className="check-row"><input type="checkbox" checked={!!attachment} disabled={!attachment && !sourceMounts.length} onChange={e => {
      const { attachment: _old, ...params } = feature.params;
      update(e.target.checked ? { ...params, translation:[0,0,0],origin:[0,0,0],angleDegrees:0, attachment:{source:sourceMounts[0],target:targetMounts[0]??{frame:xyFrame()},mode:'align',offset:[0,0,0],twistDegrees:0} } : params);
    }} /><span>Attach by mount</span></label>}
    {source && !attachment && !sourceMounts.length && <p className="field-hint">Add a named mount in the source part's Parameters, then return here. Inherited mounts appear on its visible result.</p>}
    {attachment && <>
      <label className="select-field"><span className="field-label">Source mount</span><Select aria-label="Source mount" value={sourceValue} onChange={e=>update({...feature.params,attachment:{...attachment,source:decode(e.target.value)}})}>
        {!sourceMounts.some(m=>choice(m)===sourceValue) && <option value={sourceValue}>Missing · {attachment.source.featureId}/{attachment.source.name}</option>}
        {sourceMounts.map(m=><option key={choice(m)} value={choice(m)}>{m.featureId} / {m.name}</option>)}
      </Select></label>
      <label className="select-field"><span className="field-label">Target mount</span><Select aria-label="Target mount" value={targetValue} onChange={e=>update({...feature.params,attachment:{...attachment,target:e.target.value?decode(e.target.value):{frame:xyFrame()}}})}>
        <option value="">Explicit world frame</option>
        {targetValue && !targetMounts.some(m=>choice(m)===targetValue) && <option value={targetValue}>Missing · {targetValue}</option>}
        {targetMounts.map(m=><option key={choice(m)} value={choice(m)}>{m.featureId} / {m.name}</option>)}
      </Select></label>
      <label className="select-field"><span className="field-label">Mount orientation</span><Select aria-label="Mount orientation" value={attachment.mode} onChange={e=>update({...feature.params,attachment:{...attachment,mode:e.target.value as 'align'|'mate'}})}><option value="align">Align axes</option><option value="mate">Mate opposing normals</option></Select></label>
      <p className="field-hint">Align matches U, V and normal. Positive twist turns right-handed about the target normal. Mate then reverses V and normal about the twisted U. Offset uses the original target axes. Attached parts use these fields instead of handles.</p>
    </>}
    </details>}
  </>;
}
