import {randomUUID} from 'node:crypto';
import {readConnection} from './connection';
import {CONTRACT_FINGERPRINT} from './fingerprint';
/** An MCP transport is connected only after its initialize handshake. Expiry handles abrupt host exits. */
export function startMcpPresence(){
 const id=randomUUID();let stopped=false;
 const send=async(action:'heartbeat'|'leave')=>{try{const connection=await readConnection();if(stopped&&action==='heartbeat')return;
  await fetch(connection.httpUrl+'/service/mcp',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':CONTRACT_FINGERPRINT},body:JSON.stringify({id,action}),signal:AbortSignal.timeout(2000)});
 }catch{/* Bridge downtime is shown by the monitor; the next heartbeat reconnects. */}};
 void send('heartbeat');const timer=setInterval(()=>void send('heartbeat'),10_000);timer.unref();
 return()=>{stopped=true;clearInterval(timer);void send('leave');};
}
