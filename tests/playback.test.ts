import assert from 'node:assert/strict';
import test from 'node:test';
import {Playback} from '../src/web/playback';
import {emptyDocument} from '../src/cad/document';
import {ENGINE_VERSION,unknownHealth,type ActivityOperation,type CadCommand,type GraphSnapshot} from '../src/shared/protocol';
import type {RuntimeState,Outcome} from '../src/cad/runtime';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options:ConstructorParameters<typeof Playback>[1]={prefetch:false}){
 const doc={...emptyDocument(),name:'Assembly',features:Array.from({length:4},(_,i)=>({id:`b${i}`,kind:'box' as const,params:{origin:[i*10,0,0] as [number,number,number],size:[5,5,5] as [number,number,number]}}))};
 let live:RuntimeState={phase:'ready',busy:false,activity:'Ready',health:unknownHealth(),canUndo:false,canRedo:false,persistence:'Test',documents:[],projects:[],document:doc,storageVersion:1,evaluation:{geometry:[],meshes:[],visibleFeatureIds:['live']}};
 const calls:{command:Extract<CadCommand,{type:'inspect_model'}>;resolve:(outcome:Outcome)=>void}[]=[],queries:any[]=[];let operations:ActivityOperation[]=[];
 const runtime={getSnapshot:()=>live,replay:(command:Extract<CadCommand,{type:'inspect_model'}>)=>new Promise<Outcome>(resolve=>calls.push({command,resolve})),execute:async(command:any)=>{queries.push(command);const p=command.params;const rows=operations.filter(o=>(!p.before||o.sequence<p.before)&&(!p.documentId||o.documentId===p.documentId)&&(!p.agentId||o.agentId===p.agentId)).sort((a,b)=>b.sequence-a.sequence).slice(0,p.limit);return{operation:'activity' as const,status:'success' as const,created:[],updated:[],warnings:[],operations:rows};}};
 const controller=new Playback(runtime,options);
 const reply=(call=calls.at(-1)!,patch:Partial<Outcome['result']>={},wrongStep=false):Outcome=>{
  const step=call.command.params.replay?.step??call.command.params.display?.step??1;
  const snapshot:GraphSnapshot={snapshotId:call.command.params.snapshot?.id??'frozen',documentId:call.command.params.documentId!,revision:doc.revision,storageVersion:1,sources:[],engineVersion:ENGINE_VERSION,cursor:call.command.params.snapshot?.sequence??10,createdAt:new Date().toISOString()};
  const replay=call.command.params.replay?{key:snapshot.snapshotId,step:wrongStep?step+1:step,steps:doc.features.map(f=>({rootStep:1,path:[{documentId:doc.documentId,name:doc.name,featureId:f.id,label:f.id}],kind:f.kind}))}:undefined;
  return{result:{operation:'inspect_model',status:'success',created:[],updated:[],warnings:[],document:{...doc,documentId:snapshot.documentId},snapshot,...patch},evaluation:{geometry:[],meshes:[],visibleFeatureIds:[`step-${step}`],replay}};
 };
 return{controller,doc,calls,queries,reply,setOperations:(rows:ActivityOperation[])=>operations=rows,setLive:(state:RuntimeState)=>live=state,runtime};
}
const op=(n:number,documentId:string,extra:Partial<ActivityOperation>={}):ActivityOperation=>({operationId:`op-${n}`,kind:'agent',agentId:'agent-a',operation:'apply_edits',status:'success',sequence:n,commitSequence:n,documentId,featureIds:[],toVersion:n,startedAt:'2026-10-31T00:00:00Z',...extra});

test('construction retains the live frame, coalesces seeks and freezes every source version',async()=>{
 const f=fixture(),original=f.runtime.getSnapshot();f.controller.openConstruction();assert.equal(f.controller.getSnapshot().frame,original.evaluation);
 f.controller.seek(2);f.controller.seek(4);assert.equal(f.calls.length,1);f.calls[0].resolve(f.reply(f.calls[0]));await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].command.params.display?.step,4);assert.equal(f.calls[1].command.params.snapshot?.id,'frozen');
 assert.equal(f.controller.getSnapshot().displayed,0);f.calls[1].resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().displayed,4);assert.equal(f.runtime.getSnapshot(),original);
 f.controller.close();assert.equal(f.controller.getSnapshot().active,false);
});

