import { useEffect, useRef, useState } from 'react';
import type { Evaluation } from '../cad/types';
import type { Outcome } from '../cad/runtime';
import type { CadCommand, StudioVideoAnimation } from '../shared/protocol';
import type { StudioView } from './StudioViewport';
import { constructionStep, validateExplosion } from './studio-video-animation';

type Inspect=(params:Extract<CadCommand,{type:'inspect_model'}>['params'])=>Promise<Outcome>;
/** Exact preview requests are coalesced, so scrubbing never queues a worker request for every pointer event. */
export function useStudioVideoAnimation(animation:StudioVideoAnimation|undefined,position:number,duration:number,evaluation:Evaluation,
  documentId:string,api:React.RefObject<StudioView|null>,inspect:Inspect|undefined){
  const [note,setNote]=useState(''),[error,setError]=useState('');
  const generation=useRef(0),pending=useRef<(()=>Promise<void>)|undefined>(undefined),running=useRef(false);
  const captured=useRef<{id:string;steps:number;shown:number;expectedRevision:number;expectedStorageVersion:number}|undefined>(undefined);
  const current=useRef({api,inspect});current.current={api,inspect};
  useEffect(()=>{
    generation.current++;captured.current=undefined;setNote('');setError('');
    return()=>{generation.current++;pending.current=undefined;current.current.api.current?.animateVideo?.(undefined,0);void current.current.api.current?.previewVideoModel?.();};
  },[animation?.kind,evaluation,documentId]);
  useEffect(()=>{
    const progress=duration?position/duration:0;
    if(animation?.kind!=='construction'){
      try{if(animation?.kind==='exploded')validateExplosion(animation,evaluation);api.current?.animateVideo?.(animation,progress);setError('');}
      catch(error){setError(String(error));}
      return;
    }
    const epoch=generation.current;
    pending.current=async()=>{
      if(!current.current.inspect)throw new Error('Reconnect to the Node service to preview construction.');
      const read=async(params:Parameters<Inspect>[0])=>{
        const outcome=await current.current.inspect!(params);
        if(outcome.result.status==='error')throw new Error(outcome.result.error!.message);
        return outcome;
      };
      setNote('Preparing exact construction preview…');
      if(!captured.current){
        const frozen=await read({documentId,snapshot:{},definitionsOnly:true});
        if(epoch!==generation.current)return;
        const id=frozen.result.snapshot!.snapshotId;
        const guards={expectedRevision:frozen.result.snapshot!.revision,expectedStorageVersion:frozen.result.snapshot!.storageVersion};
        const first=await read({documentId,snapshot:{id},replay:{step:1,key:id,...guards}});
        if(epoch!==generation.current)return;
        captured.current={id,steps:first.evaluation!.replay!.steps.length,shown:0,...guards};
      }
      const capture=captured.current,step=constructionStep(animation,capture.steps,progress);
      if(capture.shown!==step){
        const outcome=await read({documentId,snapshot:{id:capture.id},replay:{step,key:capture.id,expectedRevision:capture.expectedRevision,expectedStorageVersion:capture.expectedStorageVersion}});
        if(epoch!==generation.current)return;
        if(!outcome.evaluation)throw new Error('The worker returned no construction display.');
        await current.current.api.current?.previewVideoModel?.(outcome.evaluation);
        capture.shown=step;
      }
      if(epoch===generation.current){setNote(`Construction step ${step} / ${capture.steps} · exact preview`);setError('');}
    };
    if(running.current)return;
    running.current=true;
    void(async()=>{
      try{while(pending.current){const work=pending.current;pending.current=undefined;await work();}}
      catch(error){if(epoch===generation.current)setError(error instanceof Error?error.message:String(error));}
      finally{running.current=false;}
    })();
  },[animation,position,duration,evaluation,documentId]);
  return {note,error};
}
