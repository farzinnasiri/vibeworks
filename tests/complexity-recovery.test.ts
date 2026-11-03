import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {CommandAuthority} from '../src/bridge/authority';
import {MemoryStore} from '../src/cad/store';
import {CadError,emptyDocument,validateDocument} from '../src/cad/document';
import {CadRuntime} from '../src/cad/runtime';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import {parseCommand,type CadResult} from '../src/shared/protocol';

test('failed active assembly cannot block listing, opening a healthy source, or source undo; prior health is never current',async t=>{
 const store=new MemoryStore(), authority=new CommandAuthority(store,{workers:1});
 t.after(()=>authority.close());await authority.ready();
 const run=async(type:string,params:unknown)=>(await authority.execute(parseCommand({type,params}))).result;
 const ok=(r:CadResult)=>{assert.equal(r.status,'success',JSON.stringify(r.error));return r;};
 const part=ok(await run('documents',{action:'create',requestId:randomUUID(),name:'source'})).documentId!;
 const feature={id:'body',kind:'box',params:{origin:[0,0,0],size:[10,10,10]},appearance:{material:'aluminum'}};
 ok(await run('apply_edits',{documentId:part,expectedRevision:0,edits:[{op:'add',feature}]}));
 const assembly=ok(await run('documents',{action:'create',kind:'assembly',requestId:randomUUID(),name:'assembly'})).documentId!;
 ok(await run('apply_edits',{documentId:assembly,expectedRevision:0,edits:[{op:'add',feature:{id:'placed',kind:'instance',params:{document:part,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}}]}));
 ok(await run('documents',{action:'open',documentId:assembly}));
 const inspected=ok(await run('inspect_model',{documentId:assembly}));
 const cursor=(await store.operation({action:'changes',after:0})).cursor;
 const projected=ok(await run('inspect_model',{documentId:assembly,display:{expectedRevision:inspected.revision,expectedStorageVersion:inspected.storageVersion,detail:'coarse'}}));
 assert.deepEqual(projected.geometry,inspected.geometry);
 assert.equal((await store.operation({action:'changes',after:0})).cursor,cursor,'display is not a durable edit');
 assert.equal((await run('inspect_model',{documentId:assembly,display:{expectedRevision:0,expectedStorageVersion:inspected.storageVersion,detail:'fine'}})).error?.code,'REVISION_CONFLICT');
 const worker=(authority as any).slots[0].worker, original=worker.evaluate.bind(worker);
 worker.evaluate=async(...args:any[])=>{if(args[0].documentId===assembly)throw new CadError('MODEL_TOO_COMPLEX','Controlled display capacity failure');return original(...args);};
 ok(await run('apply_edits',{documentId:part,expectedRevision:1,edits:[{op:'update',feature:{...feature,params:{...feature.params,size:[12,10,10]}}}]}));
 const failed=await run('inspect_model',{documentId:assembly});
 assert.equal(failed.error?.code,'MODEL_TOO_COMPLEX');
 assert.notEqual(failed.health?.analysis,'current');assert.notEqual(failed.health?.ok,true);
 const definitions=ok(await run('inspect_model',{documentId:assembly,definitionsOnly:true}));assert.equal(definitions.document!.features[0].id,'placed');assert.deepEqual(definitions.geometry,[]);assert.notEqual(definitions.health?.ok,true);
 const json=ok(await run('export_model',{documentId:assembly,format:'json',skipAnalysis:true}));assert.equal(JSON.parse(Buffer.from(json.artifact!.base64,'base64').toString()).documentId,assembly);
 ok(await run('documents',{action:'list'}));
 ok(await run('documents',{action:'history',documentId:assembly}));
 ok(await run('documents',{action:'open',documentId:part}));
 const undo=ok(await run('document_action',{documentId:part,expectedRevision:2,action:'undo'}));
 assert.equal(undo.revision,3);assert.deepEqual((await store.read(part))!.document.features[0].params,{origin:[0,0,0],size:[10,10,10]});
 // Recovery also works when the target's current evaluation itself fails.
 worker.evaluate=async(...args:any[])=>{if(args[0].documentId===part && args[0].features[0]?.params.size[0]===10)throw new CadError('MODEL_TOO_COMPLEX','Current part cannot display');return original(...args);};
 (authority as any).slots[0].runtime.sessions.delete(part);
 const redo=ok(await run('document_action',{documentId:part,expectedRevision:3,action:'redo'}));
 assert.equal(redo.revision,4);const restored=(await store.read(part))!.document.features[0];assert.equal(restored.kind,'box');if(restored.kind==='box')assert.deepEqual(restored.params.size,[12,10,10]);
});

test('a saved model that exceeds display capacity on startup still permits saved-definition backup and undo',async t=>{
 const store=new MemoryStore(),worker=new NodeGeometryWorker(),runtime=new CadRuntime(store,worker);
 t.after(()=>worker.close());
 const original=emptyDocument(),saved=validateDocument({...original,revision:1,features:[{id:'body',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}}]});
 await store.put(saved,null,{undo:[original],redo:[]});
 t.mock.method(worker,'initialize',async()=>{throw new CadError('MODEL_TOO_COMPLEX','Controlled startup display capacity failure');});
 await runtime.initialize();assert.equal(runtime.getSnapshot().phase,'ready');assert.equal(runtime.getSnapshot().health.ok,false);
 const definitions=await runtime.execute({type:'inspect_model',params:{documentId:saved.documentId,definitionsOnly:true}});
 assert.equal(definitions.status,'success');assert.equal(definitions.document!.features.length,1);
 const backup=await runtime.execute({type:'export_model',params:{documentId:saved.documentId,format:'json',skipAnalysis:true}});
 assert.equal(backup.status,'success');assert.equal(JSON.parse(Buffer.from(backup.artifact!.base64,'base64').toString()).features.length,1);
 const undo=await runtime.execute({type:'document_action',params:{documentId:saved.documentId,expectedRevision:1,action:'undo'}});
 assert.equal(undo.status,'success',JSON.stringify(undo.error));assert.equal((await store.read(saved.documentId))!.document.features.length,0);
});