test('component detail switches in the same player, ignores obsolete frames and rejects wrong steps',async()=>{
 const f=fixture();f.controller.openConstruction();f.controller.setConstructionDetail('components');f.controller.toggle();assert.equal(f.controller.getSnapshot().active,true);assert.equal(f.calls.length,1);
 f.calls[0].resolve(f.reply(f.calls[0]));await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].command.params.replay?.step,1);
 f.calls[1].resolve(f.reply(f.calls[1],{},true));await settle();assert.match(f.controller.getSnapshot().error!,/match/);assert.equal(f.controller.getSnapshot().displayed,0);
 f.controller.retry();f.calls.at(-1)!.resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().displayed,1);
 f.controller.seek(2);f.controller.close();f.calls.at(-1)!.resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().active,false);
});

test('a frame failure preserves the last exact frame and retries only on request',async()=>{
 const f=fixture();f.controller.openConstruction();f.calls[0].resolve(f.reply());await settle();const frame=f.controller.getSnapshot().frame;
 f.controller.seek(2);f.calls[1].resolve({...f.reply(),result:{operation:'inspect_model',status:'error',created:[],updated:[],warnings:[],error:{code:'WORKER_TIMEOUT',message:'Worker stopped'}}});await settle();
 assert.equal(f.controller.getSnapshot().frame,frame);assert.equal(f.controller.getSnapshot().displayed,1);assert.equal(f.controller.getSnapshot().requested,2);assert.equal(f.controller.getSnapshot().playing,false);const count=f.calls.length;await settle();assert.equal(f.calls.length,count);
 f.controller.retry();f.calls.at(-1)!.resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().displayed,2);f.controller.close();
});

test('changes load beyond one page, retain commit order, and reconstruct a stable assembly scope',async()=>{
 const f=fixture();f.setOperations(Array.from({length:205},(_,i)=>op(i+1,'child',{agentId:'agent-a'})));
 await f.controller.openChanges({documentId:f.doc.documentId,name:f.doc.name,projectId:'project',agentId:'agent-a'});assert.equal(f.queries.length,3);assert.equal(f.controller.getSnapshot().total,205);assert.equal(f.controller.getSnapshot().requested,205);
 assert.equal(f.calls[0].command.params.documentId,f.doc.documentId);assert.equal(f.calls[0].command.params.snapshot?.sequence,205);
 f.calls[0].resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().operation?.operationId,'op-205');assert.equal(f.controller.getSnapshot().scope?.documentId,f.doc.documentId);
 f.controller.seek(1);assert.equal(f.calls.at(-1)!.command.params.snapshot?.sequence,1);f.calls.at(-1)!.resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().displayed,1);f.controller.close();
});

test('failed attempts are excluded but recorded commits with failed delivery remain reviewable',async()=>{
 const f=fixture();f.setOperations([op(1,f.doc.documentId,{toVersion:undefined,status:'error'}),op(2,f.doc.documentId,{status:'unknown'}),op(3,f.doc.documentId)]);
 await f.controller.openChanges({documentId:f.doc.documentId,name:f.doc.name});assert.deepEqual(f.controller.getSnapshot().operations.map(o=>o.operationId),['op-2','op-3']);f.controller.close();f.calls[0].resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().active,false);
});

test('prefetch is bounded and 16x changes the target clock without adding a post-load delay',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=fixture({now:()=>Date.now(),prefetch:true});
 f.controller.openConstruction({playing:true});f.calls[0].resolve(f.reply());await settle();assert.equal(f.calls.length,2,'one next frame is prepared while the first is visible');
 f.calls[1].resolve(f.reply());await settle();assert.equal(f.calls.length,2);f.controller.setSpeed(16);t.mock.timers.tick(41);await settle();assert.equal(f.controller.getSnapshot().displayed,2);assert.equal(f.calls.length,3);
 t.mock.timers.tick(100);assert.equal(f.controller.getSnapshot().loading,true);assert.equal(f.controller.getSnapshot().displayed,2);
 f.calls[2].resolve(f.reply());await settle();assert.equal(f.controller.getSnapshot().displayed,3);f.controller.close();
});

