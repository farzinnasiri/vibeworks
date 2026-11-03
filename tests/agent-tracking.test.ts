import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {Collaboration,SESSION_LEASE_MS} from '../src/bridge/collaboration';
import {startBridge} from '../src/bridge/server';
import {forwardCommand,useAgentSession} from '../src/bridge/client';
import {CONTRACT_FINGERPRINT} from '../src/bridge/fingerprint';
import {parseCommand,LEGACY_PROJECT_ID,type CadResult} from '../src/shared/protocol';
import {emptyDocument} from '../src/cad/document';
const ok=(r:CadResult)=>{assert.equal(r.status,'success',JSON.stringify(r.error));return r;};
const box=(x=10)=>({id:'body',kind:'box',params:{origin:[0,0,0],size:[x,10,10]}});

test('generated identities are unique; live resume is refused; expired resume preserves identity and handoff while ending the old session',()=>{
 const store=new SqliteStore(':memory:');let now=Date.now();const collaboration=new Collaboration((store as any).db,()=>now);
 try{
  const a=collaboration.command({action:'join',client:'codex',projectIds:[LEGACY_PROJECT_ID]});
  assert.match(a.agent.name,/^[a-z]+_[a-z]+/);
  assert.throws(()=>collaboration.command({action:'resume',agent:a.agent.name,client:'claude'}),e=>(e as any).code==='AGENT_ACTIVE');
  const own=collaboration.command({action:'resume',agent:a.agent.name,client:'codex'},a.session.sessionId);
  assert.equal(own.session.sessionId,a.session.sessionId,'resuming the caller own live session does not create a competing session');
  const clientInstanceId=crypto.randomUUID();
  const adapter=collaboration.command({action:'join',client:'codex',clientInstanceId});
  assert.equal(collaboration.command({action:'resume',agent:adapter.agent.name,client:'codex',clientInstanceId}).session.sessionId,adapter.session.sessionId);
  assert.throws(()=>collaboration.command({action:'resume',agent:adapter.agent.name,client:'codex',clientInstanceId:crypto.randomUUID()}),e=>(e as any).code==='AGENT_ACTIVE');
  collaboration.command({action:'handoff',handoff:'Preserve the chassis fillet. Check the cover next.'},a.session.sessionId);
  now+=SESSION_LEASE_MS+1;
  const resumed=collaboration.command({action:'resume',agent:a.agent.name,client:'claude',model:'declared-model'});
  assert.equal(resumed.agent.agentId,a.agent.agentId);assert.notEqual(resumed.session.sessionId,a.session.sessionId);assert.match(resumed.session.handoff!,/fillet/);
  assert.throws(()=>collaboration.command({action:'heartbeat'},a.session.sessionId),e=>(e as any).code==='AGENT_SESSION_EXPIRED');
  const other=collaboration.command({action:'join',client:'codex',continuedFrom:a.agent.name});assert.notEqual(other.agent.agentId,a.agent.agentId);assert.equal(other.agent.continuedFrom,a.agent.agentId);
  const names=new Set([a.agent.name,other.agent.name]);for(let i=0;i<30;i++){const n=collaboration.command({action:'join',client:'cli'}).agent.name;assert.equal(names.has(n),false);names.add(n);}
  assert.equal(collaboration.query({agentId:a.agent.agentId}).operations.find(o=>o.operation==='handoff')!.handoff,'Preserve the chassis fillet. Check the cover next.');
 }finally{store.close();}
});

