import { COMMAND_TIMEOUT_MS, type CadDocument } from '../shared/protocol';
import { CadError } from './document';
import type { Evaluation, WorkerReply, WorkerTask } from './types';

export interface GeometryClient {
  initialize(document: CadDocument, documents?: CadDocument[]): Promise<Evaluation>;
  evaluate(document: CadDocument, timeoutMs?: number, analyze?: { featureIds?: string[] }, documents?: CadDocument[], replay?: { step: number; key: string }, display?: import('../shared/protocol').DisplayRequest, projection?:boolean, options?: { meshes?: boolean; sections?: import('./types').SectionRequest }): Promise<Evaluation>;
  export(format: 'step' | 'stl', featureIds: string[], document: CadDocument, documents?: CadDocument[]): Promise<{bytes: ArrayBuffer; mimeType: string; warnings?: string[]}>;
  stop(error?: CadError): void;
}
export class GeometryWorker implements GeometryClient {
  private worker?: Worker;
  private sequence = 0;
  private recycle = false;
  private pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();

  private create(): Worker {
    const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (worker !== this.worker) return;
      const reply = event.data;
      const request = this.pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(reply.id);
      this.recycle ||= !!reply.recycle;
      // Drain already queued work before recycling; no accepted request is cancelled.
      if (this.recycle && !this.pending.size) this.stop();
      if (reply.ok) request.resolve(reply.value);
      else request.reject(new CadError(reply.error.code, reply.error.message, reply.error.details));
    };
    worker.onerror = event => {
      event.preventDefault();
      if (worker === this.worker) this.stop(new CadError('WORKER_CRASH', event.message || 'The geometry worker stopped. The committed document is preserved.'));
    };
    worker.onmessageerror = () => {
      if (worker === this.worker) this.stop(new CadError('WORKER_MESSAGE', 'Could not decode the geometry response. The committed document is preserved.'));
    };
    this.worker = worker;
    return worker;
  }

  stop(error = new CadError('WORKER_STOPPED', 'Geometry worker stopped.')): void {
    this.worker?.terminate(); this.worker = undefined; this.recycle = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private request<T>(task: WorkerTask, timeoutMs = COMMAND_TIMEOUT_MS - 5_000): Promise<T> {
    const worker = this.worker ?? this.create();
    const id = ++this.sequence;
    const limit = Math.max(1, Math.min(timeoutMs, COMMAND_TIMEOUT_MS - 5_000));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Termination is essential: an expired synchronous WASM operation can never commit later.
        this.stop(new CadError('WORKER_TIMEOUT', `Geometry exceeded ${COMMAND_TIMEOUT_MS / 1000} seconds. The worker was terminated; the committed model is unchanged. Inspect or retry with simpler geometry.`));
      }, limit);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { worker.postMessage({ ...task, id, budgetMs: limit }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize(document: CadDocument, documents: CadDocument[] = []): Promise<Evaluation> {
    await this.request({ type: 'initialize' });
    return this.evaluate(document, undefined, undefined, documents);
  }
  async evaluate(document: CadDocument, timeoutMs?: number, analyze?: { featureIds?: string[] }, documents: CadDocument[] = [], replay?: { step: number; key: string }, display?: import('../shared/protocol').DisplayRequest, projection?:boolean, options: { meshes?: boolean; sections?: import('./types').SectionRequest } = {}): Promise<Evaluation> {
    return this.request<Evaluation>({ type: 'evaluate', document, documents, ...(replay ? { replay } : {}), ...(display ? { display } : {}), ...(projection ? {projection} : {}), ...(analyze ? { analyze } : {}), ...(options.meshes === false ? { meshes: false as const } : {}), ...(options.sections ? { sections: options.sections } : {}) }, timeoutMs);
  }
  async export(format: 'step' | 'stl', featureIds: string[], document: CadDocument, documents: CadDocument[] = []): Promise<{bytes: ArrayBuffer; mimeType: string; warnings?: string[]}> {
    return this.request({ type: 'export', format, featureIds, document, documents });
  }
}
