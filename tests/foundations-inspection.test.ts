import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {startBridge} from '../src/bridge/server';
import {CommandAuthority} from '../src/bridge/authority';
import {emptyDocument,validateDocument} from '../src/cad/document';
import {ENGINE_VERSION,parseCommand} from '../src/shared/protocol';
import {logMcpCall} from '../src/bridge/effort-log';
import {toMcpResult} from '../src/bridge/mcp';

test('inspection pages pin definitions across concurrent storage changes, enforce budgets and reject mismatched cursors',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-foundations-pages-')),path=join(dir,'workspace.db');t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new SqliteStore(path);const document=validateDocument({...emptyDocument(),features:Array.from({length:100},(_,i)=>({id:`body_${i}`,kind:'box',label:`A long feature name number ${i}`,params:{origin:[i*2,0,0],size:[1,1,1]}}))});
 await store.put(document,null);t.after(()=>store.close());
 const bridge=await startBridge({port:0,databasePath:path,connectionFile:join(dir,'connection.json'),workers:1});t.after(()=>bridge.close());await bridge.ready();
 const headers={Authorization:`Bearer ${bridge.connection.token}`,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};let sessionId:string|undefined;
 const call=async(command:unknown)=>{const response=await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),command,sessionId})});return await response.json() as any;};
 sessionId=(await call({type:'agent_session',params:{action:'join',client:'foundations-pagination'}})).session.sessionId;
 const params={documentId:document.documentId,definitionsOnly:true,select:{features:{fields:['kind','label','params']}},page:{limit:7},budgetBytes:4096};
 const first=await call({type:'inspect_model',params});assert.equal(first.status,'success',JSON.stringify(first.error));assert.equal(first.inspection.features.length,7);assert.ok(Buffer.byteLength(JSON.stringify(first))<=4096);assert.ok(first.snapshot);
 await store.put({...document,revision:1,features:document.features.slice(1)},1);
 const ids=first.inspection.features.map((f:any)=>f.id);let cursor=first.inspection.nextCursor;
 while(cursor){const page=await call({type:'inspect_model',params:{...params,page:{limit:7,cursor}}});assert.equal(page.status,'success',JSON.stringify(page.error));assert.equal(page.revision,0);assert.equal(page.inspection.current,false);assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);ids.push(...page.inspection.features.map((f:any)=>f.id));cursor=page.inspection.nextCursor;}
 assert.deepEqual(ids,document.features.map(f=>f.id));
 const wrong=await call({type:'inspect_model',params:{...params,select:{features:{fields:['kind']}},page:{cursor:first.inspection.nextCursor}}});assert.equal(wrong.status,'error');assert.equal(wrong.error.code,'CURSOR_INVALID');
 const bad=await call({type:'inspect_model',params:{...params,page:{cursor:'broken'}}});assert.equal(bad.status,'error');assert.equal(bad.error.code,'CURSOR_INVALID');
});
test('old snapshot engine requires explicit reevaluation and preserves original metadata and revision bytes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-foundations-old-')),path=join(dir,'workspace.db');t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new SqliteStore(path);t.after(()=>store.close());const doc=validateDocument({...emptyDocument(),features:[{id:'box',kind:'box',params:{origin:[0,0,0],size:[10,20,5]}}]});await store.put(doc,null);
 const graph=(await store.operation({action:'snapshot',documentId:doc.documentId,snapshot:{}})).graph!;
 const raw=new DatabaseSync(path);t.after(()=>raw.close());const original=raw.prepare('SELECT body FROM revisions').get()!.body;
 const metadata={...graph.snapshot,engineVersion:'fixture-old-engine'};raw.prepare('UPDATE graph_snapshots SET body=? WHERE id=?').run(JSON.stringify(metadata),metadata.snapshotId);
 await assert.rejects(store.operation({action:'snapshot',documentId:doc.documentId,snapshot:{id:metadata.snapshotId}}),{code:'SNAPSHOT_ENGINE'});
 const authority=new CommandAuthority(store,{workers:1});t.after(()=>authority.close());await authority.ready();
 const outcome=await authority.execute(parseCommand({type:'inspect_model',params:{documentId:doc.documentId,snapshot:{id:metadata.snapshotId,reevaluate:true}}}));
 assert.equal(outcome.result.status,'success',JSON.stringify(outcome.result.error));assert.equal(outcome.result.snapshot!.engineVersion,'fixture-old-engine');assert.deepEqual(outcome.result.evaluationProvenance,{authoredEngine:'fixture-old-engine',evaluatedWith:ENGINE_VERSION,originalEvidence:false});assert.equal(outcome.result.health!.ok,false);assert.equal(raw.prepare('SELECT body FROM revisions').get()!.body,original);assert.deepEqual(JSON.parse(String(raw.prepare('SELECT body FROM graph_snapshots').get()!.body)),metadata);
});
test('MCP effort evidence measures actual bytes and images, and receipts carry self-consistent JSON byte counts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-foundations-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'effort.jsonl');const prior=process.env.VIBEWORKS_MCP_LOG;process.env.VIBEWORKS_MCP_LOG=path;t.after(()=>{if(prior===undefined)delete process.env.VIBEWORKS_MCP_LOG;else process.env.VIBEWORKS_MCP_LOG=prior;});
 const command=parseCommand({type:'documents',params:{action:'list'}}),result={operation:'documents' as const,status:'success' as const,created:[],updated:[],warnings:[]};const reply=await toMcpResult(command,result);const measured=reply.structuredContent as any;
 assert.equal(measured.meta.replyBytes,Buffer.byteLength(JSON.stringify(measured)));
 const withImage={...reply,content:[...reply.content,{type:'image' as const,mimeType:'image/png',data:Buffer.from([1,2,3]).toString('base64')}]};logMcpCall('documents',command.params,withImage,performance.now());const entry=JSON.parse((await readFile(path,'utf8')).trim());assert.equal(entry.argumentBytes,Buffer.byteLength(JSON.stringify(command.params)));assert.equal(entry.replyBytes,Buffer.byteLength(JSON.stringify(withImage)));assert.equal(entry.images[0].bytes,3);assert.ok(!('tokens'in entry));
});

