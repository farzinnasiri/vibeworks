import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { COMMAND_TIMEOUT_MS, uncertainOutcome, knownCreatedDocumentId, withCreationRequestId, changesDocument, commandError, commandFailureSchema, type CadCommand, type CadResult, type LocalConnection } from '../shared/protocol.ts';
import { rejectedAttemptSchema, type RejectedAttempt } from '../shared/protocol.ts';
import { readConnection } from './connection.ts';
import { MAX_COMMAND_BYTES } from './validation.ts';
import { CONTRACT_FINGERPRINT } from './fingerprint.ts';
import { doctor } from './doctor.ts';
import { diagnosisError, deduplicateIssues } from './diagnosis.ts';
import { readJson } from './http.ts';

// The authenticated bridge validates CadResult content. Only routing, status and
// the receipt envelope are checked here; unknown result fields pass through.
// Binary sizes, signatures and safe output paths are still checked by deliver.ts.
export const adapterResultSchema = z.object({
  operation: z.string(), status: z.enum(['success', 'error']),
  documentId: z.string().uuid().optional(), revision: z.number().int().nonnegative().optional(),
  created: z.array(z.string()), updated: z.array(z.string()), warnings: z.array(z.string()),
  error: commandFailureSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  const emptyWorkspace = value.operation === 'inspect_model' && !!value.inspection && typeof value.inspection==='object' && 'emptyWorkspace' in value.inspection && value.inspection.emptyWorkspace===true || value.operation === 'inspect_model' && Array.isArray(value.documents) && value.documents.length === 0 && Array.isArray(value.projects) && !value.document && !value.geometry;
  if (value.status === 'error' ? !value.error : value.error || (!emptyWorkspace && !['documents','agent_session','activity','describe','workspace_view'].includes(value.operation) && (!value.documentId || value.revision === undefined))) ctx.addIssue({ code: 'custom', message: 'Invalid result status envelope.' });
});

