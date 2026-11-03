import {useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {RuntimeClient,RuntimeState} from '../cad/runtime';
import type {CadResult} from '../shared/protocol';
import {visibleFeatures} from '../cad/document';
import {useModalFocus} from './useModalFocus';
import {featureName} from './modeling';
export function ExtractDialog({runtime,state,initial,onClose}:{runtime:RuntimeClient;state:RuntimeState;initial:string[];onClose:()=>void}){
 const ref=useRef<HTMLFormElement>(null);useModalFocus(ref);
 const [requestId]=useState(()=>crypto.randomUUID()),[name,setName]=useState('Extracted part'),[ids,setIds]=useState(initial),[shared,setShared]=useState<'error'|'copy'>('error'),[parameters,setParameters]=useState<'error'|'copy'>('error'),[replacement,setReplacement]=useState<'single'|'per_result'>('single'),[preview,setPreview]=useState<CadResult>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const close=()=>{onClose();requestAnimationFrame(()=>document.querySelector<HTMLElement>(`.model-tree-row[data-owner="${state.document.documentId}"][data-feature="${initial[0]}"]`)?.focus());};
 const doc=state.document;const invalidate=()=>{setPreview(undefined);setError('');};
 const run=async(apply=false)=>{setBusy(true);setError('');try{
  const result=await runtime.execute({type:'documents',params:{action:'extract',requestId,documentId:doc.documentId,expectedRevision:doc.revision,expectedStorageVersion:state.storageVersion,features:ids,name,shared,parameters,replacement,incoming:'remap',dryRun:!apply,...(apply?{planToken:preview?.extraction?.planToken}:{})}});
  if(result.status==='error'){setError(`${result.error!.code}: ${result.error!.message}${result.error?.details?' '+JSON.stringify(result.error.details):''}`);setPreview(undefined);return;}
  if(apply){try{const key=`vibeworks.surface-selection:${doc.documentId}`,saved=localStorage.getItem(key);if(saved){const target=JSON.parse(saved);if(ids.includes(target.feature)){const old=target.feature;target.feature=replacement==='per_result'||ids.length===1?old:ids[0];target.path=[old,...(target.path??[])];localStorage.setItem(key,JSON.stringify(target));}}}catch{}close();}else setPreview(result);
 }catch(e){setError(String(e));}finally{setBusy(false);}};
 const plan=preview?.extraction?.plan;
 const impact=(key:string,item:any)=>{
  if(key==='closure')return featureName(doc.features.find(f=>f.id===item))||String(item);
  if(key==='shared')return `${featureName(doc.features.find(f=>f.id===item.id))||item.id} · copied · used by ${item.users.join(', ')}`;
  if(key==='parameters')return `${item.name} · ${item.policy==='copy'?'copy into the new part':'move into the new part'}`;
  if(key==='incoming')return `${state.documents.find(d=>d.documentId===item.documentId)?.name??item.documentId} · ${item.features.join(', ')}`;
  if(key==='mounts')return `${item.name} · ${item.feature} · position ${item.frame.origin.join(', ')} mm`;
  if(key==='checks')return `${item.id} · ${item.expect}`;
  return `${item.feature} → ${item.replacement} / ${item.prefix.join(' / ')}`;
 };
 return createPortal(<div className="palette-backdrop"><form ref={ref} role="dialog" aria-modal="true" aria-labelledby="extract-title" className="dialog extract-dialog" onSubmit={e=>{e.preventDefault();void run(!!preview);}} onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();close();}}}>
  <h2 id="extract-title">Extract to part</h2><p className="field-hint">Keep the results in place and create a reusable source. Return to {doc.name??'this model'} after applying.</p>
  <label className="dialog-field"><span>Part name</span><input className="text-input" aria-label="Part name" maxLength={120} value={name} disabled={busy} onChange={e=>{setName(e.target.value);invalidate();}}/></label>
  <fieldset disabled={busy}><legend>Results</legend>{visibleFeatures(doc).map(id=><label key={id} className="check-row"><input type="checkbox" checked={ids.includes(id)} onChange={e=>{setIds(e.target.checked?[...ids,id]:ids.filter(v=>v!==id));invalidate();}}/><span>{featureName(doc.features.find(f=>f.id===id))}</span></label>)}</fieldset>
  <label className="dialog-field"><span>Shared helpers</span><select value={shared} disabled={busy} onChange={e=>{setShared(e.target.value as typeof shared);invalidate();}}><option value="error">Stop if shared</option><option value="copy">Copy shared helpers</option></select></label>
  <label className="dialog-field"><span>Shared variables</span><select value={parameters} disabled={busy} onChange={e=>{setParameters(e.target.value as typeof parameters);invalidate();}}><option value="error">Stop if shared</option><option value="copy">Copy shared variables</option></select></label>
  <label className="dialog-field"><span>Replacement</span><select value={replacement} disabled={busy} onChange={e=>{setReplacement(e.target.value as typeof replacement);invalidate();}}><option value="single">One component</option><option value="per_result">One component per result</option></select></label>
  {(shared==='copy'||parameters==='copy')&&<p className="field-hint">Copied helpers and variables can diverge after later edits.</p>}
  {error&&<p className="field-error" role="alert">{error}</p>}
  {plan&&<div className="extract-impact" role="status"><h3>Exact preview passed</h3><p>Coordinates, construction, appearance, graphics and mass are preserved.</p>{(['closure','shared','parameters','incoming','mounts','checks','remaps']as const).map(key=><details key={key}><summary>{key==='parameters'?'Variables':key==='closure'?'Included features':key==='remaps'?'Selection and reference paths':key.charAt(0).toUpperCase()+key.slice(1)} · {Array.isArray(plan[key])?plan[key].length:0}</summary><ul>{(Array.isArray(plan[key])?plan[key]:[]).map((item,index)=><li key={index}>{impact(key,item)}</li>)}</ul></details>)}</div>}
  <div className="dialog-actions"><button type="button" className="ghost-button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={busy||!ids.length||!name.trim()}>{busy?'Checking exact geometry…':preview?'Apply extraction':'Preview extraction'}</button></div>
 </form></div>,document.body);
}
