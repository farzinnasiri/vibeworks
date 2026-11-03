import { selectSurface, useSurfaceSelection } from './surface-selection';
import {Select} from './Select';
import { countLabel, massLabel } from '../shared/format';
import { AppearanceFields, rememberMaterial } from './AppearanceFields';
import { SurfaceGraphicsFields } from './SurfaceGraphicsFields';
import { useEffect,useState,useRef } from 'react';
import {getAppearanceFeedback,setAppearanceFeedback} from './appearance-feedback';
import {dialogs} from './Dialogs';
import './inspector.css';
import type { RuntimeClient, RuntimeState } from '../cad/runtime';
import { effectiveAppearance, references } from '../cad/document';
import { context } from '../cad/demo';
import { FINISHES, materialById } from '../shared/materials';
import type { Appearance, CadDocument, Feature, GeometryInfo, Vector3 } from '../shared/protocol';
import { FeatureFields } from './FeatureFields';
import { HolePattern } from './HolePattern';
import { Icon } from './icons';
import { featureCommand, featureName, fmt, kindIcons, kindLabels } from './modeling';
import { track } from './activity';
import { CommandPreview, PreviewReadout, describeError, usePreviewReport } from './ToolCard';
import { useLivePreview, type LivePreview } from './preview';
import { AnalysisPanel } from './AnalysisPanel';

/**
 * Material, color and finish for one feature. A feature without its own appearance shows the one it inherits
 * from the part it was built from. A display preview commits as one undoable edit.
 */
function AppearanceEditor({ feature, document, runtime, disabled, resolvedAppearance, mixed = [] }: { mixed?: (keyof Appearance)[]; resolvedAppearance?: Appearance; feature: Feature; document: CadDocument; runtime: RuntimeClient; disabled: boolean }) {
  const [saving,setSaving]=useState(false),[error,setError]=useState<string>();
  const [draft,setDraft]=useState<Appearance>(),[base,setBase]=useState<CadDocument>();
  const effective=resolvedAppearance??effectiveAppearance(document,feature.id)??{};
  const value=draft??{...effective,...feature.appearance};
  const stale=!!base&&base.revision!==document.revision;
  useEffect(()=>{setAppearanceFeedback({documentId:document.documentId,featureId:feature.id,appearance:draft});return()=>setAppearanceFeedback(undefined);},[document.documentId,feature.id,draft]);
  const change=(appearance:Appearance)=>{if(!base)setBase(document);setDraft(appearance);setError(undefined);};
  const discard=()=>{setDraft(undefined);setBase(undefined);setError(undefined);};
  const reset=async()=>{setSaving(true);setError(undefined);const {appearance:_old,...rest}=feature;
    try{const result=await track('apply_edits',()=>runtime.execute({type:'apply_edits',params:{...context(document),edits:[{op:'update',feature:rest as Feature}]}}));if(result.status==='error')setError(result.error?.message);else discard();}catch(error){setError(describeError(error));}finally{setSaving(false);}
  };
  const apply=async()=>{
    if(!draft||!base||stale||saving)return;
    setSaving(true);setError(undefined);
    // Instances override only changed fields, retaining each source piece's other properties.
    const changed=Object.fromEntries((['material','color','finish','detail','graphics'] as const).filter(key=>draft[key]!==effective[key]).map(key=>[key,draft[key]]));
    const appearance=feature.kind==='instance'?{...feature.appearance,...changed}:draft;
    const {appearance:_old,...rest}=feature;
    const next={...rest,...(Object.keys(appearance).length?{appearance}:{})} as Feature;
    try{const result=await track('apply_edits',()=>runtime.execute({type:'apply_edits',params:{...context(base),edits:[{op:'update',feature:next}]}}));
      if(result.status==='error')setError(result.error?.message);else{rememberMaterial(runtime,appearance.material);discard();}
    }catch(error){setError(describeError(error));}finally{setSaving(false);}
  };
  return <section className="appearance" aria-label="Appearance">
    <p className="appearance-scope">{feature.kind==='instance'?'Changes this component only.':'Changes this feature.'} {draft?'Previewing unsaved appearance.':'Material and color'}</p>
    <AppearanceFields mixed={draft?[]:mixed} value={value} disabled={disabled||saving||stale} noneLabel={feature.kind==='instance'?'Inherit from source':'None (neutral)'} onChange={change}/>
    {feature.appearance&&<button type="button" className="link-button" disabled={disabled||saving||!!draft} onClick={()=>void reset()}>{feature.kind==='instance'?'Use source appearance':'Reset appearance'}</button>}
    <label className="select-field"><span className="field-label">Finish</span><Select aria-label="Finish" disabled={disabled||saving||stale} value={value.finish??''} onChange={event=>change({...value,finish:(event.target.value||undefined) as Appearance['finish']})}>
      <option value="">Material default</option>{FINISHES.map(finish=><option key={finish} value={finish}>{finish[0].toUpperCase()+finish.slice(1)}</option>)}
    </Select></label>
    <details className="appearance-advanced"><summary>Surface detail and graphics</summary>
      <label className="select-field"><span className="field-label">Surface detail</span><Select aria-label="Surface detail" disabled={disabled||saving||stale} value={value.detail??''} onChange={event=>change({...value,detail:(event.target.value||undefined) as Appearance['detail']})}>
        <option value="">Material default</option><option value="plain">Plain</option><option value="carbon">Carbon weave</option><option value="rubber">Rubber grain</option><option value="brushed">Brushed</option>
      </Select></label>
      {feature.kind!=='instance'&&<SurfaceGraphicsFields value={value.graphics} bounds={runtime.getSnapshot().evaluation.geometry.find(g=>g.featureId===feature.id)?.bounds} disabled={disabled||saving||stale} onChange={async graphics=>{change({...value,graphics});return true;}}/>}
    </details>
    {stale&&<p className="field-error" role="alert">This design changed. Discard this preview before editing again.</p>}
    {error&&<p className="field-error" role="alert">{error}</p>}
    {draft&&<div className="apply-bar"><span>Unsaved appearance</span><button type="button" className="ghost-button" disabled={saving} onClick={discard}>Cancel</button><button type="button" className="primary-button" disabled={disabled||saving||stale} onClick={()=>void apply()}>{saving?'Saving…':'Apply appearance'}</button></div>}
  </section>;
}

