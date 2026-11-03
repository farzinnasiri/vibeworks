import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setOC } from 'replicad';
import initOpenCascade from 'replicad-opencascadejs';
import { GeometryEngine } from '../src/cad/geometry';
import { GeometryWorker } from '../src/cad/worker-client';
import { CadRuntime } from '../src/cad/runtime';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { CadError } from '../src/cad/document';
import { BridgeStore } from '../src/web/bridge-store';
import type { CadDocument, CadCommand, StorageOperation } from '../src/shared/protocol';

const kernel=readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm',import.meta.url)).then(wasmBinary=>initOpenCascade({wasmBinary,print:()=>{},printErr:()=>{}}));
async function fixture(t: TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'vibeworks-runtime-storage-')); const path=join(dir,'workspace.db');
  setOC(await kernel);
  const a=new SqliteStore(path), b=new SqliteStore(path), engine=new GeometryEngine(await kernel);
  t.after(()=>{engine.dispose();a.close();b.close();return rm(dir,{recursive:true,force:true});});
  t.mock.method(GeometryWorker.prototype,'initialize',async(d:CadDocument,refs:CadDocument[]=[])=>engine.evaluate(d,refs));
  t.mock.method(GeometryWorker.prototype,'evaluate',async(d:CadDocument,_timeout?:number,analyze?:{featureIds?:string[]},refs:CadDocument[]=[])=>{
    const result=engine.evaluate(d,refs);return analyze?{...result,analysis:engine.analyze(d,result.geometry,analyze.featureIds)}:result;
  });
  const first=new CadRuntime(a);await first.initialize();const second=new CadRuntime(b);await second.initialize();
  assert.equal(first.getSnapshot().phase,'ready');assert.equal(second.getSnapshot().phase,'ready');
  return {a,b,first,second};
}
const edit=(runtime:CadRuntime,id='body'):CadCommand=>({type:'apply_edits',params:{documentId:runtime.getSnapshot().document.documentId,expectedRevision:runtime.getSnapshot().document.revision,edits:[{op:'add',feature:{id,kind:'box',params:{origin:[0,0,0],size:[10,20,5]}}}]}});

test('a stale command refreshes durable state first and rejects its old revision without losing the winning model',async t=>{
  const {a,b,first,second}=await fixture(t), old=second.getSnapshot();
  assert.equal((await first.execute(edit(first))).status,'success');
  const lost=await second.execute(edit(second,'loser'));
  assert.equal(lost.error?.code,'REVISION_CONFLICT');assert.equal(second.getSnapshot().document.revision,1);assert.deepEqual(second.getSnapshot().document.features.map(f=>f.id),['body']);assert.equal(second.getSnapshot().canUndo,true);
  assert.deepEqual((await a.read(old.document.documentId))!.document.features.map(f=>f.id),['body']);
  assert.equal((await b.operation({action:'history',documentId:old.document.documentId})).revisions!.length,2);
  const reconciled=await second.execute({type:'inspect_model',params:{}});
  assert.equal(reconciled.revision,1);assert.deepEqual(reconciled.document!.features.map(f=>f.id),['body']);assert.equal(reconciled.history!.canUndo,true);
});

test('persistence failure after real OCCT evaluation leaves document, geometry, version and durable history unchanged',async t=>{
  const {a,first}=await fixture(t), old=first.getSnapshot(), operation=a.operation.bind(a);
  t.mock.method(a,'operation',async (op:StorageOperation)=>{if(op.action==='write')throw new CadError('PERSISTENCE_FAILED','Controlled disk failure');return operation(op);});
  const result=await first.execute(edit(first));assert.equal(result.error?.code,'PERSISTENCE_FAILED');
  assert.deepEqual(first.getSnapshot().document,old.document);assert.equal(first.getSnapshot().evaluation,old.evaluation);assert.equal(first.getSnapshot().storageVersion,old.storageVersion);assert.equal(first.getSnapshot().canUndo,false);
  assert.equal((await a.read(old.document.documentId))!.version,1);
});

