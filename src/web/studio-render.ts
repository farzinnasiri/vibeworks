import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';

/** Yield between completed dispatches when the live preview is being manipulated. */
export function dispatchDelay(elapsedMs: number, state: { hidden: boolean; interacting: boolean }) {
  return state.interacting && !state.hidden ? Math.min(50, elapsedMs * 1.75) : 0;
}

export interface RenderJobSpec {
  key: string;
  scene: () => THREE.Scene;
  release: (scene: THREE.Scene) => void;
  camera: THREE.Camera;
  width: number; height: number;
  samples: number; bounces: number;
  denoise?: boolean;
  exposure: number;
}
export interface RenderStatus { phase: 'preparing' | 'compiling' | 'rendering' | 'finishing'; samples: number; target: number; elapsedMs: number; etaMs?: number }
export interface RenderOutput { blob: Blob; thumbnail?: Blob; width: number; height: number; samples: number; elapsedMs: number; traceMs: number; hiddenMs: number; background: boolean }

class Ticker {
  private worker?: Worker; private timeout = 0; private stopped = true;
  /** False when the worker clock is unavailable and page timers, which browsers throttle in background tabs, drive the job. */
  get background() { return !!this.worker; }
  constructor(private tick: () => void) {
    try {
      this.worker = new Worker(new URL('./render-ticker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = () => { if (!this.stopped) this.tick(); };
      this.worker.onerror = event => {
        event.preventDefault(); this.worker?.terminate(); this.worker = undefined;
        // Worker script loading fails asynchronously, including if a render starts during an outage.
        if (!this.stopped) this.start();
      };
    } catch { this.worker = undefined; }
  }
  start() {
    this.stopped = false;
    if (this.worker) this.worker.postMessage(4);
    else { const loop = () => { if (this.stopped) return; this.tick(); this.timeout = window.setTimeout(loop, 4); }; loop(); }
  }
  stop() { this.stopped = true; this.worker?.postMessage(0); clearTimeout(this.timeout); }
  dispose() { this.stop(); this.worker?.terminate(); }
}

/** A captured image in its own native GPU context. Camera and scene edits only change the live preview. */
export class StudioRenderer {
  private surface = document.createElement('canvas');
  get canvas() { return this.surface; }
  private renderer?: WebGPURenderer;
  private tracer?: WebGPUPathTracer;
  private device?: GPUDevice;
  private key = '';
  private traced?: { scene: THREE.Scene; release: (scene: THREE.Scene) => void };
  private running?: { abort: () => void };
  private closed = false;
  private lost = false;
  private idle = 0;
  interacting = false;
  onDisplay?: () => void;
  get busy() { return !!this.running; }

  private async ensure() {
    if (this.closed) throw new DOMException('Render cancelled.', 'AbortError');
    if (this.renderer && !this.lost) return;
    this.teardown();
    if (this.lost) { this.surface = document.createElement('canvas'); this.lost = false; }
    if (!navigator.gpu) throw new Error('Final images need WebGPU. Use a current browser with graphics acceleration enabled. Save preview PNG remains available.');
    const [{ WebGPURenderer, NeutralToneMapping, SRGBColorSpace }, { WebGPUPathTracer, TRANSMISSIVE_BACKGROUND_ENVIRONMENT }] = await Promise.all([
      import('three/webgpu'), import('three-gpu-pathtracer/webgpu'),
    ]);
    const renderer = new WebGPURenderer({ canvas: this.surface, alpha: true, antialias: false, powerPreference: 'high-performance' });
    try {
      await renderer.init();
      const backend = renderer.backend as typeof renderer.backend & { isWebGPUBackend?: boolean; device?: GPUDevice };
      if (!backend.isWebGPUBackend || !backend.device) throw new Error('WebGPU could not start. Enable graphics acceleration or use a supported browser. Save preview PNG remains available.');
      if (this.closed) throw new DOMException('Render cancelled.', 'AbortError');
      renderer.setClearAlpha(0);
      renderer.setPixelRatio(1); renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = NeutralToneMapping;
      const tracer = new WebGPUPathTracer(renderer);
      tracer.maxTransparentBounces = 8; tracer.filterGlossyFactor = 0.5;
      tracer.renderDelay = 0; tracer.fadeDuration = 0; tracer.dynamicLowRes = false; tracer.minSamples = 1;
      tracer.transmissiveBackground = TRANSMISSIVE_BACKGROUND_ENVIRONMENT;
      this.renderer = renderer; this.tracer = tracer; this.device = backend.device; this.key = '';
      const device = this.device;
      void device.lost.then(() => { if (this.device === device) { this.lost = true; this.running?.abort(); } });
    } catch (error) { renderer.dispose(); throw error; }
  }

  async render(spec: RenderJobSpec, onStatus: (status: RenderStatus) => void, signal: AbortSignal): Promise<RenderOutput> {
    if (this.running) throw new Error('A render is already running.');
    clearTimeout(this.idle);
    const started = performance.now();
    const cancellation = new AbortController();
    let aborted = false; const abort = () => { aborted = true; cancellation.abort(); };
    this.running = { abort }; signal.addEventListener('abort', abort);
    const check = () => {
      if (this.lost) throw new Error('Graphics memory was lost while rendering. Render again to retry.');
      if (aborted || signal.aborted || this.closed) throw new DOMException('Render cancelled.', 'AbortError');
    };
    try {
      onStatus({ phase: 'preparing', samples: 0, target: spec.samples, elapsedMs: 0 });
      await this.ensure(); check();
      const renderer = this.renderer!, tracer = this.tracer!;
      renderer.setSize(spec.width, spec.height, false); renderer.toneMappingExposure = spec.exposure;
      // Each slot owns 448 bytes across the native ray queues. Bound working memory independently of output size.
      tracer.maxBounces = spec.bounces; tracer.maxSamples = spec.samples; tracer.frameBudget = 262144;
      if (this.key === spec.key && this.traced) tracer.setCamera(spec.camera);
      else {
        const scene = spec.scene();
        try { tracer.setScene(scene, spec.camera); }
        catch (error) { spec.release(scene); throw error; }
        if (this.traced) this.traced.release(this.traced.scene);
        this.traced = { scene, release: spec.release }; this.key = spec.key;
      }
      check(); tracer.reset();
      return await this.trace(spec, onStatus, started, check, cancellation.signal);
    } finally {
      signal.removeEventListener('abort', abort); this.running = undefined;
      if (this.closed) this.teardown();
      else this.idle = window.setTimeout(() => this.teardown(), 10000);
    }
  }

  private trace(spec: RenderJobSpec, onStatus: (status: RenderStatus) => void, started: number, check: () => void, signal: AbortSignal): Promise<RenderOutput> {
    const renderer = this.renderer!, tracer = this.tracer!, device = this.device!;
    let nextDispatch = 0, inFlight = false, settled = false, samples = 0, lastRead = 0, lastDisplay = 0, lastStatus = 0, firstSample = 0;
    let hiddenMs = 0, hiddenSince = document.hidden ? performance.now() : 0;
    onStatus({ phase: 'compiling', samples: 0, target: spec.samples, elapsedMs: performance.now() - started });
    return new Promise<RenderOutput>((resolve, reject) => {
      const ticker = new Ticker(() => {
        if (inFlight || settled || performance.now() < nextDispatch) return;
        inFlight = true;
        void step().catch(error => { settled = true; ticker.dispose(); reject(error); }).finally(() => { inFlight = false; });
      });
      const step = async () => {
        check();
        if (document.hidden && !hiddenSince) hiddenSince = performance.now();
        if (!document.hidden && hiddenSince) { hiddenMs += performance.now() - hiddenSince; hiddenSince = 0; }
        const submitted = performance.now();
        for (let i = 0; i < (this.interacting ? 1 : 2); i++) tracer.renderSample();
        // WebGPU completion, not CPU submission time, bounds the next dispatch.
        await device.queue.onSubmittedWorkDone(); check();
        const now = performance.now();
        // Resizing the native wavefront pool recompiles kernels and drops paths. Keep its size fixed.
        nextDispatch = now + dispatchDelay(now - submitted, { hidden: document.hidden, interacting: this.interacting });
        if (now - lastRead > 100 || !samples) { lastRead = now; samples = (await tracer.getSampleCountsAsync()).min; check(); }
        if (samples > 0 && !firstSample) firstSample = now;
        if (samples >= spec.samples) {
          settled = true; ticker.dispose();
          onStatus({ phase: 'finishing', samples: spec.samples, target: spec.samples, elapsedMs: now - started });
          if (hiddenSince) hiddenMs += now - hiddenSince;
          await this.finish(spec, signal); check();
          const blob = await new Promise<Blob | null>(done => this.canvas.toBlob(done, 'image/png')); check();
          if (!blob) throw new Error('The rendered image could not be encoded as PNG.');
          // History thumbnails must not decode and retain every full-resolution PNG in an <img>.
          const small = document.createElement('canvas'); small.width = 128; small.height = Math.max(1, Math.round(128 * spec.height / spec.width));
          small.getContext('2d')!.drawImage(this.canvas, 0, 0, small.width, small.height);
          const thumbnail = await new Promise<Blob | null>(done => small.toBlob(done, 'image/webp', 0.8));
          small.width = small.height = 0; check();
          resolve({ blob, ...(thumbnail ? { thumbnail } : {}), width: spec.width, height: spec.height, samples: spec.samples, elapsedMs: performance.now() - started,
            traceMs: now - (firstSample || started), hiddenMs, background: ticker.background });
          return;
        }
        if (!document.hidden && now - lastDisplay > 600) { lastDisplay = now; this.onDisplay?.(); }
        if (now - lastStatus > 250) {
          lastStatus = now;
          const rate = firstSample && now > firstSample ? samples / (now - firstSample) : 0;
          onStatus({ phase: samples ? 'rendering' : 'compiling', samples, target: spec.samples, elapsedMs: now - started,
            etaMs: rate ? (spec.samples - samples) / rate : undefined });
        }
      };
      ticker.start();
    });
  }

  private async finish(spec: RenderJobSpec, signal: AbortSignal) {
    if (spec.denoise) {
      const { denoiseStudioImage } = await import('./studio-denoise');
      await denoiseStudioImage(this.renderer!, this.tracer!.target!, this.traced!.scene, spec.camera, signal);
    }
    this.onDisplay?.();
  }

  private teardown() {
    clearTimeout(this.idle);
    this.tracer?.dispose(); this.renderer?.dispose();
    this.tracer = undefined; this.renderer = undefined; this.device = undefined; this.key = '';
    if (this.traced) { this.traced.release(this.traced.scene); this.traced = undefined; }
  }
  dispose() {
    clearTimeout(this.idle);
    this.closed = true; this.running?.abort();
    // Let a submitted dispatch finish before releasing resources it still owns.
    if (!this.running) this.teardown();
  }
}
