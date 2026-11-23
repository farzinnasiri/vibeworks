import { chromium, type Browser } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CadError } from '../cad/document';
import type { CadResult, RenderedTile } from '../shared/protocol';
import type { RenderStatus } from '../web/studio-render';

export interface StudioImageResult {health?:CadResult['health'];warnings?:string[];evaluationStats?:CadResult['evaluationStats'];base64:string;width:number;height:number;camera:RenderedTile;samples:number;elapsedMs:number}
export type StudioImageRunner = (payload:string,progress:(status:RenderStatus)=>void,signal:AbortSignal)=>Promise<StudioImageResult>;
const exec=promisify(execFile),require=createRequire(import.meta.url);

/** A final image owns its browser/GPU lifetime, separate from software-WebGL inspection outputs. */
export class StudioImageRenderer {
  private bundle?:string;
  // One immutable prepared graph, at most 32 MiB, reused for repeated camera/lighting requests.
  private prepared?:{snapshotId:string;evaluation:string;metadata:Pick<StudioImageResult,'health'|'warnings'|'evaluationStats'>};
  close(){this.prepared=undefined;this.bundle=undefined;}
  render:StudioImageRunner=async(payload,progress,signal)=>{
    let capture:Pick<StudioImageResult,'health'|'warnings'|'evaluationStats'>={};
    let browser:Browser|undefined, poll:ReturnType<typeof setInterval>|undefined;
    const abort=()=>{void browser?.close().catch(()=>{});};
    signal.addEventListener('abort',abort);
    const check=()=>{if(signal.aborted)throw new CadError('RENDER_CANCELLED','Studio image was cancelled.');};
    try {
      check();
      const input=JSON.parse(payload);
      if(input.graph){
        const {prepareStudioCapture}=await import('./studio-capture');
        const key=input.graph.snapshot.snapshotId+'|'+input.skipAnalysis;
        if(this.prepared?.snapshotId===key){capture=this.prepared.metadata;input.evaluation=JSON.parse(this.prepared.evaluation);}
        else {
          this.prepared=undefined;
          const prepared=await prepareStudioCapture(input.graph,input.job,input.skipAnalysis,progress,signal);
          capture={health:prepared.health,warnings:prepared.warnings,evaluationStats:prepared.evaluationStats};
          input.evaluation=prepared.evaluation;
          this.prepared={snapshotId:key,evaluation:JSON.stringify(prepared.evaluation),metadata:capture};
        }
        delete input.graph;delete input.skipAnalysis;
        payload=JSON.stringify(input);check();
      }
      if(!this.bundle){
        const {stdout}=await exec(process.execPath,['--input-type=module','-e',
          `import {build} from ${JSON.stringify(require.resolve('esbuild'))};
          const r=await build({entryPoints:[${JSON.stringify(fileURLToPath(new URL('../web/studio-output-entry.ts',import.meta.url)))}],bundle:true,write:false,format:'iife',platform:'browser',minify:true,logLevel:'silent',loader:{'.tza':'dataurl'}});process.stdout.write(r.outputFiles[0].text);`],
          {timeout:30000,maxBuffer:32*1024*1024,signal});
        this.bundle=stdout;
      }
      check();
      browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]});check();
      const page=await browser.newPage();
      // A fulfilled loopback origin is trustworthy for WebGPU. No network or local web server is used.
      await page.route('**/*',route=>route.request().url()==='http://127.0.0.1/'
        ? route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}) : route.abort());
      await page.goto('http://127.0.0.1/');
      if(!await page.evaluate(async()=>{const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});return !!adapter && !adapter.info.isFallbackAdapter;}))
        throw new CadError('WEBGPU_UNAVAILABLE','Managed Chromium could not obtain a WebGPU adapter. Enable graphics acceleration on this host; render_views remains available for raster inspection.');
      await page.addScriptTag({content:this.bundle});check();
      let reading=false;
      poll=setInterval(()=>{
        if(reading)return;reading=true;
        void page.evaluate(()=>(globalThis as any).__studioProgress).then(s=>{if(s)progress(s);}).catch(()=>{}).finally(()=>{reading=false;});
      },300);
      const result=await page.evaluate(async p=>await (globalThis as any).__studioOutput(JSON.parse(p)),payload);
      check();return {...result,...capture};
    } catch(error){
      check();
      if(error instanceof CadError)throw error;
      const missing=/Executable doesn't exist/.test(String(error));
      throw new CadError(missing?'RENDERER_DEPENDENCY':'STUDIO_RENDER_FAILED',
        (missing?'Install the pinned Chromium with pnpm run renderer:install. ':'Studio image failed; no raster fallback was returned. ')+String(error));
    } finally {clearInterval(poll);signal.removeEventListener('abort',abort);await browser?.close().catch(()=>{});}
  };
}
