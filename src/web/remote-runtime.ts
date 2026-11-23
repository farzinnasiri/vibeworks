import { z } from "zod";
import {ManualHistory} from './manual-history';
import { emptyDocument, CadError } from "../cad/document";
import { modelHealth } from "../cad/health";
import {
  parseCommand,
  browserConnectionSchema,
  commandError,
  uncertainOutcome,
  withCreationRequestId,
  workspaceViewResultSchema,
  type WorkspaceViewRequest,
  COMMAND_TIMEOUT_MS,
  MAX_FEATURES,
  type CadCommand,
  type CadResult,
} from "../shared/protocol";
import type { RuntimeClient, RuntimeState, Outcome } from "../cad/runtime";
import { displayDeliverySchema } from "../bridge/validation";
import { readJson } from "../bridge/http";

declare const __VIBEWORKS_FINGERPRINT__: string;
const fingerprint = __VIBEWORKS_FINGERPRINT__;
/** Personal view over the Node command authority. There is no local kernel or mutation fallback. */
export class RemoteRuntime implements RuntimeClient {
  private manualHistory=new ManualHistory();
  manualHistoryTarget=(action:'undo'|'redo')=>this.manualHistory.target(action);
  async manualHistoryAction(action:'undo'|'redo'):Promise<CadResult>{
    const result=await this.enqueue(async()=>{
      const target=this.manualHistory.target(action);
      if(!target)return commandError('document_action','HISTORY_EMPTY',`No manual ${action} is available in this tab.`);
      this.publish({busy:true});
      try{
        const checked=await this.send({type:'inspect_model',params:{documentId:target.documentId,definitionsOnly:true}},true);
        if(!this.manualHistory.matches(target,checked.result))return commandError('document_action','HISTORY_CHANGED',`${target.name} changed since your edit. Review its History before undoing; no change was made.`);
        const outcome=await this.send({type:'document_action',params:{documentId:target.documentId,expectedRevision:target.revision,expectedStorageVersion:target.storageVersion,action:target.operationId?(action==='undo'?'undo_operation':'redo_operation'):action,...(target.operationId?{operationId:target.operationId}:{})}});
        if(outcome.result.status==='success')this.manualHistory.moved(action,outcome.result);
        if(this.state.document.documentId===target.documentId)this.adopt(outcome);this.publish({lastResult:outcome.result});return outcome.result;
      }finally{this.publish({busy:false});}
    });
    if(result.status==='success')await this.refreshStorage(true);
    return result;
  }