test('prefetch failures do not retry in a loop or clear the visible design',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const f=fixture({now:()=>Date.now(),prefetch:true});f.controller.openConstruction({playing:true});f.calls[0].resolve(f.reply());await settle();
 f.calls[1].resolve({result:{operation:'inspect_model',status:'error',created:[],updated:[],warnings:[],error:{code:'FAILED',message:'Missing source'}}});await settle();assert.equal(f.calls.length,2);
 t.mock.timers.tick(650);await settle();assert.equal(f.calls.length,3);f.calls[2].resolve({result:{operation:'inspect_model',status:'error',created:[],updated:[],warnings:[],error:{code:'FAILED',message:'Missing source'}}});await settle();assert.equal(f.calls.length,3);assert.equal(f.controller.getSnapshot().displayed,1);assert.equal(f.controller.getSnapshot().playing,false);f.controller.close();
});

test('malformed historical identity cannot replace the viewport',async()=>{
 const f=fixture();f.setOperations([op(1,f.doc.documentId)]);await f.controller.openChanges({documentId:f.doc.documentId,name:f.doc.name});const original=f.controller.getSnapshot().frame;
 const out=f.reply();out.result.snapshot!.cursor=99;f.calls[0].resolve(out);await settle();assert.match(f.controller.getSnapshot().error!,/sequence/);assert.equal(f.controller.getSnapshot().frame,original);f.controller.close();
});

test('a timed-out first frame is retryable and closing rejects its late delivery',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture({timeoutMs:5,prefetch:false});f.controller.openConstruction();const baseline=f.controller.getSnapshot().frame;
 t.mock.timers.tick(6);await settle();assert.equal(f.controller.getSnapshot().loading,false);assert.match(f.controller.getSnapshot().error!,/timed out/);assert.equal(f.controller.getSnapshot().frame,baseline);
 f.controller.retry();assert.equal(f.calls.length,2);f.calls[0].resolve(f.reply(f.calls[0]));await settle();assert.equal(f.controller.getSnapshot().displayed,0);
 f.controller.close();f.calls[1].resolve(f.reply(f.calls[1]));await settle();assert.equal(f.controller.getSnapshot().active,false);
});

test('concurrent live edits cannot change a frozen construction session',async()=>{
 const f=fixture();f.controller.openConstruction();f.controller.seek(3);const live=f.runtime.getSnapshot();f.setLive({...live,storageVersion:9,document:{...live.document,revision:8}});
 f.calls[0].resolve(f.reply(f.calls[0]));await settle();assert.equal(f.calls[1].command.params.snapshot?.id,'frozen');assert.equal(f.calls[1].command.params.display?.expectedStorageVersion,1);f.calls[1].resolve(f.reply(f.calls[1]));await settle();
 assert.equal(f.controller.getSnapshot().snapshot?.storageVersion,1);assert.equal(f.runtime.getSnapshot().document.revision,8);f.controller.close();
});

test('opening the player and choosing detail can defer geometry work until Play',async()=>{
 const f=fixture();f.controller.openConstruction({prepareOnly:true});assert.equal(f.calls.length,0);assert.equal(f.controller.getSnapshot().active,true);f.controller.setConstructionDetail('components');assert.equal(f.calls.length,0);
 f.controller.toggle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].command.params.replay?.step,1);f.controller.close();f.calls[0].resolve(f.reply());await settle();
});


test('placement scope filters edits in its owner without confusing shared source edits',async()=>{
 const f=fixture();f.setOperations([op(1,f.doc.documentId,{featureIds:['left']}),op(2,f.doc.documentId,{featureIds:['right']}),op(3,'source',{featureIds:['body']}),op(4,f.doc.documentId,{featureIds:['left']})]);
 await f.controller.openChanges({documentId:f.doc.documentId,name:'Left placement',filterDocumentId:f.doc.documentId,featureId:'left'});assert.deepEqual(f.controller.getSnapshot().operations.map(o=>o.operationId),['op-1','op-4']);f.controller.close();f.calls[0].resolve(f.reply());await settle();
});
