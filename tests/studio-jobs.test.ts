import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StudioJobs} from '../src/bridge/studio-jobs';
import {emptyDocument} from '../src/cad/document';
import {parseCommand, unknownHealth, type CadResult, type CadCommand} from '../src/shared/protocol';
import {resultSchema} from '../src/bridge/validation';
import type {StudioImageRunner} from '../src/bridge/studio-image-renderer';
import type {Evaluation} from '../src/cad/types';
import type {FrozenGraph} from '../src/shared/protocol';

const doc=emptyDocument();
const base:CadResult={operation:'render_image',status:'success',documentId:doc.documentId,revision:0,storageVersion:1,
  created:[],updated:[],warnings:[],document:doc,health:unknownHealth(),provenance:{documentId:doc.documentId,revision:0,sources:[]}};
const evaluation:Evaluation={geometry:[],meshes:[],visibleFeatureIds:[]};
const start=()=>({action:'start' as const,requestId:randomUUID(),documentId:doc.documentId});
const turn=()=>new Promise<void>(r=>setImmediate(r));

test('Studio jobs freeze inputs, reuse request identities and keep control calls outside rendering',async()=>{
 const captures:any[]=[];
 const run:StudioImageRunner=(payload,progress,signal)=>new Promise((_,reject)=>{
  captures.push(JSON.parse(payload));progress({phase:'rendering',samples:3,target:64,elapsedMs:250,etaMs:5000});
  signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
 });
 const jobs=new StudioJobs(run);try{
  const first={...start(),presentation:{exposure:1.2}};
  const accepted=jobs.start(first,structuredClone(base),evaluation);resultSchema.parse(accepted);
  first.presentation.exposure=2;
  await turn();assert.equal(captures[0].job.presentation.exposure,1.2);
  const retry={...first,presentation:{exposure:1.2}};
  assert.equal(jobs.existing(retry)!.renderJob!.jobId,accepted.renderJob!.jobId);
  assert.throws(()=>jobs.existing(first),(e:any)=>e.code==='REQUEST_ID_CONFLICT');
  const status=jobs.control({action:'status',jobId:first.requestId});resultSchema.parse(status);
  assert.equal(status.renderJob!.samples,3);assert.equal(status.image,undefined);
  const second=start();jobs.start(second,base,evaluation);
  assert.throws(()=>jobs.start(start(),base,evaluation),(e:any)=>e.code==='RENDERER_BUSY');
  assert.equal(jobs.control({action:'cancel',jobId:second.requestId}).renderJob!.state,'cancelled');
  assert.equal(jobs.control({action:'cancel',jobId:first.requestId}).renderJob!.state,'cancelled');
  await turn();assert.equal(captures.length,1,'cancelled queued work never reaches the GPU');
  assert.equal(jobs.control({action:'result',jobId:first.requestId}).image,undefined);
 }finally{await jobs.close();}
});

test('Studio failures and deadlines remain explicit and cancelled work cannot publish a late result',async()=>{
 let resolve!:(v:any)=>void;
 const jobs=new StudioJobs(()=>new Promise(r=>{resolve=r;}));
 const p=start();jobs.start(p,base,evaluation);await turn();
 jobs.control({action:'cancel',jobId:p.requestId});resolve({base64:'late'});await turn();
 assert.equal(jobs.control({action:'status',jobId:p.requestId}).renderJob!.state,'cancelled');await jobs.close();
 const timed=new StudioJobs((_payload,_progress,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')))),15);
 try{
  const p=start();timed.start(p,base,evaluation);await new Promise(r=>setTimeout(r,30));
  const result=timed.control({action:'result',jobId:p.requestId});resultSchema.parse(result);
  assert.equal(result.error?.code,'RENDER_TIMEOUT');assert.equal(result.image,undefined);
 }finally{await timed.close();}
 const failed=new StudioJobs(async()=>{throw Error('GPU unavailable');});
 try{const p=start();failed.start(p,base,evaluation);await turn();const r=failed.control({action:'result',jobId:p.requestId});
  assert.equal(r.error?.code,'STUDIO_RENDER_FAILED');assert.match(r.error!.message,/GPU unavailable/);resultSchema.parse(r);
 }finally{await failed.close();}
});

test('Studio commands reject unsupported overlays and ambiguous action fields before dispatch',()=>{
 const params=start();
 for(const extra of [{output:{size:'viewport'}},{shot:{view:'top',section:{axis:'Z',offset:0}}},{shot:{view:'top',ghost:['part']}},{output:{samples:100000}}])
  assert.throws(()=>parseCommand({type:'render_image',params:{...params,...extra}}));
 assert.throws(()=>parseCommand({type:'render_image',params:{action:'status',jobId:params.requestId,documentId:doc.documentId}}));
 const parsed=parseCommand({type:'render_image',params:{...params,output:{}}}) as Extract<CadCommand,{type:'render_image'}>;
 assert.ok(parsed.params.action==='start');if(parsed.params.action==='start')assert.deepEqual(parsed.params.output,{size:'hd',quality:'standard',denoise:true});
});

test('accepted Studio jobs freeze definitions and source versions before asynchronous exact preparation',async()=>{
 const source={...emptyDocument(),revision:4};
 const graph:FrozenGraph={document:structuredClone(doc),documents:[source],snapshot:{snapshotId:randomUUID(),documentId:doc.documentId,
  revision:0,storageVersion:1,sources:[{documentId:source.documentId,revision:4,storageVersion:5}],engineVersion:'test',cursor:1,createdAt:new Date().toISOString()}};
 let captured:any;
 const jobs=new StudioJobs((payload,_progress,signal)=>new Promise((_,reject)=>{
  captured=JSON.parse(payload);signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
 }));
 try{
  const p=start(),accepted=jobs.startGraph(p,graph);resultSchema.parse(accepted);
  source.revision=5;graph.document.name='changed after acceptance';
  await turn();
  assert.equal(captured.graph.documents[0].revision,4);
  assert.notEqual(captured.graph.document.name,'changed after acceptance');
  assert.equal(accepted.provenance!.sources[0].revision,4);
  assert.equal(accepted.health!.analysis,'unavailable','preparation has not certified the capture yet');
  assert.equal(jobs.control({action:'cancel',jobId:p.requestId}).renderJob!.state,'cancelled');
 }finally{await jobs.close();}
});
