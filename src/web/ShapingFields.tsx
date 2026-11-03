import {useState} from 'react';
import type {CadDocument,Feature,SurfaceTarget,TopologyTable} from '../shared/protocol';
import type {RuntimeClient} from '../cad/runtime';
/** Advanced data is edited as a draft and validated by the shared command authority at preview. */
export function ShapingJSON({label,value,onChange}:{label:string;value:unknown;onChange:(v:any)=>void}){
 const [text,setText]=useState<string>(),[error,setError]=useState('');
 return <label className="field-label shaping-field">{label}<textarea aria-label={label} rows={5} style={{width:'100%',maxWidth:'100%',fontFamily:'monospace',resize:'vertical'}} value={text??JSON.stringify(value,null,2)} onChange={e=>{setText(e.target.value);try{onChange(JSON.parse(e.target.value));setError('');e.currentTarget.setCustomValidity('');}catch{setError('Enter complete JSON before previewing.');e.currentTarget.setCustomValidity('Enter complete JSON.');}}}/>{error&&<span role="alert">{error}</span>}</label>;
}
export function ConstructionFields({feature:f,document,runtime,change}:{feature:Extract<Feature,{kind:'fill'|'join'}>;document:CadDocument;runtime?:RuntimeClient;change:(v:Record<string,unknown>)=>void}){
 const earlier=document.features.slice(0,document.features.findIndex(v=>v.id===f.id)<0?undefined:document.features.findIndex(v=>v.id===f.id));
 const [source,setSource]=useState(f.kind==='join'?f.params.target:earlier.find(v=>v.kind!=='fill')?.id??''),[table,setTable]=useState<TopologyTable>(),[error,setError]=useState('');
 const faceRef=(face:TopologyTable['faces'][number]):SurfaceTarget=>({feature:source,select:{faces:[face.lineage[0]],fragments:'one'},signature:{surface:face.surface,areaMm2:face.areaMm2,normal:face.normal,shapeSamples:face.shapeSamples}});
 const load=async()=>{setError('');const r=await runtime?.execute({type:'inspect_model',params:{documentId:document.documentId,select:{topology:{target:{feature:source},edges:{query:'all'}}}}});if(r?.status==='error')setError(r.error!.message);else setTable((r?.inspection?.topology as any[])?.[0]);};
 const boundary=(index:number)=>{
  const list=table!.edges.filter(e=>e.faces.includes(index)),ordered:typeof list=[];
  if(list.some(e=>!e.endpoints)){setError('This delivery lacks exact edge endpoints. Reload topology.');return;}
  if(list.length){ordered.push(list.shift()!);let end=ordered[0].endpoints![1];while(list.length){const i=list.findIndex(e=>e.endpoints!.some(p=>Math.hypot(...p.map((v,k)=>v-end[k]))<1e-5));if(i<0){setError('Face has multiple loops. Choose one explicit ordered boundary in Advanced.');return;}const edge=list.splice(i,1)[0];const same=Math.hypot(...edge.endpoints![0].map((v,k)=>v-end[k]))<1e-5;end=edge.endpoints![same?1:0];ordered.push(edge);}}
  change({boundary:ordered.map(edge=>({edge:{feature:source,name:edge.lineage[0],signature:{center:edge.center,lengthMm:edge.lengthMm}},continuity:'G0'}))});
 };
 return <>
  <p className="field-hint">{f.kind==='fill'?'Create an exact construction sheet from a closed boundary. It stays visible for review and contributes no physical mass.':'Replace captured faces with construction sheets, then sew and validate one exact solid.'}</p>
  <label className="field-label">Source solid<select aria-label="Construction source" value={source} onChange={e=>{setSource(e.target.value);setTable(undefined);}}>{earlier.filter(v=>v.kind!=='fill').map(v=><option key={v.id} value={v.id}>{v.label??v.id}</option>)}</select></label>
  <button type="button" className="ghost-button" disabled={!runtime||!source} onClick={()=>void load()}>Inspect source faces</button>
  {table?.faces.map((face,i)=>face.lineage.length>0&&<button key={i} type="button" className="ghost-button" onClick={()=>f.kind==='fill'?boundary(i):change({target:source,replaceFaces:faceRef(face)})}>{f.kind==='fill'?'Use boundary of':'Replace'} {face.lineage.join(', ')}</button>)}
  {error&&<p role="alert">{error}</p>}
  {f.kind==='join'&&<fieldset><legend>Construction sheets</legend>{earlier.filter(v=>v.kind==='fill').map(v=><label key={v.id}><input type="checkbox" checked={f.params.surfaces.includes(v.id)} onChange={e=>change({surfaces:e.target.checked?[...f.params.surfaces,v.id]:f.params.surfaces.filter(id=>id!==v.id)})}/>{v.label??v.id}</label>)}</fieldset>}
  <details className="method"><summary>Boundary, continuity and tolerances</summary><ShapingJSON label="Construction parameters" value={f.params} onChange={change}/><p>G2 filling requires a support face and g2 tolerance in inverse millimeters. Join can check maxCurvaturePerMm alongside maxAngleDeg. Measurements sample exact surfaces and do not certify the entire seam.</p></details>
 </>;
}
