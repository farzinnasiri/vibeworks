import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {startBridge} from '../src/bridge/server';
import {ServiceMonitor} from '../src/bridge/service-monitor';
import {serviceStatusSchema,type CadCommand} from '../src/shared/protocol';
import {CONTRACT_FINGERPRINT} from '../src/bridge/fingerprint';
import {PROJECT_ROOT} from '../src/bridge/connection';

const until=async(check:()=>Promise<boolean>)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error('Timed out waiting for observable service state');await new Promise(resolve=>setTimeout(resolve,20));}};

test('every project is deletable, including the starter, and reopening does not resurrect it',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-project-removal-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'workspace.db');
 let store=new SqliteStore(path);const [project]=(await store.operation({action:'projects'})).projects!;
 await store.operation({action:'remove_project',projectId:project.projectId,expectedVersion:project.version,documentVersions:{}});store.close();
 store=new SqliteStore(path);assert.deepEqual((await store.operation({action:'projects'})).projects,[]);store.close();
});

test('restart refuses to interrupt an accepted edit',{timeout:30_000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-service-busy-'));
 const bridge=await startBridge({port:0,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),workers:1});
 t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});await bridge.ready();
 const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':CONTRACT_FINGERPRINT};
 const command=async(command:CadCommand,sessionId?:string)=>(await(await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),command,sessionId})})).json());
 const sessionId=(await command({type:'agent_session',params:{action:'join',client:'busy-restart-test'}})).session.sessionId;
 const docId=(await command({type:'documents',params:{action:'list'}},sessionId)).documentId;
 const editing=command({type:'apply_edits',params:{documentId:docId,expectedRevision:0,analyze:false,edits:Array.from({length:120},(_,i)=>({op:'add' as const,feature:{id:`piece_${i}`,kind:'cylinder' as const,params:{origin:[i*30,0,0] as [number,number,number],radius:10,height:20}}}))}},sessionId);
 await until(async()=>{const status=await(await fetch(bridge.connection.httpUrl+'/service',{headers})).json();return status.pending>0;});
 const restart=await fetch(bridge.connection.httpUrl+'/service/restart',{method:'POST',headers,body:'{"action":"restart"}'});
 assert.equal(restart.status,409);assert.equal((await restart.json()).error.code,'SERVICE_BUSY');
 const saved=await editing;assert.equal(saved.status,'success',JSON.stringify(saved));assert.equal(saved.revision,1);
 const inspected=await command({type:'inspect_model',params:{detail:'full',documentId:docId}},sessionId);assert.equal(inspected.geometry.length,120);assert.equal(inspected.revision,1);
});

test('service request window and MCP leases are bounded and failures settle only once',()=>{
 let now=100_000;const monitor=new ServiceMonitor(()=>now);monitor.presence(randomUUID(),'heartbeat');const first=monitor.begin(true);first(true);first(true);
 assert.equal(monitor.read().requests.failed,1);assert.equal(monitor.read().requests.active,0);assert.equal(monitor.read().mcpClients,1);
 now+=61_000;assert.equal(monitor.read().mcpClients,0);assert.equal(monitor.read().requests.samples.reduce((n,s)=>n+s.count,0),0);assert.equal(monitor.read().requests.total,1);
 const id=monitor.read().serviceId;monitor.restart();assert.notEqual(monitor.read().serviceId,id);assert.equal(monitor.read().requests.total,0);assert.equal(monitor.read().uptimeMs,0);
});

