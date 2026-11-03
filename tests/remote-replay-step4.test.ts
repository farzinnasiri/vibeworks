import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDocument } from '../src/cad/document';
import { modelHealth } from '../src/cad/health';
import { displayDeliverySchema } from '../src/bridge/validation';
import type { Replay } from '../src/shared/protocol';

test('remote replay validates full deliveries and never adopts frames through either read entry point', async t=>{
  (globalThis as any).__VIBEWORKS_FINGERPRINT__='replay-test';
  const {RemoteRuntime}=await import('../src/web/remote-runtime');
  const document=emptyDocument(), other=emptyDocument(), evaluation={geometry:[],meshes:[],visibleFeatureIds:[]};
  const replay:Replay={key:'graph',step:1,steps:[{rootStep:1,path:[{documentId:document.documentId,name:'part',featureId:'box',label:'Box'}],kind:'box'}]};
  let wrongStep=false, requests=0, lastPassive=false;
  t.mock.method(globalThis,'fetch',async(url:any,options?:RequestInit)=>{
    if(url==='/api/connection')return Response.json({token:'unit-only',fingerprint:'replay-test',bridgeId:'00000000-0000-4000-8000-000000000001',wsUrl:'ws://127.0.0.1'});
    const {requestId,command,passive}=JSON.parse(options!.body as string);requests++;lastPassive=passive;
    const observed=command.params.documentId===other.documentId?other:document;
    const projection=command.params.replay?{...replay,step:wrongStep?2:1,steps:wrongStep?[...replay.steps,...replay.steps]:replay.steps}:undefined;
    return Response.json({result:{operation:command.type,requestId,status:'success',documentId:observed.documentId,revision:0,storageVersion:1,created:[],updated:[],warnings:[],document:observed,geometry:[],visibleFeatureIds:[],health:modelHealth(observed,evaluation,null),...(projection?{replay:projection}:{})},evaluation:{...evaluation,...(projection?{replay:projection}:{})}},{headers:{'x-vibeworks-fingerprint':'replay-test'}});
  });
  const runtime=new RemoteRuntime();await runtime.initialize();
  const committed=runtime.getSnapshot();
  const observation=await runtime.replay({type:'inspect_model',params:{documentId:other.documentId}});
  assert.equal(observation.result.status,'success');assert.equal(observation.result.documentId,other.documentId);
  assert.equal(lastPassive,true,'Follower observations must not create human activity or change agent focus');
  assert.equal(runtime.getSnapshot(),committed,'Observing another part must retain the main view, selection and last command');
  const command={type:'inspect_model' as const,params:{documentId:document.documentId,replay:{step:1,expectedRevision:0,expectedStorageVersion:1}}};
  const outcome=await runtime.replay(command);assert.equal(outcome.result.status,'success');assert.equal(runtime.getSnapshot(),committed);
  assert.equal((await runtime.execute(command)).status,'success');assert.equal(runtime.getSnapshot(),committed);
  wrongStep=true;assert.equal((await runtime.replay(command)).result.error?.code,'REPLAY_STALE');assert.equal(runtime.getSnapshot(),committed);
  assert.ok(requests>=4);
  assert.equal(displayDeliverySchema.safeParse({...outcome,evaluation:{...outcome.evaluation,replay:{...replay,key:'other'}}}).success,false);
  assert.equal(displayDeliverySchema.safeParse({...outcome,result:{...outcome.result,status:'error',error:{code:'FAILED',message:'failed'}}}).success,false);
});
