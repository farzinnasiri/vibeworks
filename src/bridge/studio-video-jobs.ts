import { CadError } from '../cad/document';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { commandError, studioVideoOutputSchema, videoOutputSize, unknownHealth, type CadCommand, type CadResult, type FrozenGraph,
  type Presentation, type StudioVideoJob, type StudioVideoRecipe } from '../shared/protocol';
import { saveArtifact } from './artifacts';
import { MAX_VIDEO_OUTPUT } from './studio-video-encoder';
import { StudioVideoRenderer, type StudioVideoResult, type StudioVideoRunner } from './studio-video-renderer';

type Command = Extract<CadCommand, { type: 'render_video' }>;
type Start = Extract<Command['params'], { action: 'start' }>;
interface Job { signature: string; info: StudioVideoJob; receipt: CadResult; payload?: string; video?: CadResult['video']; abort: AbortController; timer?: NodeJS.Timeout }
const DEADLINE = 20 * 60_000, RETENTION = 30 * 60_000;
const DEFAULT_RECIPE: StudioVideoRecipe = { preset: { name: 'turntable' } };

/** Bounded video jobs, shaped like render_image: capture first, render later, poll by jobId. */
export class StudioVideoJobs {
  private jobs = new Map<string, Job>();
  private active?: Job;
  private work?: Promise<void>;
  private closed = false;
  private renderer?: StudioVideoRenderer;
  private runner: StudioVideoRunner;
  constructor(runner?: StudioVideoRunner, private deadlineMs = DEADLINE, private save = saveArtifact) {
    this.renderer = runner ? undefined : new StudioVideoRenderer(); this.runner = runner ?? this.renderer!.render;
  }
  private signature(params: Start) { const { sessionId: _, ...input } = params; return JSON.stringify(input); }
  get busy() { return [...this.jobs.values()].some(job => job.info.state === 'queued' || job.info.state === 'running'); }
  private prune() {
    for (const [id, job] of this.jobs) if (job !== this.active && job.info.state !== 'queued' && Date.parse(job.info.expiresAt) <= Date.now()) this.jobs.delete(id);
    while (this.jobs.size > 8) {
      const oldest = [...this.jobs].find(([, j]) => j !== this.active && j.info.state !== 'queued');
      if (!oldest) break; this.jobs.delete(oldest[0]);
    }
  }
  existing(params: Start): CadResult | undefined {
    this.prune(); const job = this.jobs.get(params.requestId); if (!job) return;
    if (job.signature !== this.signature(params)) throw new CadError('REQUEST_ID_CONFLICT', 'Video requestId already identifies different inputs. Use a new UUID.');
    return this.receipt(job);
  }
  checkCapacity() {
    if (this.closed) throw new CadError('RENDERER_UNAVAILABLE', 'Studio video service is shutting down.');
    if ([...this.jobs.values()].filter(j => j.info.state === 'queued' || j === this.active).length >= 2)
      throw new CadError('RENDERER_BUSY', 'One Studio video is running and one is queued. Wait or cancel one before submitting another.');
  }
  /** Freeze the committed graph and every default now: later edits, saved recipes and presentations cannot change this job. */
  startGraph(params: Start, graph: FrozenGraph): CadResult {
    const existing = this.existing(params); if (existing) return existing;
    this.checkCapacity();
    const recipe: StudioVideoRecipe = structuredClone(params.video ?? graph.document.video ?? DEFAULT_RECIPE);
    const output = studioVideoOutputSchema.parse({ ...recipe.output, ...params.output });
    const presentation: Presentation = structuredClone({ ...graph.document.presentation, ...params.presentation });
    const { width, height } = videoOutputSize(output);
    const now = Date.now();
    const info: StudioVideoJob = { jobId: params.requestId, state: 'queued', phase: 'queued', createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.deadlineMs).toISOString(), output, width, height, seconds: 0, frames: 0, completedFrames: 0,
      elapsedMs: 0, renderer: 'three-webgl/studio' };
    const receipt: CadResult = { operation: 'render_video', status: 'success', documentId: graph.document.documentId,
      revision: graph.document.revision, storageVersion: graph.snapshot.storageVersion, snapshot: graph.snapshot,
      provenance: { documentId: graph.document.documentId, revision: graph.document.revision, sources: graph.snapshot.sources.map(({ documentId, revision }) => ({ documentId, revision })) },
      health: unknownHealth(), created: [], updated: [],
      warnings: [params.video ? 'Using the recipe in this request.' : graph.document.video ? 'Using the camera move saved with the model (set_video).' : 'No recipe given or saved: rendering a turntable.'] };
    const job: Job = { signature: this.signature(params), info, receipt, abort: new AbortController(),
      payload: JSON.stringify({ graph, skipAnalysis: !!params.skipAnalysis, expiresAt: info.expiresAt, recipe: { ...recipe, output }, presentation,
        job: { width, height, fps: output.fps, quality: output.quality,meshDetail:output.meshDetail,depthOfField:output.depthOfField } }) };
    if (this.jobs.size >= 8) { const oldest = [...this.jobs].find(([, j]) => j !== this.active && j.info.state !== 'queued'); if (oldest) this.jobs.delete(oldest[0]); }
    this.jobs.set(info.jobId, job);
    job.timer = setTimeout(() => {
      if (job.info.state === 'queued' || job.info.state === 'running') {
        this.terminal(job, 'error', { code: 'RENDER_TIMEOUT', message: 'Studio video exceeded its twenty-minute budget, including queue time. Use a shorter move, a lower resolution or fps.' }); job.abort.abort();
      }
    }, this.deadlineMs); job.timer.unref?.();
    queueMicrotask(() => this.pump());
    return this.receipt(job);
  }
  control(params: Exclude<Command['params'], { action: 'start' }>): CadResult {
    this.prune(); const job = this.jobs.get(params.jobId);
    if (!job) throw new CadError('RENDER_JOB_NOT_FOUND', 'Video job is absent, expired, evicted or belongs to an earlier bridge lifetime. Start a new render.');
    if (params.action === 'cancel' && (job.info.state === 'queued' || job.info.state === 'running')) { this.terminal(job, 'cancelled'); job.abort.abort(); }
    const result = this.receipt(job);
    if (params.action === 'result' && job.info.state === 'complete') result.video = structuredClone(job.video);
    if (params.action === 'result' && job.info.state !== 'complete' && job.info.state !== 'error')
      result.warnings.push(`Video is ${job.info.state}; poll status until state is complete, then call result.`);
    if (job.info.state === 'error') return { ...result, ...commandError('render_video', job.info.error!.code, job.info.error!.message), videoJob: structuredClone(job.info) };
    return result;
  }
  async output(jobId:string):Promise<Buffer>{
    const result=this.control({action:'result',jobId});
    if(result.status==='error')throw new CadError(result.error!.code,result.error!.message);
    if(!result.video)throw new CadError('RENDER_NOT_READY','The video has not completed.');
    const bytes=await readFile(result.video.path);
    if(bytes.length!==result.video.byteLength||createHash('sha256').update(bytes).digest('hex')!==result.video.sha256)
      throw new CadError('INVALID_RESPONSE','The saved video changed after rendering.');
    return bytes;
  }
  private receipt(job: Job): CadResult {
    return { ...structuredClone(job.receipt), videoJob: structuredClone(job.info),
      warnings: [...job.receipt.warnings, 'Captured Studio video. Later model or scene edits do not update this job.'] };
  }
  private terminal(job: Job, state: 'error' | 'cancelled' | 'complete', error?: { code: string; message: string }) {
    clearTimeout(job.timer); job.info.state = state; job.info.phase = state;
    job.info.expiresAt = new Date(Date.now() + RETENTION).toISOString(); job.info.elapsedMs = Date.now() - Date.parse(job.info.createdAt);
    job.info.error = error; job.info.etaMs = undefined; job.payload = undefined;
  }
  private pump() {
    if (this.active || this.closed) return;
    const job = [...this.jobs.values()].find(j => j.info.state === 'queued'); if (!job) return;
    this.active = job; job.info.state = 'running'; job.info.phase = 'preparing';
    const payload = job.payload!; job.payload = undefined;
    const started = Date.now();
    let renderStarted = 0;
    this.work = (async () => {
      try {
        const result: StudioVideoResult = await this.runner(payload, status => {
          if (job.info.state !== 'running') return;
          job.info.phase = status.phase; job.info.frames = status.frames; job.info.completedFrames = status.completedFrames;
          if (status.seconds !== undefined) job.info.seconds = status.seconds;
          if (status.keyframes) job.info.keyframes = status.keyframes;
          job.info.elapsedMs = Date.now() - Date.parse(job.info.createdAt);
          if (status.phase === 'rendering' && !renderStarted) renderStarted = Date.now();
          if (status.phase === 'rendering' && status.completedFrames >= 4)
            job.info.etaMs = (Date.now() - renderStarted) / status.completedFrames * (status.frames - status.completedFrames);
        }, job.abort.signal);
        if (job.info.state !== 'running') return;
        if (result.mp4.length < 32 || result.mp4.toString('ascii', 4, 8) !== 'ftyp') throw new CadError('INVALID_RESPONSE', 'Studio video renderer did not return an MP4.');
        const name = `studio-video-r${job.receipt.revision ?? 'x'}.mp4`;
        const saved = await this.save(result.mp4, name, 'video/mp4', undefined, MAX_VIDEO_OUTPUT);
        job.video = { ...saved, mimeType: 'video/mp4', width: job.info.width, height: job.info.height, fps: job.info.output.fps,
          frames: result.frames, seconds: result.seconds,
          poster: { mimeType: 'image/png', base64: result.poster.toString('base64'), width: job.info.width, height: job.info.height } };
        if (result.health) job.receipt.health = result.health;
        if (result.warnings) job.receipt.warnings.push(...result.warnings);
        if (result.evaluationStats) job.receipt.evaluationStats = result.evaluationStats;
        job.info.frames = result.frames; job.info.completedFrames = result.frames; job.info.seconds = result.seconds; job.info.keyframes = result.keyframes;
        job.receipt.durationMs = Date.now() - started;
        this.terminal(job, 'complete');
      } catch (error) {
        if (job.info.state === 'running') this.terminal(job, 'error', { code: error instanceof CadError ? error.code : 'STUDIO_RENDER_FAILED', message: String(error).slice(0, 2000) });
      } finally { this.active = undefined; this.work = undefined; this.prune(); this.pump(); }
    })();
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (job.info.state === 'queued' || job.info.state === 'running') { this.terminal(job, 'cancelled'); job.abort.abort(); }
    await this.work; this.jobs.clear(); this.renderer?.close();
  }
}
