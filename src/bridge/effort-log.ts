import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/server';
const identicalCalls=new Map<string,number>();
function logParameters(value:unknown):unknown{
 if(Array.isArray(value))return value.map(logParameters);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/token|secret|password|authorization|api.?key|base64|dataUrl/i.test(key)?'[redacted]':logParameters(v)]));
 return value;
}
/** Opt-in local measurement. Byte counts are transport bytes, never token estimates. */
export function logMcpCall(tool:string,args:unknown,reply:CallToolResult,started:number):void {
 const path=process.env.VIBEWORKS_MCP_LOG;
 if(!path)return;
 const result=reply.structuredContent as {status?:string;requestId?:string;actor?:{sessionId?:string};image?:{path?:string;panels?:{path?:string}[]};error?:{code?:string}}|undefined;
 const argumentHash=createHash('sha256').update(JSON.stringify(args)).digest('hex');
 const identity=tool+argumentHash;const identicalCallOrdinal=(identicalCalls.get(identity)??0)+1;identicalCalls.set(identity,identicalCallOrdinal);if(identicalCalls.size>10000)identicalCalls.delete(identicalCalls.keys().next().value!);
 const imageArtifacts=[result?.image?.path,...(result?.image?.panels??[]).map(p=>p.path)].filter(Boolean);
 const images=reply.content.filter(c=>c.type==='image').map(c=>({mimeType:c.mimeType,bytes:Buffer.from(c.data,'base64').byteLength}));
 try { appendFileSync(path,JSON.stringify({at:new Date().toISOString(),sessionId:(args as {sessionId?:string})?.sessionId??result?.actor?.sessionId,requestId:result?.requestId,tool,...(process.env.VIBEWORKS_MCP_LOG_PARAMETERS==='1'?{parameters:logParameters(args)}:{}),argumentHash,identicalCallOrdinal,imageArtifacts,argumentBytes:Buffer.byteLength(JSON.stringify(args)),replyBytes:Buffer.byteLength(JSON.stringify(reply)),images,status:reply.isError?'error':result?.status??'success',errorCode:result?.error?.code,durationMs:performance.now()-started})+'\n',{mode:0o600}); }
 catch(error){process.stderr.write(`[cad-mcp] effort log unavailable: ${error instanceof Error?error.message:String(error)}\n`);}
}
