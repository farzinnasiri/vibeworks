import type { CadCommand, CadResult, StudioVideoRecipe, Presentation } from '../shared/protocol';
import type { VideoProgress } from './studio-video-render';
declare const __VIBEWORKS_FINGERPRINT__:string;

/** Humans submit the same frozen render_video job as agents; the private download only delivers its saved bytes. */
export async function renderSharedStudioVideo(execute:(command:CadCommand)=>Promise<CadResult>,documentId:string,revision:number,
  recipe:StudioVideoRecipe,presentation:Presentation,progress:(value:VideoProgress)=>void,signal:AbortSignal){
  const requestId=crypto.randomUUID(),started=performance.now();
  const cancel=()=>execute({type:'render_video',params:{action:'cancel',jobId:requestId}}).catch(()=>{});
  signal.addEventListener('abort',cancel,{once:true});
  const accepted=(result:CadResult)=>{
    if(result.status==='error')throw Object.assign(new Error(result.error!.message),{code:result.error!.code});
    if(!result.videoJob)throw new Error('The bridge returned no video job.');
    return result;
  };
  try{
    signal.throwIfAborted();
    let result=accepted(await execute({type:'render_video',params:{action:'start',documentId,expectedRevision:revision,requestId,video:recipe,presentation,skipAnalysis:true}}));
    while(result.videoJob!.state!=='complete'){
      signal.throwIfAborted();const job=result.videoJob!;
      if(job.state==='cancelled')throw new DOMException('Video cancelled.','AbortError');
      progress({phase:job.phase==='queued'?'preparing':job.phase as VideoProgress['phase'],frames:job.completedFrames,total:job.frames,samples:0,target:0,elapsedMs:job.elapsedMs,etaMs:job.etaMs});
      await new Promise<void>((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},250);signal.addEventListener('abort',stop,{once:true});
        if(signal.aborted)stop();
      });
      result=accepted(await execute({type:'render_video',params:{action:'status',jobId:requestId}}));
    }
    result=accepted(await execute({type:'render_video',params:{action:'result',jobId:requestId}}));
    const connection=await (await fetch('/api/connection',{cache:'no-store',signal})).json();
    const response=await fetch(`/api/studio-video/result?jobId=${requestId}`,{headers:{Authorization:`Bearer ${connection.token}`,'X-Vibeworks-Fingerprint':__VIBEWORKS_FINGERPRINT__},signal});
    if(!response.ok)throw new Error('The finished video could not be downloaded.');
    const blob=await response.blob();signal.throwIfAborted();
    if(blob.type!=='video/mp4'||blob.size!==result.video!.byteLength)throw new Error('The video download did not match its captured result.');
    return {blob,frames:result.video!.frames,width:result.video!.width,height:result.video!.height,elapsedMs:performance.now()-started,warnings:result.warnings};
  }catch(error){await cancel();throw error;}
  finally{signal.removeEventListener('abort',cancel);}
}
