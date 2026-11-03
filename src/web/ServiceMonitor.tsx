import {useRef,useState} from 'react';
import {Popover} from './Popover';
import {Icon} from './icons';
import {dialogs} from './Dialogs';
import {refreshService,serviceCall,useService} from './service-client';
const bytes=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(1)} GB`:`${(n/1024**2).toFixed(1)} MB`;
const uptime=(n:number)=>{const minutes=Math.floor(n/60_000);return minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:minutes?`${minutes}m ${Math.floor(n/1000)%60}s`:`${Math.floor(n/1000)}s`;};

/** Service reachability and actual MCP transports are separate facts. One monitor serves every entrance. */
export function ServiceMonitor(){
 const {data,error,loading}=useService(),[open,setOpen]=useState(false),[restarting,setRestarting]=useState(false),[restartError,setRestartError]=useState<string>();
 const anchor=useRef<HTMLButtonElement>(null);
 const phase=error?'offline':data?.phase??'starting';const label=phase==='online'?'Online':phase==='starting'?'Starting':phase==='restarting'?'Restarting':'Offline';
 const total=data?.requests.samples.reduce((n,s)=>n+s.count,0)??0,peak=Math.max(1,...(data?.requests.samples.map(s=>s.count)??[]));
 const restart=async()=>{
  setOpen(false);const approved=await dialogs.confirm({title:'Restart modeling service?',body:'Restart the geometry workers used by the app and MCP clients. Saved projects and history are preserved. Active requests or renders must finish first.',confirmLabel:'Restart service'});
  setOpen(true);if(!approved)return;setRestarting(true);setRestartError(undefined);
  try{await serviceCall('/service/restart',{action:'restart'});await refreshService();}catch(error){setRestartError(error instanceof Error?error.message:String(error));}finally{setRestarting(false);}
 };
 return <div className="service-monitor">
  <button ref={anchor} type="button" className={`bar-button service-trigger ${phase}`} aria-label={`MCP service: ${label}`} title="Modeling service and MCP connections" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(!open)}><span className="readiness-light" aria-hidden="true"/><span>MCP</span><span className="service-trigger-label">{label}</span></button>
  <Popover role="dialog" open={open} anchor={anchor} align="end" label="Service monitor" className="service-popover" onClose={()=>setOpen(false)}>
   <header className="service-heading"><div><strong>Modeling service</strong><span className={`service-state ${phase}`}>{label}</span></div><button type="button" className="icon-button" aria-label="Close service monitor" onClick={()=>setOpen(false)}><Icon name="close" size={16}/></button></header>
   <p className="service-connections">{data&&!error?`${data.mcpClients} MCP ${data.mcpClients===1?'client':'clients'} connected`:'Waiting for service connection'}</p>
   {(error||data?.error)&&<p className="field-error" role="alert">{error??data?.error}</p>}
   {loading&&!data&&<p role="status">Reading service status…</p>}
   {data&&<>
    <dl className={`service-metrics ${error?'stale':''}`} aria-label={error?'Last available measurements':'Service measurements'}>
     <div title="Memory used by the modeling service and its geometry workers. Browser memory is not included."><dt>Service memory</dt><dd>{bytes(data.memoryBytes)}</dd></div><div title="Database, history and journal files. Exported files are not included."><dt>Workspace storage</dt><dd>{bytes(data.storageBytes)}</dd></div><div><dt>Uptime</dt><dd>{uptime(data.uptimeMs)}</dd></div>
    </dl>
    <figure className="service-traffic"><figcaption><span>Requests · last minute</span><strong>{total}</strong></figcaption>
     <svg viewBox="0 0 300 65" role="img" aria-label={`${total} modeling requests in the last minute. ${data.requests.failed} failed since service start.`}>{data.requests.samples.map((sample,i)=><g key={sample.at}><rect x={i*5} y={60-sample.count/peak*56} width="3" height={sample.count/peak*56} rx="1" fill="currentColor"/>{sample.failed>0&&<rect x={i*5} y={60-sample.failed/peak*56} width="3" height={sample.failed/peak*56} rx="1" className="service-failed-bar"/>}</g>)}<path d="M0 61H300" className="service-chart-baseline"/></svg>
     <div className="service-traffic-labels"><span>60s ago</span><span>Now</span></div>
    </figure>
    <div className="service-counters"><span>{data.requests.total} total</span><span>{data.requests.mcp} via MCP</span><span>{data.requests.failed} failed</span><span>{data.pending} pending</span></div>
    {error&&<p className="field-hint">Showing the last available measurements.</p>}
   </>}
   {restartError&&<p className="field-error" role="alert">{restartError}</p>}
   <footer><button type="button" className="ghost-button" onClick={()=>void refreshService()}><Icon name="rotate" size={15}/>Refresh</button><button type="button" className="ghost-button" disabled={restarting||!!error||!data||data.phase==='starting'||data.phase==='restarting'} onClick={()=>void restart()}>{restarting?'Restarting…':'Restart service'}</button></footer>
  </Popover>
 </div>;
}