test('v1 fixture migration requires opt-in, writes a full backup and preserves all historical document bytes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-foundations-migration-')),path=join(dir,'workspace.db');t.after(()=>rm(dir,{recursive:true,force:true}));
 let store=new SqliteStore(path);const document=validateDocument({...emptyDocument(),features:[{id:'legacy',kind:'box',params:{origin:[0,0,0],size:[10,20,3]},appearance:{material:'steel',color:'#123456',graphics:[]}}]});await store.put(document,null);store.close();
 const raw=new DatabaseSync(path);const original=raw.prepare('SELECT body FROM revisions').get()!.body;raw.exec('UPDATE workspace_schema SET version=1');raw.close();
 assert.throws(()=>new SqliteStore(path),{code:'WORKSPACE_MIGRATION_CONSENT_REQUIRED'});
 store=new SqliteStore(path,{allowMigration:true});assert.deepEqual(await store.get(document.documentId),JSON.parse(String(original)));store.close();
 const {readdir}=await import('node:fs/promises');const backup=(await readdir(dir)).find(n=>n.startsWith('workspace.db.pre-v2-'));assert.ok(backup);
 const saved=new DatabaseSync(join(dir,backup!)),updated=new DatabaseSync(path);t.after(()=>{saved.close();updated.close();});assert.equal(saved.prepare('SELECT version FROM workspace_schema').get()!.version,1);assert.equal(updated.prepare('SELECT version FROM workspace_schema').get()!.version,2);assert.equal(saved.prepare('SELECT body FROM revisions').get()!.body,original);assert.equal(updated.prepare('SELECT body FROM revisions').get()!.body,original);
});

