import {Select} from './Select';
import {useState} from 'react';
import type {ActivityOperation,DocumentSummary} from '../shared/protocol';
import type {ProjectWork} from './Agents';
import {agentLabel} from './participants';
import {Icon} from './icons';
export function RevisionHistory({work,documents,loading,error,onView,selected,loadEarlier,onPlay}:{
 work:ProjectWork;documents:DocumentSummary[];loading:boolean;error?:string;onView:(operation:ActivityOperation)=>Promise<void>;selected?:string;loadEarlier:()=>Promise<void>;onPlay:(documentId?:string,agentId?:string)=>void;
}){
 const [filter,setFilter]=useState(''),[failure,setFailure]=useState(''),[busy,setBusy]=useState<string>(),[agent,setAgent]=useState('');
 const people=new Map(work.participants.map(p=>[p.identity.agentId,p]));
 const rows=work.operations.filter(o=>o.toVersion!==undefined&&o.documentId&&(!filter||o.documentId===filter)&&(!agent||o.agentId===agent)).sort((a,b)=>(b.commitSequence??b.sequence)-(a.commitSequence??a.sequence));
 const name=(id?:string)=>documents.find(d=>d.documentId===id)?.name??'Historical document';
 const view=async(o:ActivityOperation)=>{setBusy(o.operationId);setFailure('');try{await onView(o);}catch(e){setFailure(String(e));}finally{setBusy(undefined);}};
 return <section className="revision-history" aria-label="Committed history">
  <p className="history-description">Saved changes by people and agents. Select a change to inspect its captured state.</p>
  <label className="history-filter"><span>Scope</span><Select aria-label="History document" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">This project</option>{documents.map(d=><option key={d.documentId} value={d.documentId}>{d.name}</option>)}</Select></label>
  <label className="history-filter"><span>Author</span><Select aria-label="History author" value={agent} onChange={e=>setAgent(e.target.value)}><option value="">Everyone</option>{work.participants.map(p=><option key={p.identity.agentId} value={p.identity.agentId}>{p.identity.kind==='human'?'You':agentLabel(p.identity.name)}</option>)}</Select></label>
  <button type="button" className="ghost-button" onClick={()=>onPlay(filter||undefined,agent||undefined)}><Icon name="play" size={14}/>Replay recorded changes</button>
  {loading&&<p role="status">Loading history…</p>}{(error||failure)&&<p className="field-error" role="alert">{error??failure}</p>}
  {!loading&&!rows.length&&<p className="field-hint">No recorded changes in this scope.</p>}
  <ol className="revision-list">{rows.map(o=>{const person=o.agentId?people.get(o.agentId):undefined;
   const author=person?(person.identity.kind==='human'?'You':agentLabel(person.identity.name)):'Unknown author';
   const title=o.intent?.purpose??(o.operation==='legacy_revision'?'Saved revision':o.operation==='apply_edits'?'Updated design':o.operation==='document_action'&&o.action==='load'?'Loaded saved design':o.action?.replaceAll('_',' ')??o.operation.replaceAll('_',' '));
   return <li key={o.operationId}><button type="button" className={`revision-row ${selected===o.operationId?'selected':''}`} aria-pressed={selected===o.operationId} disabled={!!busy} onClick={()=>void view(o)}>
    <span className="revision-mark"><Icon name={person?.identity.kind==='agent'?'agent':'history'} size={16}/></span><span className="revision-body"><strong>{title}</strong><span>{name(o.documentId)}</span><small>{author} · {o.revision!==undefined?`r${o.revision}`:`v${o.toVersion}`} · <time dateTime={o.completedAt??o.startedAt}>{new Date(o.completedAt??o.startedAt).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></small>{o.status!=='success'&&<small className="warn-text">Committed · output {o.status==='unknown'?'unverified':'failed'}</small>}{busy===o.operationId&&<small role="status">Loading snapshot…</small>}</span>
   </button></li>;
  })}</ol>
  <button type="button" className="ghost-button" disabled={!!busy||loading} onClick={()=>void loadEarlier().catch(e=>setFailure(String(e)))}>Load older changes</button>
 </section>;
}