test('reload restores undo/redo while selection and active document stay per client; selection creates no shared writes',async t=>{
  const {a,b,first,second}=await fixture(t);await first.execute(edit(first));await second.refreshStorage();
  const id=first.getSnapshot().document.documentId;await first.select(['body']);
  assert.deepEqual(first.getSnapshot().document.selectedFeatureIds,['body']);assert.deepEqual(second.getSnapshot().document.selectedFeatureIds,[]);
  assert.equal((await a.read(id))!.version,2);assert.deepEqual((await a.read(id))!.document.selectedFeatureIds,[]);
  const created=await first.execute({type:'documents',params:{action:'create',name:'Other'}});await first.openDocument(created.documentId!);
  await second.refreshStorage();assert.equal(second.getSnapshot().document.documentId,id);
  const reloaded=new CadRuntime(b);await reloaded.initialize();assert.equal(reloaded.getSnapshot().canUndo,true);
  const undo=await reloaded.execute({type:'document_action',params:{action:'undo',documentId:id,expectedRevision:1}});assert.equal(undo.status,'success');assert.equal(undo.revision,2);assert.equal(undo.history!.canRedo,true);
  const again=new CadRuntime(b);await again.initialize();assert.equal(again.getSnapshot().canRedo,true);
  const redo=await again.execute({type:'document_action',params:{action:'redo',documentId:id,expectedRevision:2}});assert.equal(redo.status,'success');assert.equal(redo.revision,3);assert.ok(Math.abs(redo.geometry![0].volumeMm3-1000)<1e-8);
});

test('same-revision rename races require observed storage version, selection cannot overwrite names',async t=>{
  const {a,first,second}=await fixture(t), id=first.getSnapshot().document.documentId;
  const renamed=await first.execute({type:'documents',params:{action:'rename',documentId:id,name:'Winner',expectedStorageVersion:1}});assert.equal(renamed.status,'success');assert.equal(renamed.revision,0);
  await second.select([]);assert.equal((await a.read(id))!.document.name,'Winner');
  const lost=await second.execute({type:'documents',params:{action:'rename',documentId:id,name:'Loser',expectedStorageVersion:1}});assert.equal(lost.error?.code,'STORAGE_CONFLICT');
  await second.refreshStorage();const stillStale=await second.execute({type:'documents',params:{action:'rename',documentId:id,name:'Loser',expectedStorageVersion:1}});assert.equal(stillStale.error?.code,'STORAGE_CONFLICT');
});

