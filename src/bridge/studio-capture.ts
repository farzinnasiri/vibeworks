import {NodeGeometryWorker} from '../cad/node-worker';
import {CadError} from '../cad/document';
import {modelHealth, healthHints} from '../cad/health';
import {packDisplay} from '../shared/display';
import type {CadResult, FrozenGraph, StudioRenderJob} from '../shared/protocol';
import type {RenderStatus} from '../web/studio-render';
import { replayPlan } from '../cad/replay';

/** One image owns one bounded Node preparation worker, released before Chromium/GPU startup. */
export async function prepareStudioCapture(graph:FrozenGraph,job:Pick<StudioRenderJob,'expiresAt'>&{targetSamples?:number;meshDetail?:'standard'|'fine'},skipAnalysis:boolean,
  progress:(status:RenderStatus)=>void,signal:AbortSignal){
  const worker=new NodeGeometryWorker({timeoutMs:10*60_000});
  const started=performance.now(),deadline=Date.parse(job.expiresAt);
  const abort=()=>worker.stop(new CadError('RENDER_CANCELLED','Studio geometry preparation cancelled.'));
  signal.addEventListener('abort',abort);
  const check=()=>{if(signal.aborted)throw new CadError('RENDER_CANCELLED','Studio geometry preparation cancelled.');};
  const report=setInterval(()=>progress({phase:'preparing',samples:0,target:job.targetSamples??0,elapsedMs:performance.now()-started}),500);
  try{
    check();
    const first=await worker.evaluate(graph.document,Math.max(1,deadline-Date.now()),skipAnalysis?undefined:{},graph.documents,
      undefined,undefined,skipAnalysis,{renderMesh:job.meshDetail==='fine'});
    check();
    if(first.referenceError)throw new CadError('ASSEMBLY_STALE',first.referenceError);
    if(first.displayError&&job.meshDetail==='fine'&&/bounded|capacity|budget/i.test(first.displayError))throw new CadError('RENDER_MESH_BUDGET',first.displayError+' Final fine tessellation could not fit. Retry with output.meshDetail: \"standard\"; exact geometry is unchanged.');
    if(first.displayError||!first.meshes.length)throw new CadError('DISPLAY_UNAVAILABLE',first.displayError??'The captured model has no visible display geometry.');
    let evaluated=first;
    // Exact pair/check caches survive these slices. Preparing an image may outlive ordinary command deadlines.
    while(!skipAnalysis&&evaluated.analysis?.skipped){
      check();
      evaluated=await worker.evaluate(graph.document,Math.max(1,deadline-Date.now()),{},graph.documents,
        undefined,undefined,false,{meshes:false});
    }
    if(!skipAnalysis&&!evaluated.analysis)throw new CadError('ANALYSIS_INCOMPLETE','Studio preparation could not complete whole-document analysis.');
    const evaluation={...evaluated,meshes:first.meshes};
    const health=modelHealth(graph.document,evaluation,!skipAnalysis?graph.document.revision:null);
    const warnings=skipAnalysis?['Studio image explicitly skipped final whole-document analysis.']:healthHints(health,evaluated.analysis,graph.document);
    const packed=packDisplay({result:{} as CadResult,evaluation}) as {evaluation:unknown};
    const encoded=JSON.stringify(packed.evaluation);
    if(Buffer.byteLength(encoded)>32*1024*1024)throw new CadError('MODEL_TOO_COMPLEX','Studio display capture exceeds its 32 MiB input budget.');
    return {evaluation:packed.evaluation,health,warnings,evaluationStats:evaluated.stats};
  }finally{clearInterval(report);signal.removeEventListener('abort',abort);await worker.close();}
}

/** Stream exact construction prefixes from the captured graph. At most one worker and one frame are retained. */
export class StudioConstructionCapture {
  readonly steps: number;
  private worker = new NodeGeometryWorker({timeoutMs:10*60_000});
  private abort = () => this.worker.stop(new CadError('RENDER_CANCELLED','Construction capture cancelled.'));
  constructor(private graph:FrozenGraph,private expiresAt:string,private signal:AbortSignal,private fine=false){
    this.steps=replayPlan(graph.document,graph.documents).length;
    signal.addEventListener('abort',this.abort);
  }
  async frame(step:number){
    this.signal.throwIfAborted();
    if(!Number.isInteger(step)||step<1||step>this.steps)throw new CadError('REPLAY_STEP','Construction frame is outside the captured build.');
    const evaluation=await this.worker.evaluate(this.graph.document,Math.max(1,Date.parse(this.expiresAt)-Date.now()),undefined,this.graph.documents,
      {step,key:this.graph.snapshot.snapshotId},undefined,true,{renderMesh:this.fine});
    if(evaluation.referenceError||evaluation.displayError)throw new CadError('DISPLAY_UNAVAILABLE',evaluation.referenceError??evaluation.displayError!);
    const packed=packDisplay({result:{} as CadResult,evaluation}) as {evaluation:unknown};
    const text=JSON.stringify(packed.evaluation);
    if(Buffer.byteLength(text)>32*1024*1024)throw new CadError('MODEL_TOO_COMPLEX','Construction frame exceeds its 32 MiB display budget.');
    return text;
  }
  async close(){this.signal.removeEventListener('abort',this.abort);await this.worker.close();}
}
