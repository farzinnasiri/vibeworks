import {useEffect,useRef,useState} from 'react';
import type {RuntimeClient,Outcome} from '../cad/runtime';
import {COMMAND_TIMEOUT_MS,type DisplayRequest,type CadDocument,type GraphSnapshot} from '../shared/protocol';
import type {Evaluation} from '../cad/types';

interface ProjectionRequest {key:string;params:DisplayRequest;documentId:string;freezeKey?:string;snapshotId?:string;sequence?:number}
/** Coalesce reads; one frozen graph is shared by every step in a history viewing session. */
export function useDisplayProjection(runtime:RuntimeClient, request:ProjectionRequest|undefined) {
 const [state,setState]=useState<{key:string;documentId?:string;freezeKey?:string;frame?:Evaluation;document?:CadDocument;snapshot?:GraphSnapshot;error?:string}>({key:''});
 const desired=useRef(request),busy=useRef(false),mounted=useRef(true),frozen=useRef<{key:string;id:string}|undefined>(undefined);
 desired.current=request;
 useEffect(()=>{
  mounted.current=true;
  // Effect cleanup also runs during hot reload and Strict Mode's setup/cleanup cycle.
  // Restore the current request so an in-flight first frame is not silently discarded.
  desired.current=request;
  return()=>{mounted.current=false;desired.current=undefined;};
 },[]);
 useEffect(()=>{
  const drain=async()=>{
   if(busy.current)return;
   while(mounted.current&&desired.current){
    const next=desired.current;busy.current=true;let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     const snapshot=next.freezeKey?next.snapshotId?{id:next.snapshotId}:frozen.current?.key===next.freezeKey?{id:frozen.current.id}:next.sequence!==undefined?{sequence:next.sequence}:{}:undefined;
     const outcome:Outcome=await Promise.race([runtime.replay({type:'inspect_model',params:{documentId:next.documentId,display:next.params,...(snapshot?{snapshot}:{})}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Display request timed out. Retry or return to latest.')),COMMAND_TIMEOUT_MS+5000);(timer as any).unref?.();})]);
     if(outcome.result.status==='error'||!outcome.evaluation)throw new Error(outcome.result.error?.message??'Display unavailable.');
     if(next.freezeKey&&outcome.result.snapshot&&desired.current?.freezeKey===next.freezeKey)frozen.current={key:next.freezeKey,id:outcome.result.snapshot.snapshotId};
     if(mounted.current&&desired.current?.key===next.key){
      if(!snapshot&&JSON.stringify(outcome.evaluation.references??[])!==JSON.stringify(runtime.getSnapshot().evaluation.references??[])){void runtime.refreshStorage();throw new Error('A source changed. Refreshing the latest model.');}
      setState({key:next.key,documentId:next.documentId,freezeKey:next.freezeKey,frame:outcome.evaluation,document:outcome.result.document,snapshot:outcome.result.snapshot});
     }
    }catch(error){if(mounted.current&&desired.current?.key===next.key)setState({key:next.key,error:error instanceof Error?error.message:String(error)});}
    finally{if(timer)clearTimeout(timer);busy.current=false;}
    if(desired.current?.key===next.key)break;
   }
  };
  void drain();
 },[runtime,request?.key]);
 const matches=!!request&&state.key===request.key;
 // Keep the last exact assembly frame while another step in the same frozen graph loads.
 // A new replay, another document or an explicitly different snapshot must start fresh.
 const retainFrame=!!request?.freezeKey&&request.freezeKey===state.freezeKey&&request.documentId===state.documentId&&
  (!request.snapshotId||request.snapshotId===state.snapshot?.snapshotId);
 return {frame:matches||retainFrame?state.frame:undefined,document:matches?state.document:undefined,snapshot:matches?state.snapshot:undefined,error:matches?state.error:undefined,loading:!!request&&!matches};
}