function Metrics({ info, busy, stale }: { info: GeometryInfo; busy: boolean; stale?: boolean }) {
  return <>
    <div className={`validity ${busy ? 'pending' : info.valid ? 'valid' : 'invalid'}`} role="status">
      <Icon name={busy ? 'rotate' : info.valid ? 'check' : 'warning'} size={14} />
      {stale ? 'Showing previous geometry · assembly references need repair' : busy ? 'Rebuilding · showing last committed result' : info.resultKind==='sheet'?'Construction sheet · not a physical solid': info.valid ? `Valid solid${info.solidCount > 1 ? `s × ${info.solidCount}` : ''} · exact OCCT check` : 'Validation failed'}
    </div>
    <dl className="metric-grid">
      <div className="span-2"><dt>Bounding size</dt><dd className="xyz-readout">{info.bounds.size.map((v, i) => <span key={i} className={`axis-${'xyz'[i]}`}>{fmt(v, 2)}</span>)}<small>mm</small></dd></div>
      <div><dt>Volume</dt><dd>{fmt(info.volumeMm3, 1)}<small>mm³</small></dd></div>
      <div><dt>Surface</dt><dd>{fmt(info.surfaceAreaMm2 ?? 0, 1)}<small>mm²</small></dd></div>
      {info.massG !== undefined && <div className="span-2"><dt>Mass · {materialById(info.material)?.name}</dt><dd>{massLabel(info.massG).value}<small>{massLabel(info.massG).unit}</small></dd></div>}
      <div><dt>Min corner</dt><dd className="mono-small">{info.bounds.min.map(v => fmt(v, 2)).join(', ')}</dd></div>
      <div><dt>Topology</dt><dd className="mono-small">{info.faceCount === undefined ? '– faces' : countLabel(info.faceCount, 'face')} · {info.edgeCount === undefined ? '– edges' : countLabel(info.edgeCount, 'edge')}</dd></div>
    </dl>
    {!!info.mounts?.length && <details className="method"><summary>Available mounts · {info.mounts.length}</summary><dl>{info.mounts.map(m=><div key={m.name}><dt><code>{m.name}</code></dt><dd className="mono-small">Origin {m.frame.origin.map(v=>fmt(v,2)).join(', ')}<br />U {m.frame.xDirection.map(v=>fmt(v,3)).join(', ')} · Normal {m.frame.normal.map(v=>fmt(v,3)).join(', ')}</dd></div>)}</dl></details>}
    {info.diagnostics&&<details className="method"><summary>Shaping measurements</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(info.diagnostics,(k,v)=>['outline','previewLines','vertices','patches'].includes(k)?undefined:v,2)}</pre></details>}
    <details className="method"><summary>How this is measured</summary><p>{info.validationMethod}. Mesh watertightness is not independently checked.</p></details>
  </>;
}

