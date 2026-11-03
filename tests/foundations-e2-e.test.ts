import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {MemoryStore} from '../src/cad/store';
import {CommandAuthority} from '../src/bridge/authority';
import {parseCommand, uncertainOutcome, knownCreatedDocumentId, type CadResult} from '../src/shared/protocol';
import {resultSchema} from '../src/bridge/validation';
import {instance} from './fixtures/presentation';
const ok=(result:CadResult)=>{assert.equal(result.status,'success',JSON.stringify(result));const valid=resultSchema.safeParse(result);assert.equal(valid.success,true,JSON.stringify(valid.error));return result;};
async function fixture(store:MemoryStore|SqliteStore){const authority=new CommandAuthority(store,{workers:1});await authority.ready();const run=async(value:unknown)=>ok((await authority.execute(parseCommand(value),undefined,false)).result);const create=async()=>run({type:'documents',params:{action:'create',requestId:crypto.randomUUID(),name:'Leaf assembly'}});const d=await create();const edited=await run({type:'apply_edits',params:{documentId:d.documentId,expectedRevision:0,analyze:false,edits:[{op:'add',feature:{id:'stock',kind:'box',params:{origin:[0,0,0],size:[10,10,10]},appearance:{material:'aluminum'}}},{op:'add',feature:{id:'separate',kind:'box',params:{origin:[30,0,0],size:[10,10,10]},appearance:{material:'aluminum'}}}]}});return {authority,run,document:edited.document!};}
for(const kind of ['memory','sqlite']as const)test(`atomic extraction public preview/apply/reply recovery/undo/redo ${kind}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-e-'));const store=kind==='memory'?new MemoryStore():new SqliteStore(join(dir,'fixture.db'));const f=await fixture(store);
 try{const args={action:'extract',requestId:crypto.randomUUID(),documentId:f.document.documentId,expectedRevision:1,expectedStorageVersion:2,features:['stock'],name:'Extracted exact stock'};
  const preview=await f.run({type:'documents',params:{...args,dryRun:true}});assert.equal((await store.list()).length,2);assert.ok(preview.extraction?.equivalence);
  await f.run({type:'documents',params:{...args,planToken:preview.extraction!.planToken}});assert.equal((await store.list()).length,3);assert.equal((await store.read(args.documentId))!.document.features[0].kind,'instance');
  const retry=await f.run({type:'documents',params:{...args,planToken:preview.extraction!.planToken}});assert.equal(retry.replayed,true);
  const recovered=await f.run({type:'documents',params:{action:'list',requestId:args.requestId}});assert.equal(recovered.createdDocumentId,args.requestId);
  const conflict=(await f.authority.execute(parseCommand({type:'documents',params:{...args,name:'different',planToken:preview.extraction!.planToken}}))).result;assert.equal(conflict.error?.code,'REQUEST_ID_CONFLICT');
  const undone=await f.run({type:'document_action',params:{documentId:args.documentId,expectedRevision:2,operationId:args.requestId,action:'undo_operation'}});assert.equal((await store.read(args.documentId))!.document.features[0].kind,'box');assert.ok(await store.read(args.requestId));assert.equal((await store.read(args.documentId))!.history.undo.length,1,'operation undo preserves the earlier document undo stack');assert.equal(undone.extraction?.retainedDocumentId,args.requestId);
  await f.run({type:'document_action',params:{documentId:args.documentId,expectedRevision:3,operationId:args.requestId,action:'redo_operation'}});assert.equal((await store.read(args.documentId))!.document.features[0].kind,'instance');
 }finally{await f.authority.close();if(store instanceof SqliteStore)store.close();await rm(dir,{recursive:true,force:true});}
});
test('one public run progresses automatically and survives SQLite reopen with completed numeric facts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-e2-'));let store=new SqliteStore(join(dir,'fixture.db'));const f=await fixture(store);let authority=f.authority;
 try{const start=await f.run({type:'analyze_model',params:{documentId:f.document.documentId,action:'run'}});assert.ok(start.analysisJob);
  const result=ok((await authority.execute(parseCommand({type:'analyze_model',params:{jobId:start.analysisJob!.id,action:'result',waitMs:20000}}))).result);assert.equal(result.analysisJob?.state,'complete');assert.equal(result.analysis?.parts,2);assert.equal(result.analysis?.floating.length,1);const facts=await store.pairFacts();assert.equal(facts.length,1);
  await authority.close();store.close();store=new SqliteStore(join(dir,'fixture.db'));authority=new CommandAuthority(store,{workers:1});await authority.ready();const reopened=ok((await authority.execute(parseCommand({type:'analyze_model',params:{jobId:start.analysisJob!.id,action:'result'}}))).result);assert.equal(reopened.analysisJob?.state,'complete');assert.equal((await store.pairFacts()).length,facts.length);
 }finally{await authority.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('compound patterns and repeated nested instances enumerate every leaf with occurrence identities',async()=>{
 const store=new MemoryStore(),f=await fixture(store);try{
 await f.run({type:'apply_edits',params:{documentId:f.document.documentId,expectedRevision:1,analyze:false,edits:[{op:'add',feature:{id:'repeat',kind:'pattern',params:{target:'stock',layout:{type:'linear',count:3,direction:[1,0,0],spacing:5}}}}]}});
 const d=await f.run({type:'documents',params:{action:'create',requestId:crypto.randomUUID()}});await f.run({type:'apply_edits',params:{documentId:d.documentId,expectedRevision:0,analyze:false,edits:[{op:'add',feature:instance('one',f.document.documentId)},{op:'add',feature:instance('two',f.document.documentId,[100,0,0])}]}});
 const result=await f.run({type:'analyze_model',params:{documentId:d.documentId,waitMs:20000}});assert.equal(result.analysisJob?.state,'complete');assert.equal(result.analysis?.parts,8);assert.equal(new Set(result.analysis?.leaves?.map(l=>l.id)).size,8);assert.ok(result.analysis!.interferences.length>=4);assert.equal(result.health?.ok,false);assert.ok(result.analysis!.leaves!.every(l=>l.path.length>0));
 }finally{await f.authority.close();}
});

test('lost extraction replies reconcile by logical identity and preview never confirms creation',()=>{
 const requestId=crypto.randomUUID(),documentId=crypto.randomUUID();const command=parseCommand({type:'documents',params:{action:'extract',requestId,documentId,expectedRevision:1,expectedStorageVersion:2,features:['body'],name:'Body'}});
 const lost=uncertainOutcome(command,'BRIDGE_TRANSPORT_ERROR','reply lost',crypto.randomUUID(),true);assert.equal(lost.error?.outcomeUnknown,true);assert.match(lost.error!.recovery!.steps.join(' '),new RegExp(requestId));
 const preview=parseCommand({...command,params:{...command.params,dryRun:true}});assert.equal(knownCreatedDocumentId(preview,{operation:'documents',createdDocumentId:requestId}),undefined);assert.equal(uncertainOutcome(preview,'BRIDGE_TRANSPORT_ERROR','preview lost',crypto.randomUUID(),true).error?.outcomeUnknown,undefined);
});