test('snapshots reconstruct exact source versions across projects and survive later edits, deletions and reopening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-graphs-')),path=join(dir,'workspace.db');let store=new SqliteStore(path);
 try{
  const other=crypto.randomUUID();await store.operation({action:'project',project:{projectId:other,name:'Sources',version:1},expectedVersion:null});
  const source={...emptyDocument(),projectId:other,features:[box()]};await store.put(source as any);
  const root={...emptyDocument(),features:[{id:'mounted',kind:'instance',params:{document:source.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]};await store.put(root as any);
  const before=(await store.operation({action:'snapshot',documentId:root.documentId})).graph!;
  const sequence=before.snapshot.cursor;
  await store.put({...source,revision:1,features:[box(20)]} as any,1);
  const latest=(await store.operation({action:'snapshot',documentId:root.documentId})).graph!;
  assert.equal(latest.snapshot.storageVersion,before.snapshot.storageVersion);assert.equal(latest.snapshot.sources[0].storageVersion,2);
  const historical=(await store.operation({action:'snapshot',documentId:root.documentId,snapshot:{sequence}})).graph!;
  assert.equal((historical.documents[0].features[0].params as any).size[0],10);
  await store.put(emptyDocument(),null);await store.remove(root.documentId,1);await store.remove(source.documentId,2);
  store.close();store=new SqliteStore(path);
  const reopened=(await store.operation({action:'snapshot',documentId:root.documentId,snapshot:{id:before.snapshot.snapshotId}})).graph!;
  assert.deepEqual(reopened,before);
  assert.equal(store.collaboration.query({changesOnly:true}).operations.every(o=>!o.agentId),true,'legacy imports never invent an actor');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('real HTTP commands require enrollment, attribute concurrent writes atomically, retain failures and replay a frozen graph after source changes', {timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-agents-'));const connectionFile=join(dir,'connection.json');
 const bridge=await startBridge({port:0,databasePath:join(dir,'workspace.db'),connectionFile});await bridge.ready();
 const connection=JSON.parse(await readFile(connectionFile,'utf8'));
 const call=(type:string,params:unknown,sessionId?:string)=>forwardCommand(parseCommand({type,params}),async()=>connection,CONTRACT_FINGERPRINT,{sessionId,heartbeat:false});
 try{
  useAgentSession(undefined);
  assert.equal((await call('inspect_model',{})).error?.code,'AGENT_SESSION_REQUIRED');
  const a=ok(await call('agent_session',{action:'join',client:'codex',projectIds:[LEGACY_PROJECT_ID]})),b=ok(await call('agent_session',{action:'join',client:'claude',projectIds:[LEGACY_PROJECT_ID]}));
  const s1=a.session!.sessionId,s2=b.session!.sessionId;
  const cli=await promisify(execFile)(process.execPath,['--import','tsx','src/bridge/cli.ts','activity','--session',s1],{env:{...process.env,VIBEWORKS_CONNECTION_FILE:connectionFile,VIBEWORKS_AGENT_SESSION:crypto.randomUUID()}});
  assert.equal(JSON.parse(cli.stdout).status,'success','explicit CLI session overrides the environment');
  const created=ok(await call('documents',{action:'create',name:'Tracked source',requestId:crypto.randomUUID()},s1));
  const id=created.documentId!;
  const passive=async(sessionId:string)=>JSON.parse(await(await fetch(connection.httpUrl+'/command',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':CONTRACT_FINGERPRINT},body:JSON.stringify({requestId:crypto.randomUUID(),sessionId,passive:true,command:{type:'inspect_model',params:{documentId:id}}})})).text());
  assert.equal((await passive(s1)).error.code,'INVALID_PASSIVE_READ','agent work cannot masquerade as personal observation');
  const human=ok(await call('agent_session',{action:'join',kind:'human',client:'browser-test'}));
  assert.equal((await passive(human.session!.sessionId)).status,'success');
  const observations=ok(await call('activity',{agentId:human.agent!.agentId}));assert.equal(observations.operations!.length,0,'background human observation does not pollute history');
  ok(await call('apply_edits',{documentId:id,expectedRevision:0,edits:[{op:'add',feature:box()}],intent:{purpose:'Establish stock',rationale:'Start with a simple solid.'}},s1));
  const otherProject=crypto.randomUUID();
  ok(await call('documents',{action:'create_project',projectId:otherProject,name:'Assembly project'},s1));
  const root=ok(await call('documents',{action:'create',projectId:otherProject,name:'Tracked assembly',kind:'assembly',requestId:crypto.randomUUID()},s1));
  ok(await call('apply_edits',{documentId:root.documentId,expectedRevision:0,edits:[{op:'add',feature:{id:'placed',kind:'instance',params:{document:id,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}}]},s1));
  const frozen=ok(await call('inspect_model',{documentId:root.documentId,snapshot:{},replay:{step:1,expectedRevision:1,expectedStorageVersion:2}},s1));
  assert.ok(frozen.snapshot);
  const outcomes=await Promise.all([call('apply_edits',{documentId:id,expectedRevision:1,edits:[{op:'update',feature:box(12)}]},s1),call('apply_edits',{documentId:id,expectedRevision:1,edits:[{op:'update',feature:box(14)}]},s2)]);
  assert.equal(outcomes.filter(r=>r.status==='success').length,1);assert.equal(outcomes.find(r=>r.status==='error')!.error!.code,'REVISION_CONFLICT');
  const again=ok(await call('inspect_model',{documentId:root.documentId,snapshot:{id:frozen.snapshot!.snapshotId},replay:{step:1,expectedRevision:1,expectedStorageVersion:2,key:frozen.replay!.key}},s2));
  assert.deepEqual(again.geometry,frozen.geometry);
  const otherHistory=ok(await call('activity',{projectId:otherProject,limit:100},s1));
  const projectCreation=otherHistory.operations!.find(o=>o.action==='create_project')!;assert.equal(projectCreation.documentId,undefined,'project metadata must not inherit an arbitrary result document');
  assert.ok(otherHistory.operations!.some(o=>o.documentId===id&&o.toVersion===3),'a source edit is visible in the affected assembly project');
  const history=ok(await call('activity',{projectId:LEGACY_PROJECT_ID,limit:100},s1));
  const committed=history.operations!.filter(o=>o.documentId===id&&o.toVersion);
  assert.equal(committed.length,3);assert.ok(committed.every(o=>o.sessionId&&o.snapshotId&&o.commitSequence));
  assert.equal(history.operations!.some(o=>o.status==='error'&&o.error?.code==='REVISION_CONFLICT'),true);
  assert.match(committed.find(o=>o.intent)?.intent?.rationale??'',/simple solid/);
  assert.equal(history.participants!.filter(p=>p.identity.kind==='agent').length,2);
  const replayFromCommit=ok(await call('inspect_model',{detail:'full',documentId:id,snapshot:{id:committed.find(o=>o.toVersion===2)!.snapshotId}},s2));assert.equal((replayFromCommit.document!.features[0].params as any).size[0],10);
 }finally{useAgentSession(undefined);await bridge.close();await rm(dir,{recursive:true,force:true});}
});

test('attribution and frozen manifests roll back with a rejected model commit; expired sessions cannot commit late',async()=>{
 const store=new SqliteStore(':memory:'),db=(store as any).db;
 try{
  const person=store.collaboration.command({action:'join',client:'transaction-check'}),d={...emptyDocument(),features:[box()]};await store.put(d as any,null);
  const context=store.collaboration.begin(crypto.randomUUID(),person.session.sessionId,parseCommand({type:'apply_edits',params:{documentId:d.documentId,expectedRevision:0,edits:[{op:'update',feature:box(15)}]}}));
  db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON revision_context BEGIN SELECT RAISE(ABORT,'controlled context failure'); END");
  const before=await store.read(d.documentId),feed=(await store.operation({action:'changes',after:0})).changes;
  await assert.rejects(store.operation({action:'write',document:{...d,revision:1,features:[box(15)]},expectedVersion:1,history:{undo:[d],redo:[]},context} as any),/controlled context failure/);
  assert.deepEqual(await store.read(d.documentId),before);assert.deepEqual((await store.operation({action:'changes',after:0})).changes,feed);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revision_context').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_snapshots').get().n,0);
  assert.equal(store.collaboration.query({}).operations.find(o=>o.operationId===context.operationId)!.toVersion,undefined);
  db.exec('DROP TRIGGER reject_context');store.collaboration.command({action:'leave'},person.session.sessionId);
  await assert.rejects(store.operation({action:'write',document:{...d,revision:1},expectedVersion:1,history:{undo:[d],redo:[]},context} as any),{code:'AGENT_SESSION_EXPIRED'});
  assert.deepEqual(await store.read(d.documentId),before);
 }finally{store.close();}
});