test('face-paint command exports independently readable STEP face colours and GLB styles with byte-identical STL',async t=>{
 const store=new SqliteStore(':memory:');t.after(()=>store.close());
 const doc=validateDocument({...emptyDocument(),analysis:{auto:false},features:[{id:'block',kind:'box',params:{origin:[0,0,0],size:[20,30,10]},appearance:{material:'steel',color:'#123456'}}]});await store.put(doc,null);
 const authority=new CommandAuthority(store,{workers:1});t.after(()=>authority.close());await authority.ready();
 const run=async(command:unknown)=>{const outcome=await authority.execute(parseCommand(command));assert.equal(outcome.result.status,'success',JSON.stringify(outcome.result.error));return outcome;};
 const before=await run({type:'export_model',params:{documentId:doc.documentId,format:'stl',skipAnalysis:true}});
 const painted=await run({type:'apply_edits',params:{documentId:doc.documentId,expectedRevision:0,analyze:false,edits:[{op:'appearance',target:{feature:'block',select:{faces:['+Z'],fragments:'all'},signature:{surface:'PLANE',areaMm2:600,normal:[0,0,1]}},set:{color:'#ee2200',roughness:0.12}}]}});
 assert.ok(painted.result.document!.features[0].surfaceStyles?.length);
 const stl=await run({type:'export_model',params:{documentId:doc.documentId,format:'stl',skipAnalysis:true}});assert.equal(stl.result.artifact!.base64,before.result.artifact!.base64);
 const step=await run({type:'export_model',params:{documentId:doc.documentId,format:'step',skipAnalysis:true}});assert.ok(!step.result.warnings.some(w=>w.includes('STEP_FACE_STYLES_OMITTED')));
 const reader=await createRequire(import.meta.url)('occt-import-js')();
 const imported=reader.ReadStepFile(new Uint8Array(Buffer.from(step.result.artifact!.base64,'base64')),{linearUnit:'millimeter'});
 assert.equal(imported.success,true);
 const faces=imported.meshes.flatMap((mesh:any)=>mesh.brep_faces);
 assert.equal(faces.length,6,'face paint does not split or replace the exported solid');
 // The importer exposes OCCT linear RGB. The existing STEP writer quantizes linear channels to 8 bits.
 const linear=(channel:number)=>{const c=channel/255;return Math.round((c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4)*255)/255;};
 assert.equal(faces.filter((face:any)=>face.color&&Math.abs(face.color[0]-linear(238))<1e-6&&Math.abs(face.color[1]-linear(34))<1e-6&&face.color[2]===0).length,1,'independent STEP reader retains the painted top face');
 const glb=await run({type:'export_model',params:{documentId:doc.documentId,format:'glb',skipAnalysis:true}});const data=Buffer.from(glb.result.artifact!.base64,'base64');assert.equal(data.toString('ascii',0,4),'glTF');const json=JSON.parse(data.toString('utf8',20,20+data.readUInt32LE(12)).trim());assert.equal(json.meshes.length,2);assert.equal(json.materials.length,2);assert.ok(json.materials.some((m:any)=>m.pbrMetallicRoughness.roughnessFactor===0.12));
 const exported=await run({type:'export_model',params:{documentId:doc.documentId,format:'json',skipAnalysis:true}});assert.deepEqual(JSON.parse(Buffer.from(exported.result.artifact!.base64,'base64').toString()).features[0].surfaceStyles,painted.result.document!.features[0].surfaceStyles);
});

