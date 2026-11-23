import { Worker } from "node:worker_threads";
import { COMMAND_TIMEOUT_MS, type CadDocument } from "../shared/protocol";
import { CadError } from "./document";
import type { Evaluation, WorkerReply, WorkerTask } from "./types";
import type { GeometryClient } from "./worker-client";

export interface WorkerExecution {
  threadId: number;
  startedAt: number;
  finishedAt: number;
  type: string;
  documentId?: string;
}
/** One isolated exact kernel. Calls are serial in its owning runtime; native deadlines terminate it. */
export class NodeGeometryWorker implements GeometryClient {
  private worker?: Worker;
  private sequence = 0;
  private pending?: {
    id: number;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private closed = false;
  private termination?: Promise<number>;
  private accepting = false;
  private analysisCheckpoint?: import('./analysis-cache').AnalysisCheckpoint;
  private seedNeeded = true;
  readonly diagnostics: {
    phase: string;
    generation: number;
    replacements: number;
    lastError?: string;
    executions: WorkerExecution[];
    active?: Omit<WorkerExecution, "finishedAt">;
  } = { phase: "initializing", generation: 0, replacements: 0, executions: [] };
  constructor(
    private options: {
      timeoutMs?: number;
      entry?: URL;
      onExecution?: (event: WorkerExecution) => void;
      onAnalysisEvent?:(event:import('./analysis-plan').AnalysisEvent)=>void;
      pairTimeoutMs?:number;
    } = {},
  ) {}
  private create() {
    if (this.closed)
      throw new CadError(
        "WORKER_STOPPED",
        "Geometry service is shutting down.",
      );
    const worker = new Worker(
      this.options.entry ??
        new URL("./node-worker-bootstrap.mjs", import.meta.url),
      // Auto detail temporarily retains a fine candidate before choosing a smaller mesh.
      // The valid reference F1 graph needs 604 MiB here while remaining under the display budget.
      { resourceLimits: { maxOldGenerationSizeMb: 768 } },
    );
    this.worker = worker;
    this.seedNeeded = true;
    this.diagnostics.generation++;
    this.diagnostics.phase = "initializing";
    worker.on(
      "message",
      (
        reply: WorkerReply & {
          analysisEvent?:import('./analysis-plan').AnalysisEvent;
          execution?: WorkerExecution;
          executionStarted?: Omit<WorkerExecution, "finishedAt">;
        },
      ) => {
        if (
          worker !== this.worker ||
          !this.pending ||
          reply.id !== this.pending.id
        )
          return;
        if(reply.analysisEvent){this.options.onAnalysisEvent?.(reply.analysisEvent);return;}
        if (reply.executionStarted) {
          this.diagnostics.active = reply.executionStarted;
          this.diagnostics.phase = "busy";
          return;
        }
        delete this.diagnostics.active;
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (reply.execution) {
          this.diagnostics.executions.push(reply.execution);
          this.diagnostics.executions.splice(
            0,
            Math.max(0, this.diagnostics.executions.length - 64),
          );
          this.options.onExecution?.(reply.execution);
        }
        this.diagnostics.phase = "ready";
        if(reply.analysisCheckpoint)this.analysisCheckpoint=reply.analysisCheckpoint;
        delete this.diagnostics.lastError;
        if (reply.recycle || (!reply.ok && reply.error.code === "KERNEL_ERROR"))
          this.stop();
        if (reply.ok) pending.resolve(reply.value);
        else
          pending.reject(
            new CadError(
              reply.error.code,
              reply.error.message,
              reply.error.details,
            ),
          );
      },
    );
    worker.on("error", (error) => {
      if (worker === this.worker)
        this.stop(
          new CadError(
            "WORKER_CRASH",
            `Geometry worker crashed: ${error.message}. Committed data is preserved.`,
          ),
        );
    });
    worker.on("messageerror", () => {
      if (worker === this.worker)
        this.stop(
          new CadError(
            "WORKER_MESSAGE",
            "Geometry worker reply could not be decoded. Committed data is preserved.",
          ),
        );
    });
    worker.on("exit", (code) => {
      if (worker === this.worker)
        this.stop(
          new CadError(
            "WORKER_CRASH",
            `Geometry worker exited (${code}). Committed data is preserved.`,
          ),
        );
    });
    return worker;
  }
  stop(error?: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      this.diagnostics.replacements++;
      this.termination = worker.terminate();
    }
    delete this.diagnostics.active;
    this.diagnostics.phase = error ? "unavailable" : "restarting";
    if (error) this.diagnostics.lastError = error.message;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(
        error ?? new CadError("WORKER_STOPPED", "Geometry worker stopped."),
      );
      this.pending = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.analysisCheckpoint=undefined;
    this.stop(new CadError("WORKER_STOPPED", "Geometry service stopped."));
    await this.termination;
  }
  private async request<T>(task: WorkerTask, timeoutMs?: number): Promise<T> {
    if (this.accepting || this.pending)
      return Promise.reject(
        new CadError(
          "WORKER_BUSY",
          "One geometry request per worker is supported.",
        ),
      );
    this.accepting = true;
    try {
      await this.termination;
      if (this.closed)
        throw new CadError("WORKER_STOPPED", "Geometry service stopped.");
      const worker = this.worker ?? this.create();
      const id = ++this.sequence;
      return await new Promise<T>((resolve, reject) => {
        const limit = Math.max(
          1,
          Math.min(
            timeoutMs ?? COMMAND_TIMEOUT_MS - 5000,
            this.options.timeoutMs ?? COMMAND_TIMEOUT_MS - 5000,
          ),
        );
        const timer = setTimeout(() => {
          if (worker === this.worker)
            this.stop(
              new CadError(
                "WORKER_TIMEOUT",
                `Geometry exceeded ${limit} ms. Its worker was terminated. Committed data is preserved.`,
              ),
            );
        }, limit);
        this.pending = { id, resolve, reject, timer };
        try {
          worker.postMessage({ ...task, id, budgetMs: limit, ...(this.seedNeeded&&this.analysisCheckpoint?{analysisSeed:this.analysisCheckpoint}:{}) });
          this.seedNeeded=false;
        } catch (error) {
          this.stop(new CadError("WORKER_MESSAGE", String(error)));
        }
      });
    } finally {
      this.accepting = false;
    }
  }
  async initialize(document: CadDocument, documents: CadDocument[] = []) {
    await this.request({ type: "initialize" });
    return this.evaluate(document, undefined, undefined, documents);
  }
  evaluate(
    document: CadDocument,
    timeoutMs?: number,
    analyze?: { featureIds?: string[];control?:import('./analysis-plan').AnalysisControl },
    documents: CadDocument[] = [],
    replay?: { step: number; key: string },
    display?: import('../shared/protocol').DisplayRequest,
    projection?: boolean,
    options: { meshes?: boolean; renderMesh?: boolean; sections?: import('./types').SectionRequest;topologyQuery?:NonNullable<import('../shared/protocol').InspectionSelect['topology']> } = {},
  ): Promise<Evaluation> {
    return this.request(
      {
        type: "evaluate",
        document,
        documents,
        ...(analyze ? { analyze } : {}),
        ...(replay ? { replay } : {}), ...(display ? { display } : {}), ...(projection ? {projection} : {}),
        ...(options.topologyQuery?{topologyQuery:options.topologyQuery}:{}), ...(options.renderMesh?{renderMesh:true as const}:{}),
        ...(options.meshes === false ? { meshes: false as const } : {}), ...(options.sections ? { sections: options.sections } : {}),
      },
      timeoutMs,
    );
  }
  validateExtraction(before:CadDocument[],after:CadDocument[],affected:string[]):Promise<{equivalence:{method:string;documents:number;occurrences:number}}>{return this.request({type:'extract_validate',before,after,affected});}
  export(
    format: "step" | "stl",
    featureIds: string[],
    document: CadDocument,
    documents: CadDocument[] = [],
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; warnings?: string[] }> {
    return this.request({
      type: "export",
      format,
      featureIds,
      document,
      documents,
    });
  }
}