function ParameterEditor({ feature, document, runtime, disabled, onPreview }: { feature: Feature; document: CadDocument; runtime: RuntimeClient; disabled: boolean; onPreview?: (preview?: LivePreview) => void }) {
  // Fields follow the live document until the first change; the draft then pins that revision.
  const [draft, setDraft] = useState<Feature | null>(null);
  const [base, setBase] = useState<CadDocument | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const stale = !!draft && !!base && base.revision !== document.revision;
  const change = (next: Feature) => { if (!draft) setBase(document); setDraft(next); setError(''); };
  const discard = () => { setDraft(null); setBase(null); setError(''); setResetEpoch(epoch => epoch + 1); };
  const preview = useLivePreview(runtime, base ?? document, draft && !stale && !pending ? [{ op: 'update', feature: draft }] : undefined);
  usePreviewReport(preview, [feature.id], onPreview);
  const committed = runtime.getSnapshot().evaluation;
  const apply = async () => {
    if (!draft || !base || disabled || pending || stale) return;
    setPending(true); setError('');
    try {
      const command = featureCommand(base, draft, true);
      const result = await track('apply_edits', () => runtime.execute(command));
      if (result.status === 'error') setError(result.error!.message); else discard();
    } catch (error) { setError(describeError(error)); }
    finally { setPending(false); }
  };
  return <form className="parameter-form" aria-label="Parameters" onSubmit={event => { event.preventDefault(); void apply(); }}>
    <fieldset disabled={disabled || pending || stale} className="fields">
      <FeatureFields key={resetEpoch} runtime={runtime} feature={draft ?? feature} document={base ?? document} onChange={change}
        extra={(draft ?? feature).kind === 'drill_holes' ? set => <HolePattern feature={(draft ?? feature) as Extract<Feature, { kind: 'drill_holes' }>} geometry={runtime.getSnapshot().evaluation.geometry} onCenters={centers => set({ centers })} /> : undefined} />
    </fieldset>
    {stale && <div className="notice warn" role="status"><Icon name="warning" size={16} /><span>The model changed while you were editing. Your values were based on revision {base!.revision}.</span><button type="button" className="ghost-button" onClick={discard}>Reload values</button></div>}
    {error && <p role="alert" className="notice error"><Icon name="warning" size={16} /><span>{error} The committed model is unchanged.</span></p>}
    {draft && !error && <PreviewReadout state={preview} committed={committed.geometry.filter(g => committed.visibleFeatureIds.includes(g.featureId))} />}
    {draft && <CommandPreview build={() => featureCommand(base!, draft, true)} />}
    {draft && <div className="apply-bar">
      <span>Unsaved change</span>
      <button type="button" className="ghost-button" onClick={discard}>Discard</button>
      <button type="submit" className="primary-button" disabled={disabled || pending || stale}>{pending ? 'Rebuilding…' : 'Apply'}<kbd>⏎</kbd></button>
    </div>}
  </form>;
}

