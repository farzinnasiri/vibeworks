import {useEffect,useRef,useState} from 'react';
import type {RuntimeClient,RuntimeState} from '../cad/runtime';
import type {ExplorerLocation} from './ModelExplorer';
interface Destination extends ExplorerLocation {trail:ExplorerLocation[]}
interface Navigation {activeId:string;trail:ExplorerLocation[];back:Destination[];forward:Destination[]}
const KEY='vibeworks.view.documentNavigation';
function read(activeId:string):Navigation{
 try{const value=JSON.parse(sessionStorage.getItem(KEY)??'null');
  const valid=(v:any)=>v&&typeof v.documentId==='string'&&typeof v.name==='string'&&Array.isArray(v.selection)&&v.selection.every((s:unknown)=>typeof s==='string');
  if(value?.activeId===activeId&&Array.isArray(value.trail)&&value.trail.every(valid)&&['back','forward'].every(k=>Array.isArray(value[k])&&value[k].every((v:any)=>valid(v)&&Array.isArray(v.trail)&&v.trail.every(valid))))return value;
 }catch{}return{activeId,trail:[],back:[],forward:[]};
}
/** Personal navigation only; revisions and model storage are unaffected. */
export function useDocumentNavigation(runtime:RuntimeClient,state:RuntimeState){
 const [nav,setNav]=useState(()=>read(state.document.documentId)),current=useRef(nav),pending=useRef(false);
 const last=useRef({documentId:state.document.documentId,name:state.document.name??'Document',selection:state.document.selectedFeatureIds});
 current.current=nav;
 useEffect(()=>{try{sessionStorage.setItem(KEY,JSON.stringify(nav));}catch{}},[nav]);
 useEffect(()=>{
  const doc=state.document;
  if(doc.documentId!==last.current.documentId&&!pending.current){const previous=last.current;
   setNav(n=>({activeId:doc.documentId,trail:[],back:[...n.back,{...previous,trail:n.trail}].slice(-40),forward:[]}));}
  last.current={documentId:doc.documentId,name:doc.name??'Document',selection:[...doc.selectedFeatureIds]};
 },[state.document.documentId,state.document.selectedFeatureIds,state.document.name]);
 const capture=():Destination=>{const doc=runtime.getSnapshot().document;return{documentId:doc.documentId,name:doc.name??'Document',selection:[...doc.selectedFeatureIds],trail:current.current.trail};};
 const open=async(destination:Destination,update:(n:Navigation,origin:Destination)=>Navigation)=>{
  if(pending.current)throw new Error('Wait for the current document to open.');
  pending.current=true;const origin=capture();
  try{const result=await runtime.openDocument(destination.documentId);if(result.status==='error')throw new Error(result.error?.message??'Document could not open.');
   await runtime.select(destination.selection);last.current={documentId:destination.documentId,name:destination.name,selection:destination.selection};
   setNav(n=>update(n,origin));
  }finally{pending.current=false;}
 };
 const navigate=async(documentId:string,featureId?:string,trail:ExplorerLocation[]=[])=>{
  const doc=runtime.getSnapshot();const name=doc.documents.find(d=>d.documentId===documentId)?.name??'Document';
  if(documentId===doc.document.documentId){if(featureId)await runtime.select([featureId]);return;}
  await open({documentId,name,selection:featureId?[featureId]:[],trail},(n,origin)=>({activeId:documentId,trail,back:[...n.back,origin].slice(-40),forward:[]}));
 };
 const openSource=(documentId:string)=>{const origin=capture();return navigate(documentId,undefined,[...origin.trail,{documentId:origin.documentId,name:origin.name,selection:origin.selection}]);};
 const go=async(direction:'back'|'forward')=>{
  const n=current.current,entry=n[direction].at(-1);if(!entry)return;
  await open(entry,(prior,origin)=>({activeId:entry.documentId,trail:entry.trail,
   back:direction==='back'?prior.back.slice(0,-1):[...prior.back,origin].slice(-40),
   forward:direction==='forward'?prior.forward.slice(0,-1):[...prior.forward,origin].slice(-40)}));
 };
 const returnToSourceParent=async()=>{
  const n=current.current,parent=n.trail.at(-1);if(!parent)return;
  await open({...parent,trail:n.trail.slice(0,-1)},(prior,origin)=>({activeId:parent.documentId,trail:n.trail.slice(0,-1),back:[...prior.back,origin].slice(-40),forward:[]}));
 };
 return{trail:nav.trail,canBack:!!nav.back.length,canForward:!!nav.forward.length,navigate,openSource,back:()=>go('back'),forward:()=>go('forward'),returnToSourceParent,clearTrail:()=>setNav(n=>({...n,trail:[]}))};
}
