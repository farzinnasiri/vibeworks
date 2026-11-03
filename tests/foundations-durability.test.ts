import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {MemoryStore} from '../src/cad/store';
import {AnalysisJobs} from '../src/bridge/analysis-jobs';
import {emptyDocument} from '../src/cad/document';
import {pairDescriptor} from '../src/cad/analysis-plan';
import {identityMatrix,placementMatrix} from '../src/shared/display';
import {CadError} from '../src/cad/document';
import type {CadDocument,Feature} from '../src/shared/protocol';
const box=(id:string,x:number,size=10):Feature=>({id,kind:'box',params:{origin:[x,0,0],size:[size,10,10]},appearance:{material:'steel'}});
const document=(features:Feature[]):CadDocument=>({...emptyDocument(),features});
test('pair order uses each operands relative frame, with translations and rotations',()=>{
 const a={descriptor:'a',matrix:identityMatrix()},b={descriptor:'b',matrix:placementMatrix({rotationAxis:[0,0,1],angleDegrees:90,origin:[0,0,0],translation:[20,30,0]})};
 assert.equal(pairDescriptor(a,b),pairDescriptor(b,a));
 assert.notEqual(pairDescriptor(a,b),pairDescriptor(a,{...b,matrix:identityMatrix()}));
});
test('actual in-flight native termination records one pair and one isolated retry, other work completes',async()=>{
 const store=new MemoryStore(),doc=document([box('a',0),box('b',5),box('c',9),box('d',30)]);await store.put(doc);
 const attempts=new Map<string,number>();let killed:string|undefined;
 const jobs=new AnalysisJobs(store,{onEvent(event,worker){if(event.type==='pair'){attempts.set(event.key,(attempts.get(event.key)??0)+1);killed??=event.key;if(event.key===killed)worker.stop(new CadError('PAIR_TIMEOUT','deterministic actual in-flight termination'));}}});
 try{await jobs.initialize();const result=await jobs.command({documentId:doc.documentId,waitMs:20000});
 assert.equal(result.analysisJob?.state,'complete');assert.equal(result.analysisJob?.expensive.length,1);assert.equal(attempts.get(killed!),2);assert.ok(result.analysisJob!.progress.done>=4);assert.ok(result.analysis!.unknownPairs!.length);assert.equal(result.health?.ok,false);assert.ok((await store.pairFacts()).length>=2);
 }finally{await jobs.close();}
});
test('restart during native work preserves every completed fact, resumes automatically and keeps cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vibeworks-durable-'));let store=new SqliteStore(join(dir,'fixture.db'));
 const doc=document(Array.from({length:12},(_,i)=>box('b'+i,i*.6,10+i*.03)));await store.put(doc);
 let reached!:()=>void;const ready=new Promise<void>(r=>reached=r);let completed=0;
 let jobs=new AnalysisJobs(store,{onEvent(e,worker){if(e.type==='fact')completed++;if(e.type==='pair'&&completed>=20){worker.stop(new CadError('PAIR_TIMEOUT','fixture crash'));reached();}}});
 try{await jobs.initialize();const start=await jobs.command({documentId:doc.documentId});await ready;await jobs.close();const facts=await store.pairFacts();assert.ok(facts.length>=20);store.close();store=new SqliteStore(join(dir,'fixture.db'));const reopened=await store.pairFacts();assert.equal(reopened.length/facts.length,1);jobs=new AnalysisJobs(store);await jobs.initialize();const resumed=await jobs.command({jobId:start.analysisJob!.id,waitMs:20000});assert.equal(resumed.analysisJob!.state,'complete');assert.equal(resumed.analysisJob!.progress.done,66);assert.equal(resumed.analysis!.unknownPairs?.length??0,0);
 const cancel=await jobs.command({jobId:start.analysisJob!.id,action:'cancel'});assert.equal(cancel.analysisJob!.state,'cancelled');await jobs.close();store.close();store=new SqliteStore(join(dir,'fixture.db'));jobs=new AnalysisJobs(store);await jobs.initialize();assert.equal((await jobs.command({jobId:start.analysisJob!.id,action:'status'})).analysisJob!.state,'cancelled');
 }finally{await jobs.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('500 exact leaf bodies measure conservative broad phase separately from native nearest distances',async()=>{
 const store=new MemoryStore();const source=document(Array.from({length:5},(_,j)=>[box('seed'+j,j*160,1),{id:'array'+j,kind:'pattern',params:{target:'seed'+j,layout:{type:'linear',count:50,spacing:3,direction:[1,0,0]}}} as Feature]).flat());await store.put(source);
 const inst=(id:string,y:number):Feature=>({id,kind:'instance',params:{document:source.documentId,translation:[0,y,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0}});
 const top=document([inst('one',0),inst('two',100)]);await store.put(top);const jobs=new AnalysisJobs(store);
 try{await jobs.initialize();let result=await jobs.command({documentId:top.documentId,waitMs:20000,page:{limit:1000}});for(let n=0;n<3&&['running','queued'].includes(result.analysisJob!.state);n++)result=await jobs.command({jobId:result.analysisJob!.id,action:'status',waitMs:20000,page:{limit:1000}});assert.equal(result.analysis?.parts,500);assert.equal(result.analysisJob?.state,'complete');assert.ok(result.analysis!.broadPhase!.durationMs<1000);assert.equal(result.analysis!.broadPhase!.ruledOut,124750);assert.equal(result.analysis!.floating.length,499);console.log('LEAF_500',JSON.stringify({broadPhase:result.analysis!.broadPhase,facts:(await store.pairFacts()).length,cached:result.analysisJob!.progress.cached}));
 }finally{await jobs.close();}
});

test('scaled and mirrored pattern solids keep exact leaf identity and volume',async()=>{
 const store=new MemoryStore(),source=document([box('seed',0),{id:'array',kind:'pattern',params:{target:'seed',layout:{type:'linear',count:3,spacing:15,direction:[1,0,0]}}},{id:'scaled',kind:'transform',params:{target:'array',scale:2,copy:false,translation:[0,0,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0}},{id:'reflected',kind:'mirror',params:{target:'scaled',plane:'YZ',origin:[0,0,0],copy:true}}]);await store.put(source);const jobs=new AnalysisJobs(store);
 try{await jobs.initialize();const result=await jobs.command({documentId:source.documentId,waitMs:20000});assert.equal(result.analysisJob!.state,'complete');assert.equal(result.analysis!.parts,6);assert.equal(new Set(result.analysis!.leaves!.map(l=>l.id)).size,6);for(const leaf of result.analysis!.leaves!)assert.ok(Math.abs(leaf.volumeMm3-8000)<1e-7);assert.equal(result.analysis!.interferences.length,0);
 }finally{await jobs.close();}
});

test('declared occurrence targets report the authored identity rather than a temporary kernel alias',async()=>{
 const store=new MemoryStore(),source=document([box('body',0)]);source.analysis={checks:[{id:'size',a:{feature:'body'},expect:'size',axis:'X',mm:10,toleranceMm:.001}]};await store.put(source);const jobs=new AnalysisJobs(store);
 try{await jobs.initialize();const r=await jobs.command({documentId:source.documentId,waitMs:20000});assert.equal(r.analysis!.checks[0].a,'body');assert.equal(r.analysis!.checks[0].ok,true);assert.doesNotMatch(r.analysis!.checks[0].message,/__analysis/);}
 finally{await jobs.close();}
});