const clientInstanceId=randomUUID();
let adapterSession:{id:string;connection:string}|undefined;
const adapterSessions=new Map<string,{connection:string;readLocal:()=>Promise<LocalConnection>;fingerprint:string}>();
let heartbeat:ReturnType<typeof setInterval>|undefined;
export function useAgentSession(id:string|undefined){if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;adapterSessions.clear();adapterSession=id?{id,connection:''}:undefined;}
export async function forwardCommand(command: CadCommand, readLocal: () => Promise<LocalConnection> = readConnection, fingerprint = CONTRACT_FINGERPRINT, context?:{sessionId?:string;intent?:import('../shared/protocol').OperationIntent;heartbeat?:boolean}): Promise<CadResult> {
  command = withCreationRequestId(command);
  if(command.type==='agent_session'&&['join','resume'].includes(command.params.action))command={...command,params:{...command.params,clientInstanceId}};
  const started = performance.now();
  const creation=(command.type==='documents'&&['create','duplicate','duplicate_project','create_project'].includes(command.params.action))
    ||(command.type==='workspace_view'&&command.params.action==='present');
  const requestId=creation&&'requestId'in command.params ? command.params.requestId! : randomUUID();
  const finish = (result: CadResult): CadResult => {
    result.requestId = requestId;
    if (result.timings && result.durationMs !== undefined) result.timings = { ...result.timings, transportMs: Math.round(Math.max(0, performance.now() - started - result.durationMs) * 10) / 10 };
    return result;
  };
  let connection: LocalConnection;
  try { connection = await readLocal(); }
  catch (error) {
    const diagnosis = await doctor(async () => { throw error; }, fingerprint);
    const failure = diagnosisError(diagnosis)!;
    return finish({ ...commandError(command.type, failure.code, failure.message), error: failure });
  }
  if (connection.fingerprint !== fingerprint) {
    const diagnosis = await doctor(async () => connection, fingerprint);
    const failure = diagnosisError(diagnosis) ?? commandError(command.type, 'VERSION_SKEW', 'Connection file and adapter fingerprints differ.').error!;
    return finish({ ...commandError(command.type, failure.code, failure.message), error: failure });
  }
  const connectionIdentity=connection.httpUrl+'|'+connection.token;
  const sessionId=context?.sessionId??command.params.sessionId??(adapterSession&&(!adapterSession.connection||adapterSession.connection===connectionIdentity)?adapterSession.id:undefined)??process.env.VIBEWORKS_AGENT_SESSION;
  if(sessionId && command.type!=='agent_session' && context?.heartbeat!==false){
    const pulse=await forwardCommand({type:'agent_session',params:{action:'heartbeat'}},readLocal,fingerprint,{sessionId,heartbeat:false});
    if(pulse.status==='error')return finish({...pulse,operation:command.type});
  }
  const body = JSON.stringify({ requestId, command, ...(sessionId?{sessionId}:{}), ...(context?.intent?{intent:context.intent}:('intent' in command.params && command.params.intent?{intent:command.params.intent}:{})) });
  if (Buffer.byteLength(body) > MAX_COMMAND_BYTES) return commandError(command.type, 'PAYLOAD_TOO_LARGE', `Command exceeds ${MAX_COMMAND_BYTES} bytes.`);
  let dispatched = false;
  let createdDocumentId: string | undefined;
  try {
    // One request, one ID, no retries. Aborting HTTP cannot undo browser work.
    dispatched = true;
    const response = await fetch(`${connection.httpUrl}/command`, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', 'X-Vibeworks-Fingerprint': fingerprint, ...(process.env.VIBEWORKS_ADAPTER==='mcp'?{'X-Vibeworks-Adapter':'mcp'}:{}) },
      body, signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 5000), redirect: 'error',
    });
    const value = await readJson(response);
    createdDocumentId = knownCreatedDocumentId(command, value);
    if (!response.ok) {
      const envelope = z.object({ status: z.literal('error'), error: commandFailureSchema }).parse(value);
      const result = commandError(command.type, envelope.error.code, envelope.error.message);
      result.error = deduplicateIssues([envelope.error])[0]; // Preserve human ownership, diagnosis and uncertainty.
      if (response.status >= 500 && changesDocument(command)) {
        const diagnosis = await doctor(async () => connection, fingerprint);
        return finish(uncertainOutcome(command, envelope.error.code, envelope.error.message, requestId, diagnosis.bridgeReachable && (diagnosis.kernel?.phase === 'ready' || diagnosis.browserConnected === true) && !diagnosis.issues.length, { requestId, diagnosis }, createdDocumentId));
      }
      return finish(result);
    }
    if (response.headers.get('x-vibeworks-fingerprint') !== fingerprint) throw new Error('Bridge response fingerprint does not match the adapter.');
    const result = adapterResultSchema.parse(value);
    if (result.error) result.error = deduplicateIssues([result.error])[0];
    if (result.operation !== command.type) throw new Error('Bridge response operation does not match the request.');
    const cad=result as unknown as CadResult;
    if(command.type==='agent_session'&&cad.status==='success'&&cad.session){
      if(command.params.action==='leave'){
        adapterSessions.delete(cad.session.sessionId);
        if(adapterSession?.id===cad.session.sessionId)adapterSession=undefined;
        if(!adapterSessions.size&&heartbeat){clearInterval(heartbeat);heartbeat=undefined;}
      }
      else {
        adapterSession={id:cad.session.sessionId,connection:connectionIdentity};
        if(command.params.action!=='heartbeat')adapterSessions.set(cad.session.sessionId,{connection:connectionIdentity,readLocal,fingerprint});
        if(!heartbeat&&adapterSessions.size){heartbeat=setInterval(()=>{for(const [id,peer]of adapterSessions)void forwardCommand({type:'agent_session',params:{action:'heartbeat',sessionId:id}},peer.readLocal,peer.fingerprint,{sessionId:id,heartbeat:false}).then(r=>{if(r.error?.code==='AGENT_SESSION_EXPIRED')adapterSessions.delete(id);}).catch(()=>{});},10000);heartbeat.unref();}
      }
    }
    return finish(cad);
  } catch (error) {
    const diagnosis = await doctor(async () => connection, fingerprint);
    const reachable = diagnosis.bridgeReachable && (diagnosis.kernel?.phase === 'ready' || diagnosis.browserConnected === true) && !diagnosis.issues.length;
    const result = uncertainOutcome(command, 'BRIDGE_TRANSPORT_ERROR', 'Bridge did not return a trustworthy result.', requestId, reachable, { requestId, cause: error instanceof Error ? error.message : 'Unknown transport failure', diagnosis }, createdDocumentId);
    if (!dispatched) delete result.error!.outcomeUnknown;
    return finish(result);
  }
}

/** Rejected inputs are observable work, never a CAD mutation. This is called only after local validation fails. */
export async function recordRejectedAttempt(attempt:Omit<RejectedAttempt,'sessionId'|'requestId'>&{sessionId?:string},readLocal=readConnection,fingerprint=CONTRACT_FINGERPRINT){
 const connection=await readLocal();if(connection.fingerprint!==fingerprint)throw new Error('Contract changed; reconnect.');
 const sessionId=attempt.sessionId??adapterSession?.id??process.env.VIBEWORKS_AGENT_SESSION;if(!sessionId)return;
 const body=rejectedAttemptSchema.parse({...attempt,sessionId,requestId:randomUUID()});
 const response=await fetch(connection.httpUrl+'/rejected',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':fingerprint},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('Rejection tracking unavailable.');return await response.json() as {actor:NonNullable<CadResult['actor']>;requestId:string};
}