function RegionPaint({runtime,document,pick,face,disabled,onPreview,onBack}:{runtime:RuntimeClient;document:CadDocument;pick:import('../shared/protocol').SurfacePick;face:import('../shared/protocol').TopologyTable['faces'][number];disabled:boolean;onPreview?:(preview?:LivePreview)=>void;onBack:()=>void}){
 const feature=document.features.find(f=>f.id===pick.feature)!;
 const existing=feature.paintRegions??[];
 const [id,setId]=useState('paint_region'),[color,setColor]=useState('#ee5500'),[kind,setKind]=useState<'plane'|'crest'|'iso'>('plane');
 const [axis,setAxis]=useState<'X'|'Y'|'Z'>('Z'),[extreme,setExtreme]=useState<'X'|'Y'|'Z'>('Y'),[toward,setToward]=useState<'positive'|'negative'>('positive');
 const [from,setFrom]=useState('0'),[to,setTo]=useState('40'),[offset,setOffset]=useState(String(face.center[0])),[active,setActive]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [base]=useState(document);
 const vector=(name:string)=>[name==='X'?1:0,name==='Y'?1:0,name==='Z'?1:0] as Vector3;
 const target={feature:pick.feature,path:pick.path,select:{faces:face.lineage,fragments:'all' as const},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples,normal:face.normal}};
 const keep:import('../shared/protocol').PaintRegion['keep']=kind==='plane'?[{side:{plane:{origin:[Number(offset),0,0],normal:[toward==='positive'?1:-1,0,0]}}}]:kind==='iso'?[{iso:{u:[Number(from),Number(to)]}}]:[{crest:{axis:vector(axis),fromMm:Number(from),toMm:Number(to),extreme:vector(extreme),toward,toleranceMm:0.05}}];
 const edit:import('../shared/protocol').Edit={op:'appearance',target:{feature:pick.feature,select:{all:true}},regions:{upsert:[{id,target,keep,look:{color}}]}};
 const preview=useLivePreview(runtime,base,active?[edit]:undefined);usePreviewReport(preview,[pick.feature],onPreview);
 const apply=async()=>{setSaving(true);setError('');try{const result=await runtime.execute({type:'apply_edits',params:{...context(base),expectedStorageVersion:pick.storageVersion,edits:[edit]}});if(result.status==='error')setError(result.error!.message);else selectSurface();}catch(e){setError(describeError(e));}finally{setSaving(false);}};
 const load=(region:import('../shared/protocol').PaintRegion)=>{setId(region.id);setColor(region.look.color??'#ee5500');const predicate=region.keep[0];if('crest'in predicate){setKind('crest');const c=predicate.crest;setAxis('XYZ'[c.axis.findIndex(v=>v!==0)] as 'X'|'Y'|'Z');setExtreme('XYZ'[c.extreme.findIndex(v=>v!==0)] as 'X'|'Y'|'Z');setFrom(String(c.fromMm));setTo(String(c.toMm));setToward(c.toward);}else if('iso'in predicate){setKind('iso');setFrom(String(predicate.iso.u?.[0]??0));setTo(String(predicate.iso.u?.[1]??1));}else{setKind('plane');setOffset(String(predicate.side.plane.origin[0]));}setActive(false);};
 return <section aria-label="Paint region"><h3>Paint region</h3><p className="field-hint">{pick.path.length?'Paint applies to this placed occurrence. Edit the source to change every placement.':'Paint applies to this source result.'}</p><p className="field-hint">Display paint preserves the solid and mass. A crest is a numerical curve on the exact face. The triangular boundary is a display approximation, with 0.05 mm crest chord tolerance.</p>
 {!!existing.length&&<div role="group" aria-label="Existing regions">{existing.map(r=><button type="button" key={r.id} className="ref-chip" onClick={()=>load(r)}>{r.id}</button>)}</div>}
 <label className="select-field"><span>Region name</span><input aria-label="Region name" value={id} onChange={e=>{setId(e.target.value);setActive(true);}}/></label>
 <label className="select-field"><span>Boundary</span><Select aria-label="Region boundary" value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setActive(false);}}><option value="plane">Plane side</option><option value="crest">Section crest</option><option value="iso">UV interval</option></Select></label>
 {kind==='plane'?<label className="select-field"><span>X position (mm)</span><input aria-label="Region plane position" type="number" value={offset} onChange={e=>{setOffset(e.target.value);setActive(true);}}/></label>:<>
 {kind==='crest'&&<><label className="select-field"><span>Station axis</span><Select aria-label="Crest station axis" value={axis} onChange={e=>{setAxis(e.target.value as typeof axis);setActive(false);}}>{['X','Y','Z'].map(a=><option key={a}>{a}</option>)}</Select></label><label className="select-field"><span>Maximum direction</span><Select aria-label="Crest maximum direction" value={extreme} onChange={e=>{setExtreme(e.target.value as typeof extreme);setActive(false);}}>{['X','Y','Z'].map(a=><option key={a}>{a}</option>)}</Select></label></>}
 <label className="select-field"><span>From {kind==='crest'?'(mm)':'(0–1)'}</span><input aria-label="Region from" type="number" value={from} onChange={e=>{setFrom(e.target.value);setActive(true);}}/></label><label className="select-field"><span>To {kind==='crest'?'(mm)':'(0–1)'}</span><input aria-label="Region to" type="number" value={to} onChange={e=>{setTo(e.target.value);setActive(true);}}/></label></>}
 <label className="select-field"><span>Side</span><Select aria-label="Region side" value={toward} onChange={e=>{setToward(e.target.value as typeof toward);setActive(true);}}><option value="positive">Positive</option><option value="negative">Negative</option></Select></label>
 <label className="select-field"><span>Region color</span><input aria-label="Region color" type="color" value={color} onChange={e=>{setColor(e.target.value);setActive(true);}}/></label>
 <PreviewReadout state={preview} committed={runtime.getSnapshot().evaluation.geometry}/>
 {error&&<p role="alert" className="field-error">{error}</p>}
 <div className="apply-bar"><button type="button" className="ghost-button" onClick={()=>{setActive(false);onBack();}}>Cancel region</button>{!active?<button type="button" className="primary-button" disabled={disabled||saving} onClick={()=>setActive(true)}>Preview region</button>:<button type="button" className="primary-button" disabled={disabled||saving||preview.pending||preview.result?.status!=='success'} onClick={()=>void apply()}>Apply region paint</button>}</div>
 </section>;
}

