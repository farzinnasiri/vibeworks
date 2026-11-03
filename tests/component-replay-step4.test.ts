import assert from 'node:assert/strict';
import test from 'node:test';
import { ComponentReplay } from '../src/web/component-replay';
import { unknownHealth } from '../src/shared/protocol';
import { emptyDocument } from '../src/cad/document';
import type { RuntimeState, Outcome } from '../src/cad/runtime';
import type { Replay } from '../src/shared/protocol';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('replay coalesces scrub reads, drops canceled/document-switch deliveries and never adopts frames', async () => {
  const doc=emptyDocument();
  let snapshot: RuntimeState = { phase:'ready',busy:false,activity:'Ready',health:unknownHealth(),canUndo:false,canRedo:false,persistence:'Test',documents:[],projects:[],document:doc,storageVersion:1,evaluation:{geometry:[],meshes:[],visibleFeatureIds:[]} };
  let requests: any[] = [], resolve: (outcome: Outcome) => void = () => {}, refreshes=0;
  const controller=new ComponentReplay({getSnapshot:()=>snapshot,refreshStorage:async()=>{refreshes++;},replay:command=>{requests.push(command);return new Promise(r=>{resolve=r;});}});
  const reply = (step: number, error?: string): Outcome => {
    const replay: Replay={key:'same-graph',step,steps:Array.from({length:5},(_,i)=>({rootStep:1,path:[{documentId:doc.documentId,name:'part',featureId:'box',label:'Box '+i}],kind:'box'}))};
    return { result: {operation:'inspect_model',status:error?'error':'success',created:[],updated:[],warnings:[],...(error?{error:{code:'WORKER_TIMEOUT',message:error}}:{replay})},evaluation:{geometry:[],meshes:[],visibleFeatureIds:[],replay} };
  };
  const committed=snapshot.evaluation;
  controller.start();controller.pause();controller.seek(2);controller.seek(4);
  assert.equal(requests.length,1);resolve(reply(1));await settle();assert.equal(requests.length,2);assert.equal(requests[1].params.replay.step,4);
  assert.equal(controller.getSnapshot().frame,undefined);resolve(reply(4));await settle();assert.equal(controller.getSnapshot().replay?.step,4);assert.equal(snapshot.evaluation,committed);
  controller.seek(5);controller.cancel();resolve(reply(5));await settle();assert.equal(controller.getSnapshot().active,false);assert.equal(controller.getSnapshot().frame,undefined);
  for (const change of [()=>{snapshot={...snapshot,document:emptyDocument()};}]) {
    controller.start();change();controller.reconcile();resolve(reply(1));await settle();assert.equal(controller.getSnapshot().active,false);assert.equal(controller.getSnapshot().frame,undefined);
  }
  snapshot={...snapshot,phase:'ready',evaluation:committed};controller.start();resolve(reply(1,'Worker stopped'));await settle();assert.equal(controller.getSnapshot().error,'Worker stopped');assert.equal(controller.getSnapshot().playing,false);assert.equal(controller.getSnapshot().frame,undefined);assert.equal(refreshes,1);
  controller.toggle();resolve(reply(1));await settle();assert.equal(controller.getSnapshot().error,undefined);assert.equal(controller.getSnapshot().replay?.step,1);
  controller.exit();await settle();assert.equal(refreshes,2);assert.equal(controller.getSnapshot().active,false);
});
