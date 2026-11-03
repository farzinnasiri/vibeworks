import {useEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import type {RuntimeClient,RuntimeState} from '../cad/runtime';
import type {CadDocument,Feature} from '../shared/protocol';
import {consumedReferences,visibleFeatures} from '../cad/document';
import {featureName,kindIcons,kindLabels} from './modeling';
import {Icon} from './icons';
import {Menu,MenuItem} from './Menu';
import {DocumentActions} from './DocumentSwitcher';

export interface ExplorerLocation {documentId:string;name:string;selection:string[]}
export function ModelExplorer({runtime,state,disabled,onSelect,onNavigate,onHover,onMenu,trail,onCreate,onNotice,onDocumentNavigate,agentDocuments,onReplay,replaying,playback,onHistory,onExtract}:{
 onExtract?:()=>void;runtime:RuntimeClient;state:RuntimeState;disabled:boolean;onSelect:(id?:string,additive?:boolean)=>void;
 onNavigate:(documentId:string,featureId?:string,trail?:ExplorerLocation[])=>Promise<void>;
 onHover:(id?:string)=>void;onMenu?:(id:string,x:number,y:number)=>void;
 trail:ExplorerLocation[];onCreate:(kind:'part'|'assembly')=>Promise<void>;onNotice:(notice:{kind:'info'|'error';text:string}|null)=>void;onDocumentNavigate:()=>void;agentDocuments:Set<string>;onReplay:()=>void;replaying:boolean;playback?:ReactNode;onHistory?:(documentId:string)=>void;
}){
 const doc=state.document,project=state.projects.find(p=>p.projectId===doc.projectId),tree=useRef<HTMLDivElement>(null);
 const [creation,setCreation]=useState<string|null>(null),[closedRoots,setClosedRoots]=useState(new Set<string>());
 const [query,setQuery]=useState(''),[focused,setFocused]=useState(''),[expanded,setExpanded]=useState<Set<string>>(new Set());
 const [sources,setSources]=useState<Map<string,{version:number;document?:CadDocument;error?:string}>>(new Map());
 const loading=useRef(new Set<string>()),generation=useRef(0),preferredPath=useRef('');
 const previousDocument=useRef(doc);
 const documents=state.documents.filter(d=>d.projectId===doc.projectId);
 useEffect(()=>{generation.current++;setExpanded(new Set());setSources(new Map());setFocused('');setQuery('');preferredPath.current='';},[doc.projectId]);
 useEffect(()=>{const previous=previousDocument.current;previousDocument.current=doc;if(previous.documentId!==doc.documentId){setSources(current=>new Map(current).set(previous.documentId,{version:state.documents.find(d=>d.documentId===previous.documentId)?.storageVersion??0,document:previous}));}},[doc]);
 const load=async(id:string)=>{
  const summary=state.documents.find(d=>d.documentId===id),version=summary?.storageVersion??0;
  if(loading.current.has(id)||sources.get(id)?.version===version&&sources.get(id)?.document)return;
  loading.current.add(id);const run=generation.current;
  try{const outcome=await runtime.replay({type:'inspect_model',params:{documentId:id,definitionsOnly:true}});
   if(outcome.result.status==='error'||!outcome.result.document)throw new Error(outcome.result.error?.message??'Source unavailable');
   if(run===generation.current)setSources(current=>new Map(current).set(id,{version,document:outcome.result.document}));
  }catch(e){if(run===generation.current)setSources(current=>new Map(current).set(id,{version,error:String(e)}));}
  finally{loading.current.delete(id);}
 };
 // Refresh only expanded source definitions when their committed storage versions change.
 useEffect(()=>{for(const [id,source]of sources)if(state.documents.find(d=>d.documentId===id)?.storageVersion!==source.version)void load(id);},[state.documents]);
 const parent=new Map<string,string>();for(const feature of doc.features)for(const id of consumedReferences(feature))if(!parent.has(id))parent.set(id,feature.id);
 const selection=doc.selectedFeatureIds[0];
 useEffect(()=>{
  if(!selection)return;
  // A click inside an expanded source stays at that occurrence when its document opens.
  const selectedRow=[...tree.current?.querySelectorAll<HTMLButtonElement>('[data-feature]')??[]].find(row=>row.dataset.owner===doc.documentId&&row.dataset.feature===selection&&(row.dataset.row===preferredPath.current));
  if(selectedRow){setFocused(selectedRow.dataset.row!);return;}
  const row=[...tree.current?.querySelectorAll<HTMLButtonElement>('[data-feature]')??[]].find(row=>row.dataset.owner===doc.documentId&&row.dataset.feature===selection);
  if(row){setFocused(row.dataset.row!);return;}
  const chain=[selection],ancestors:string[]=[];for(let id=parent.get(selection);id;id=parent.get(id))chain.unshift(id);
  let path=`${doc.documentId}/${chain[0]}`;for(const id of chain.slice(1)){ancestors.push(path);path+=`/input:${id}`;}
  setClosedRoots(current=>{const next=new Set(current);next.delete(doc.documentId);return next;});
  setExpanded(current=>new Set([...current,`document:${doc.documentId}`,...ancestors]));setFocused(path);
 },[selection,doc.documentId]);
 const toggle=(path:string,feature:Feature)=>{
  setFocused(path);requestAnimationFrame(()=>tree.current?.querySelector<HTMLButtonElement>(`[data-row="${CSS.escape(path)}"]`)?.focus());
  setExpanded(current=>{const next=new Set(current);if(next.has(path))next.delete(path);else next.add(path);return next;});
  if(feature.kind==='instance')void load(feature.params.document);
 };
 const roots=(document:CadDocument)=>{const used=new Set(document.features.flatMap(consumedReferences));return document.features.filter(f=>!used.has(f.id));};
 const matches=(feature:Feature)=>!query||`${featureName(feature)} ${kindLabels[feature.kind]}`.toLowerCase().includes(query.toLowerCase());
 const render=(owner:CadDocument,feature:Feature,path:string,depth:number,trail:ExplorerLocation[]):ReactNode=>{
  const inputs=consumedReferences(feature).map(id=>owner.features.find(f=>f.id===id)).filter((f):f is Feature=>!!f);
  const instance=feature.kind==='instance',source=instance?sources.get(feature.params.document):undefined;
  const open=expanded.has(path),selected=owner.documentId===doc.documentId&&doc.selectedFeatureIds.includes(feature.id);
  const canExpand=inputs.length>0||instance&&depth<5;
  const summary=instance?state.documents.find(d=>d.documentId===feature.params.document):undefined;
  const choose=(additive=false)=>{
   preferredPath.current=path;setFocused(path);
   if(owner.documentId===doc.documentId)onSelect(feature.id,additive);
   else void onNavigate(owner.documentId,feature.id,trail);
  };
  return <div key={path} className="model-node" role="treeitem" aria-level={depth+1} aria-selected={selected} aria-expanded={canExpand?open:undefined}>
   <div className={`model-tree-line ${selected?'selected':''}`} style={{paddingLeft:depth*14}}>
    {canExpand?<button type="button" tabIndex={-1} className="model-caret" aria-label={`${open?'Collapse':'Expand'} ${featureName(feature)}`} disabled={disabled} onClick={()=>toggle(path,feature)}><Icon name="chevron" size={12} className={open?'':'collapsed'}/></button>:<span className="model-caret"/>}
    <button type="button" className="model-tree-row" data-row={path} data-feature={feature.id} data-owner={owner.documentId}
     tabIndex={focused===path?0:-1} disabled={disabled} aria-pressed={selected}
     onFocus={()=>setFocused(path)} onClick={e=>choose(e.shiftKey||e.metaKey||e.ctrlKey)}
     onDoubleClick={()=>{if(instance)void onNavigate(feature.params.document,undefined,[...trail,{documentId:owner.documentId,name:owner.name??'Assembly',selection:[feature.id]}]);}}
     onContextMenu={e=>{if(owner.documentId!==doc.documentId||!onMenu)return;e.preventDefault();choose();onMenu(feature.id,e.clientX,e.clientY);}}
     onMouseEnter={()=>{if(owner.documentId===doc.documentId&&!visibleFeatures(owner).includes(feature.id))onHover(feature.id);}} onMouseLeave={()=>onHover(undefined)}>
     <Icon name={instance?(summary?.kind==='assembly'?'layers':'box'):kindIcons[feature.kind]} size={16}/><span><b>{featureName(feature)}</b><small>{instance?summary?.name??'Missing source':kindLabels[feature.kind]}</small></span>
    </button>
   </div>
   {canExpand&&open&&<div role="group">
    {inputs.map(f=>render(owner,f,`${path}/input:${f.id}`,depth+1,trail))}
    {instance&&(!source?.document?<div className="model-source-status">{source?.error?<><span role="alert">Source unavailable</span><button type="button" onClick={()=>void load(feature.params.document)}>Retry</button></>:<span role="status">Loading source…</span>}</div>:
      (feature.params.featureId?source.document.features.filter(f=>f.id===feature.params.featureId):roots(source.document)).map(f=>render(source.document!,f,`${path}/${f.id}`,depth+1,[...trail,{documentId:owner.documentId,name:owner.name??'Assembly',selection:[feature.id]}])))}
   </div>}
  </div>;
 };
 const key=(event:KeyboardEvent)=>{
  const row=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-row]');if(!row)return;
  const rows=[...tree.current!.querySelectorAll<HTMLButtonElement>('[data-row]:not(:disabled)')],at=rows.indexOf(row);
  let next:number|undefined;
  if(event.key==='ArrowDown')next=Math.min(at+1,rows.length-1);if(event.key==='ArrowUp')next=Math.max(0,at-1);
  if(event.key==='Home')next=0;if(event.key==='End')next=rows.length-1;
  if(next!==undefined){event.preventDefault();rows[next]?.focus();}
  if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
   const node=row.closest('[role="treeitem"]')!,open=node.getAttribute('aria-expanded');
   event.preventDefault();
   if(event.key==='ArrowRight'&&open!==null){if(open==='false')node.querySelector<HTMLButtonElement>('.model-caret')?.click();else rows[at+1]?.focus();}
   if(event.key==='ArrowLeft'){if(open==='true')node.querySelector<HTMLButtonElement>('.model-caret')?.click();else node.parentElement?.closest('[role=treeitem]')?.querySelector<HTMLButtonElement>('[data-row]')?.focus();}
  }
 };
 const shown=query?doc.features.filter(matches):roots(doc);
 const catalog=[...documents].sort((a,b)=>Number(b.documentId===project?.mainAssemblyId)-Number(a.documentId===project?.mainAssemblyId)||a.name.localeCompare(b.name));
 return <div className="model-explorer">
  <div className="model-toolbar"><Menu id="new-document" open={creation==='new-document'} onToggle={setCreation} label={<>New<Icon name="chevron" size={12}/></>} icon="plus" ariaLabel="New document"><MenuItem label="New part" icon="box" disabled={disabled} onClick={()=>{setCreation(null);void onCreate('part');}}/><MenuItem label="New assembly" icon="layers" disabled={disabled} onClick={()=>{setCreation(null);void onCreate('assembly');}}/></Menu>
   {onExtract&&<button type="button" className="bar-button" disabled={disabled||!doc.features.length} onClick={onExtract}>Extract…</button>}
   <button type="button" className="bar-button" disabled={!doc.features.length||state.busy} aria-label={replaying?'Pause replay':'Replay construction'} onClick={onReplay}><Icon name={replaying?'pause':'play'} size={14}/>{replaying?'Pause':'Replay'}</button>
  </div>
  {playback&&<div className="construction-playback">{playback}</div>}
  <label className="outline-search"><Icon name="search" size={15}/><input aria-label="Find in model" placeholder="Find in project" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  <div ref={tree} role="tree" aria-label="Model" onKeyDown={key}>{catalog.filter(d=>!query||d.name.toLowerCase().includes(query.toLowerCase())||d.documentId===doc.documentId&&shown.length>0).map(d=>{
   const active=d.documentId===doc.documentId,path=`document:${d.documentId}`,open=expanded.has(path)||d.documentId===(project?.mainAssemblyId??documents[0]?.documentId)&&!closedRoots.has(d.documentId),owner=active?doc:sources.get(d.documentId)?.document;
   const rootToggle=()=>{setFocused(path);requestAnimationFrame(()=>tree.current?.querySelector<HTMLButtonElement>(`[data-row="${CSS.escape(path)}"]`)?.focus());setClosedRoots(current=>{const next=new Set(current);if(open)next.add(d.documentId);else next.delete(d.documentId);return next;});setExpanded(current=>{const next=new Set(current);if(open)next.delete(path);else next.add(path);return next;});if(!active)void load(d.documentId);};
   return <div key={d.documentId} role="treeitem" aria-level={1} aria-expanded={open} className={`document-node ${active?'current':''}`}>
    <div className="document-tree-line"><button type="button" className="model-caret" tabIndex={-1} disabled={disabled} aria-label={`${open?'Collapse':'Expand'} document ${d.name}`} onClick={rootToggle}><Icon name="chevron" size={12} className={open?'':'collapsed'}/></button>
     <button type="button" className="model-document-row" data-row={path} tabIndex={focused===path||!focused&&active?0:-1} aria-label={d.name} aria-current={active?'page':undefined} disabled={disabled} onFocus={()=>setFocused(path)} onClick={()=>void onNavigate(d.documentId)}><Icon name={d.kind==='assembly'?'layers':'box'} size={16}/><span><b>{d.name}</b><small>{d.documentId===project?.mainAssemblyId?'Main assembly':d.kind==='assembly'?'Assembly':'Part'} · r{d.revision}</small></span>{agentDocuments.has(d.documentId)&&<Icon name="agent" size={12}/>}</button>
     {onHistory&&<button type="button" className="icon-button model-history-action" aria-label={`Show changes to ${d.name}`} onClick={()=>onHistory(d.documentId)}><Icon name="history" size={14}/></button>}<DocumentActions runtime={runtime} documents={state.documents} projects={state.projects} documentId={d.documentId} disabled={disabled} onNotice={onNotice} onNavigate={onDocumentNavigate}/>
    </div>
    {open&&<div role="group">{owner?(query&&active&&!d.name.toLowerCase().includes(query.toLowerCase())?shown:roots(owner)).map(f=>render(owner,f,`${owner.documentId}/${f.id}`,1,[])):<p className="model-source-status">{sources.get(d.documentId)?.error?<button type="button" onClick={()=>void load(d.documentId)}>Retry loading document</button>:'Loading document…'}</p>}{owner&&!owner.features.length&&<p className="field-hint empty-document-hint">No features yet.</p>}</div>}
   </div>;
  })}</div>
 </div>;
}