function FacePaint({runtime,document,pick,face,disabled,onPreview}:{runtime:RuntimeClient;document:CadDocument;pick:import('../shared/protocol').SurfacePick;face:import('../shared/protocol').TopologyTable['faces'][number];disabled:boolean;onPreview?:(preview?:LivePreview)=>void}){
  const [region,setRegion]=useState(false);
  const [color,setColor]=useState<string>(),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const [base]=useState(document);
  const target={feature:pick.feature,path:pick.path,select:{faces:face.lineage,fragments:'all' as const},signature:{surface:face.surface,areaMm2:face.areaMm2,shapeSamples:face.shapeSamples,normal:face.normal}};
  const edit:import('../shared/protocol').Edit={op:'appearance',target,set:{color}};
  const preview=useLivePreview(runtime,base,color?[edit]:undefined);
  usePreviewReport(preview,[pick.feature],onPreview);
  const apply=async()=>{setSaving(true);setError('');try{const result=await runtime.execute({type:'apply_edits',params:{...context(base),expectedStorageVersion:pick.storageVersion,edits:[edit]}});if(result.status==='error')setError(result.error!.message);else{setColor(undefined);selectSurface();}}catch(error){setError(describeError(error));}finally{setSaving(false);}};
  if(region)return <RegionPaint runtime={runtime} document={document} pick={pick} face={face} disabled={disabled} onPreview={onPreview} onBack={()=>setRegion(false)}/>;
  return <section aria-label="Paint face"><button type="button" className="ghost-button" onClick={()=>{setColor(undefined);setRegion(true);}}>Paint region</button><label className="select-field"><span className="field-label">Face color</span><input aria-label="Face color" type="color" value={color??'#458df0'} disabled={disabled||saving} onChange={e=>setColor(e.target.value)}/></label>
    {color&&<><PreviewReadout state={preview} committed={runtime.getSnapshot().evaluation.geometry.filter(g=>runtime.getSnapshot().evaluation.visibleFeatureIds.includes(g.featureId))}/><div className="apply-bar"><button type="button" className="ghost-button" onClick={()=>setColor(undefined)}>Cancel paint</button><button type="button" className="primary-button" disabled={disabled||saving||preview.pending||preview.result?.status!=='success'} onClick={()=>void apply()}>Apply face paint</button></div></>}
    {error&&<p role="alert" className="field-error">{error}</p>}
  </section>;
}

