import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
const [state,phase,pidArg]=process.argv.slice(2);if(!state?.includes('vibeworks-foundations-stack-')||!['before','after'].includes(phase))throw Error('Pass owned fixture state and before|after.');
const marker=JSON.parse(await readFile(join(state,'foundations-stack.json'),'utf8'));assert.equal(marker.owner,'vibeworks-foundations-2026-11-02');
const c=JSON.parse(await readFile(join(state,'connection.json'),'utf8')),out=new URL('../artifacts/foundations/e2-e/',import.meta.url);let sessionId;
const headers={Authorization:`Bearer ${c.token}`,'Content-Type':'application/json','X-Vibeworks-Fingerprint':c.fingerprint};
async function call(type,params){const body=JSON.stringify({requestId:type==='documents'&&['create','create_project','extract'].includes(params.action)?params.requestId:crypto.randomUUID(),sessionId,command:{type,params}}),start=performance.now();const response=await fetch(c.httpUrl+'/command',{method:'POST',headers,body}),text=await response.text(),result=JSON.parse(text);await appendFile(new URL('restart-calls.jsonl',out),JSON.stringify({timestamp:new Date().toISOString(),phase,type,argumentBytes:Buffer.byteLength(body),resultBytes:Buffer.byteLength(text),status:result.status,error:result.error?.code,durationMs:performance.now()-start})+'\n');assert.equal(result.status,'success',JSON.stringify(result));return result;}
sessionId=(await call('agent_session',{action:'join',client:'e2-e-restart-fixture'})).session.sessionId;
const db=new DatabaseSync(join(state,'workspace.db'),{readOnly:true});const facts=()=>db.prepare('SELECT key,used_at FROM pair_facts').all();
if(phase==='before'){
 const pid=Number(pidArg),command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});assert.ok(command.includes('start-foundations-stack.mjs')&&command.includes(state),'PID is not this owned fixture launcher');
 const prior=new Set(facts().map(f=>f.key));const d=await call('documents',{action:'create',requestId:crypto.randomUUID(),name:'Durable analysis restart fixture'});
 await call('apply_edits',{documentId:d.documentId,expectedRevision:0,analyze:false,edits:Array.from({length:55},(_,i)=>({op:'add',feature:{id:'body_'+i,kind:'box',params:{origin:[i*.11,0,0],size:[12+i*.013,11+i*.007,10]},appearance:{material:'steel'}}}))});
 const start=await call('analyze_model',{documentId:d.documentId,action:'run'});assert.ok(['queued','running'].includes(start.analysisJob.state));
 const other=await call('documents',{action:'create',requestId:crypto.randomUUID(),name:'Interactive edit during background checks'});const edit=await call('apply_edits',{documentId:other.documentId,expectedRevision:0,analyze:false,edits:[{op:'add',feature:{id:'body',kind:'box',params:{origin:[0,0,0],size:[5,5,5]}}}]});assert.equal(edit.revision,1);
 const end=Date.now()+20000;let saved,completed;
 do{saved=JSON.parse(db.prepare('SELECT body FROM analysis_jobs WHERE id=?').get(start.analysisJob.id).body);completed=facts().filter(f=>!prior.has(f.key));if(saved.job.inFlight&&completed.length>=20)break;await new Promise(r=>setTimeout(r,5));}while(Date.now()<end);
 assert.ok(saved.job.inFlight&&completed.length>=20,'Fixture never observed actual persisted native pair plus completed facts');
 await writeFile(new URL('restart-before.json',out),JSON.stringify({state,documentId:d.documentId,jobId:start.analysisJob.id,completed,job:saved.job,interactiveEditRevision:edit.revision},null,2));db.close();process.kill(pid,'SIGKILL');console.log(JSON.stringify({status:'crashed-owned-fixture',completedFacts:completed.length,inFlight:saved.job.inFlight.a+' / '+saved.job.inFlight.b}));
}else{
 const before=JSON.parse(await readFile(new URL('restart-before.json',out),'utf8'));let result=await call('analyze_model',{jobId:before.jobId,action:'status',waitMs:20000,page:{limit:1000}});for(let n=0;n<3&&['queued','running'].includes(result.analysisJob.state);n++)result=await call('analyze_model',{jobId:before.jobId,action:'status',waitMs:20000,page:{limit:1000}});
 assert.equal(result.analysisJob.state,'complete');assert.equal(result.analysisJob.progress.done,1485);assert.equal(result.analysisJob.progress.unknown,0);const rows=new Map(facts().map(f=>[f.key,f.used_at])),reused=before.completed.filter(f=>rows.get(f.key)===f.used_at).length;assert.ok(reused/before.completed.length>=.95);
 const recovery=await call('documents',{action:'list',requestId:JSON.parse(await readFile(new URL('commands.json',out),'utf8')).operationId});assert.equal(recovery.replayed,true);
 await call('analyze_model',{jobId:before.jobId,action:'cancel'});assert.equal((await call('analyze_model',{jobId:before.jobId,action:'status'})).analysisJob.state,'cancelled');
 await writeFile(new URL('restart-after.json',out),JSON.stringify({status:'passed',completedBefore:before.completed.length,reusedWithoutRecomputation:reused,reuseFraction:reused/before.completed.length,job:result.analysisJob,coverage:result.analysis.coverage,recoveredExtraction:recovery.createdDocumentId},null,2));db.close();console.log(JSON.stringify({status:'passed',before:before.completed.length,reused}));
}
