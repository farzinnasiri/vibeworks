import type {RuntimeClient,Outcome} from '../cad/runtime';
import type {Evaluation} from '../cad/types';
import {COMMAND_TIMEOUT_MS,type ActivityOperation,type CadDocument,type GraphSnapshot,type Replay} from '../shared/protocol';

export type PlaybackMode='construction'|'changes';
export type ConstructionDetail='assembly'|'components';
export interface PlaybackScope {documentId:string;name:string;projectId?:string;filterDocumentId?:string;agentId?:string;author?:string;featureId?:string}
interface Frame {evaluation:Evaluation;document:CadDocument;snapshot:GraphSnapshot;replay?:Replay;operation?:ActivityOperation;values:number}
export interface PlaybackState {
 active:boolean;mode:PlaybackMode;detail:ConstructionDetail;scope?:PlaybackScope;playing:boolean;loading:boolean;preparing:boolean;
 requested:number;displayed:number;total:number;speed:number;frame?:Evaluation;document?:CadDocument;snapshot?:GraphSnapshot;
 replay?:Replay;operations:ActivityOperation[];operation?:ActivityOperation;error?:string;frameMs?:number;generation:number;
}
const idle=():PlaybackState=>({active:false,mode:'construction',detail:'assembly',playing:false,loading:false,preparing:false,requested:1,displayed:0,total:0,speed:1,operations:[],generation:0});
/** Disposable read-only playback. Its scope and event list stay fixed while live edits continue. */
export class Playback {
 private state=idle();private listeners=new Set<()=>void>();private generation=0;private origin='';private detail:'auto'|'fine'|'coarse'='auto';
 private wanted?:number;private inFlight=false;private timer?:ReturnType<typeof setTimeout>;private shownAt=0;
 private failedPrefetch=new Set<string>();private cache=new Map<string,Frame>();private values=0;private frozen?:GraphSnapshot;private root?:CadDocument;
 constructor(private runtime:Pick<RuntimeClient,'getSnapshot'|'replay'|'execute'>,private options:{timeoutMs?:number;prefetch?:boolean;now?:()=>number}={}){}
 getSnapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(patch:Partial<PlaybackState>){this.state={...this.state,...patch};this.listeners.forEach(l=>l());}
 private now=()=>this.options.now?.()??performance.now();
 private clearTimer(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
 close=()=>{this.generation++;this.clearTimer();this.wanted=undefined;this.cache.clear();this.failedPrefetch.clear();this.values=0;this.frozen=undefined;this.root=undefined;this.state={...idle(),speed:this.state.speed,generation:this.generation};this.listeners.forEach(l=>l());};
 reconcile=()=>{if(this.state.active&&this.origin!==this.runtime.getSnapshot().document.documentId)this.close();};
 private begin(mode:PlaybackMode,scope:PlaybackScope,playing:boolean){
  const prior=this.state.frame??this.runtime.getSnapshot().evaluation;this.close();this.origin=this.runtime.getSnapshot().document.documentId;
  this.publish({active:true,mode,scope,playing,loading:true,frame:prior,generation:this.generation});return this.generation;
 }
 openConstruction=(options:{scope?:PlaybackScope;detail?:ConstructionDetail;playing?:boolean;snapshot?:GraphSnapshot;document?:CadDocument;step?:number;prepareOnly?:boolean}={})=>{
  const live=this.runtime.getSnapshot(),doc=options.document??live.document;
  this.begin('construction',options.scope??{documentId:doc.documentId,name:doc.name??'Untitled',projectId:doc.projectId},options.playing??false);
  this.root=doc;this.frozen=options.snapshot;
  this.publish({detail:options.detail??'assembly',total:options.detail==='components'?0:doc.features.length,document:doc,snapshot:options.snapshot});
  if(!doc.features.length){this.publish({loading:false,playing:false,error:'This design has no construction steps.'});return;}
  if(options.prepareOnly){this.publish({loading:false});return;}
  this.seek(options.step??1);
 };
 openChanges=async(scope:PlaybackScope,options:{operation?:ActivityOperation;playing?:boolean}={})=>{
  const generation=this.begin('changes',scope,options.playing??false);this.publish({preparing:true});
  try{
   const operations=new Map<string,ActivityOperation>();let before:number|undefined,cutoff:number|undefined;
   for(let page=0;page<200;page++){
    const result=await this.runtime.execute({type:'activity',params:{projectId:scope.projectId,documentId:scope.filterDocumentId,agentId:scope.agentId,changesOnly:true,limit:100,...(before?{before}:{})}});
    if(generation!==this.generation)return;
    if(result.status==='error')throw Error(result.error?.message??'Recorded changes are unavailable.');
    const rows=result.operations??[];if(cutoff===undefined)cutoff=Math.max(0,...rows.map(o=>o.sequence));
    for(const op of rows)if(op.sequence<=cutoff&&op.toVersion!==undefined&&op.documentId&&(!scope.featureId||op.featureIds.includes(scope.featureId)))operations.set(op.operationId,op);
    if(rows.length<100)break;
    const next=Math.min(...rows.map(o=>o.sequence));if(before!==undefined&&next>=before)throw Error('History pagination did not advance.');before=next;
    if(page===199)throw Error('This history exceeds 20,000 loaded changes. Choose a part or agent to narrow the scope.');
   }
   if(options.operation)operations.set(options.operation.operationId,options.operation);
   const list=[...operations.values()].sort((a,b)=>(a.commitSequence??a.sequence)-(b.commitSequence??b.sequence));
   this.publish({operations:list,total:list.length,preparing:false});
   if(!list.length){this.publish({loading:false,playing:false,error:'No recorded changes in this scope.'});return;}
   const selected=options.operation?list.findIndex(o=>o.operationId===options.operation!.operationId):this.state.playing?0:list.length-1;
   this.seek(selected+1);
  }catch(error){if(generation===this.generation)this.publish({preparing:false,loading:false,playing:false,error:String(error)});}
 };
 setConstructionDetail=(detail:ConstructionDetail)=>{
  if(this.state.mode!=='construction'||!this.root)return;
  const options={scope:this.state.scope,document:this.root,snapshot:this.frozen,playing:this.state.playing,detail,prepareOnly:!this.state.playing};this.openConstruction(options);
 };
 setDetail=(detail:'auto'|'fine'|'coarse')=>{if(this.detail===detail)return;this.detail=detail;this.cache.clear();this.values=0;if(this.state.active&&!this.state.preparing)this.seek(this.state.requested);};
 setSpeed=(speed:number)=>{if(![1,2,4,8,16].includes(speed))return;this.publish({speed});this.schedule();};
 pause=()=>{this.clearTimer();this.publish({playing:false});};
 toggle=()=>{
  if(!this.state.active||this.state.preparing)return;
  if(this.state.playing){this.pause();return;}
  const retry=!!this.state.error;this.publish({playing:true,error:undefined});
  if(retry||!this.state.displayed)this.seek(this.state.requested);
  else if(this.state.displayed>=this.state.total)this.seek(1);
  else{this.schedule();void this.drain();}
 };
 retry=()=>{this.publish({error:undefined});this.seek(this.state.requested);};
 seek=(step:number)=>{
  if(!this.state.active||this.state.preparing)return;this.reconcile();if(!this.state.active)return;
  const target=Math.max(1,Math.min(this.state.total||step,Math.trunc(step)));this.clearTimer();
  this.wanted=target;this.publish({requested:target,loading:true,error:undefined});
  const cached=this.cache.get(this.key(target));if(cached){this.wanted=undefined;this.deliver(target,cached);}
  void this.drain();
 };
 private key(step:number){return `${this.state.mode}:${this.state.detail}:${this.detail}:${step}`;}
 private deliver(step:number,frame:Frame){
  this.shownAt=this.now();this.publish({displayed:step,requested:step,loading:false,error:undefined,frame:frame.evaluation,document:frame.document,snapshot:frame.snapshot,replay:frame.replay,operation:frame.operation});this.schedule();
 }
 private schedule(){
  this.clearTimer();if(!this.state.playing||this.state.loading||!this.state.displayed)return;
  if(this.state.displayed>=this.state.total){this.publish({playing:false});return;}
  const reduced=typeof matchMedia!=='undefined'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  const interval=(reduced?1100:650)/this.state.speed;
  this.timer=setTimeout(()=>{this.timer=undefined;this.seek(this.state.displayed+1);},Math.max(0,this.shownAt+interval-this.now()));
 }
 private cacheFrame(key:string,frame:Frame){
  if(frame.values>4_000_000)return;
  this.values-=this.cache.get(key)?.values??0;this.cache.delete(key);this.cache.set(key,frame);this.values+=frame.values;
  while(this.cache.size>6||this.values>4_000_000){const first=this.cache.keys().next().value!;this.values-=this.cache.get(first)!.values;this.cache.delete(first);}
 }
 private async drain(){
  if(this.inFlight||!this.state.active||this.state.preparing)return;
  const target=this.wanted??(this.options.prefetch!==false&&this.state.playing&&this.state.displayed<this.state.total?this.state.displayed+1:undefined);
  if(!target||this.cache.has(this.key(target))||!this.wanted&&this.failedPrefetch.has(this.key(target)))return;
  const generation=this.generation,key=this.key(target),state=this.state,displayDetail=this.detail;this.wanted=undefined;this.inFlight=true;
  const started=this.now();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const operation=state.mode==='changes'?state.operations[target-1]:undefined;
   const graph=state.mode==='construction'?(this.frozen?{id:this.frozen.snapshotId}:{}):operation?.snapshotId&&operation.documentId===state.scope!.documentId?{id:operation.snapshotId}:{sequence:operation?.action==='delete'&&operation.documentId===state.scope!.documentId?(operation.commitSequence??0)-1:operation?.commitSequence};
   if(state.mode==='changes'&&!('id'in graph)&&graph.sequence===undefined)throw Error('This change has no recorded graph or commit sequence. Choose another change.');
   const doc=this.root??this.runtime.getSnapshot().document;
   const outcome:Outcome=await Promise.race([this.runtime.replay({type:'inspect_model',params:{documentId:state.scope!.documentId,snapshot:graph,
    ...(state.mode==='construction'?state.detail==='components'?{replay:{step:target,detail:this.detail,expectedRevision:doc.revision,expectedStorageVersion:this.frozen?.storageVersion??this.runtime.getSnapshot().storageVersion??1,...(this.frozen?{key:this.frozen.snapshotId}:{})}}:{display:{step:target,detail:this.detail==='fine'?'fine':'coarse',expectedRevision:doc.revision,expectedStorageVersion:this.frozen?.storageVersion??this.runtime.getSnapshot().storageVersion??1}}:{display:{detail:this.detail==='fine'?'fine':'coarse',expectedRevision:0,expectedStorageVersion:1}})
   }}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Frame preparation timed out. Retry, choose another step or close replay.')),this.options.timeoutMs??COMMAND_TIMEOUT_MS+5000);timer.unref?.();})]);
   if(generation!==this.generation||!this.state.active||displayDetail!==this.detail)return;this.reconcile();if(!this.state.active)return;
   const result=outcome.result;if(result.status==='error'||!outcome.evaluation||!result.document||!result.snapshot)throw Error(result.error?.message??'The recorded frame is unavailable.');
   if('sequence'in graph&&graph.sequence!==undefined&&result.snapshot.cursor!==graph.sequence)throw Error('The returned change sequence did not match the request.');
   if(result.document.documentId!==state.scope!.documentId||result.snapshot.documentId!==state.scope!.documentId)throw Error('The frame belongs to a different design.');
   if(state.mode==='construction'){
    if(this.frozen&&result.snapshot.snapshotId!==this.frozen.snapshotId)throw Error('Construction graph changed. Close and restart replay.');
    if(state.detail==='components'&&outcome.evaluation.replay?.step!==target)throw Error('The returned construction step did not match the request.');
    this.frozen=result.snapshot;this.root=result.document;
    this.publish({total:state.detail==='components'?outcome.evaluation.replay!.steps.length:result.document.features.length});
   }
   const arrays=new Set(outcome.evaluation.meshes.flatMap(m=>[m.vertices,m.normals,m.triangles,m.lines]));
   const frame:Frame={evaluation:outcome.evaluation,document:result.document,snapshot:result.snapshot,replay:outcome.evaluation.replay,operation,values:[...arrays].reduce((n,a)=>n+a.length,0)};
   this.cacheFrame(key,frame);this.publish({frameMs:Math.round(this.now()-started)});
   if((this.state.loading||this.state.displayed!==target)&&this.state.requested===target&&(!this.wanted||this.wanted===target)){this.wanted=undefined;this.deliver(target,frame);}
  }catch(error){if(generation===this.generation)this.failedPrefetch.add(key);if(generation===this.generation&&(!this.wanted||this.wanted===target)&&this.state.requested===target){this.clearTimer();this.wanted=undefined;this.publish({playing:false,loading:false,error:error instanceof Error?error.message:String(error)});}}
  finally{if(timer)clearTimeout(timer);this.inFlight=false;if(this.state.active&&(this.wanted||this.state.playing))void this.drain();}
 }
}
