import assert from 'node:assert/strict';
import test from 'node:test';
import {ComponentReplay} from '../src/web/component-replay';
import {emptyDocument} from '../src/cad/document';
import {unknownHealth,type GraphSnapshot} from '../src/shared/protocol';
import type {RuntimeState,Outcome} from '../src/cad/runtime';
const state=():RuntimeState=>({phase:'ready',busy:false,activity:'Ready',health:unknownHealth(),canUndo:false,canRedo:false,persistence:'Test',documents:[],projects:[],document:emptyDocument(),storageVersion:1,evaluation:{geometry:[],meshes:[],visibleFeatureIds:[]}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('frozen component playback survives a concurrent source edit and keeps requesting the same snapshot',async()=>{
 let current=state();const snapshot:GraphSnapshot={snapshotId:crypto.randomUUID(),documentId:current.document.documentId,storageVersion:1,revision:0,sources:[],engineVersion:'test',cursor:1,createdAt:new Date().toISOString()};const requests:any[]=[];
 const controller=new ComponentReplay({getSnapshot:()=>current,refreshStorage:async()=>{},replay:async c=>{requests.push(c);const replay={key:snapshot.snapshotId,step:c.params.replay!.step,steps:[1,2].map(()=>({rootStep:1,path:[{documentId:current.document.documentId,name:'part',featureId:'body',label:'Body'}],kind:'box' as const}))};return {result:{operation:'inspect_model',status:'success',documentId:snapshot.documentId,revision:0,created:[],updated:[],warnings:[],snapshot,replay},evaluation:{geometry:[],meshes:[],visibleFeatureIds:[],replay}};}});
 controller.start();controller.pause();await settle();current={...current,evaluation:{...current.evaluation,references:[{documentId:crypto.randomUUID(),revision:7}]}};controller.reconcile();
 assert.equal(controller.getSnapshot().active,true);controller.seek(2);await settle();assert.equal(requests.at(-1).params.snapshot.id,snapshot.snapshotId);assert.equal(controller.getSnapshot().replay!.step,2);
});
test('a stalled first frame exits loading with a retryable error instead of an indefinite spinner',async()=>{
 const current=state(),controller=new ComponentReplay({getSnapshot:()=>current,refreshStorage:async()=>{},replay:()=>new Promise<Outcome>(()=>{})},{timeoutMs:5});
 controller.start();await new Promise(r=>setTimeout(r,20));assert.equal(controller.getSnapshot().loading,false);assert.equal(controller.getSnapshot().playing,false);assert.match(controller.getSnapshot().error!,/timed out/i);
});
test('scrubbing while the first frame loads preserves its frozen graph for the coalesced destination',async()=>{
 let current=state(),complete!:(o:Outcome)=>void;const requests:any[]=[],snapshot:GraphSnapshot={snapshotId:crypto.randomUUID(),documentId:current.document.documentId,storageVersion:1,revision:0,sources:[],engineVersion:'test',cursor:1,createdAt:new Date().toISOString()};
 const reply=(step:number):Outcome=>{const replay={key:snapshot.snapshotId,step,steps:[1,2].map(()=>({rootStep:1,path:[{documentId:snapshot.documentId,name:'part',featureId:'body',label:'Body'}],kind:'box' as const}))};return {result:{operation:'inspect_model',status:'success',documentId:snapshot.documentId,revision:0,created:[],updated:[],warnings:[],document:current.document,snapshot,replay},evaluation:{geometry:[],meshes:[],visibleFeatureIds:[],replay}};};
 const controller=new ComponentReplay({getSnapshot:()=>current,refreshStorage:async()=>{},replay:async c=>{requests.push(c);return requests.length===1?new Promise(r=>{complete=r;}):reply(c.params.replay!.step);}});
 controller.start();controller.seek(2);current={...current,storageVersion:2,document:{...current.document,revision:1}};complete(reply(1));await settle();await settle();
 assert.equal(requests.length,2);assert.equal(requests[1].params.snapshot.id,snapshot.snapshotId);assert.equal(requests[1].params.replay.expectedStorageVersion,1);assert.equal(controller.getSnapshot().replay!.step,2);
});