export function Inspector({ runtime, state, disabled, agentTouched, onSelect, onPreview, onOpenPart }: {
  runtime: RuntimeClient; state: RuntimeState; disabled: boolean; agentTouched: Map<string, number>;
  onOpenPart: (id: string) => void; onSelect: (ids: string[]) => void; onPreview?: (preview?: LivePreview) => void;
}) {
  const faceSelection=useSurfaceSelection();
  const faceHeading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{faceHeading.current?.focus();},[faceSelection]);
  const doc = state.document, evaluation = state.evaluation;
  const byId = (id: string) => doc.features.find(f => f.id === id);
  const name = (id: string) => featureName(byId(id)) || id;
  const selected = doc.selectedFeatureIds;
  const [copied, setCopied] = useState(false);
  const [tab,setTab]=useState<'appearance'|'shape'|'measurements'>('appearance');
  useEffect(()=>{setTab('appearance');},[doc.documentId,selected.join(',')]);
  const chip = (id: string) => <button key={id} type="button" className="ref-chip" disabled={disabled} onClick={() => onSelect([id])}>{name(id)}</button>;

  if(faceSelection&&faceSelection.documentId===doc.documentId&&faceSelection.displayKey===evaluation.displayKey&&selected.includes(faceSelection.feature)){
    const mesh=evaluation.meshes.find(m=>m.featureId===faceSelection.feature&&JSON.stringify(m.occurrencePath?.slice(1)??[])===JSON.stringify(faceSelection.path));
    const face=mesh?.topology?.faces[faceSelection.faceIndex];
    if(face)return <section className="inspector-card" aria-label="Face details"><header className="card-head"><span className="tool-glyph"><Icon name="box" size={20}/></span><div><h2 ref={faceHeading} tabIndex={-1}>Face</h2><p>{[faceSelection.feature,...faceSelection.path].join(' / ')}</p></div></header><div className="card-body">
      <p>{face.lineage.join(', ')||'Surface reference unsupported for this operation'}</p>
      <dl className="metric-grid"><div><dt>Surface</dt><dd>{face.surface}</dd></div><div><dt>Area</dt><dd>{fmt(face.areaMm2,3)} mm²</dd></div></dl>
      <p className="field-hint">Source {mesh?.source?.featureId} · revision {mesh?.source?.revision}. Face indices belong to this display only.</p>
      {!!face.lineage.length&&<FacePaint key={`${faceSelection.displayKey}/${faceSelection.faceIndex}`} runtime={runtime} document={doc} pick={faceSelection} face={face} disabled={disabled} onPreview={onPreview}/>}
      <h3>Neighbouring faces</h3><div role="group" aria-label="Neighbouring faces">{face.neighbours.map(i=><button key={i} type="button" className="ref-chip" onClick={()=>{const next=mesh!.topology!.faces[i];selectSurface({...faceSelection,faceIndex:i},{feature:faceSelection.feature,path:faceSelection.path,select:{faces:next.lineage,fragments:'one'},signature:{surface:next.surface,areaMm2:next.areaMm2,shapeSamples:next.shapeSamples,normal:next.normal}});}}>{mesh?.topology?.faces[i].lineage.join(', ')||`Face ${i+1}`}</button>)}</div>
      <button type="button" className="ghost-button" onClick={()=>selectSurface()}>Return to component</button>
    </div></section>;
  }
  if (selected.length === 1 && byId(selected[0])) {
    const feature = byId(selected[0])!;
    const info = evaluation.geometry.find(g => g.featureId === feature.id);
    const visible = evaluation.visibleFeatureIds.includes(feature.id);
    const uses = references(feature);
    const usedBy = doc.features.filter(f => references(f).includes(feature.id)).map(f => f.id);
    return <section className="inspector-card" aria-label="Inspector">
      <header className="card-head">
        <span className="tool-glyph"><Icon name={kindIcons[feature.kind]} size={20} /></span>
        <div>
          <h2>{featureName(feature)}</h2>
          <p>{feature.kind==='instance'?'Component':kindLabels[feature.kind]} · {doc.name}</p><details className="object-identity"><summary>Identifier</summary><button type="button" className="id-copy" title="Copy feature ID" onClick={() => { void navigator.clipboard?.writeText(feature.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>{copied ? 'copied' : `id ${feature.id}`}</button></details>
        </div>
        <button className="icon-button quiet" type="button" aria-label="Clear selection" title="Clear selection · Esc" disabled={disabled} onClick={() => onSelect([])}><Icon name="close" size={16} /></button>
      </header>
      <div className="card-body">
        {feature.kind==='instance'&&<div className="source-context"><span>Source</span><strong>{evaluation.instances?.find(i=>i.featureId===feature.id)?.name??state.documents.find(d=>d.documentId===feature.params.document)?.name??'Missing source'}</strong><button type="button" className="ghost-button" disabled={disabled} title="Edit the reusable source. Changes affect every component using it." onClick={()=>onOpenPart(feature.params.document)}>Edit source</button></div>}
        <div className="inspector-tabs" role="tablist" aria-label="Object properties">
          {([['appearance','Appearance'],['shape',feature.kind==='instance'?'Placement':'Shape'],['measurements','Measurements']] as const).map(([id,label])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>void(async()=>{if(id===tab)return;if(tab==='appearance'&&getAppearanceFeedback()?.appearance&&!await dialogs.confirm({title:'Discard appearance preview?',body:'Apply the appearance or discard it before changing tasks.',confirmLabel:'Discard preview'}))return;setTab(id);})()}>{label}</button>)}
        </div>
        {tab==='appearance'&&<AppearanceEditor key={doc.documentId+'/'+feature.id} feature={feature} document={doc} runtime={runtime} disabled={disabled} resolvedAppearance={info?.appearance} mixed={(['color','material','finish','detail'] as const).filter(field=>{const pieces=evaluation.meshes.filter(mesh=>mesh.featureId===feature.id);return pieces.length>1&&pieces.some(mesh=>mesh.appearance?.[field]!==pieces[0].appearance?.[field]);})}/>}
        <div hidden={tab!=='shape'}><ParameterEditor key={doc.documentId+'/'+feature.id} feature={feature} document={doc} runtime={runtime} disabled={disabled} onPreview={onPreview}/></div>
        {tab==='measurements'&&<div className="inspector-measurements">{info?<Metrics info={info} busy={state.busy} stale={!!evaluation.referenceError}/>:<p>No measurements available.</p>}
          {(uses.length>0||usedBy.length>0)&&<details className="relations"><summary>Feature connections</summary>{uses.length>0&&<div><span>Uses</span>{uses.map(chip)}</div>}{usedBy.length>0&&<div><span>Used by</span>{usedBy.map(chip)}</div>}</details>}
          <p className="field-hint">{visible?'Visible result':'Construction input'}{agentTouched.has(feature.id)?' · Changed by agent':''}</p>
        </div>}
      </div>
    </section>;
  }

  if (selected.length > 1) {
    const infos = selected.map(id => evaluation.geometry.find(g => g.featureId === id)).filter((g): g is GeometryInfo => !!g);
    return <section className="inspector-card" aria-label="Inspector">
      <header className="card-head">
        <span className="tool-glyph"><Icon name="layers" size={20} /></span>
        <div><h2>{selected.length} objects</h2><p>The first one is the target for Cut and other combines</p></div>
        <button className="icon-button quiet" type="button" aria-label="Clear selection" title="Clear selection · Esc" disabled={disabled} onClick={() => onSelect([])}><Icon name="close" size={16} /></button>
      </header>
      <div className="card-body">
        <ol className="selection-list">{selected.map((id, i) => <li key={id}>
          <span className={`order ${i === 0 ? 'target' : ''}`}>{i === 0 ? 'Target' : i + 1}</span>
          <button type="button" className="link-button" disabled={disabled} onClick={() => onSelect([id])}>{name(id)}</button>
          <span className="mono-small">{fmt(evaluation.geometry.find(g => g.featureId === id)?.volumeMm3 ?? 0, 0)} mm³</span>
          {i > 0 && <button type="button" className="ghost-button small" disabled={disabled} onClick={() => onSelect([id, ...selected.filter(other => other !== id)])}>Make target</button>}
        </li>)}</ol>
        <dl className="metric-grid"><div className="span-2"><dt>Combined volume (sum, overlaps counted twice)</dt><dd>{fmt(infos.reduce((sum, g) => sum + g.volumeMm3, 0), 1)}<small>mm³</small></dd></div></dl>
      </div>
    </section>;
  }

  const results = evaluation.geometry.filter(g => evaluation.visibleFeatureIds.includes(g.featureId));
  const min = [0, 1, 2].map(i => Math.min(...results.map(g => g.bounds.min[i])));
  const max = [0, 1, 2].map(i => Math.max(...results.map(g => g.bounds.max[i])));
  const assembly = doc.kind === 'assembly' || !!evaluation.instances?.length;
  const valid = results.every(g => g.valid);
  const solids = results.reduce((sum, g) => sum + g.solidCount, 0);
  const totalVolume = results.reduce((sum, g) => sum + g.volumeMm3, 0), volumeScale = totalVolume >= 1e6 ? 1000 : 1;
  const geometry = !results.length ? undefined
    : evaluation.referenceError ? { tone: 'invalid' as const, text: 'Showing previous geometry · assembly references need repair' }
      : state.busy ? { tone: 'pending' as const, text: 'Rebuilding · showing last committed result' }
        : valid ? { tone: 'valid' as const, text: countLabel(solids, 'valid solid') }
          : { tone: 'invalid' as const, text: `${countLabel(results.filter(g => !g.valid).length, 'result')} failed validation` };
  return <section className="inspector-card overview" aria-label="Document overview">
    <header className="card-head">
      <span className="tool-glyph"><Icon name={assembly ? 'layers' : 'box'} size={20} /></span>
      <div><h2>{doc.name ?? 'Untitled part'}</h2><p>{assembly ? 'Assembly' : 'Part'} · {countLabel(doc.features.length, 'feature')}</p></div>
    </header>
    <div className="card-body">
      {results.length ? <section aria-label="Size">
        <h3 className="section-title">Size</h3>
        <dl className="metric-grid">
          <div className="span-2"><dt>Overall extents</dt><dd className="xyz-readout">{max.map((v, i) => <span key={i} className={`axis-${'xyz'[i]}`}>{fmt(v - min[i], 2)}</span>)}<small>mm</small></dd></div>
          <div title={`${fmt(totalVolume, 1)} mm³`}><dt>Total volume</dt><dd>{fmt(totalVolume / volumeScale, 1)}<small>{volumeScale === 1000 ? 'cm³' : 'mm³'}</small></dd></div>
          <div><dt>Solids</dt><dd>{solids}</dd></div>
        </dl>
      </section> : <p className="field-hint">Exact measurements appear here once a solid exists.</p>}
      <AnalysisPanel runtime={runtime} state={state} disabled={disabled} onSelect={onSelect} geometry={geometry} />
    </div>
  </section>;
}
