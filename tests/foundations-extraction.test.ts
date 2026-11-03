import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/cad/store';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import {extractComponent} from '../src/bridge/extraction';
import {emptyDocument} from '../src/cad/document';
import {planExtraction} from '../src/cad/extract';
import {parseCommand,type CadDocument,type Feature} from '../src/shared/protocol';
import {instance} from './fixtures/presentation';
const frame={origin:[0,0,10] as [number,number,number],normal:[0,0,1] as [number,number,number],xDirection:[1,0,0] as [number,number,number]};
const block=(id:string,x:number):Feature=>({id,kind:'box',params:{origin:[x,0,0],size:[10,10,10]},appearance:{material:'aluminum',color:'#5599aa'},mounts:[{name:'top',frame:{...frame,origin:[x,0,10]}}]});
const doc=(features:Feature[]):CadDocument=>({...emptyDocument(),features});
const argsFor=(d:CadDocument)=>({action:'extract' as const,documentId:d.documentId,expectedRevision:0,expectedStorageVersion:1,requestId:crypto.randomUUID(),features:['cut'],name:'Extracted component',shared:'copy' as const,parameters:'copy' as const,incoming:'remap' as const});
const params=(v:unknown)=>{const c=parseCommand({type:'documents',params:v});if(c.type!=='documents')throw Error();return c.params;};
async function records(store:MemoryStore|SqliteStore){return Promise.all((await store.list()).map(async d=>(await store.read(d.documentId))!));}
async function sharedFixture(store:MemoryStore|SqliteStore){
 const stock=block('stock',0);stock.bindings={'size.0':'width'};
 const source=doc([stock,{id:'cut',kind:'transform',params:{target:'stock',copy:true,scale:1,translation:[20,0,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0}}]);source.parameters=[{name:'width',value:10}];source.analysis={ground:'stock',checks:[{id:'space',a:'stock',b:'cut',expect:'clearance',minGapMm:10,note:'Designed space'}]};await store.put(source);
 const mounted=instance('all',source.documentId,[0,40,0]);mounted.surfaceStyles=[{target:{feature:'all',path:['cut'],select:{all:true}},look:{color:'#ee5555'}}];
 const incoming=doc([mounted,instance('selected',source.documentId,[100,0,0],'cut')]);incoming.analysis={checks:[{id:'width',a:{feature:'all',path:['cut']},expect:'size',axis:'X',mm:10,toleranceMm:0.001}]};await store.put(incoming);
 const nested=instance('nested',incoming.documentId,[0,50,0]);nested.surfaceStyles=[{target:{feature:'nested',path:['all','cut'],select:{all:true}},look:{color:'#eecc55'}}];const ancestor=doc([nested]);await store.put(ancestor);
 return {source,incoming,ancestor};
}
for(const kind of ['memory','sqlite']as const)test(`shared helper/variable, crossing checks, incoming paint and ancestor paths ${kind}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-extract-'));const store=kind==='memory'?new MemoryStore():new SqliteStore(join(dir,'fixture.db'));const worker=new NodeGeometryWorker();
 try{const {source,incoming,ancestor}=await sharedFixture(store),args=argsFor(source);
 const saved=await records(store);
 assert.throws(()=>planExtraction({...args,shared:'error'},saved),(e:any)=>e.code==='EXTRACT_SHARED_HELPER');
 assert.throws(()=>planExtraction({...args,parameters:'error'},saved),(e:any)=>e.code==='EXTRACT_SHARED_PARAMETER');
 const before=await worker.evaluate(ancestor,undefined,undefined,saved.map(r=>r.document));
 const preview=await extractComponent(store,worker,params({...args,dryRun:true}));assert.ok(preview.extraction?.equivalence);assert.equal((await store.list()).length,3);
 const applied=await extractComponent(store,worker,params({...args,planToken:preview.extraction!.planToken}));assert.equal(applied.status,'success');
 const retained=(await store.get(source.documentId))!;assert.equal(retained.features[0].id,'stock');assert.equal(retained.features[1].kind,'instance');assert.equal(retained.parameters?.[0].name,'width');const crossing=retained.analysis!.checks![0];assert.ok('b' in crossing);assert.deepEqual(crossing.b,{feature:'cut',path:['cut']});
 const direct=(await store.get(incoming.documentId))!;assert.equal((direct.features[1]as any).params.document,args.requestId);assert.deepEqual(direct.features[0].surfaceStyles?.[0].target.path,['cut','cut']);
 const top=(await store.get(ancestor.documentId))!;assert.deepEqual(top.features[0].surfaceStyles?.[0].target.path,['all','cut','cut']);
 const after=await worker.evaluate(top,undefined,undefined,await store.bodies());assert.equal(before.geometry[0].volumeMm3,after.geometry[0].volumeMm3);assert.equal(before.geometry[0].massG,after.geometry[0].massG);assert.equal(before.meshes[0].appearance?.color,after.meshes[0].appearance?.color);
 const op=(await store.storedOperation(args.requestId))!;assert.equal(op.before.length,3);
 await store.operation({action:'operation_history',operationId:args.requestId,direction:'undo'});assert.deepEqual((await store.get(ancestor.documentId))!.features[0].surfaceStyles?.[0].target.path,['all','cut']);
 await store.operation({action:'operation_history',operationId:args.requestId,direction:'redo'});
 const external=(await store.read(incoming.documentId))!;await store.put({...external.document,name:'external edit'},external.version);
 await assert.rejects(store.operation({action:'operation_history',operationId:args.requestId,direction:'undo'}),(e:any)=>e.code==='OPERATION_CONFLICT');
 
 }finally{await worker.close();if(store instanceof SqliteStore)store.close();await rm(dir,{recursive:true,force:true});}
});


test('SQLite commit failure rolls back every body, receipt, history and feed; reopen recovers exactly once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-extract-rollback-')),path=join(dir,'fixture.db');let store=new SqliteStore(path);const db=new DatabaseSync(path),worker=new NodeGeometryWorker();
 try{const {source}=await sharedFixture(store),args=argsFor(source),before=await records(store);
 const preview=await extractComponent(store,worker,params({...args,dryRun:true}));
 const count=()=>Number(db.prepare('SELECT COUNT(*) AS n FROM changes').get()!.n),sequence=count();
 db.exec("CREATE TRIGGER fixture_extract_failure BEFORE INSERT ON operation_requests BEGIN SELECT RAISE(ABORT,'fixture atomic failure'); END");
 await assert.rejects(extractComponent(store,worker,params({...args,planToken:preview.extraction!.planToken})),/fixture atomic failure/);assert.equal(count(),sequence);assert.deepEqual(await records(store),before);assert.equal(await store.storedOperation(args.requestId),undefined);
 db.exec('DROP TRIGGER fixture_extract_failure');await extractComponent(store,worker,params({...args,planToken:preview.extraction!.planToken}));store.close();store=new SqliteStore(path);
 const replay=await extractComponent(store,worker,params({...args,planToken:preview.extraction!.planToken}));assert.equal(replay.replayed,true);assert.equal((await store.list()).length,4);
 }finally{await worker.close();db.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('dry-run plan guards include new incoming documents and same-revision dependency changes',async()=>{
 const store=new MemoryStore(),worker=new NodeGeometryWorker();
 try{const source=doc([block('cut',0)]);await store.put(source);const args=argsFor(source),preview=await extractComponent(store,worker,params({...args,dryRun:true}));
 const incoming=doc([instance('new',source.documentId)]);await store.put(incoming);
 await assert.rejects(extractComponent(store,worker,params({...args,planToken:preview.extraction!.planToken})),(e:any)=>e.code==='EXTRACT_PLAN_CHANGED');assert.equal((await store.get(source.documentId))!.revision,0);assert.equal(await store.get(args.requestId),undefined);
 const next=await extractComponent(store,worker,params({...args,dryRun:true}));const r=(await store.read(incoming.documentId))!;await store.put({...r.document,name:'same revision changed storage'},r.version);
 await assert.rejects(extractComponent(store,worker,params({...args,planToken:next.extraction!.planToken})),(e:any)=>e.code==='EXTRACT_PLAN_CHANGED');
 }finally{await worker.close();}
});

test('measured extraction fallback checks both Boolean differences; changed painted constructions fail',async()=>{
 const worker=new NodeGeometryWorker();
 try{
  const body=block('body',0);delete body.mounts;const before=doc([body]);
  const after={...before,features:[body,{id:'equivalent',kind:'transform',params:{target:'body',scale:1,copy:false,translation:[0,0,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0}}as Feature]};
  const result=await worker.validateExtraction([before],[after],[before.documentId]);assert.match(result.equivalence.method,/boolean-fallback/);
  const changed=structuredClone(after);if(changed.features[1].kind==='transform')changed.features[1].params.translation=[0.1,0,0];await assert.rejects(worker.validateExtraction([before],[changed],[before.documentId]),(e:any)=>e.code==='EXTRACT_NOT_EQUIVALENT');
  const painted=structuredClone(before);painted.features[0].surfaceStyles=[{target:{feature:'body',select:{all:true}},look:{color:'#ee0000'}}];const altered={...after,features:[painted.features[0],after.features[1]]};await assert.rejects(worker.validateExtraction([painted],[altered],[before.documentId]),(e:any)=>e.code==='EXTRACT_NOT_EQUIVALENT');
 }finally{await worker.close();}
});