test('cross-tab source changes invalidate cached assembly geometry and preserve latest transitive provenance',async t=>{
  const {a,first,second}=await fixture(t);await first.execute(edit(first));const source=first.getSnapshot().document;
  const created=await first.execute({type:'documents',params:{action:'create',kind:'assembly',name:'Car'}});const assemblyId=created.documentId!;
  const result=await first.execute({type:'apply_edits',params:{documentId:assemblyId,expectedRevision:0,edits:[{op:'add',feature:{id:'mount',kind:'instance',params:{document:source.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}}]}});assert.equal(result.status,'success');
  await first.openDocument(assemblyId);await second.refreshStorage();
  const feature={...source.features[0],params:{origin:[0,0,0],size:[20,20,5]}};
  const changed=await second.execute({type:'apply_edits',params:{documentId:source.documentId,expectedRevision:1,edits:[{op:'update',feature}]}});assert.equal(changed.status,'success');
  await first.refreshStorage();const inspected=await first.execute({type:'inspect_model',params:{documentId:assemblyId}});
  assert.equal(inspected.revision,1);assert.ok(Math.abs(inspected.geometry![0].volumeMm3-2000)<1e-8);assert.deepEqual(inspected.provenance!.sources,[{documentId:source.documentId,revision:2}]);
  assert.equal((await a.read(assemblyId))!.version,2,'derived refresh does not write the assembly');
});

test('lost storage response is uncertain after one attempt; malformed identity cannot report success',async t=>{
  const calls:string[]=[];t.mock.method(globalThis,'fetch',async(input:unknown)=>{
    calls.push(String(input));if(String(input).endsWith('/connection'))return new Response(JSON.stringify({wsUrl:'ws://127.0.0.1/runtime',token:'test',fingerprint:'unbuilt'}));throw new Error('Controlled lost response');
  });
  const store=new BridgeStore();
  await assert.rejects(store.put({...emptyForTransport()},null),{code:'STORAGE_OUTCOME_UNKNOWN'});
  assert.equal(calls.filter(c=>c.endsWith('/storage')).length,1);
  calls.length=0;
  t.mock.method(globalThis,'fetch',async(input:unknown)=>{calls.push(String(input));return String(input).endsWith('/connection')?new Response(JSON.stringify({wsUrl:'ws://127.0.0.1/runtime',token:'test',fingerprint:'unbuilt'})):new Response(JSON.stringify({requestId:crypto.randomUUID(),fingerprint:'unbuilt',ok:true,version:1}));});
  await assert.rejects(new BridgeStore().put(emptyForTransport(),null),{code:'STORAGE_OUTCOME_UNKNOWN'});assert.equal(calls.length,2);
});
function emptyForTransport():CadDocument{return{schemaVersion:1,documentId:crypto.randomUUID(),revision:0,units:'mm',features:[],selectedFeatureIds:[]};}

test('a committed SQLite write with a lost reply stays uncertain until an explicit read reconciles the runtime',async t=>{
  const {a,first}=await fixture(t), old=first.getSnapshot(), operation=a.operation.bind(a);let attempts=0;
  t.mock.method(a,'operation',async(op:StorageOperation)=>{
    const result=await operation(op);
    if(op.action==='write'){attempts++;throw new CadError('STORAGE_OUTCOME_UNKNOWN','Controlled lost reply after commit');}return result;
  });
  const lost=await first.execute(edit(first));assert.equal(lost.error?.code,'STORAGE_OUTCOME_UNKNOWN');assert.equal(lost.error?.outcomeUnknown,true);assert.equal(attempts,1);
  assert.deepEqual(first.getSnapshot().document,old.document);assert.equal(first.getSnapshot().canUndo,false);
  assert.equal((await a.read(old.document.documentId))!.document.revision,1);
  const read=await first.execute({type:'inspect_model',params:{}});assert.equal(read.revision,1);assert.equal(read.history!.canUndo,true);assert.equal(attempts,1);
});

test('undo depth is bounded to 40 across reloads while SQLite audit records retain every commit',async t=>{
  const {a,first}=await fixture(t);await first.execute(edit(first));
  for(let i=0;i<45;i++){
    const d=first.getSnapshot().document;
    const result=await first.execute({type:'apply_edits',params:{documentId:d.documentId,expectedRevision:d.revision,edits:[{op:'set_parameter',name:'width',value:i}]}});assert.equal(result.status,'success');
  }
  const id=first.getSnapshot().document.documentId, record=(await a.read(id))!;assert.equal(record.history.undo.length,40);
  const reloaded=new CadRuntime(a);await reloaded.initialize();
  for(let i=0;i<40;i++){
    const d=reloaded.getSnapshot().document;assert.equal((await reloaded.execute({type:'document_action',params:{documentId:id,expectedRevision:d.revision,action:'undo'}})).status,'success');
  }
  assert.equal(reloaded.getSnapshot().canUndo,false);assert.equal(reloaded.getSnapshot().canRedo,true);
  assert.equal((await a.operation({action:'changes',after:0})).changes!.length,87);
});

test('appearance-only edits retain exact geometry and physical checks without invoking the worker, including undo and density', async t => {
  const { first } = await fixture(t);
  await first.execute(edit(first));
  const before = first.getSnapshot();
  const worker = t.mock.method(GeometryWorker.prototype, 'evaluate', async () => { throw new Error('Appearance-only edit must not evaluate geometry'); });
  const updated = await first.execute({ type: 'apply_edits', params: { documentId: before.document.documentId, expectedRevision: 1,
    edits: [{ op: 'patch', id: 'body', appearance: { material: 'aluminum', color: '#c02020' } }] } });
  assert.equal(updated.status, 'success', JSON.stringify(updated.error));
  assert.equal(updated.geometry![0].massG, updated.geometry![0].volumeMm3 * 2.7 / 1000);
  assert.equal(updated.health?.analysis, 'current');
  assert.equal(updated.timings?.geometryEvaluationMs, 0);
  const undone = await first.execute({ type: 'document_action', params: { action: 'undo', documentId: before.document.documentId, expectedRevision: 2 } });
  assert.equal(undone.status, 'success', JSON.stringify(undone.error));
  assert.equal(undone.geometry![0].massG, undefined);
  assert.equal(worker.mock.callCount(), 0);
});
