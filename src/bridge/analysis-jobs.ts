import { createHash } from 'node:crypto';
import { ENGINE_VERSION, type AnalysisJob, type AnalysisReport, type CadCommand, type CadResult, type FrozenGraph } from '../shared/protocol';
import { ANALYSIS_ALGORITHM, type AnalysisEvent } from '../cad/analysis-plan';
import { NodeGeometryWorker } from '../cad/node-worker';
import { DocumentStore } from '../cad/store';
import { CadError } from '../cad/document';
import { modelHealth, publicAnalysis } from '../cad/health';
import type { Evaluation } from '../cad/types';
export interface SavedJob { job:AnalysisJob; graph:FrozenGraph; featureIds?:string[]; report?:AnalysisReport; historical?:boolean; evaluation?:Pick<Evaluation,'geometry'|'visibleFeatureIds'>; identity?:string; engineVersion?:string }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One background kernel, one native pair at a time. Only plain definitions and numeric facts survive it. */
export class AnalysisJobs {
 private worker:NodeGeometryWorker;
 private jobs=new Map<string,SavedJob>(); private pumping=false; private pumpDone?:Promise<void>; private persistence=Promise.resolve(); private persistenceError?:unknown;private closed=false;private pairTimer?:ReturnType<typeof setTimeout>;private active?:SavedJob;
 constructor(private store:DocumentStore,private options:{pairMs?:number;retryMs?:number;onEvent?:(event:AnalysisEvent,worker:NodeGeometryWorker)=>void}={}){
  if(process.env.VIBEWORKS_ANALYSIS_WORKER==='0')throw new CadError('ANALYSIS_CONFIG','VIBEWORKS_ANALYSIS_WORKER=0 is unsupported. Enable the single bounded analysis worker.');
  this.worker=new NodeGeometryWorker({timeoutMs:150_000,onAnalysisEvent:event=>this.event(event)});
 }
 async initialize(){for(const saved of await this.store.analysisRecords()){if((saved.engineVersion??saved.graph.snapshot.engineVersion)!==ENGINE_VERSION){saved.job.state='error';saved.job.error='Engine changed; request a new analysis.';}else if(['running','queued'].includes(saved.job.state)){saved.job.state='queued';if(saved.job.inFlight){const p=saved.job.inFlight;saved.job.expensive.push({...p,attempts:1,elapsedMs:Date.now()-p.startedAt,error:'interrupted'});delete saved.job.inFlight;}}this.jobs.set(saved.job.id,saved);await this.save(saved);}void this.pump();}
 private async save(saved:SavedJob){await this.store.saveAnalysis(saved.job.id,saved);while(this.jobs.size>72){const old=[...this.jobs.values()].find(s=>!['queued','running'].includes(s.job.state)&&s!==this.active);if(!old)break;this.jobs.delete(old.job.id);}}
 private persist(action:()=>Promise<unknown>){this.persistence=this.persistence.then(action).then(()=>{},error=>{this.persistenceError=error;this.worker.stop(new CadError('ANALYSIS_STORAGE','Analysis facts could not be persisted.'));});}
 private event(event:AnalysisEvent){const saved=this.active;if(!saved)return;
  if(event.type==='leaves'){saved.job.progress.leafBodies=event.leaves.length;saved.job.progress.candidatePairs=event.leaves.length*(event.leaves.length-1)/2;}
  if(event.type==='pair'){
   clearTimeout(this.pairTimer);saved.job.inFlight={...event,startedAt:Date.now()};
   const prior=saved.job.expensive.find(p=>p.key===event.key);const ms=prior?this.options.retryMs??120_000:this.options.pairMs??25_000;
   this.pairTimer=setTimeout(()=>this.worker.stop(new CadError('PAIR_TIMEOUT','Exact native pair deadline exceeded.')),ms);
  }
  if(event.type==='fact'){saved.job.expensive=saved.job.expensive.filter(p=>p.key!==event.fact.key);clearTimeout(this.pairTimer);delete saved.job.inFlight;this.persist(()=>this.store.savePairFact(event.fact));saved.job.progress.done++;}
  if(event.type==='failure'){clearTimeout(this.pairTimer);delete saved.job.inFlight;const old=saved.job.expensive.find(p=>p.key===event.key);if(old){old.attempts=2;old.error=event.error;}else saved.job.expensive.push({key:event.key,a:event.a,b:event.b,error:event.error,attempts:1,elapsedMs:0});}
  const copy={...saved,job:structuredClone(saved.job)};this.persist(()=>this.save(copy));this.options.onEvent?.(event,this.worker);
 }
 private async current(saved:SavedJob){return (await Promise.all([{documentId:saved.graph.document.documentId,storageVersion:saved.graph.snapshot.storageVersion},...saved.graph.snapshot.sources].map(async s=>(await this.store.body(s.documentId))?.version===s.storageVersion))).every(Boolean);}
 async supersede(){for(const saved of this.jobs.values())if(['running','queued','complete'].includes(saved.job.state)&&!saved.historical&&!await this.current(saved)){saved.job.state='superseded';await this.save(saved);if(this.active===saved)this.worker.stop();}}
 private pump():Promise<void>{
  if(this.pumping||this.closed)return this.pumpDone??Promise.resolve();
  this.pumping=true;
  this.pumpDone=this.advance().finally(()=>{this.pumping=false;});
  return this.pumpDone;
 }
 private async advance(){
  while(!this.closed){
   const saved=[...this.jobs.values()].find(s=>s.job.state==='queued');if(!saved)break;
   saved.job.current=await this.current(saved);
   if(!saved.job.current&&!saved.historical){saved.job.state='superseded';await this.save(saved);continue;}
   this.active=saved;saved.job.state='running';await this.save(saved);
   const facts=await this.store.pairFacts();
   // First finish ordinary work. Retry exactly one failed pair in a fresh kernel only after that pass.
   const retry=saved.report&&!saved.report.skipped?.startsWith('Analysis slice')
    ?saved.job.expensive.find(p=>p.attempts===1):undefined;
   if(retry){retry.attempts=2;await this.save(saved);this.worker.stop();}
   const excluded=saved.job.expensive.filter(p=>p.key!==retry?.key).map(p=>p.key);
   const priorDone=saved.job.progress.done;
   try{
    const evaluation=await this.worker.evaluate(saved.graph.document,145_000,{featureIds:saved.featureIds,control:{facts,excluded,pairLimit:retry?1:32,...(retry?{retryKey:retry.key,retryPair:{a:retry.a,b:retry.b}}:{})}},saved.graph.documents,undefined,undefined,undefined,{meshes:false});
    await this.persistence;if(this.persistenceError)throw this.persistenceError;
    if(saved.job.state!=='running')continue;
    const report=publicAnalysis(evaluation.analysis!);
    if(!report.skipped?.startsWith('Analysis slice')&&saved.job.expensive.some(p=>p.attempts>=2)){for(const p of saved.job.expensive.filter(p=>p.attempts>=2)){report.unknownPairs??=[];if(!report.unknownPairs.some(x=>x.a===p.a&&x.b===p.b))report.unknownPairs.push({a:p.a,b:p.b,reason:p.error});}report.skipped??='Exact pairs remain unknown after the controlled retry.';}
    saved.report=report;
    saved.evaluation={geometry:evaluation.geometry,visibleFeatureIds:evaluation.visibleFeatureIds};
    saved.job.progress={leafBodies:report.parts,candidatePairs:report.coverage?.totalPairs??0,done:report.coverage?.completedPairs??0,cached:evaluation.stats?.analysis?.pairHits??0,checks:report.coverage?.completedChecks??0,unknown:report.unknownPairs?.length??0,timedOut:saved.job.expensive.length};
    const sliced=report.skipped?.startsWith('Analysis slice');
    const canRetry=saved.job.expensive.some(p=>p.attempts===1);
    saved.job.state=sliced||canRetry?'queued':'complete';
    // The active fact working set is bounded. Refuse a nonconverging graph rather than loop after eviction.
    if(sliced&&facts.length>=32000&&saved.job.progress.done<=priorDone){saved.job.state='error';saved.job.error='ANALYSIS_FACT_LIMIT: the graph exceeds the 32000 active exact-fact budget. Coverage remains incomplete.';}
   }catch(error){
    if(saved.job.state!=='running')continue;
    const pair=saved.job.inFlight;
    if(pair&&!this.persistenceError){const old=saved.job.expensive.find(p=>p.key===pair.key);if(old){old.attempts=2;old.error=String(error);old.elapsedMs+=Date.now()-pair.startedAt;}else saved.job.expensive.push({key:pair.key,a:pair.a,b:pair.b,attempts:1,elapsedMs:Date.now()-pair.startedAt,error:String(error)});saved.job.state='queued';}
    else{saved.job.state='error';saved.job.error=String(error);}
   }finally{
    clearTimeout(this.pairTimer);delete saved.job.inFlight;this.active=undefined;
    await this.persistence;await this.save(saved);
    // Round robin between bounded slices; interactive authority owns separate kernels.
    this.jobs.delete(saved.job.id);this.jobs.set(saved.job.id,saved);
   }
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 async command(params:Extract<CadCommand,{type:'analyze_model'}>['params']):Promise<CadResult>{
  let saved=params.jobId?this.jobs.get(params.jobId):undefined;
  if(saved&&params.documentId&&params.documentId!==saved.job.documentId)throw new CadError('DOCUMENT_MISMATCH','This job belongs to a different document.');
  if(params.jobId&&!saved)throw new CadError('ANALYSIS_JOB_NOT_FOUND','Analysis job does not exist.');
  if(!saved){if(!params.documentId)throw new CadError('DOCUMENT_REQUIRED','Analysis requires documentId or jobId.');
   const {graph}=await this.store.operation({action:'snapshot',documentId:params.documentId,snapshot:params.snapshot});if(!graph)throw new CadError('SNAPSHOT_NOT_FOUND','Analysis snapshot unavailable.');
   const identity=hash([ANALYSIS_ALGORITHM,ENGINE_VERSION,graph.document,graph.documents,params.featureIds??null]);saved=[...this.jobs.values()].find(s=>(s as SavedJob&{identity?:string}).identity===identity);
   if(!saved){if(params.action&&params.action!=='run')throw new CadError('ANALYSIS_JOB_NOT_FOUND','Start analysis with action run.');
    if([...this.jobs.values()].filter(s=>['running','queued'].includes(s.job.state)).length>=8)throw new CadError('ANALYSIS_BUSY','Eight analysis jobs are already queued.');
    saved={graph,engineVersion:ENGINE_VERSION,historical:!!params.snapshot,featureIds:params.featureIds,job:{id:crypto.randomUUID(),documentId:graph.document.documentId,snapshotId:graph.snapshot.snapshotId,state:'queued',current:true,progress:{leafBodies:0,candidatePairs:0,done:0,cached:0,timedOut:0,unknown:0,checks:0},expensive:[]}};Object.assign(saved,{identity});this.jobs.set(saved.job.id,saved);await this.save(saved);
   }
  }
  if(params.action==='run'&&saved.job.state==='cancelled'){saved.job.state='queued';await this.save(saved);}
  if(params.action==='cancel'){saved.job.state='cancelled';if(this.active===saved)this.worker.stop();await this.persistence;await this.save(saved);}else void this.pump();
  const end=Date.now()+(params.waitMs??0);while(['queued','running'].includes(saved.job.state)&&Date.now()<end)await new Promise(r=>setTimeout(r,Math.min(50,end-Date.now())));
  saved.job.current=await this.current(saved);let report=saved.report?structuredClone(saved.report):undefined;
  const evaluation:Evaluation={geometry:saved.evaluation?.geometry??[],visibleFeatureIds:saved.evaluation?.visibleFeatureIds??[],meshes:[],...(report?{analysis:report}:{})};
  if(!saved.job.current||saved.job.state!=='complete'){if(report)report.skipped??=`Job is ${saved.job.state}${saved.job.current?'':' for a stale graph'}.`;}
  const health=modelHealth(saved.graph.document,evaluation,null);if(!saved.job.current||saved.job.state!=='complete')health.ok=false;
  health.pending={jobId:saved.job.id,state:saved.job.state};
  const job=structuredClone(saved.job),limit=params.page?.limit??25,cursor=params.page?.cursor,prefix=saved.job.id+':'+hash(saved.report??null)+':',offset=cursor?.startsWith(prefix)?Number(cursor.slice(prefix.length)):cursor?NaN:0;
  if(!Number.isInteger(offset)||offset<0)throw new CadError('CURSOR_INVALID','Invalid analysis page.');
  if(report){const items=[...(report.leaves??[]).map(value=>({type:'leaves' as const,value})),...report.checks.map(value=>({type:'checks' as const,value})),...(report.unknownPairs??[]).map(value=>({type:'unknownPairs' as const,value})),...report.contacts.map(value=>({type:'contacts' as const,value})),...report.interferences.map(value=>({type:'interferences' as const,value})),...report.floating.map(value=>({type:'floating' as const,value}))];if(offset>items.length)throw new CadError('CURSOR_INVALID','Analysis page offset does not exist.');report.leaves=[];report.checks=[];report.unknownPairs=[];report.contacts=[];report.interferences=[];report.floating=[];for(const item of items.slice(offset,offset+limit))(report[item.type] as unknown[]).push(item.value);if(offset+limit<items.length)job.nextCursor=prefix+String(offset+limit);}
  const evaluationProvenance=saved.graph.snapshot.engineVersion===ENGINE_VERSION?undefined:{authoredEngine:saved.graph.snapshot.engineVersion,evaluatedWith:ENGINE_VERSION,originalEvidence:false as const};
  return {operation:'analyze_model',status:'success',evaluationProvenance,created:[],updated:[],warnings:evaluationProvenance?['Frozen definitions were re-evaluated with the current engine. These findings are not original historical evidence.']:[],documentId:saved.job.documentId,revision:saved.graph.document.revision,storageVersion:saved.graph.snapshot.storageVersion,analysisJob:job,analysis:report,health};
 }
 async report(documentId:string){const saved=[...this.jobs.values()].reverse().find(s=>s.job.documentId===documentId&&!s.featureIds&&s.job.state==='complete'&&!s.report?.skipped);return saved&&await this.current(saved)?structuredClone(saved.report):undefined;}
 async decorate(result:CadResult,evaluation?:Evaluation){if(!result.documentId||!result.document)return;const saved=[...this.jobs.values()].reverse().find(s=>s.job.documentId===result.documentId&&!s.featureIds&&!s.historical&&s.job.state!=='superseded');if(!saved||!await this.current(saved))return;
 const report=saved.report?structuredClone(saved.report):undefined;
 if(report&&saved.job.state!=='complete')report.skipped??=`Job is ${saved.job.state}.`;
 const e:Evaluation={geometry:result.geometry??evaluation?.geometry??[],meshes:evaluation?.meshes??[],visibleFeatureIds:result.visibleFeatureIds??evaluation?.visibleFeatureIds??[],...(report?{analysis:report}:{}),...(evaluation?.referenceError?{referenceError:evaluation.referenceError}:{})};
 result.analysisJob=structuredClone(saved.job);result.analysis=report;result.health=modelHealth(result.document,e,null);result.health.pending={jobId:saved.job.id,state:saved.job.state};if(saved.job.state!=='complete')result.health.ok=false;if(evaluation)evaluation.analysis=report;
 }
 async close(){this.closed=true;clearTimeout(this.pairTimer);await this.worker.close();await this.pumpDone;await this.persistence;}
}
