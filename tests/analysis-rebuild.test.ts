import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyDocument,validateDocument} from '../src/cad/document';
import {CadRuntime} from '../src/cad/runtime';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import {MemoryStore} from '../src/cad/store';

test('explicit whole analysis rebuilds cold and source-stale models once, then inspection reuses current results',async t=>{
  const store=new MemoryStore(),worker=new NodeGeometryWorker(),runtime=new CadRuntime(store,worker);
  t.after(()=>worker.close());
  const part=validateDocument({...emptyDocument(),revision:1,features:[{id:'solid',kind:'box',params:{origin:[0,0,0],size:[10,10,10]},appearance:{material:'aluminum'}}]});
  const version=await store.put(part,null);
  const root=validateDocument({...emptyDocument(),kind:'assembly',revision:1,analysis:{auto:true,checks:[]},features:[{id:'placed',kind:'instance',params:{document:part.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]});
  await store.put(root,null);await store.setPreference('activeDocumentId',root.documentId);
  await runtime.initialize(true);
  const count=()=>worker.diagnostics.executions.filter(x=>x.type==='evaluate'&&x.documentId===root.documentId).length;
  const first=await runtime.execute({type:'analyze_model',params:{documentId:root.documentId}});
  assert.equal(first.status,'success',JSON.stringify(first.error));assert.equal(first.health?.analysis,'current');
  assert.equal(count(),1,'analysis must not spend its deadline rebuilding before its own exact rebuild');
  const inspected=await runtime.execute({type:'inspect_model',params:{documentId:root.documentId}});
  assert.equal(inspected.health?.analysis,'current');assert.equal(count(),1,'successful analysis satisfies the pending geometry refresh');
  const resized=validateDocument({...part,revision:2,features:[{id:'solid',kind:'box',params:{origin:[0,0,0],size:[12,10,10]},appearance:{material:'aluminum'}}]});
  await store.put(resized,version);
  const second=await runtime.execute({type:'analyze_model',params:{documentId:root.documentId}});
  assert.equal(second.status,'success',JSON.stringify(second.error));assert.ok(Math.abs(second.geometry![0].volumeMm3-1200)<1e-8);
  assert.equal(second.health?.analysis,'current');assert.equal(second.health?.referencesChanged,true);
  assert.equal(count(),2,'source refresh and explicit analysis share one rebuild');
  await runtime.execute({type:'inspect_model',params:{documentId:root.documentId}});assert.equal(count(),2);
  assert.equal((await store.read(root.documentId))?.document.analysis?.auto,true,'read-only analysis preserves the saved auto setting');
});