test('public topology reads recover consumed inputs and reject stale storage and unavailable occurrence picks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-surface-picks-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bridge=await startBridge({port:0,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),workers:1});t.after(()=>bridge.close());await bridge.ready();
 const headers={Authorization:`Bearer ${bridge.connection.token}`,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};let sessionId:string|undefined;
 const call=async(type:string,params:Record<string,unknown>)=>{const response=await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify({requestId:params.requestId??crypto.randomUUID(),sessionId,command:{type,params}})});return await response.json() as any;};
 sessionId=(await call('agent_session',{action:'join',client:'surface-pick-regression'})).session.sessionId;
 const project=await call('documents',{action:'create_project',name:'Surface pick regression',requestId:crypto.randomUUID()});
 const documentId=(await call('documents',{action:'create',projectId:project.createdProjectId,name:'Consumed input',requestId:crypto.randomUUID()})).createdDocumentId;
 const edited=await call('apply_edits',{documentId,expectedRevision:0,analyze:false,edits:[{op:'add',feature:{id:'base',kind:'box',params:{origin:[0,0,0],size:[30,30,10]}}},{op:'add',feature:{id:'tool',kind:'box',params:{origin:[12,-1,-1],size:[6,32,12]}}},{op:'add',feature:{id:'cut',kind:'subtract',params:{target:'base',tools:['tool']}}}]});assert.equal(edited.status,'success',JSON.stringify(edited.error));
 const inspected=await call('inspect_model',{documentId,select:{topology:{target:{feature:'cut'}}}}),entry=inspected.inspection.topology[0],face=entry.faces[0];
 const pick={documentId,revision:inspected.revision,storageVersion:inspected.storageVersion,displayKey:entry.displayKey,feature:'cut',path:[],faceIndex:face.index,point:face.center,normal:face.normal};
 const accepted=await call('inspect_model',{documentId,select:{topology:{target:{feature:'cut'},faces:{pick}}}});assert.equal(accepted.status,'success',JSON.stringify(accepted.error));assert.equal(accepted.inspection.topology[0].faces.length,1);
 for(const bad of[{...pick,storageVersion:pick.storageVersion+1},{...pick,path:['unavailable']}]){const result=await call('inspect_model',{documentId,select:{topology:{target:{feature:'cut'},faces:{pick:bad}}}});assert.equal(result.error?.code,'TOPOLOGY_STALE');}
 const unavailable=await call('inspect_model',{documentId,select:{topology:{target:{feature:'cut',path:['unavailable']}}}});assert.equal(unavailable.error?.code,'REFERENCE_MISSING');assert.ok(unavailable.error.details.candidates.length);
 const hidden=await call('inspect_model',{documentId,select:{topology:{target:{feature:'base'}}}});assert.equal(hidden.status,'success',JSON.stringify(hidden.error));assert.equal(hidden.inspection.topology[0].faces.length,6);assert.ok(hidden.inspection.topology[0].faces.some((f:any)=>f.lineage.includes('+Z')));
 const restored=await call('inspect_model',{documentId,select:{topology:{target:{feature:'cut'},faces:{pick}}}});assert.equal(restored.status,'success',JSON.stringify(restored.error));assert.equal(restored.inspection.topology[0].faces.length,1,'hidden projection must not replace the normal prepared delivery');
});
test('opt-in MCP parameter logs keep reviewable CAD arguments and redact credential and inline payload fields',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-foundations-parameter-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const previousLog=process.env.VIBEWORKS_MCP_LOG,previousParameters=process.env.VIBEWORKS_MCP_LOG_PARAMETERS;process.env.VIBEWORKS_MCP_LOG=join(dir,'calls.jsonl');process.env.VIBEWORKS_MCP_LOG_PARAMETERS='1';
 t.after(()=>{if(previousLog===undefined)delete process.env.VIBEWORKS_MCP_LOG;else process.env.VIBEWORKS_MCP_LOG=previousLog;if(previousParameters===undefined)delete process.env.VIBEWORKS_MCP_LOG_PARAMETERS;else process.env.VIBEWORKS_MCP_LOG_PARAMETERS=previousParameters;});
 logMcpCall('apply_edits',{documentId:'fixture',edits:[{radius:2,token:'sensitive',content:{dataUrl:'inline'}}]}, {content:[]},performance.now());
 const entry=JSON.parse(await readFile(process.env.VIBEWORKS_MCP_LOG,'utf8'));assert.equal(entry.parameters.edits[0].radius,2);assert.equal(entry.parameters.edits[0].token,'[redacted]');assert.equal(entry.parameters.edits[0].content.dataUrl,'[redacted]');assert.equal(entry.parameters.documentId,'fixture');
});
