import {restoreOperation} from '../cad/operations';
import {extractComponent} from './extraction';
import {AnalysisJobs} from './analysis-jobs';
import { ENGINE_VERSION } from '../shared/protocol';
import { decodeInspectionCursor, inspectionSignature } from './discovery';
import { identifyDisplay } from '../cad/display-identity';
import type { PreparedDisplayStore } from '../cad/types';
import type { Collaboration } from './collaboration';
import { unknownHealth, type OperationContext } from '../shared/protocol';
import { CadRuntime, type Outcome } from "../cad/runtime";
import { NodeGeometryWorker } from "../cad/node-worker";
import { DocumentStore } from "../cad/store";
import { modelHealth, healthHints } from "../cad/health";
import { CadError,visibleFeatures } from "../cad/document";
import {
  commandError,
  type CadCommand,
  type StorageOperation,
} from "../shared/protocol";
import { StudioJobs } from './studio-jobs';
import { HeadlessRenderer } from "./renderer";

class SlotStore extends DocumentStore {
  context?:OperationContext;
  constructor(private store: DocumentStore) {
    super();
  }
  bodies() { return this.store.bodies(); }
  operation(operation: StorageOperation) {
    return this.store.operation(['write','remove','project','remove_project','duplicate_project'].includes(operation.action) && this.context ? {...operation,context:this.context} as StorageOperation : operation);
  }
}
interface Job {
  key: string;
  command: CadCommand;
  /** The caller shows the model (a browser view). Agent commands get receipts without display meshes. */
  display: boolean;
  resolve: (outcome: Outcome) => void;
  received: number;
  context?:OperationContext;
}
/** A busy home slot is worth waiting for: a cold rebuild of a large assembly takes seconds. */
const AFFINITY_WAIT_MS = 2_000;
/** Two serial runtimes share one SQLite authority. No browser controls dispatch or commits. */
export class CommandAuthority {
  private analysisJobs:AnalysisJobs;
  private renderer = new HeadlessRenderer();
  private studioJobs = new StudioJobs();
  private slots: {
    runtime: CadRuntime;
    worker: NodeGeometryWorker;
    store:SlotStore;
    busy: boolean;
    key?: string;
  }[];
  private jobs: Job[] = [];
  private running = new Set<string>();
  private closed = false;
  private defaultId = "";
  private initialization: Promise<void>;
  phase: "initializing" | "ready" | "unavailable" = "initializing";
  error?: string;
  constructor(
    private store: DocumentStore,
    private options: {
      preparedDisplay?: PreparedDisplayStore;
      workers?: number;
      queueLimit?: number;
      workerTimeoutMs?: number;
      collaboration?:Collaboration;
    } = {},
  ) {
    this.analysisJobs=new AnalysisJobs(store);
    const count = options.workers ?? 2;
    if (!Number.isInteger(count) || count < 1 || count > 4)
      throw new Error("Headless worker count must be 1..4.");
    this.slots = Array.from({ length: count }, () => {
      const worker = new NodeGeometryWorker({
        timeoutMs: options.workerTimeoutMs,
      });
      const slotStore=new SlotStore(store);
      const runtime = new CadRuntime(slotStore, worker, options.preparedDisplay);
      runtime.setAnalysisProvider(async id=>{await this.analysisJobs.command({documentId:id,action:'run',waitMs:20000});return this.analysisJobs.report(id);});
      runtime.setRenderer(this.renderer.render);
      runtime.setMeshExporter(this.renderer.glb);
      return { runtime, worker, store:slotStore, busy: false };
    });
    this.initialization = this.initialize();
  }
  private async initialize() {
    try {
      for (const slot of this.slots) {
        await slot.runtime.initialize(true);
        if (slot.runtime.getSnapshot().phase !== "ready")
          throw new Error(
            slot.runtime.getSnapshot().error ?? "Kernel initialization failed.",
          );
        this.defaultId ||= slot.runtime.getSnapshot().document.documentId;
      }
      await this.analysisJobs.initialize();
      this.phase = "ready";
    } catch (error) {
      this.phase = "unavailable";
      this.error = String(error);
    }
  }
  ready() {
    return this.initialization;
  }
  get canRestart(){return !this.jobs.length&&!this.running.size&&!this.studioJobs.busy;}
  diagnostics() {
    return {
      authority: "node" as const,
      phase: this.phase,
      error: this.error,
      workers: this.slots.map((s, slot) => ({
        slot,
        busy: s.busy,
        documentId: s.key,
        ...s.worker.diagnostics,
      })),
      pending: this.jobs.length + this.running.size,
      queueLimit: this.options.queueLimit ?? 32,
      renderer: this.renderer.status,
      rssBytes: process.memoryUsage().rss,
    };
  }
  execute(command: CadCommand, context?:OperationContext, display = true): Promise<Outcome> {
    if (this.closed)
      return Promise.resolve({
        result: commandError(
          command.type,
          "RUNTIME_UNAVAILABLE",
          "Headless authority is shutting down.",
        ),
      });
    if (command.type === 'render_image') return (async () => {
      try {
        if(command.params.action !== 'start')return {result:this.studioJobs.control(command.params)};
        const existing=this.studioJobs.existing(command.params);if(existing)return {result:existing};
        this.studioJobs.checkCapacity();
        const {graph}=await this.store.operation({action:'snapshot',documentId:command.params.documentId,snapshot:{}});
        if(!graph)throw new CadError('SNAPSHOT_NOT_FOUND','Studio could not capture the committed document graph.');
        if(command.params.expectedRevision!==undefined && command.params.expectedRevision!==graph.document.revision)
          throw new CadError('REVISION_CONFLICT','Studio capture revision differs from expectedRevision. Inspect the model again.');
        if(command.params.expectedStorageVersion!==undefined && command.params.expectedStorageVersion!==graph.snapshot.storageVersion)
          throw new CadError('STORAGE_CONFLICT','Studio capture storage version differs from expectedStorageVersion. Inspect the model again.');
        return {result:this.studioJobs.startGraph(command.params,graph)};
      } catch(error) {return {result:commandError(command.type,error instanceof CadError?error.code:'STUDIO_RENDER_FAILED',String(error))};}
    })();
    if (this.phase !== "ready")
      return Promise.resolve({
        result: commandError(
          command.type,
          this.phase === "initializing"
            ? "RUNTIME_INITIALIZING"
            : "WORKER_UNAVAILABLE",
          this.error ??
            "Node kernel initialization is in progress. Wait and inspect again.",
        ),
      });
    if(command.type==='analyze_model')return this.analysisJobs.command({...command.params,documentId:command.params.documentId??(command.params.jobId?undefined:this.defaultId)}).then(result=>({result})).catch(error=>({result:commandError(command.type,error instanceof CadError?error.code:'ANALYSIS_ERROR',String(error))}));
    if(command.type==='inspect_model'&&(command.params.select||command.params.page)){
      let cursor:ReturnType<typeof decodeInspectionCursor>|undefined;
      try{cursor=command.params.page?.cursor?decodeInspectionCursor(command.params.page.cursor):undefined;}catch(error){return Promise.resolve({result:commandError('inspect_model','CURSOR_INVALID',error instanceof Error?error.message:String(error))});}
      if(cursor&&(cursor.signature!==inspectionSignature(command.params)||command.params.documentId&&cursor.documentId!==command.params.documentId))return Promise.resolve({result:commandError('inspect_model','CURSOR_INVALID','Cursor belongs to another inspection projection.')});
      command={...command,params:{...command.params,documentId:command.params.documentId??cursor?.documentId??this.defaultId,snapshot:cursor?{id:cursor.snapshotId,...(command.params.snapshot?.reevaluate?{reevaluate:true as const}:{})}:command.params.snapshot??{}}};
    }
    // Saved navigation must remain available while every geometry worker is occupied or recovering.
    if (command.type === 'inspect_model' && command.params.definitionsOnly && !command.params.snapshot)
      return this.definitions(command);
    if (this.jobs.length + this.running.size >= (this.options.queueLimit ?? 32))
      return Promise.resolve({
        result: commandError(
          command.type,
          "BRIDGE_BUSY",
          "The bounded headless command queue is full. Wait for accepted commands to finish.",
        ),
      });
    // No implicit human tab. Reads without context address the startup document.
    if (
      "documentId" in command.params
        ? !command.params.documentId
        : command.type !== "documents"
    ) {
      if (command.type !== "documents")
        command = {
          ...command,
          params: { ...command.params, documentId: this.defaultId },
        } as CadCommand;
    }
    const key =
      ("documentId" in command.params && command.params.documentId) ||
      "@workspace";
    return new Promise((resolve) => {
      this.jobs.push({ key, command, display, resolve, received: Date.now(), context });
      this.pump();
    });
  }
  private async definitions(command: Extract<CadCommand, { type: 'inspect_model' }>): Promise<Outcome> {
    const started = performance.now();
    try {
      const documents = await this.store.list();
      const id = command.params.documentId ?? (documents.some(d => d.documentId === this.defaultId) ? this.defaultId : documents[0]?.documentId);
      const record = id ? await this.store.read(id) : undefined;
      if(!documents.length&&!command.params.documentId)return{result:{operation:'inspect_model',status:'success',documents:[],projects:(await this.store.operation({action:'projects'})).projects!,created:[],updated:[],warnings:[]}};
      if (!record) throw new CadError('DOCUMENT_NOT_FOUND', 'The saved document no longer exists. Choose a document from Projects.');
      const { document, version, history } = record;
      if (command.params.featureId && !document.features.some(f => f.id === command.params.featureId))
        throw new CadError('FEATURE_NOT_FOUND', `Feature '${command.params.featureId}' does not exist.`);
      const projects = (await this.store.operation({ action: 'projects' })).projects!;
      const health = modelHealth(document, { geometry: [], meshes: [], visibleFeatureIds: [] }, null);
      return { result: {
        operation: 'inspect_model', status: 'success', documentId: document.documentId, revision: document.revision,
        storageVersion: version, document: { ...document, selectedFeatureIds: [] },
        documents: documents.map(d => ({ ...d, active: d.documentId === id })), projects,
        created: [], updated: [], geometry: [], visibleFeatureIds: [], health,
        history: { canUndo: !!history.undo.length, canRedo: !!history.redo.length },
        warnings: ['Saved definitions only. Geometry and analysis have not been evaluated for this read.'],
        nextSteps: healthHints(health, undefined, document), durationMs: performance.now() - started,
      } };
    } catch (error) {
      return { result: commandError(command.type, error instanceof CadError ? error.code : 'STORAGE_ERROR', String(error)) };
    }
  }
  /** Which slot last ran each document: its worker holds that document's exact shapes and sessions. */
  private homes = new Map<string, number>();
  private affinityTimer?: ReturnType<typeof setTimeout>;
  private home(key: string, slot: number) {
    this.homes.delete(key); this.homes.set(key, slot);
    if (this.homes.size > 256) this.homes.delete(this.homes.keys().next().value!);
  }
  private pump() {
    let wake = Infinity;
    for (const [index, slot] of this.slots.entries()) {
      if (slot.busy || this.closed) continue;
      // Take the earliest eligible document; blocked documents cannot occupy the other slot. A document goes back to
      // the slot that has it cached, and waits briefly for it there rather than rebuilding cold elsewhere.
      const now = Date.now();
      const i = this.jobs.findIndex(job => {
        if (this.running.has(job.key)) return false;
        const home = this.homes.get(job.key);
        if (home === undefined || home === index) return true;
        if (!this.slots[home].busy) return false;
        const waited = now - job.received;
        if (waited >= AFFINITY_WAIT_MS) return true;
        wake = Math.min(wake, AFFINITY_WAIT_MS - waited);
        return false;
      });
      if (i < 0) continue;
      const job = this.jobs[i];
      this.jobs.splice(i, 1);
      this.home(job.key, index);
      slot.busy = true;
      slot.key = job.key;
      slot.store.context=job.context;
      if(job.context)this.options.collaboration?.start(job.context.operationId);
      this.running.add(job.key);
      void (async () => {
        if (Date.now() - job.received >= 50000)
          return {
            result: commandError(
              job.command.type,
              "COMMAND_EXPIRED",
              "Command expired in the headless queue before execution.",
            ),
          };
        if (slot.runtime.getSnapshot().phase !== "ready")
          await slot.runtime.retryInitialization();
        let outcome:Outcome;
        if(job.command.type==='documents'&&job.command.params.action==='extract'){
          const result=await extractComponent(this.store,slot.worker,job.command.params,job.context);
          if(result.document&&!result.dryRun){const documents=await this.store.bodies();const evaluation=await slot.worker.evaluate(result.document,undefined,undefined,documents,undefined,undefined,undefined,{meshes:job.display});outcome={result,evaluation};}else outcome={result};
        }else if(job.command.type==='documents'&&job.command.params.action==='list'&&job.command.params.requestId&&(await this.store.operation({action:'operation_request',requestId:job.command.params.requestId})).batchReceipt){
          const saved=(await this.store.operation({action:'operation_request',requestId:job.command.params.requestId})).batchReceipt!;const {identity,...result}=saved;outcome={result:{...result,replayed:true} as unknown as import('../shared/protocol').CadResult};
        }else if(job.command.type==='document_action'&&['undo_operation','redo_operation'].includes(job.command.params.action)){
          if(!job.command.params.operationId)throw new CadError('OPERATION_REQUIRED','operationId is required.');
          const operation=await this.store.storedOperation(job.command.params.operationId);if(!operation)throw new CadError('OPERATION_NOT_FOUND','Operation is not stored.');
          const records=await Promise.all((await this.store.list()).map(async d=>(await this.store.read(d.documentId))!));
          const targetId=job.command.params.documentId;const current=records.find(r=>r.document.documentId===targetId);if(current?.document.revision!==job.command.params.expectedRevision)throw new CadError('REVISION_CONFLICT','Operation target revision changed.');if(job.command.params.expectedStorageVersion!==undefined&&current?.version!==job.command.params.expectedStorageVersion)throw new CadError('STORAGE_CONFLICT','Operation target storage version changed.');
          const restored=restoreOperation(operation,job.command.params.action==='undo_operation'?'undo':'redo',records);
          const before=records.map(r=>r.document),after=[...before.filter(d=>!restored.some(r=>r.documentId===d.documentId)),...restored];await slot.worker.validateExtraction(before,after,restored.map(d=>d.documentId));
          const guards=Object.fromEntries(records.map(r=>[r.document.documentId,r.version]));
          const stored=await this.store.operation({action:'operation_history',guards,operationId:job.command.params.operationId,direction:job.command.params.action==='undo_operation'?'undo':'redo',context:job.context});
          const record=await this.store.read(job.command.params.documentId);if(!record)throw new CadError('DOCUMENT_NOT_FOUND','Operation document is absent.');
          const evaluation=await slot.worker.evaluate(record.document,undefined,undefined,await this.store.bodies(),undefined,undefined,undefined,{meshes:job.display});
          const {state:operationState,retainedDocumentId,...storedReceipt}=stored.batchReceipt!;const saved=storedReceipt as unknown as import('../shared/protocol').CadResult;
          outcome={result:{...saved,operation:'document_action',document:record.document,documentId:record.document.documentId,revision:record.document.revision,storageVersion:record.version,history:{canUndo:record.history.undo.length>0,canRedo:job.command.params.action==='undo_operation'||record.history.redo.length>0},extraction:saved.extraction?{...saved.extraction,retainedDocumentId:String(stored.batchReceipt?.retainedDocumentId)}:undefined},evaluation};
        }else outcome = job.command.type==='inspect_model' && job.command.params.snapshot ? await this.frozen(slot.worker,job.command,job.received) : await slot.runtime.executeDelivery(
          job.command,
          performance.now() - (Date.now() - job.received),
          job.display,
        );
        if (
          job.command.type === "documents" &&
          ['delete','delete_project','create','duplicate'].includes(job.command.params.action) &&
          !outcome.result.documents?.some(document => document.documentId === this.defaultId) &&
          outcome.result.status === "success"
        ) {
          this.defaultId = outcome.result.documents?.[0]?.documentId ?? '';
        }
        if(outcome.result.status==='success' && !outcome.result.dryRun && (job.command.type==='apply_edits'||job.command.type==='document_action'||job.command.type==='documents')){
          await this.analysisJobs.supersede();
          if(outcome.result.documentId&&outcome.result.document?.features.length&&(outcome.result.document.analysis?.auto??true)&&!(job.command.type==='apply_edits'&&job.command.params.analyze===false))await this.analysisJobs.command({documentId:outcome.result.documentId,action:'run'});
        }
        if(job.command.type!=='inspect_model'||!job.command.params.snapshot)await this.analysisJobs.decorate(outcome.result,outcome.evaluation);
        // Every product receipt states the actual command authority, including headless UI calls.
        outcome.result.authority = {
          kind: "node",
          kernel: "replicad@1.1.0/replicad-opencascadejs@1.1.0",
          workerSlot: this.slots.indexOf(slot),
        };
        if (outcome.result.document && job.command.type !== "select_features")
          outcome.result.document.selectedFeatureIds =
            job.command.type === "apply_edits"
              ? [...(job.command.params.select ?? [])]
              : [];
        if (
          job.command.type === "select_features" &&
          outcome.result.status === "success"
        )
          outcome.result.warnings.push(
            "Selection applies to this command client only. No human viewer is selected or opened.",
          );
        return outcome;
      })()
        .catch((error) => ({
          result: commandError(
            job.command.type,
            error instanceof CadError ? error.code : "RUNTIME_ERROR",
            String(error),
            error instanceof CadError?error.details:undefined,
          ),
        }))
        .then(job.resolve)
        .finally(() => {
          slot.busy = false;
          slot.store.context=undefined;
          this.running.delete(job.key);
          this.pump();
        });
    }
    if (wake < Infinity && !this.closed) {
      clearTimeout(this.affinityTimer);
      this.affinityTimer = setTimeout(() => this.pump(), wake + 1);
      this.affinityTimer.unref?.();
    }
  }
  private async frozen(worker:NodeGeometryWorker,command:Extract<CadCommand,{type:'inspect_model'}>,received:number):Promise<Outcome> {
    const documentId=command.params.documentId;
    if(!documentId)throw new CadError('INVALID_ARGUMENT','Frozen graph inspection requires documentId.');
    const {graph}=await this.store.operation({action:'snapshot',documentId,snapshot:command.params.snapshot});
    if(!graph)throw new CadError('SNAPSHOT_NOT_FOUND','Frozen definitions could not be read.');
    const {snapshot,document,documents}=graph;
    const evaluationProvenance=snapshot.engineVersion===ENGINE_VERSION?undefined:{authoredEngine:snapshot.engineVersion,evaluatedWith:ENGINE_VERSION,originalEvidence:false as const};
    if(command.params.replay?.key&&command.params.replay.key!==snapshot.snapshotId)throw new CadError('REPLAY_STALE','Replay key belongs to a different frozen graph.');
    const started=Date.now();
    const latest=await this.store.read(documentId);
    const current=latest?.version===snapshot.storageVersion&&(await Promise.all(snapshot.sources.map(async s=>(await this.store.read(s.documentId))?.version===s.storageVersion))).every(Boolean);
    if(command.params.definitionsOnly){
      const prepared=current?this.options.preparedDisplay?.get(document,documents):undefined;
      return {result:{operation:'inspect_model',status:'success',evaluationProvenance,documentId,revision:document.revision,storageVersion:snapshot.storageVersion,document,created:[],updated:[],warnings:['Frozen definitions only. Geometry and analysis were not evaluated.'],snapshot,inspection:{current,...(prepared?{displayCache:'prepared'}:{})},health:unknownHealth()}};
    }
    const exactQuery=command.params.select?.topology&&(command.params.select.topology.near||command.params.select.topology.edges?.query);
    const hiddenTarget=command.params.select?.topology?.target.feature;
    const topologyDisplay=hiddenTarget&&!visibleFeatures(document).includes(hiddenTarget)?{expectedRevision:document.revision,expectedStorageVersion:snapshot.storageVersion,featureIds:[hiddenTarget]}:command.params.display;
    const cached=!topologyDisplay&&!exactQuery&&!command.params.replay&&!command.params.display?this.options.preparedDisplay?.get(document,documents):undefined;
    const evaluation=cached??await worker.evaluate(document,Math.max(1,55000-(Date.now()-received)),undefined,documents,command.params.replay?{step:command.params.replay.step,key:snapshot.snapshotId}:undefined,topologyDisplay??(command.params.replay?{expectedRevision:document.revision,expectedStorageVersion:snapshot.storageVersion,detail:command.params.replay.detail==='fine'?'fine':'coarse'}:undefined),true,{...(exactQuery?{topologyQuery:command.params.select!.topology}:{})});
    const visible=evaluation.visibleFeatureIds;
    await identifyDisplay(evaluation, document, documents);
    if(!cached&&!topologyDisplay&&!exactQuery&&!command.params.replay&&!command.params.display)this.options.preparedDisplay?.put(document,documents,evaluation);
    return {evaluation,result:{operation:'inspect_model',status:'success',evaluationProvenance,documentId,revision:document.revision,storageVersion:snapshot.storageVersion,document,created:[],updated:[],inspection:{current,displayCache:cached?'prepared':'rebuilt'},warnings:[...(evaluationProvenance?['Definitions re-evaluated with a different engine. Original geometry, equivalence and original certification are not asserted.']:[]),'Read-only frozen graph. Live edits do not replace this view. Final physical analysis is not repeated.',...(command.params.snapshot?.sequence!==undefined?['Historical sources are reconstructed as of the saved workspace change sequence; original legacy authorship and rationale may be unknown.']:[])],snapshot,replay:evaluation.replay,geometry:evaluation.geometry.filter(g=>visible.includes(g.featureId)),visibleFeatureIds:visible,health:unknownHealth(),evaluationStats:evaluation.stats,durationMs:Date.now()-started}};
  }
  async close() {
    this.closed = true;
    clearTimeout(this.affinityTimer);
    for (const job of this.jobs.splice(0))
      job.resolve({
        result: commandError(
          job.command.type,
          "RUNTIME_UNAVAILABLE",
          "Authority stopped before dispatch.",
        ),
      });
    await this.analysisJobs.close();
    await Promise.all(this.slots.map((slot) => slot.worker.close()));
    await this.initialization;
    await this.renderer.close();
    await this.studioJobs.close();
    // Terminated native operations settle their runtime commands before the caller closes SQLite.
    while (this.running.size)
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
