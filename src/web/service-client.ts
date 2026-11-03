import {useSyncExternalStore} from 'react';
import {browserConnectionSchema,serviceStatusSchema,type ServiceStatus} from '../shared/protocol';

declare const __VIBEWORKS_FINGERPRINT__:string;
let connection:ReturnType<typeof browserConnectionSchema.parse>|undefined;
let state:{data?:ServiceStatus;error?:string;loading:boolean}={loading:true};
const listeners=new Set<()=>void>();let timer:ReturnType<typeof setInterval>|undefined,pending=false;
const publish=(next:typeof state)=>{state=next;listeners.forEach(listener=>listener());};
export async function serviceCall(path='/service',body?:object){
 if(!connection){const response=await fetch('/api/connection',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Service is offline. Start make dev or the headless service.');connection=browserConnectionSchema.parse(await response.json());}
 const response=await fetch('/api'+path,{method:body?'POST':'GET',cache:'no-store',headers:{Authorization:'Bearer '+connection.token,'X-Vibeworks-Fingerprint':__VIBEWORKS_FINGERPRINT__,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?30_000:5000)});
 if(response.status===401)connection=undefined;
 const value=await response.json().catch(()=>{throw Error('Service is offline. Start make dev or the headless service.');});if(!response.ok)throw Error(value.error?.message??'Service is unavailable.');
 return value;
}
export async function refreshService(){if(pending||document.hidden)return;pending=true;try{const data=serviceStatusSchema.parse(await serviceCall());publish({data,loading:false});}catch(error){publish({...state,error:error instanceof Error?error.message:String(error),loading:false});}finally{pending=false;}}
function subscribe(listener:()=>void){listeners.add(listener);if(!timer){void refreshService();timer=setInterval(()=>void refreshService(),2000);document.addEventListener('visibilitychange',refreshService);}
 return()=>{listeners.delete(listener);if(!listeners.size){clearInterval(timer);timer=undefined;document.removeEventListener('visibilitychange',refreshService);}};
}
export function useService(){return useSyncExternalStore(subscribe,()=>state);}