test('authenticated service monitor sees real MCP traffic and restart preserves projects, revision and replay identity',{timeout:60_000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cad-service-')),file=join(dir,'connection.json');
 const bridge=await startBridge({port:0,databasePath:join(dir,'workspace.db'),connectionFile:file,workers:1});t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});await bridge.ready();
 const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':CONTRACT_FINGERPRINT};
 const monitor=async()=>serviceStatusSchema.parse(await(await fetch(bridge.connection.httpUrl+'/service',{headers})).json());
 assert.equal((await fetch(bridge.connection.httpUrl+'/service')).status,401);assert.equal((await fetch(bridge.connection.httpUrl+'/service/restart',{method:'POST',body:'{"action":"restart"}',headers:{'Content-Type':'application/json'}})).status,401);
 const client=new Client({name:'service-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(PROJECT_ROOT,'src/bridge/mcp.ts')],cwd:PROJECT_ROOT,env:{...process.env,VIBEWORKS_CONNECTION_FILE:file} as Record<string,string>}));t.after(()=>client.close());
 await until(async()=> (await monitor()).mcpClients===1);
 const tool=async(name:string,args:Record<string,unknown>)=>(await client.callTool({name,arguments:args})).structuredContent as any;
 const joined=await tool('agent_session',{action:'join',client:'service-test'});const sessionId=joined.session.sessionId;
 const list=await tool('documents',{action:'list',sessionId});assert.equal(list.status,'success');
 const docId=list.documentId,project=list.projects[0];const requestId=randomUUID();
 const envelope={requestId,sessionId,command:{type:'apply_edits',params:{documentId:docId,expectedRevision:0,analyze:false,edits:[{op:'add',feature:{id:'body',kind:'box',params:{origin:[0,0,0],size:[10,20,30]}}}]}}};
 const command=async(body:object)=>(await(await fetch(bridge.connection.httpUrl+'/command',{method:'POST',headers,body:JSON.stringify(body)})).json());
 const changed=await command(envelope);assert.equal(changed.status,'success');
 const before=await monitor();assert.ok(before.memoryBytes>0);assert.ok(before.storageBytes>0);assert.ok(before.requests.mcp>=1);assert.ok(before.requests.total>=2);assert.equal(before.phase,'online');
 const response=await fetch(bridge.connection.httpUrl+'/service/restart',{method:'POST',headers,body:'{"action":"restart"}'});assert.equal(response.status,200,await response.text());
 const after=await monitor();assert.notEqual(after.serviceId,before.serviceId);assert.equal(after.mcpClients,1);assert.ok(after.uptimeMs<5000);
 const recovered=await command(envelope);assert.equal(recovered.status,'success');assert.equal(recovered.revision,1);assert.ok(recovered.replayed);
 const inspected=await tool('inspect_model',{detail:'full',documentId:docId,sessionId});assert.equal(inspected.revision,1);assert.equal(inspected.geometry[0].volumeMm3,6000);
 const deleted=await tool('documents',{action:'delete_project',projectId:project.projectId,expectedStorageVersion:project.version,documentVersions:{[docId]:changed.storageVersion},sessionId});assert.equal(deleted.status,'success',JSON.stringify(deleted));
 const emptyDefinition=await tool('inspect_model',{definitionsOnly:true,sessionId});assert.equal(emptyDefinition.status,'success',JSON.stringify(emptyDefinition));assert.deepEqual(emptyDefinition.documents,undefined);
 const restartEmpty=await fetch(bridge.connection.httpUrl+'/service/restart',{method:'POST',headers,body:'{"action":"restart"}'});assert.equal(restartEmpty.status,200);
 const empty=await tool('documents',{action:'list',sessionId});assert.equal(empty.status,'success',JSON.stringify(empty));assert.deepEqual(empty.projects,[]);assert.deepEqual(empty.documents,[]);
 const newProject=await tool('documents',{action:'create_project',name:'Fresh project',sessionId});assert.equal(newProject.status,'success',JSON.stringify(newProject));
 const created=await tool('documents',{action:'create',kind:'assembly',projectId:newProject.createdProjectId,sessionId});assert.equal(created.status,'success',JSON.stringify(created));
 const rediscovered=await tool('inspect_model',{sessionId});assert.equal(rediscovered.status,'success',JSON.stringify(rediscovered));assert.equal(rediscovered.documentId,created.documentId);
 await client.close();await until(async()=> (await monitor()).mcpClients===0);
});