  private listeners = new Set<() => void>();
  private connection?: z.infer<typeof browserConnectionSchema>;
  private clientId = crypto.randomUUID();
  private transientDisconnect = false;
  private authorityId?: string;
  private sessionId?:string;
  private workspacePolling=false;
  private handledView?:string;
  private workspaceMode:'modeling'|'studio'='modeling';
  private heartbeat?:ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  private refresh?: Promise<void>;
  private initializing?: Promise<void>;
  private displaySignature = "";
  private probed?: string;
  private hasDocument = false;
  private viewGeneration = 0;
  private navigationGeneration = 0;
  private failedReadData?: string;
  private state: RuntimeState;
  constructor() {
    const document = emptyDocument();
    this.state = {
      phase: "initializing",
      workspaceHome: true,
      busy: false,
      activity: "Connecting to Node geometry",
      document,
      evaluation: { geometry: [], meshes: [], visibleFeatureIds: [] },
      health: modelHealth(
        document,
        { geometry: [], meshes: [], visibleFeatureIds: [] },
        null,
      ),
      canUndo: false,
      canRedo: false,
      persistence: "Connecting to local authority",
      documents: [],
      projects: [],
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.startHeartbeat();
    return () => {
      this.listeners.delete(listener);
      if(!this.listeners.size&&this.heartbeat){clearInterval(this.heartbeat);this.heartbeat=undefined;}
    };
  };
  private startHeartbeat(){
    if(this.sessionId&&!this.heartbeat&&this.listeners.size){this.heartbeat=setInterval(()=>{void this.send({type:'agent_session',params:{action:'heartbeat'}});},10000);(this.heartbeat as any).unref?.();}
  }
  private async enroll(){
    this.sessionId=this.preference('participantSession');
    let outcome=this.sessionId?await this.send({type:'agent_session',params:{action:'heartbeat'}}):undefined;
    if(!outcome||outcome.result.status==='error'){
      const agent=this.preference('participantName');
      outcome=agent?await this.send({type:'agent_session',params:{action:'resume',agent,client:'browser'}}):undefined;
      if(!outcome||outcome.result.status==='error')outcome=await this.send({type:'agent_session',params:{action:'join',kind:'human',client:'browser'}});
    }
    if(outcome.result.status==='error')throw new CadError(outcome.result.error!.code,outcome.result.error!.message);
  }
  getSnapshot = () => this.state;
  reportWorkspaceMode=(mode:'modeling'|'studio')=>{this.workspaceMode=mode;};
  dismissWorkspaceView=()=>{this.publish({workspaceView:undefined});};
  private async workspaceCall(body:Record<string,unknown>){
    if(!this.connection||!this.sessionId)throw new Error('Workspace viewer is not connected.');
    const response=await fetch('/api/workspace-view',{method:'POST',headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+this.connection.token,'X-Vibeworks-Fingerprint':fingerprint},
      body:JSON.stringify({...body,sessionId:this.sessionId,viewerId:this.clientId}),signal:AbortSignal.timeout(5000)});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error?.message??'Workspace view delivery failed.');
    return workspaceViewResultSchema.parse(value);
  }
  acknowledgeWorkspaceView=async(requestId:string,error?:string)=>{
    await this.workspaceCall({action:'ack',requestId,status:error?'error':'applied',...(error?{error}:{})});
  };
  async refreshWorkspaceView(){
    if(this.workspacePolling||!this.connection||!this.sessionId||this.state.phase!=='ready')return;
    this.workspacePolling=true;
    let request:WorkspaceViewRequest|undefined;
    try{
      const current=this.state.workspaceHome?{}:{projectId:this.state.document.projectId,documentId:this.state.document.documentId,
        revision:this.state.document.revision,selection:this.state.document.selectedFeatureIds,mode:this.workspaceMode};
      request=(await this.workspaceCall({action:'poll',current})).request;
      if(!request||request.requestId===this.handledView)return;
      this.handledView=request.requestId;
      const result=await this.openDocument(request.documentId);
      if(result.status==='error')throw new Error(result.error?.message??'Cannot open the prepared document.');
      if(this.state.document.documentId!==request.documentId||this.state.document.revision!==request.revision)
        throw new Error('The document changed or navigation moved before the prepared view was applied.');
      await this.select(request.state.selection);
      this.publish({workspaceView:request});
    }catch(error){
      if(request)await this.acknowledgeWorkspaceView(request.requestId,error instanceof Error?error.message:String(error)).catch(()=>{});
    }finally{this.workspacePolling=false;}
  }
  private publish(patch: Partial<RuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private preference(key: string) {
    try {
      return sessionStorage.getItem("vibeworks.view." + key) ?? undefined;
    } catch {
      return undefined;
    }
  }
  private remember(key: string, value: string) {
    try {
      sessionStorage.setItem("vibeworks.view." + key, value);
    } catch {}
  }
  private rememberNavigation(documentId?: string) {
    this.remember("navigation", JSON.stringify({ bridgeId: this.connection?.bridgeId, ...(documentId ? { documentId } : {}) }));
  }
  private selection(document = this.state.document) {
    try {
      const ids: unknown = JSON.parse(
        this.preference("selection:" + document.documentId) ?? "[]",
      );
      return Array.isArray(ids)
        ? ids.filter(
            (id): id is string =>
              typeof id === "string" &&
              document.features.some((f) => f.id === id),
          )
        : [];
    } catch {
      return [];
    }
  }
  private async send(command: CadCommand, passive=false): Promise<Outcome> {
    if(command.type==='inspect_model'&&!command.params.select&&!command.params.include)command={...command,params:{...command.params,detail:'full'}};

    if (!this.connection) {
      const response = await fetch("/api/connection", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new CadError(
          "BRIDGE_NOT_RUNNING",
          `Bridge bootstrap returned HTTP ${response.status}. Start pnpm run headless.`,
        );
      this.connection = browserConnectionSchema.parse(await response.json());
      this.authorityId = this.connection.bridgeId;
    }
    if (this.connection.fingerprint !== fingerprint)
      throw new CadError(
        "VERSION_SKEW",
        "Browser and Node authority differ. Restart the stack and reload.",
      );
    command = withCreationRequestId(command);
    const creation=(command.type==='documents'&&['create','duplicate','duplicate_project','create_project'].includes(command.params.action))
      ||(command.type==='workspace_view'&&command.params.action==='present');
    const requestId =
      creation&&'requestId'in command.params
        ? command.params.requestId!
        : crypto.randomUUID();
    try {
      const response = await fetch("/api/view-command", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.connection.token,
          "X-Vibeworks-Fingerprint": fingerprint,
          "X-Vibeworks-Client": this.clientId,
        },
        body: JSON.stringify({ requestId, command,...(this.sessionId?{sessionId:this.sessionId}:{}),...(passive?{passive:true}:{}) }),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 5000),
      });
      if (
        response.status === 401 ||
        response.status === 409 ||
        response.status === 400
      ) {
        this.connection = undefined;
        this.transientDisconnect = false;
        const value = await response.json();
        return {
          result: commandError(
            command.type,
            value.error?.code ?? "INVALID_COMMAND",
            value.error?.message ??
              "Authority rejected the command before execution.",
          ),
        };
      }
      if (!response.ok)
        throw new Error(`Authority returned HTTP ${response.status}`);
      if (response.headers.get("x-vibeworks-fingerprint") !== fingerprint)
        throw new Error("Response fingerprint mismatch.");
      const outcome = displayDeliverySchema.parse(await readJson(response));
      if (
        outcome.result.requestId !== requestId ||
        outcome.result.operation !== command.type ||
        (command.type !== "documents" && command.type!=="agent_session" && command.type!=="activity" &&
          "documentId" in command.params &&
          command.params.documentId &&
          outcome.result.status === "success" &&
          outcome.result.documentId !== command.params.documentId)
      )
        throw new Error("Response identity mismatch.");
      if(outcome.result.session){this.sessionId=outcome.result.session.sessionId;this.remember('participantSession',this.sessionId);if(outcome.result.agent)this.remember('participantName',outcome.result.agent.name);this.startHeartbeat();}
      return outcome;
    } catch (error) {
      this.connection = undefined;
      this.transientDisconnect = true;
      return {
        result: uncertainOutcome(
          command,
          "BRIDGE_TRANSPORT_ERROR",
          "The Node authority did not return a trustworthy result. " +
            String(error),
          requestId,
          false,
        ),
      };
    }
  }
  private adopt(outcome: Outcome, show = false) {
    const { result, evaluation } = outcome;
    if (result.replay) return;
    if (result.status === "error") {
      const unavailable = ["BRIDGE_TRANSPORT_ERROR", "BRIDGE_NOT_RUNNING", "UNAUTHORIZED", "VERSION_SKEW", "RUNTIME_INITIALIZING", "RUNTIME_UNAVAILABLE", "WORKER_UNAVAILABLE"].includes(result.error!.code);
      this.publish({
        ...(unavailable ? { phase: "error", persistence: "Node authority unavailable" } : {}),
        error: result.error?.message, lastResult: result,
      });
      return;
    }
    this.transientDisconnect = false;
    const patch: Partial<RuntimeState> = {
      phase: "ready",
      persistence: "Node authority · local SQLite",
      error: this.state.displayStatus === 'failed' ? this.state.error : undefined,
    };
    if(result.documents&&!this.state.workspaceHome&&!result.documents.some(d=>d.documentId===this.state.document.documentId))this.showProjects();
    if (result.documents)
      patch.documents = result.documents.map((d) => ({
        ...d,
        active:
          d.documentId ===
          (show ? result.documentId : this.state.document.documentId),
      }));
    if (result.projects) patch.projects = result.projects;
    if (
      result.document &&
      evaluation &&
      (show || result.documentId === this.state.document.documentId)
    ) {
      const {
        interferenceMeshes: _meshes,
        durationMs: _duration,
        ...analysis
      } = evaluation.analysis ?? {};
      const signature = JSON.stringify({
        documentId: result.documentId,
        version: result.storageVersion,
        references: evaluation.references,
        referenceError: evaluation.referenceError,
        referencesChanged: evaluation.referencesChanged,
        health: result.health,
        analysis,
      });
      // Polling an unchanged model must not rebuild the scene or replace form inputs every 1.5 seconds.
      if (signature === this.displaySignature && !show) {
        this.publish(patch);
        return;
      }
      this.displaySignature = signature;
      this.viewGeneration++;
      this.failedReadData = undefined;
      // Reuse array identity when a new delivery changes only appearance/analysis/placement.
      // This keeps GPU buffers alive across receipts without retaining old document assets.
      if (result.documentId === this.state.document.documentId) {
        const previous = this.state.evaluation.meshes;
        const same = (a: number[], b: number[]) => a === b || (a.length === b.length && a.every((value, index) => value === b[index]));
        evaluation.meshes = evaluation.meshes.map((mesh, index) => {
          const old = previous[index];
          if (!old || old.featureId !== mesh.featureId || !same(old.vertices, mesh.vertices) || !same(old.normals, mesh.normals) || !same(old.triangles, mesh.triangles) || !same(old.lines, mesh.lines)) return mesh;
          return { ...mesh, vertices: old.vertices, normals: old.normals, triangles: old.triangles, lines: old.lines };
        });
      }
      const document = {
        ...result.document,
        selectedFeatureIds: this.selection(result.document),
      };
      Object.assign(patch, {
        displayStatus: undefined,
        error: undefined,
        document,
        evaluation,
        health: result.health,
        storageVersion: result.storageVersion,
        canUndo: result.history?.canUndo ?? false,
        canRedo: result.history?.canRedo ?? false,
      });
      this.remember("activeDocumentId", document.documentId);
      if (!this.state.workspaceHome || show) this.rememberNavigation(document.documentId);
      this.hasDocument = true;
    }
    this.publish(patch);
  }
  /** Saved workspace navigation does not depend on the selected model being able to display. */
  private adoptDefinitions(outcome: Outcome) {
    const { result } = outcome;
    if (!result.document)
      throw new CadError('RESPONSE_MISMATCH', 'Saved-document discovery did not return its document.');
    const document = { ...result.document, selectedFeatureIds: this.selection(result.document) };
    const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
    this.hasDocument = true;
    this.displaySignature = '';
    this.viewGeneration++;
    this.remember('activeDocumentId', document.documentId);
    this.rememberNavigation(document.documentId);
    this.publish({
      phase: 'ready',
      workspaceHome: false,
      displayStatus: 'loading',
      document,
      evaluation,
      health: modelHealth(document, evaluation, null),
      storageVersion: result.storageVersion,
      documents: (result.documents ?? []).map(d => ({ ...d, active: d.documentId === document.documentId })),
      projects: result.projects ?? [],
      canUndo: result.history?.canUndo ?? false,
      canRedo: result.history?.canRedo ?? false,
      persistence: 'Node authority · local SQLite',
      activity: 'Loading exact geometry',
      error: undefined,
    });
  }
  initialize(): Promise<void> {
    return (this.initializing ??= (async () => {
      const generation = this.navigationGeneration;
      try {
        await this.enroll();
        await this.discoverWorkspace();
        if (generation !== this.navigationGeneration) return;
        let remembered: { bridgeId?: string; documentId?: string } | undefined;
        try { remembered = JSON.parse(this.preference('navigation') ?? 'null'); } catch {}
        if (remembered?.bridgeId === this.connection?.bridgeId && remembered?.documentId &&
            this.state.documents.some(d => d.documentId === remembered.documentId)) {
          const restored = await this.navigate(remembered.documentId);
          if (restored.error?.code === 'DOCUMENT_NOT_FOUND' && generation + 1 === this.navigationGeneration) {
            this.showProjects();
            await this.discoverWorkspace();
          }
        } else this.rememberNavigation();
      } catch (error) {
        if (generation !== this.navigationGeneration) return;
        this.publish({
          phase: "error",
          error: String(error),
          persistence: "Node authority unavailable",
        });
      }
    })());
  }
  async retryInitialization() {
    this.connection = undefined;
    this.initializing = undefined;
    this.showProjects(false);
    this.publish({ phase: "initializing", error: undefined });
    await this.initialize();
  }
  /** Returning home also invalidates late display replies without interrupting any committed edit. */
  showProjects(remember = true) {
    this.dismissWorkspaceView();
    if (remember) this.rememberNavigation();
    this.navigationGeneration++;
    this.viewGeneration++;
    this.hasDocument = false;
    this.displaySignature = '';
    this.publish({ workspaceHome: true, displayStatus: undefined, error: undefined,
      evaluation: { geometry: [], meshes: [], visibleFeatureIds: [] },
      documents: this.state.documents.map(d => ({ ...d, active: false })) });
  }
  private async discoverWorkspace() {
    const generation = this.navigationGeneration;
    // The bridge's existing passive discovery read returns the catalog without display or analysis.
    const outcome = await this.send({ type: 'inspect_model', params: { definitionsOnly: true } }, true);
    if (generation !== this.navigationGeneration) return;
    if (outcome.result.status !== 'success')
      throw new CadError(outcome.result.error!.code, outcome.result.error!.message);
    this.publish({ phase: 'ready', persistence: 'Node authority · local SQLite', activity: 'Ready', error: undefined,
      documents: (outcome.result.documents ?? []).map(d => ({ ...d, active: !this.state.workspaceHome && d.documentId === this.state.document.documentId })),
      projects: outcome.result.projects ?? [] });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action, action);
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private contextual(command: CadCommand): CadCommand {
    if(command.type==='render_video'&&command.params.action!=='start')return command;
    if (
      command.type !== "documents" && command.type!=="agent_session" && command.type!=="activity" &&
      !("documentId" in command.params && command.params.documentId)
    )
      return {
        ...command,
        params: {
          ...command.params,
          documentId: this.state.document.documentId,
        },
      } as CadCommand;
    return command;
  }
  execute(value: unknown): Promise<CadResult> {
    let command: CadCommand;
    try {
      command = this.contextual(parseCommand(value));
      if (command.type === 'documents' && command.params.action === 'open') return this.navigate(command.params.documentId!);
      if (command.type === 'select_features') return this.selectLocal(command.params.featureIds);
      if(command.type==='activity'||command.type==='agent_session'||command.type==='analyze_model'||command.type==='render_video')return this.send(command).then(o=>o.result);
      if (command.type === "inspect_model" && (command.params.replay || command.params.display || command.params.snapshot)) return this.replay(command).then(outcome => outcome.result);
    } catch (error) {
      return Promise.resolve(
        commandError("inspect_model", "INVALID_ARGUMENT", String(error)),
      );
    }
    return this.enqueue(async () => {
      if (this.state.phase !== "ready")
        return commandError(command.type, "RUNTIME_NOT_READY", "Node authority unavailable. Start pnpm run headless and wait for reconnection.");
      this.publish({ busy: true, activity: command.type });
      try {
        const generation = this.navigationGeneration;
        const outcome = await this.send(command);
        const result = outcome.result;
        this.manualHistory.record(command,result,this.state.documents.find(d=>d.documentId===result.documentId)?.name??this.state.document.name??'Document');
        if (generation !== this.navigationGeneration) return result;
        if (result.status === "success" && result.documentId) {
          const selected =
            command.type === "apply_edits"
                ? command.params.select
                : undefined;
          if (selected)
            this.remember(
              "selection:" + result.documentId,
              JSON.stringify(selected),
            );
          this.adopt(outcome);
          if (result.documentId === this.state.document.documentId && selected)
            this.publish({
              document: {
                ...this.state.document,
                selectedFeatureIds: this.selection(),
              },
            });
          // Management receipts already carry workspace metadata; do not evaluate unrelated geometry.

        } else this.adopt(outcome);
        this.publish({ lastResult: result });
        return result;
      } catch (error) {
        const result = commandError(
          command.type,
          error instanceof CadError ? error.code : "RUNTIME_ERROR",
          String(error),
        );
        this.publish({ phase: "error", persistence: "Node authority unavailable", lastResult: result, error: result.error!.message });
        return result;
      } finally {
        this.publish({ busy: false, activity: "Ready" });
      }
    });
  }
  inspectDisplay(params: Extract<CadCommand,{type:'inspect_model'}>['params']): Promise<Outcome> {
    return this.send(parseCommand({type:'inspect_model',params}) as Extract<CadCommand,{type:'inspect_model'}>, true);
  }
  preview(
    command: Extract<CadCommand, { type: "apply_edits" }>,
  ): Promise<Outcome> {
    return this.enqueue(async () => {
      if (this.state.phase !== "ready")
        return { result: commandError("apply_edits", "RUNTIME_NOT_READY", "Node authority unavailable. Exact previews resume after reconnection.") };
      try {
        const outcome = await this.send(
          parseCommand({
            ...command,
            params: { ...command.params, dryRun: true },
          }),
        );
        if (outcome.result.status === "error" && outcome.result.error?.code === "BRIDGE_TRANSPORT_ERROR") this.adopt(outcome);
        return outcome;
      } catch (error) {
        this.publish({ phase: "error", persistence: "Node authority unavailable", error: String(error) });
        return {
          result: commandError("apply_edits", "RUNTIME_ERROR", String(error)),
        };
      }
    });
  }
  /** Personal observations and projection deliveries never enter committed state or the mutation queue. */
  async replay(command: Extract<CadCommand, { type: "inspect_model" }>): Promise<Outcome> {
    if (this.state.phase !== 'ready') return { result: commandError('inspect_model', 'RUNTIME_NOT_READY', 'Reconnect before replaying the build.') };
    try {
      const outcome = await this.send(parseCommand(command),true);
      if (outcome.result.error?.code === 'BRIDGE_TRANSPORT_ERROR') this.adopt(outcome);
      const requested = command.params.replay;
      const display = command.params.display;
      if (outcome.result.status === 'success' && command.params.snapshot && (!outcome.result.snapshot || (command.params.snapshot.id && command.params.snapshot.id!==outcome.result.snapshot.snapshotId))) return {result:commandError('inspect_model','SNAPSHOT_MISMATCH','Frozen graph identity changed. Restart playback.')};
      if (outcome.result.status === 'success' && !command.params.snapshot && display && (outcome.result.revision !== display.expectedRevision || outcome.result.storageVersion !== display.expectedStorageVersion))
        return {result:commandError('inspect_model','STORAGE_CONFLICT','The display context changed. Read the latest model.')};
      if (outcome.result.status === 'success' && !display && requested && (
        outcome.result.replay?.step!==requested.step ||
        (requested.key&&outcome.result.replay.key!==requested.key) ||
        (!command.params.snapshot&&(outcome.result.revision!==requested.expectedRevision||outcome.result.storageVersion!==requested.expectedStorageVersion))))
        return {result:commandError('inspect_model','REPLAY_STALE','The returned frame does not match the requested graph. Restart playback.')};
      return outcome;
    } catch (error) {
      return { result: commandError('inspect_model', 'REPLAY_FAILED', String(error)) };
    }
  }
  /** Durable workspace sequences; undefined when the bridge cannot answer, which forces a full read. */
  private async probe(): Promise<string | undefined> {
    if (!this.connection) return undefined;
    try {
      const response = await fetch("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.connection.token, "X-Vibeworks-Fingerprint": fingerprint },
        body: JSON.stringify(this.state.document.projectId ? { projectId: this.state.document.projectId } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? JSON.stringify(await response.json()) : undefined;
    } catch {
      return undefined;
    }
  }
  /** Geometry reads themselves change `work`; only saved data warrants retrying a failed display. */
  private probeData(probe?: string): string | undefined {
    return probe ? JSON.stringify(JSON.parse(probe).changes) : undefined;
  }
  private adoptDisplay(outcome: Outcome, data?: string, show = false) {
    if (outcome.result.status === 'error' && !this.displaySignature) {
      this.failedReadData = data;
      this.publish({ displayStatus: 'failed' });
    }
    this.adopt(outcome, show);
  }
  /**
   * Polling reads the model only when a durable sequence moved, so an unchanged model is not
   * re-sent, re-validated and discarded every 1.5 s. A failed first display refreshes only saved metadata
   * until data changes or the user explicitly retries the model.
   */
  refreshStorage(force = false): Promise<void> {
    if (this.state.phase === "initializing" || this.state.displayStatus === 'loading') return Promise.resolve();
    // A temporary failed poll must not navigate away and cancel an independent Studio image.
    // Authentication or contract rejection still uses the explicit bridge-restart recovery.
    const keepOpen = this.hasDocument && !this.state.workspaceHome && this.transientDisconnect;
    if ((this.state.phase === 'error' || !this.connection) && !keepOpen) return this.retryInitialization();
    if (this.state.workspaceHome) return (this.refresh ??= this.discoverWorkspace().catch(error => {
      this.publish({ phase: 'error', persistence: 'Node authority unavailable', error: String(error) });
    }).finally(() => { this.refresh = undefined; }));
    if (!this.hasDocument) return this.retryInitialization();
    return (this.refresh ??= this.enqueue(async () => {
      const generation = this.navigationGeneration;
      try {
        if (keepOpen) {
          const authorityId = this.authorityId;
          await this.enroll();
          if (generation !== this.navigationGeneration) return;
          // Re-enrollment after a network failure may connect to a new authority with the same code.
          if (authorityId && authorityId !== this.connection?.bridgeId) {
            this.showProjects();
            await this.discoverWorkspace();
            return;
          }
        }
        if (generation !== this.navigationGeneration) return;
        const probe = this.state.phase === "ready" ? await this.probe() : undefined;
        const data = this.probeData(probe);
        if (!force && probe && probe === this.probed) return;
        const definitionsOnly = this.state.phase === 'ready' && this.state.displayStatus === 'failed' && data === this.failedReadData;
        const outcome = await this.send({
          type: "inspect_model",
          params: { documentId: this.state.document.documentId, ...(definitionsOnly ? { definitionsOnly: true } : {}) },
        },true);
        if (generation !== this.navigationGeneration) return;
        if (definitionsOnly) this.adopt(outcome);
        else this.adoptDisplay(outcome, data);
        this.probed = probe;
      } catch (error) {
        this.publish({
          phase: "error",
          persistence: "Node authority unavailable",
          error: String(error),
        });
      }
    }).finally(() => {
      this.refresh = undefined;
    }));
  }
  private selectLocal(featureIds: string[]): Promise<CadResult> {
    const document = this.state.document;
    const ids = featureIds.filter(id => document.features.some(feature => feature.id === id));
    this.remember('selection:' + document.documentId, JSON.stringify(ids));
    this.publish({ document: { ...document, selectedFeatureIds: ids } });
    return Promise.resolve({ operation: 'select_features', status: 'success', documentId: document.documentId,
      revision: document.revision, created: [], updated: [], warnings: [] });
  }
  async select(featureIds: string[]) { await this.selectLocal(featureIds); }

  /** Warm large assembly sources through frozen prefix reads, each within the ordinary worker budget. */
  private async prepareAssembly(definitions: CadResult, generation: number): Promise<CadResult | undefined> {
    if (!definitions.document?.features.some(feature => feature.kind === 'instance')) return;
    const documentId = definitions.document.documentId;
    const captured = await this.send({ type: 'inspect_model', params: { documentId, definitionsOnly: true, snapshot: {} } }, true);
    if (generation !== this.navigationGeneration || captured.result.status === 'error') return captured.result;
    const snapshot = captured.result.snapshot;
    if (!snapshot || captured.result.inspection?.displayCache === 'prepared') return;
    const document = captured.result.document ?? definitions.document;
    const summaries = new Map(definitions.documents?.map(summary => [summary.documentId, summary.features]));
    const work = document.features.length + snapshot.sources.reduce((count, source) => count + (summaries.get(source.documentId) ?? MAX_FEATURES), 0);
    if (work <= MAX_FEATURES) return;
    const sources = new Set<string>();
    const steps = document.features.flatMap((feature, index) => {
      if (feature.kind !== 'instance' || sources.has(feature.params.document)) return [];
      sources.add(feature.params.document);
      return [{ feature, step: index + 1 }];
    });
    for (const [index, { feature, step }] of steps.entries()) {
      if (generation !== this.navigationGeneration) return;
      this.publish({ activity: `Preparing component ${index + 1} of ${steps.length}` });
      const prepared = await this.send({ type: 'inspect_model', params: {
        documentId, snapshot: { id: snapshot.snapshotId },
        display: { expectedRevision: snapshot.revision, expectedStorageVersion: snapshot.storageVersion, step, detail: 'coarse', featureIds: [feature.id] },
      } }, true);
      if (generation !== this.navigationGeneration || prepared.result.status === 'error') return prepared.result;
      if (prepared.result.inspection?.current === false)
        return commandError('inspect_model', 'PREPARATION_CHANGED', 'This design changed while loading. Open it again to prepare the current design.');
    }
  }

  /** Personal navigation bypasses pending reads; only the latest destination may publish. */
  private async navigate(documentId: string): Promise<CadResult> {
    this.dismissWorkspaceView();
    const generation = ++this.navigationGeneration;
    this.viewGeneration++;
    try {
      const definitions = await this.send({ type: 'inspect_model', params: { documentId, definitionsOnly: true } });
      if (generation !== this.navigationGeneration) return definitions.result;
      if (definitions.result.status === 'error') { this.adopt(definitions); return definitions.result; }
      this.adoptDefinitions(definitions);
      const data = this.probeData(await this.probe());
      if (generation !== this.navigationGeneration) return definitions.result;
      const preparation = await this.prepareAssembly(definitions.result, generation);
      if (generation !== this.navigationGeneration) return preparation ?? definitions.result;
      if (preparation?.status === 'error') {
        this.adoptDisplay({ result: preparation }, data, true);
        this.publish({ lastResult: preparation, activity: 'Ready' });
        return preparation;
      }
      const display = await this.send({ type: 'inspect_model', params: { documentId } });
      if (generation !== this.navigationGeneration) return display.result;
      this.adoptDisplay(display, data, true);
      this.publish({ lastResult: display.result, activity: 'Ready' });
      return display.result;
    } catch (error) {
      const result = commandError('documents', error instanceof CadError ? error.code : 'RUNTIME_ERROR', String(error));
      if (generation === this.navigationGeneration) this.adoptDisplay({ result });
      return result;
    }
  }
  openDocument(documentId: string) { return this.navigate(documentId); }
}
