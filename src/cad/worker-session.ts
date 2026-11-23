import { GeometryEngine } from './geometry';
import { CadError } from './document';
import { shouldRecycleWorker } from './worker-policy';
import { COMMAND_TIMEOUT_MS } from '../shared/protocol';

/** Analysis is incremental, so it takes what is left of the caller's deadline, never the whole command. */
export const ANALYSIS_SLICE_MS = 20_000;
const REPLY_RESERVE_MS = 2_000;
export function analysisBudget(deadline: number, now = performance.now()): number {
  return Math.max(0, Math.min(ANALYSIS_SLICE_MS, deadline - now - REPLY_RESERVE_MS));
}
import type { WorkerReply, WorkerRequest } from './types';

/** The worker's serial request loop. Injected loaders also allow real OCCT tests in Node workers. */
export class GeometryWorkerSession {
  private initialization?: Promise<GeometryEngine>;
  private queue = Promise.resolve();
  private evaluations = 0;
  constructor(private loadKernel: () => Promise<GeometryEngine>, private loadFont: () => Promise<void>, private emit?:(id:number,event:import('./analysis-plan').AnalysisEvent)=>void) {}

  handle(request: WorkerRequest): Promise<WorkerReply> {
    const reply = this.queue.then(() => this.run(request));
    this.queue = reply.then(() => {}, () => {});
    return reply;
  }

  private async run(request: WorkerRequest): Promise<WorkerReply> {
    const deadline = performance.now() + (request.budgetMs ?? COMMAND_TIMEOUT_MS - 5_000);
    let engine: GeometryEngine | undefined;
    let reply: WorkerReply;
    let heapBefore = 0;
    try {
      engine = await (this.initialization ??= this.loadKernel().catch(error => { this.initialization = undefined; throw error; }));
      heapBefore = engine.cacheStats().wasmHeapBytes;
      if(request.analysisSeed)engine.restoreAnalysis(request.analysisSeed);
      if ((request.type==='extract_validate'?[...request.before,...request.after]:'document' in request?[request.document,...(request.documents??[])]:[]).some(doc => doc.features.some(feature => feature.kind === 'text'))) await this.loadFont();
      let value: Extract<WorkerReply, { ok: true }>['value'];
      if (request.type === 'initialize') value = { ready: true };
      else if(request.type==='extract_validate') {
        let occurrences=0,measured=false;
        for(const id of request.affected){
          const before=request.before.find(d=>d.documentId===id)!,after=request.after.find(d=>d.documentId===id)!;
          const a=engine.evaluate(before,request.before,undefined,undefined,{meshes:false});const first=engine.extractionBodies(before);
          try{
          const checksA=before.analysis?.checks?.length?engine.analyze(before,a.geometry).checks:[];
          const b=engine.evaluate(after,request.after,undefined,undefined,{meshes:false});const second=engine.extractionBodies(after);
          try{measured=engine.compareExtraction(first,second)==='measured'||measured;}finally{second.forEach(b=>b.shape.delete());}
          const checksB=after.analysis?.checks?.length?engine.analyze(after,b.geometry).checks:[];
          const facts=(checks:typeof checksA)=>checks.map(({a,b,message,...facts})=>facts);
          if(checksB.some(c=>c.ok===null)||JSON.stringify(facts(checksA))!==JSON.stringify(facts(checksB)))throw new CadError('EXTRACT_NOT_EQUIVALENT','Declared exact check results changed or remain unresolved.',{documentId:id,before:checksA,after:checksB});
          if(a.geometry.some(g=>!g.valid)||b.geometry.some(g=>!g.valid))throw new CadError('EXTRACT_NOT_EQUIVALENT','Invalid exact candidate geometry.');
          // Every pre-existing mount frame must survive qualification. New component mounts are metadata.
          for(const g of a.geometry.filter(g=>a.visibleFeatureIds.includes(g.featureId)))for(const mount of g.mounts??[]){if(!b.geometry.filter(g=>b.visibleFeatureIds.includes(g.featureId)).some(g=>g.mounts?.some(m=>JSON.stringify(m.frame)===JSON.stringify(mount.frame))))throw new CadError('EXTRACT_NOT_EQUIVALENT','A resolved mount frame changed.',{documentId:id,mount});}
          const mass=(e:typeof a)=>e.geometry.filter(g=>e.visibleFeatureIds.includes(g.featureId)).reduce((n,g)=>n+(g.massG??0),0);
          if(Math.abs(mass(a)-mass(b))>1e-9*Math.max(1,mass(a)))throw new CadError('EXTRACT_NOT_EQUIVALENT','Physical mass changed.');
          occurrences+=first.length;
          }finally{first.forEach(b=>b.shape.delete());}
        }
        value={equivalence:{method:measured?'construction-and-exact-two-way-boolean-fallback':'complete-construction-descriptors-and-bitwise-world-placement',documents:request.affected.length,occurrences}};
      }
      else {
        // Exports and agent commands need exact results only; display meshes are made when a viewer asks.
        const meshes = request.type === 'evaluate' && request.meshes !== false;
        const evaluation = engine.evaluate(request.document, request.documents, request.type === 'evaluate' ? request.replay : undefined, request.type === 'evaluate' ? request.display : undefined, { meshes, renderMesh:request.type==='evaluate'&&request.renderMesh });
        if (request.type === 'export') value = await engine.export(request.format, request.featureIds, request.document);
        else {
          value = request.analyze ? { ...evaluation, analysis: engine.analyze(request.document, evaluation.geometry, request.analyze.featureIds, analysisBudget(deadline), Math.max(0, deadline - performance.now() - REPLY_RESERVE_MS), request.analyze.control, event=>this.emit?.(request.id,event)) } : evaluation;
          if(request.topologyQuery)value={...value,topologyQuery:engine.queryTopology(request.topologyQuery)};
          if (request.sections) value = { ...value, sections: engine.sections(request.document, request.sections.featureId, request.sections.planes) };
        }
      }
      reply = { id: request.id, ok: true, value, ...(request.type==='evaluate'&&request.analyze?{analysisCheckpoint:engine.analysisCheckpoint()}:{}) };
    } catch (error) {
      reply = { id: request.id, ok: false, error: {
        code: error instanceof CadError ? error.code : 'KERNEL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof CadError && error.details !== undefined ? { details: error.details } : {}),
      } };
    }
    if (request.type !== 'initialize') this.evaluations++;
    const heap = engine?.cacheStats().wasmHeapBytes ?? 0;
    reply.recycle = shouldRecycleWorker(this.evaluations, heap, request.type==='evaluate' && request.projection, heap - heapBefore);
    return reply;
  }
}
