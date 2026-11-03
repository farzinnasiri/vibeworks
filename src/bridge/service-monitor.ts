import {randomUUID} from 'node:crypto';
import type {ServiceStatus} from '../shared/protocol';

/** One bounded minute of real command traffic. Polls and presence heartbeats are excluded. */
export class ServiceMonitor {
 private started=Date.now();private id=randomUUID();private total=0;private failed=0;private active=0;private mcp=0;
 private samples=new Map<number,{count:number;failed:number}>();private clients=new Map<string,number>();
 constructor(private now=()=>Date.now()){this.started=now();}
 presence(id:string,action:'heartbeat'|'leave'){if(action==='leave')this.clients.delete(id);else{this.clients.delete(id);this.clients.set(id,this.now());if(this.clients.size>128)this.clients.delete(this.clients.keys().next().value!);}}
 begin(mcp:boolean){this.total++;this.active++;if(mcp)this.mcp++;const at=Math.floor(this.now()/1000)*1000;
  const sample=this.samples.get(at)??{count:0,failed:0};sample.count++;this.samples.set(at,sample);this.prune();let done=false;
  return(failed:boolean)=>{if(done)return;done=true;this.active--;if(failed){this.failed++;if(this.samples.has(at))sample.failed++;}};
 }
 restart(){this.started=this.now();this.id=randomUUID();this.total=0;this.failed=0;this.mcp=0;this.samples.clear();}
 private prune(){for(const at of this.samples.keys())if(at<this.now()-60_000)this.samples.delete(at);for(const[id,at]of this.clients)if(at<this.now()-25_000)this.clients.delete(id);}
 read():Pick<ServiceStatus,'serviceId'|'startedAt'|'uptimeMs'|'mcpClients'|'requests'>{this.prune();const end=Math.floor(this.now()/1000)*1000;
  return{serviceId:this.id,startedAt:new Date(this.started).toISOString(),uptimeMs:Math.max(0,this.now()-this.started),mcpClients:this.clients.size,
   requests:{total:this.total,failed:this.failed,active:this.active,mcp:this.mcp,samples:Array.from({length:60},(_,i)=>{const at=end-(59-i)*1000;return{at,...(this.samples.get(at)??{count:0,failed:0})};})}};
 }
}
