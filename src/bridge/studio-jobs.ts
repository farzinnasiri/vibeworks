import { CadError } from '../cad/document';
import type { Evaluation } from '../cad/types';
import { packDisplay } from '../shared/display';
import { commandError, unknownHealth, type FrozenGraph, type CadCommand, type CadResult, type StudioRenderJob } from '../shared/protocol';
import { IMAGE_SIZES, imageQuality } from '../shared/studio';
import { decodeBase64 } from './validation';
import { StudioImageRenderer, type StudioImageRunner } from './studio-image-renderer';

type Command=Extract<CadCommand,{type:'render_image'}>;
type Start=Extract<Command['params'],{action:'start'}>;
interface Job {signature:string;info:StudioRenderJob;receipt:CadResult;payload?:string;image?:CadResult['image'];abort:AbortController;timer?:NodeJS.Timeout;}
const DEADLINE=10*60_000, RETENTION=15*60_000, IMAGE_BUDGET=64*1024*1024;
/** Bounded image jobs only. Captures leave the exact command queue before GPU work starts. */
export class StudioJobs {
  private jobs=new Map<string,Job>();
  private active?:Job;
  private work?:Promise<void>;
  private closed=false;
  private renderer?:StudioImageRenderer;
  private runner:StudioImageRunner;
  constructor(runner?:StudioImageRunner,private deadlineMs=DEADLINE){
    this.renderer=runner?undefined:new StudioImageRenderer();this.runner=runner??this.renderer!.render;
  }
  private signature(params:Start){const {sessionId:_,...input}=params;return JSON.stringify(input);}
  get busy(){return [...this.jobs.values()].some(job=>job.info.state==='queued'||job.info.state==='running');}
  private prune(){
    for(const [id,job] of this.jobs)if(job!==this.active&&job.info.state!=='queued'&&Date.parse(job.info.expiresAt)<=Date.now())this.jobs.delete(id);
    let bytes=[...this.jobs.values()].reduce((n,j)=>n+(j.image?.base64.length??0),0);
    for(const [id,job] of this.jobs){
      if(this.jobs.size<=8&&bytes<=IMAGE_BUDGET)break;
      if(job===this.active||job.info.state==='queued')continue;
      bytes-=job.image?.base64.length??0;this.jobs.delete(id);
    }
  }
  existing(params:Start):CadResult|undefined{
    this.prune();const job=this.jobs.get(params.requestId);if(!job)return;
    if(job.signature!==this.signature(params))throw new CadError('REQUEST_ID_CONFLICT','Studio requestId already identifies different inputs. Use a new UUID.');
    return this.receipt(job);
  }
  checkCapacity(){
    if(this.closed)throw new CadError('RENDERER_UNAVAILABLE','Studio job service is shutting down.');
    if([...this.jobs.values()].filter(j=>j.info.state==='queued'||j===this.active).length>=2)
      throw new CadError('RENDERER_BUSY','One Studio image is running and one is queued. Wait or cancel one before submitting another.');
  }
  startGraph(params:Start,graph:FrozenGraph):CadResult{
    const result:CadResult={operation:'render_image',status:'success',documentId:graph.document.documentId,
      revision:graph.document.revision,storageVersion:graph.snapshot.storageVersion,snapshot:graph.snapshot,
      provenance:{documentId:graph.document.documentId,revision:graph.document.revision,sources:graph.snapshot.sources.map(({documentId,revision})=>({documentId,revision}))},
      document:graph.document,health:unknownHealth(),created:[],updated:[],warnings:['Exact display preparation and output analysis run inside this image job.']};
    return this.start(params,result,undefined,graph);
  }
  start(params:Start,result:CadResult,evaluation?:Evaluation,graph?:FrozenGraph):CadResult{
    const existing=this.existing(params);if(existing)return existing;
    this.checkCapacity();
    const output=structuredClone(params.output??{size:'hd' as const,quality:'standard' as const,denoise:true}),pixels=IMAGE_SIZES[output.size];
    const presentation=structuredClone({...result.document?.presentation,...params.presentation});
    const info:StudioRenderJob={jobId:params.requestId,state:'queued',phase:'queued',createdAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+this.deadlineMs).toISOString(),output,presentation,
      shot:structuredClone(params.shot??{view:'isometric',projection:'perspective'}),width:pixels.width,height:pixels.height,
      samples:0,targetSamples:imageQuality(output).samples,elapsedMs:0,renderer:'three-gpu-pathtracer@0.0.27/WebGPU'};
    const {document,geometry,analysis,documents,projects,...metadata}=result;
    const job:Job={signature:this.signature(params),info,receipt:structuredClone(metadata),abort:new AbortController()};
    const captured=graph?{graph,skipAnalysis:!!params.skipAnalysis}:{evaluation:(packDisplay({result:{} as CadResult,evaluation:evaluation!}) as {evaluation:unknown}).evaluation};
    job.payload=JSON.stringify({...captured,document:{documentId:document!.documentId,revision:document!.revision},job:info});
    if(Buffer.byteLength(job.payload)>32*1024*1024)throw new CadError('MODEL_TOO_COMPLEX','Studio display capture exceeds its 32 MiB input budget.');
    if(this.jobs.size>=8){const oldest=[...this.jobs].find(([,j])=>j!==this.active&&j.info.state!=='queued');if(oldest)this.jobs.delete(oldest[0]);}
    this.jobs.set(info.jobId,job);
    job.timer=setTimeout(()=>{
      if(job.info.state==='queued'||job.info.state==='running'){
        this.terminal(job,'error',{code:'RENDER_TIMEOUT',message:'Studio image exceeded its ten-minute budget, including queue time.'});job.abort.abort();
      }
    },this.deadlineMs);job.timer.unref?.();
    queueMicrotask(()=>this.pump());return this.receipt(job);
  }
  control(params:Exclude<Command['params'],{action:'start'}>):CadResult{
    this.prune();const job=this.jobs.get(params.jobId);
    if(!job)throw new CadError('RENDER_JOB_NOT_FOUND','Studio job is absent, expired, evicted or belongs to an earlier bridge lifetime. Start a new render.');
    if(params.action==='cancel'&&(job.info.state==='queued'||job.info.state==='running')){
      this.terminal(job,'cancelled');job.abort.abort();
    }
    const result=this.receipt(job);
    if(params.action==='result'&&job.info.state==='complete')result.image=job.image;
    if(job.info.state==='error')return {...result,...commandError('render_image',job.info.error!.code,job.info.error!.message),renderJob:structuredClone(job.info)};
    return result;
  }
  private receipt(job:Job):CadResult{
    return {...structuredClone(job.receipt),renderJob:structuredClone(job.info),
      warnings:[...job.receipt.warnings,'Captured Studio image. Later model/scene edits do not update this job; inspect its recorded revision and sources.']};
  }
  private terminal(job:Job,state:'error'|'cancelled'|'complete',error?:{code:string;message:string}){
    clearTimeout(job.timer);job.info.state=state;job.info.phase=state;
    job.info.expiresAt=new Date(Date.now()+RETENTION).toISOString();job.info.elapsedMs=Date.now()-Date.parse(job.info.createdAt);job.info.error=error;job.info.etaMs=undefined;job.payload=undefined;
  }
  private pump(){
    if(this.active||this.closed)return;
    const job=[...this.jobs.values()].find(j=>j.info.state==='queued');if(!job)return;
    this.active=job;job.info.state='running';job.info.phase='preparing';
    const payload=job.payload!;job.payload=undefined;
    this.work=(async()=>{
      try {
        const image=await this.runner(payload,status=>{
          if(job.info.state!=='running')return;
          job.info.phase=status.phase;job.info.samples=status.samples;job.info.targetSamples=status.target;
          job.info.elapsedMs=Date.now()-Date.parse(job.info.createdAt);job.info.etaMs=status.etaMs;
        },job.abort.signal);
        if(job.info.state!=='running')return;
        const bytes=decodeBase64(image.base64);
        if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==job.info.width||bytes.readUInt32BE(20)!==job.info.height)
          throw new CadError('INVALID_RESPONSE','Studio renderer did not return a PNG of the requested size.');
        job.image={mimeType:'image/png',base64:image.base64,width:job.info.width,height:job.info.height,tiles:[image.camera]};
        if(image.health)job.receipt.health=image.health;
        if(image.warnings)job.receipt.warnings.push(...image.warnings);
        if(image.evaluationStats)job.receipt.evaluationStats=image.evaluationStats;
        job.info.camera=image.camera;job.info.samples=image.samples;job.info.elapsedMs=image.elapsedMs;
        this.terminal(job,'complete');
      }catch(error){
        if(job.info.state==='running')this.terminal(job,'error',{code:error instanceof CadError?error.code:'STUDIO_RENDER_FAILED',message:String(error).slice(0,2000)});
      }finally{this.active=undefined;this.work=undefined;this.prune();this.pump();}
    })();
  }
  async close(){this.closed=true;for(const job of this.jobs.values())if(job.info.state==='queued'||job.info.state==='running'){this.terminal(job,'cancelled');job.abort.abort();}await this.work;this.jobs.clear();this.renderer?.close();}
}
