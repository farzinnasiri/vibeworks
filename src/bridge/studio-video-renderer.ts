import { chromium, type Browser } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CadError } from '../cad/document';
import type { CadResult, StudioVideoJob } from '../shared/protocol';
import { StudioVideoEncoder, VideoEncodingError } from './studio-video-encoder';
import { StudioConstructionCapture } from './studio-capture';

export interface StudioVideoProgress { phase: 'preparing' | 'rendering' | 'encoding'; completedFrames: number; frames: number; seconds?: number; keyframes?: StudioVideoJob['keyframes'] }
export interface StudioVideoResult {
  mp4: Buffer; poster: Buffer; frames: number; seconds: number; keyframes: NonNullable<StudioVideoJob['keyframes']>;
  health?: CadResult['health']; warnings?: string[]; evaluationStats?: CadResult['evaluationStats'];
}
export type StudioVideoRunner = (payload: string, progress: (status: StudioVideoProgress) => void, signal: AbortSignal) => Promise<StudioVideoResult>;
const exec = promisify(execFile), require = createRequire(import.meta.url);

/**
 * A video owns one exact preparation, one display-only Chromium page and one FFmpeg pipe for its lifetime.
 * Frames go straight from the page to the encoder in order; nothing accumulates in memory or on disk.
 */
export class StudioVideoRenderer {
  private bundle?: string;
  constructor(private executable = 'ffmpeg') {}
  close() { this.bundle = undefined; }
  render: StudioVideoRunner = async (payload, progress, signal) => {
    let browser: Browser | undefined;
    let construction: StudioConstructionCapture | undefined;
    const encoder = new StudioVideoEncoder(this.executable, 20 * 60_000), id = randomUUID();
    const abort = () => { void browser?.close().catch(() => {}); void encoder.cancel(id); };
    signal.addEventListener('abort', abort);
    const check = () => { if (signal.aborted) throw new CadError('RENDER_CANCELLED', 'Studio video was cancelled.'); };
    try {
      check();
      const input = JSON.parse(payload);
      const { prepareStudioCapture } = await import('./studio-capture');
      progress({ phase: 'preparing', completedFrames: 0, frames: 0 });
      const prepared = await prepareStudioCapture(input.graph, { expiresAt: input.expiresAt,meshDetail:input.job.meshDetail??'fine' }, input.skipAnalysis, () => {}, signal);
      if(input.recipe.animation?.kind==='construction')construction=new StudioConstructionCapture(input.graph,input.expiresAt,signal,input.job.meshDetail!=='standard');
      check();
      if (!this.bundle) {
        const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
          `import {build} from ${JSON.stringify(require.resolve('esbuild'))};
          const r=await build({entryPoints:[${JSON.stringify(fileURLToPath(new URL('../web/studio-video-output-entry.ts', import.meta.url)))}],bundle:true,write:false,format:'iife',platform:'browser',minify:true,logLevel:'silent',loader:{'.tza':'dataurl'}});process.stdout.write(r.outputFiles[0].text);`],
          { timeout: 30000, maxBuffer: 32 * 1024 * 1024, signal });
        this.bundle = stdout;
      }
      check();
      browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] }); check();
      const page = await browser.newPage();
      if(construction)await page.exposeFunction('__videoConstruction',(step:number)=>construction!.frame(step));
      await page.route('**/*', route => route.request().url() === 'http://127.0.0.1/'
        ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }) : route.abort());
      await page.goto('http://127.0.0.1/');
      let plan: { frames: number; seconds: number; keyframes: StudioVideoResult['keyframes']; warnings?: string[] } | undefined;
      let previous: Buffer | undefined, poster: Buffer | undefined, posterAt = 0;
      await page.exposeFunction('__videoPlan', async (text: string) => {
        plan = JSON.parse(text);
        if (!plan || plan.frames < 12) throw new Error('Video must last at least half a second.');
        posterAt = Math.floor(plan.frames * 0.4);
        await encoder.start({ id, width: input.job.width, height: input.job.height, fps: input.job.fps, frames: plan.frames, quality: input.job.quality });
        progress({ phase: 'rendering', completedFrames: 0, frames: plan.frames, seconds: plan.seconds, keyframes: plan.keyframes });
      });
      await page.exposeFunction('__videoFrame', async (index: number, base64: string | null) => {
        check();
        const png = base64 ? Buffer.from(base64, 'base64') : previous;
        if (!png) throw new Error('The first video frame cannot repeat an earlier one.');
        await encoder.frame(id, index, png);
        previous = png;
        if (index === posterAt) poster = png;
        progress({ phase: 'rendering', completedFrames: index + 1, frames: plan!.frames, seconds: plan!.seconds, keyframes: plan!.keyframes });
      });
      await page.addScriptTag({ content: this.bundle }); check();
      const { evaluation, health, warnings, evaluationStats } = prepared;
      await page.evaluate(async p => await (globalThis as any).__studioVideo(JSON.parse(p)),
        JSON.stringify({ evaluation, recipe: input.recipe, presentation: input.presentation, job: input.job, constructionSteps: construction?.steps }));
      check();
      progress({ phase: 'encoding', completedFrames: plan!.frames, frames: plan!.frames, seconds: plan!.seconds, keyframes: plan!.keyframes });
      const mp4 = await encoder.finish(id);
      return { mp4, poster: poster ?? previous!, frames: plan!.frames, seconds: plan!.seconds, keyframes: plan!.keyframes, health,
        warnings: [...(warnings ?? []), ...(plan!.warnings ?? [])], evaluationStats };
    } catch (error) {
      check();
      if (error instanceof CadError) throw error;
      if (error instanceof VideoEncodingError) throw new CadError(error.code, error.message);
      const missing = /Executable doesn't exist/.test(String(error));
      throw new CadError(missing ? 'RENDERER_DEPENDENCY' : 'STUDIO_RENDER_FAILED',
        (missing ? 'Install the pinned Chromium with pnpm run renderer:install. ' : 'Studio video failed. ') + String(error).slice(0, 1500));
    } finally {
      signal.removeEventListener('abort', abort);
      await browser?.close().catch(() => {});
      await construction?.close();
      await encoder.cancel(id);
    }
  };
}
