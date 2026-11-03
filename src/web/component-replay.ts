import type { RuntimeClient, RuntimeState, Outcome } from '../cad/runtime';
import { COMMAND_TIMEOUT_MS, type GraphSnapshot, type CadDocument, type Replay } from '../shared/protocol';
import type { Evaluation } from '../cad/types';

export const presentationIdentity = (s: RuntimeState) => JSON.stringify([
  s.document.documentId, s.document.revision, s.storageVersion,
  s.evaluation.references, s.evaluation.referenceError, s.phase,
]);
export interface ComponentReplayState {
  active: boolean;
  loading: boolean;
  playing: boolean;
  frame?: Evaluation;
  replay?: Replay;
  error?: string;
  snapshot?:GraphSnapshot;
  document?:CadDocument;
}
/** One in-flight read and one latest requested step. Cancellation discards delivery, never aborts a write. */
export class ComponentReplay {
  private state: ComponentReplayState = { active: false, loading: false, playing: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private inFlight = false;
  private wanted?: { step: number; generation: number };
  private identity = '';
  private frames = new Map<string, { frame: Evaluation; values: number }>();
  private cachedValues = 0;
  private detail:'auto'|'fine'|'coarse'='auto';
  setDetail=(detail:'auto'|'fine'|'coarse')=>{if(this.detail===detail)return;this.detail=detail;if(this.state.active)this.seek(this.state.replay?.step??1);};
  constructor(private runtime: Pick<RuntimeClient, 'getSnapshot' | 'replay' | 'refreshStorage'>,private options:{timeoutMs?:number}={}) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ComponentReplayState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l()); }
  cancel = () => {
    this.generation++; this.wanted = undefined;
    this.frames.clear(); this.cachedValues = 0;
    this.state = { active: false, loading: false, playing: false };
    this.listeners.forEach(l => l());
  };
  exit = () => { const active = this.state.active; this.cancel(); if (active) void this.runtime.refreshStorage(); };
  reconcile = () => {
    if (this.state.active && this.identity !== this.runtime.getSnapshot().document.documentId) this.cancel();
  };
  start = () => {
    this.cancel();
    this.identity = this.runtime.getSnapshot().document.documentId;
    this.publish({ active: true, playing: true });
    this.seek(1);
  };
  pause = () => this.publish({ playing: false });
  toggle = () => {
    if (!this.state.active) this.start();
    else if (this.state.error) { this.publish({ playing: true }); this.seek(this.state.replay?.step ?? 1); }
    else this.publish({ playing: !this.state.playing });
  };
  advance = () => {
    if (!this.state.playing || this.state.loading || !this.state.replay) return;
    if (this.state.replay.step >= this.state.replay.steps.length) { this.pause(); return; }
    this.seek(this.state.replay.step + 1);
  };
  seek = (step: number) => {
    if (!this.state.active) return;
    this.reconcile();
    if (!this.state.active) return;
    const key = `${this.state.snapshot?.snapshotId}:${this.detail}:${step}`;
    const cached = this.state.snapshot && this.frames.get(key);
    if (cached) {
      this.generation++; this.wanted = undefined;
      this.frames.delete(key); this.frames.set(key, cached);
      this.publish({ frame: cached.frame, replay: cached.frame.replay, loading: false, error: undefined });
      return;
    }
    this.wanted = { step, generation: this.generation };
    this.publish({ loading: true, error: undefined });
    void this.drain();
  };
  private async drain() {
    if (this.inFlight || !this.wanted) return;
    const detail = this.detail;
    const request = this.wanted; this.wanted = undefined; this.inFlight = true;
    const snapshot = this.runtime.getSnapshot(),document=this.state.document??snapshot.document;
    let outcome: Outcome;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      outcome = await Promise.race([this.runtime.replay({ type: 'inspect_model', params: {
        documentId: document.documentId,
        snapshot:this.state.snapshot?{id:this.state.snapshot.snapshotId}:{},
        replay: { detail,step: request.step, expectedRevision: document.revision, expectedStorageVersion: this.state.snapshot?.storageVersion??snapshot.storageVersion!, ...(this.state.replay ? { key: this.state.replay.key } : {}) },
      } }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Build frame timed out. Retry or return to latest.')),this.options.timeoutMs??COMMAND_TIMEOUT_MS+5000);(timer as any).unref?.();})]);
      if (request.generation !== this.generation) return;
      this.reconcile();
      if (!this.state.active || request.generation !== this.generation) return;
      const frame = outcome.evaluation;
      if (outcome.result.status === 'error' || !frame?.replay)
        throw new Error(outcome.result.error?.message ?? 'The build frame was unavailable. Retry or return to latest.');
      if (!outcome.result.snapshot && JSON.stringify(frame.references ?? []) !== JSON.stringify(snapshot.evaluation.references ?? []))
        throw new Error('A component changed. Return to latest and restart replay.');
      if (outcome.result.snapshot) {
        const arrays = new Set(frame.meshes.flatMap(mesh => [mesh.vertices, mesh.normals, mesh.triangles, mesh.lines]));
        const values = [...arrays].reduce((total, array) => total + array.length, 0);
        if (values <= 4_000_000) {
          const key = `${outcome.result.snapshot.snapshotId}:${detail}:${request.step}`;
          this.cachedValues -= this.frames.get(key)?.values ?? 0;
          this.frames.delete(key); this.frames.set(key, { frame, values }); this.cachedValues += values;
          while (this.frames.size > 4 || this.cachedValues > 4_000_000) {
            const oldest = this.frames.keys().next().value!;
            this.cachedValues -= this.frames.get(oldest)!.values; this.frames.delete(oldest);
          }
        }
      }
      if(this.wanted){if(outcome.result.snapshot)this.publish({snapshot:outcome.result.snapshot,document:outcome.result.document});return;}
      this.publish({ frame, replay: frame.replay, loading: false,snapshot:outcome.result.snapshot,document:outcome.result.document });
    } catch (error) {
      if (request.generation === this.generation && !this.wanted) {
        this.publish({ playing: false, loading: false, error: error instanceof Error ? error.message : String(error) });
        void this.runtime.refreshStorage();
      }
    } finally {
      if(timer)clearTimeout(timer);
      this.inFlight = false;
      if (this.wanted) void this.drain();
    }
  }
}
