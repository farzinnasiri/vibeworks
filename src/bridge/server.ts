import {resolveFaces} from '../cad/surface-reference';
import {ServiceMonitor} from './service-monitor';
import {serviceStatusSchema,mcpPresenceSchema,serviceRestartSchema} from '../shared/protocol';
import {describeTool,selectInspection} from './discovery';
import { commandEnvelopeSchema,rejectedAttemptSchema, workspaceViewPollSchema, type OperationContext } from '../shared/protocol';
import {displayBytes,displayValueCount,packDisplay} from '../shared/display';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "./sqlite-store";
import { CommandAuthority } from "./authority";
import { CadError } from "../cad/document";
import {
  storageRequestSchema,
  storageResponseSchema,
  PROTOCOL_VERSION,
  uncertainOutcome,
  replayedResult,
  knownCreatedDocumentId,
  commandError,
  humanRecovery,
  parseCommand,
  type CadCommand,
  type ConnectionDiagnosis,
  type LocalConnection,
} from "../shared/protocol";
import { bridgePort, plainWebOrigin, workerCount } from "./config";
import { CONTRACT_FINGERPRINT, workspaceFingerprint } from "./fingerprint";
import { versionIssues } from "./diagnosis";
import { CONNECTION_FILE } from "./connection";
import {
  MAX_COMMAND_BYTES,
  MAX_RESPONSE_BYTES,
  resultSchema,
  displayDeliverySchema,
} from "./validation";
import type { Outcome } from "../cad/runtime";

export interface BridgeOptions {
  port?: number;
  databasePath?: string;
  connectionFile?: string;
  workers?: number;
  queueLimit?: number;
  workerTimeoutMs?: number;
  webOrigins?: string[];
  fingerprint?: string;
  currentFingerprint?: () => string;
  log?: (line: string) => void;
}
export function configuredWebOrigins(
  value = process.env.VIBEWORKS_WEB_ORIGIN,
): string[] {
  const extra = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      const url = new URL(origin);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== origin.replace(/\/$/, "")
      )
        throw new Error(
          `VIBEWORKS_WEB_ORIGIN must list exact http(s) origins without paths: ${origin}`,
        );
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.hostname.endsWith(".localhost")
      )
        throw new Error(
          `Web origins must be loopback or .localhost names: ${origin}`,
        );
      return url.origin;
    });
  return [...new Set([plainWebOrigin(), ...extra])];
}
const requestSchema = commandEnvelopeSchema;
function sameToken(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** An upper bound of the packed response, without encoding display assets twice per command. */
function deliveryBytes(outcome: Outcome): number {
  if (!outcome.evaluation) return Buffer.byteLength(JSON.stringify(outcome));
  const { meshes, ...rest } = outcome.evaluation;
  return Buffer.byteLength(JSON.stringify({ ...outcome, evaluation: rest })) + displayBytes(displayValueCount(meshes), meshes.length);
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function readBody(
  req: IncomingMessage,
  limit = MAX_COMMAND_BYTES,
): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(415, "CONTENT_TYPE_REQUIRED", "Send application/json.");
  if (Number(req.headers["content-length"]) > limit)
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Request limit is ${limit} bytes.`,
    );
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit)
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request limit is ${limit} bytes.`,
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON.",
    );
  }
}

export async function startBridge(options: BridgeOptions = {}) {
  const store = new SqliteStore(
    options.databasePath ?? (options.port === 0 ? ":memory:" : undefined),
  );
  let authority = new CommandAuthority(store, {...options,collaboration:store.collaboration,preparedDisplay:store.preparedDisplay});
  const monitor=new ServiceMonitor();let restarting=false,activeCommands=0;
  const fingerprint = options.fingerprint ?? CONTRACT_FINGERPRINT;
  const currentFingerprint = options.currentFingerprint ?? workspaceFingerprint;
  const connectionFile =
    options.connectionFile ??
    process.env.VIBEWORKS_CONNECTION_FILE ??
    CONNECTION_FILE;
  const token = randomBytes(32).toString("hex");
  const bridgeId = randomUUID(); // One identity per authority lifetime, independent of contract/source changes.
  const origins = options.webOrigins ?? configuredWebOrigins();
  const webHosts = origins.map((origin) => new URL(origin).host);
  const viewers = new Map<string, number>();
  const cache = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<Outcome>;
      at?: number;
      bytes: number;
    }
  >();
  let bridgeHost = "",
    stopped = false;
  function diagnosis(adapter?: string): ConnectionDiagnosis {
    for (const [id, at] of viewers)
      if (Date.now() - at > 6000) viewers.delete(id);
    const fingerprints = {
      workspace: currentFingerprint(),
      bridge: fingerprint,
      ...(adapter ? { adapter } : {}),
    };
    const kernel = authority.diagnostics();
    return {
      bridgeReachable: true,
      browserConnected: viewers.size > 0,
      fingerprints,
      kernel,
      issues: [
        ...versionIssues(fingerprints),
        ...(kernel.phase === "ready"
          ? []
          : [
              {
                code:
                  kernel.phase === "initializing"
                    ? "RUNTIME_INITIALIZING"
                    : "WORKER_UNAVAILABLE",
                message:
                  kernel.error ?? "Node geometry workers are initializing.",
              },
            ]),
      ],
    };
  }
  function validateRequest(req: IncomingMessage, bootstrap = false) {
    const host = req.headers.host;
    if (host !== bridgeHost && !webHosts.includes(host ?? ""))
      throw new HttpError(
        403,
        "FORBIDDEN_HOST",
        "Use the configured loopback host.",
      );
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin))
      throw new HttpError(
        403,
        "FORBIDDEN_ORIGIN",
        "Origin is not an allowed workspace origin.",
      );
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(
        403,
        "FORBIDDEN_ORIGIN",
        "Cross-site requests are forbidden.",
      );
    if (
      bootstrap &&
      (!webHosts.includes(host ?? "") ||
        req.headers["sec-fetch-site"] !== "same-origin" ||
        !["cors", "same-origin"].includes(
          String(req.headers["sec-fetch-mode"]),
        ) ||
        req.headers["sec-fetch-dest"] !== "empty")
    )
      throw new HttpError(
        403,
        "BOOTSTRAP_FORBIDDEN",
        "Connection bootstrap is available only to the same-origin workspace application.",
      );
  }
  function authenticate(req: IncomingMessage) {
    if (
      !req.headers.authorization?.startsWith("Bearer ") ||
      !sameToken(req.headers.authorization.slice(7), token)
    )
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Bridge token is missing or invalid. No command was dispatched.",
      );
    if (
      req.headers["x-vibeworks-fingerprint"] !== fingerprint ||
      currentFingerprint() !== fingerprint
    )
      throw new HttpError(
        409,
        "VERSION_SKEW",
        "Client and bridge contracts differ. Restart the matched stack and reload clients.",
      );
  }
  function pruneCache() {
    let bytes = [...cache.values()].reduce((n, entry) => n + entry.bytes, 0);
    for (const [key, entry] of cache) {
      if (
        entry.at &&
        (Date.now() - entry.at > 300_000 ||
          cache.size > 256 ||
          bytes > 64 * 1024 * 1024)
      ) {
        bytes -= entry.bytes;
        cache.delete(key);
      }
    }
  }
  function dispatch(id: string, command: CadCommand, sessionId?:string, intent?:import('../shared/protocol').OperationIntent, passive=false, display=false): Promise<Outcome> {
    if(sessionId&&command.params.sessionId&&sessionId!==command.params.sessionId)return Promise.resolve({result:commandError(command.type,'SESSION_MISMATCH','The command and transport sessions differ.')});
    sessionId??=command.params.sessionId;
    const signature = JSON.stringify([sessionId,command,intent,passive,display]);
    const old = cache.get(id);
    if (old)
      return old.fingerprint === signature
        ? old.promise.then((outcome) => ({
            ...outcome,
            result: replayedResult(outcome.result),
          }))
        : Promise.resolve({
            result: commandError(
              command.type,
              "REQUEST_ID_CONFLICT",
              "This request ID was already used for a different command.",
            ),
          });
    pruneCache();
    if ([...cache.values()].filter((c) => !c.at).length >= 32)
      return Promise.resolve({
        result: commandError(
          command.type,
          "BRIDGE_BUSY",
          "The bridge has 32 pending commands.",
        ),
      });
    let context:OperationContext|undefined;
    const collaborate=command.type==='agent_session'||command.type==='activity'||command.type==='describe';
    try {if(!collaborate && passive){const participant=store.collaboration.require(sessionId);const identity=store.collaboration.query({agentId:participant.agentId}).participants[0]?.identity;if(identity?.kind!=='human'||!['inspect_model','select_features'].includes(command.type))throw new CadError('INVALID_PASSIVE_READ','Only personal browser observation may omit an activity record.');}
    if(!collaborate&&!passive)context=store.collaboration.begin(id,sessionId!,command,intent??('intent' in command.params?command.params.intent:undefined));}
    catch(error){return Promise.resolve({result:commandError(command.type,error instanceof CadError?error.code:'COLLABORATION_ERROR',error instanceof Error?error.message:String(error))});}
    const action=async():Promise<Outcome>=>{
      if(command.type==='documents'&&command.params.action==='asset'){
        const asset=store.graphicAsset(command.params.hash!)??(await store.bodies()).map(d=>d.graphicAssets?.[command.params.hash!]).find(Boolean);
        if(!asset)throw new CadError('ASSET_NOT_FOUND','Graphic resource was not found.');
        return {result:{operation:'documents',status:'success',created:[],updated:[],warnings:[],artifact:{filename:`${command.params.hash!.slice(7)}.${asset.mime==='image/png'?'png':'svg'}`,mimeType:asset.mime,byteLength:asset.bytes,base64:asset.base64}}};
      }
      if(command.type==='workspace_view'){
        const workspaceView=store.workspaceViews.command(command.params);
        const doc=(workspaceView.request ? await store.get(workspaceView.request.documentId) : undefined)??(await store.bodies())[0];
        return {result:{operation:'workspace_view',status:'success',documentId:doc?.documentId,revision:doc?.revision??0,
          created:[],updated:[],warnings:[],workspaceView}};
      }
      if(command.type==='agent_session'||command.type==='activity'||command.type==='describe'){
        const first=(await store.list())[0];
        return {result:{operation:command.type,status:'success',...(first?{documentId:first.documentId,revision:first.revision}:{}),created:[],updated:[],warnings:[],...(command.type==='agent_session'?store.collaboration.command(command.params,sessionId):command.type==='describe'?{help:describeTool(command.params)}:store.collaboration.query(command.params))}};
      }
      if(command.type==='select_features'&&command.params.selection){
        const inspected=await authority.execute({type:'inspect_model',params:{documentId:command.params.documentId,detail:'full'}},context,true);
        if(inspected.result.status==='error')return inspected;
        for(const selection of command.params.selection){
          const meshes=inspected.evaluation?.meshes.filter(m=>m.featureId===selection.feature&&JSON.stringify(m.occurrencePath?.slice(1)??[])===JSON.stringify(selection.path??[]))??[];
          if(!meshes.length)throw new CadError('REFERENCE_MISSING','Selected occurrence does not exist.',{reference:selection});
          if(selection.faces?.length)resolveFaces(meshes[0].topology!,{feature:selection.feature,select:{faces:selection.faces,fragments:'all'}});
        }
        const selected=await authority.execute({...command,params:{...command.params,featureIds:[...new Set([...command.params.featureIds,...command.params.selection.map(s=>s.feature)])]}},context,display);
        if(selected.result.status==='success')store.surfaceSelection(store.collaboration.require(sessionId!).agentId,selected.result.documentId!,command.params.selection);
        selected.result.inspection={selection:command.params.selection};return selected;
      }
      const query=command.type==='inspect_model'&&command.params.detail!=='full'&&!command.params.select&&!command.params.page&&!command.params.replay&&!command.params.display&&(await store.list()).length?{...command,params:{...command.params,select:{features:{}},include:command.params.include??['features','geometry','references'] as const}}:command;
      return authority.execute(query as CadCommand,context,display);
    };
    const promise = action()
      .then(async (outcome) => {
        if((command.type==='apply_edits'&&!command.params.dryRun||command.type==='document_action'&&command.params.action!=='save')&&outcome.result.status==='success'&&outcome.result.documentId){
          try {
          const checkDeadline=Date.now()+4000;
          const docs=await store.bodies(),affected=new Set([outcome.result.documentId]);let changed=true;
          while(changed){changed=false;for(const d of docs)if(!affected.has(d.documentId)&&d.features.some(f=>f.kind==='instance'&&affected.has(f.params.document))){affected.add(d.documentId);changed=true;}}
          for(const d of docs)if(d.documentId!==outcome.result.documentId&&affected.has(d.documentId)&&d.features.some(f=>f.graphicEdits||f.surfaceStyles?.length||f.paintRegions?.length)){
            if((outcome.result.dependentWarnings?.length??0)>=64){outcome.result.warnings.push('Additional dependent appearance checks are pending; inspect incoming references.');break;}
            if(Date.now()>checkDeadline){(outcome.result.dependentWarnings??=[]).push({documentId:d.documentId,code:'DEPENDENT_CHECK_PENDING',message:'Dependent appearance validation is pending; inspect this document before editing it.'});continue;}
            const checked=await authority.execute({type:'inspect_model',params:{documentId:d.documentId,detail:'full',snapshot:{}}},undefined,false);
            if(checked.result.status==='error'||checked.result.health?.referenceError){const error=checked.result.error;const warning={documentId:d.documentId,code:error?.code??'REFERENCE_UNRESOLVED',message:error?.message??checked.result.health!.referenceError!,...(error?.details?{details:error.details}:{})};(outcome.result.dependentWarnings??=[]).push(warning);outcome.result.warnings.push(`Dependent surface reference in '${d.name??d.documentId}' needs repair: ${warning.message}`);}
          }
          } catch(error){outcome.result.warnings.push(`Edit committed; dependent appearance validation could not finish: ${error instanceof Error?error.message:String(error)}`);}
        }
        if(command.type==='inspect_model'&&command.params.select?.diff&&outcome.result.documentId){
          const old=(await store.operation({action:'snapshot',documentId:outcome.result.documentId,snapshot:{id:command.params.select.diff.fromSnapshot}})).graph!.document;
          const now=outcome.result.document!,ids=new Set([...old.features.map(f=>f.id),...now.features.map(f=>f.id)]);
          const diff=[...ids].flatMap(id=>{const before=old.features.find(f=>f.id===id),after=now.features.find(f=>f.id===id);if(JSON.stringify(before)===JSON.stringify(after))return[];return[{id,change:!before?'added':!after?'deleted':'updated',fields:Object.keys({...before,...after}).filter(k=>JSON.stringify(before?.[k as keyof typeof before])!==JSON.stringify(after?.[k as keyof typeof after]))}];});outcome.result.inspection={...outcome.result.inspection,diff};
        }
        if(command.type==='inspect_model'&&outcome.result.documentId)outcome.result.inspection={...outcome.result.inspection,selection:store.surfaceSelection(store.collaboration.require(sessionId!).agentId,outcome.result.documentId)};
        if(command.type==='inspect_model'&&command.params.select?.references?.incoming){const incoming=(await store.bodies()).flatMap(d=>d.features.filter(f=>f.kind==='instance'&&f.params.document===outcome.result.documentId).map(f=>({documentId:d.documentId,feature:f.id})));outcome.result.inspection={...outcome.result.inspection,incoming};}
        if(command.type==='inspect_model')outcome={...outcome,result:selectInspection(outcome.result,command.params,outcome.evaluation)};
        const actorSession=outcome.result.session?.sessionId??sessionId;
        if(actorSession)outcome.result.actor=store.collaboration.actor(actorSession);
        const parsed = displayDeliverySchema.safeParse(outcome);
        if (
          !parsed.success ||
          deliveryBytes(outcome) > MAX_RESPONSE_BYTES
        ) {
          const failed = {
            result: uncertainOutcome(
              command,
              "INVALID_RESPONSE",
              "Node output did not pass the bounded response validator. Inspect before another mutation.",
              id,
              authority.phase === "ready",
              undefined,
              knownCreatedDocumentId(command, outcome.result),
            ),
          };
          if(context)store.collaboration.finish(context.operationId,failed.result);
          return failed;
        }
        if(context)store.collaboration.finish(context.operationId,parsed.data.result);
        return parsed.data;
      })
      .catch((error) => {
        const result = (collaborate||command.type==='inspect_model'&&error instanceof CadError) ? commandError(command.type,error instanceof CadError?error.code:"COLLABORATION_ERROR",error instanceof Error?error.message:String(error),error instanceof CadError?error.details:undefined) : uncertainOutcome(
          command,
          "RUNTIME_ERROR",
          String(error),
          id,
          authority.phase === "ready",
        );
        if(context)store.collaboration.finish(context.operationId,result);
        return {result};
      });
    const entry = {
      fingerprint: signature,
      promise,
      bytes: 0,
      at: undefined as number | undefined,
    };
    cache.set(id, entry);
    void promise.then((outcome) => {
      entry.at = Date.now();
      entry.bytes = deliveryBytes(outcome);
      pruneCache();
    });
    return promise;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Vibeworks-Fingerprint", fingerprint);
    try {
      validateRequest(req, req.url === "/connection");
      if(req.method==='GET'&&req.url==='/service'){
        authenticate(req);const kernel=authority.diagnostics();
        sendJson(res,200,serviceStatusSchema.parse({...monitor.read(),phase:restarting?'restarting':kernel.phase==='ready'?'online':kernel.phase==='initializing'?'starting':'unavailable',
          memoryBytes:process.memoryUsage().rss,storageBytes:store.storageBytes(),pending:kernel.pending,workers:kernel.workers.length,...(kernel.error?{error:kernel.error}:{})}));return;
      }
      if(req.method==='POST'&&req.url==='/service/mcp'){
        authenticate(req);const input=mcpPresenceSchema.parse(await readBody(req));monitor.presence(input.id,input.action);sendJson(res,200,{ok:true});return;
      }
      if(req.method==='POST'&&req.url==='/service/restart'){
        authenticate(req);serviceRestartSchema.parse(await readBody(req));
        if(restarting)throw new HttpError(409,'SERVICE_RESTARTING','The service is already restarting.');
        if(activeCommands||!authority.canRestart)throw new HttpError(409,'SERVICE_BUSY','Wait for active requests and renders to finish before restarting.');
        restarting=true;
        try{await authority.close();authority=new CommandAuthority(store,{...options,collaboration:store.collaboration,preparedDisplay:store.preparedDisplay});await authority.ready();
          if(authority.phase!=='ready')throw new HttpError(503,'SERVICE_UNAVAILABLE',authority.error??'Service could not start.');monitor.restart();sendJson(res,200,{ok:true});
        }finally{restarting=false;}return;
      }
      if (req.method === "GET" && req.url === "/health") {
        const state = diagnosis(
          typeof req.headers["x-vibeworks-fingerprint"] === "string"
            ? req.headers["x-vibeworks-fingerprint"]
            : undefined,
        );
        sendJson(res, 200, {
          protocolVersion: PROTOCOL_VERSION,
          fingerprint,
          browserConnected: state.browserConnected,
          diagnosis: state,
        });
        return;
      }
      if (req.method === "GET" && req.url === "/connection") {
        sendJson(res, 200, {
          wsUrl: `ws://${bridgeHost}/runtime`,
          bridgeId,
          token,
          fingerprint,
        });
        return;
      }
      if(req.method==='POST'&&req.url==='/rejected'){
        authenticate(req);const attempt=rejectedAttemptSchema.parse(await readBody(req));
        sendJson(res,200,{actor:store.collaboration.reject(attempt),requestId:attempt.requestId});return;
      }
      if(req.method==='POST'&&req.url==='/workspace-view'){
        authenticate(req);
        const input=workspaceViewPollSchema.parse(await readBody(req));
        const session=store.collaboration.require(input.sessionId);
        const identity=store.collaboration.query({agentId:session.agentId}).participants[0]?.identity;
        if(identity?.kind!=='human')throw new HttpError(403,'HUMAN_VIEWER_REQUIRED','Only an enrolled human viewer may receive or acknowledge workspace views.');
        const value=input.action==='poll'?store.workspaceViews.poll(input.viewerId,input.sessionId,input.current)
          :store.workspaceViews.acknowledge(input.viewerId,input.sessionId,input.requestId,input.status,input.error);
        sendJson(res,200,value);return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/studio-video/result?')) {
        authenticate(req);
        const jobId = z.uuid().safeParse(new URL(req.url, 'http://127.0.0.1').searchParams.get('jobId'));
        if (!jobId.success) throw new HttpError(400, 'INVALID_REQUEST', 'A valid video job ID is required.');
        let bytes: Buffer;
        try {
          bytes = await authority.videoOutput(jobId.data);
        } catch (error) {
          if (error instanceof CadError && error.code === 'RENDER_JOB_NOT_FOUND')
            throw new HttpError(404, error.code, error.message);
          if (error instanceof CadError && error.code === 'RENDER_NOT_READY')
            throw new HttpError(409, error.code, error.message);
          throw error;
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && req.url === "/probe") {
        authenticate(req);
        const { projectId } = z.object({ projectId: z.string().uuid().optional() }).strict().parse(await readBody(req));
        sendJson(res, 200, store.probe(projectId));
        return;
      }
      if (req.method === "POST" && req.url === "/storage") {
        authenticate(req);
        const envelope = storageRequestSchema.parse(await readBody(req));
        if (
          ["write", "remove", "project", "remove_project", "duplicate_project"].includes(
            envelope.operation.action,
          )
        )
          throw new HttpError(
            403,
            "COMMAND_AUTHORITY_REQUIRED",
            "Model and project writes must use the validated CAD commands.",
          );
        try {
          sendJson(
            res,
            200,
            storageResponseSchema.parse({
              requestId: envelope.requestId,
              fingerprint,
              ok: true,
              ...(await store.operation(envelope.operation)),
            }),
          );
        } catch (error) {
          sendJson(
            res,
            200,
            storageResponseSchema.parse({
              requestId: envelope.requestId,
              fingerprint,
              ok: false,
              error: {
                code:
                  error instanceof CadError ? error.code : "PERSISTENCE_FAILED",
                message: String(error),
              },
            }),
          );
        }
        return;
      }
      if (
        req.method === "POST" &&
        ["/command", "/view-command"].includes(req.url ?? "")
      ) {
        authenticate(req);
        const body = requestSchema.safeParse(await readBody(req));
        if (!body.success)
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "Expected {requestId: UUID, command: {type,params}}.",
          );
        let command: CadCommand;
        try {
          command = parseCommand(body.data.command);
          if(command.type==='workspace_view'&&command.params.action==='present'){
            if(command.params.requestId&&command.params.requestId!==body.data.requestId)throw new Error('View requestId must match its envelope.');
            command={...command,params:{...command.params,requestId:body.data.requestId}};
          }
          if (
            command.type === "documents" &&
            ["create", "duplicate", "duplicate_project", "create_project"].includes(command.params.action)
          ) {
            if (
              command.params.requestId &&
              command.params.requestId !== body.data.requestId
            )
              throw new Error("Creation requestId must match its envelope.");
            command = {
              ...command,
              params: { ...command.params, requestId: body.data.requestId,
                ...(command.params.action==='create_project'?{projectId:command.params.projectId??body.data.requestId}:{}) },
            };
          }
        } catch (error) {
          throw new HttpError(
            400,
            "INVALID_COMMAND",
            `Command does not match the shared schema. ${String(error)}`,
          );
        }
        if (req.url === "/view-command") {
          const client = req.headers["x-vibeworks-client"];
          if (
            typeof client === "string" &&
            z.string().uuid().safeParse(client).success
          ) {
            viewers.delete(client);
            viewers.set(client, Date.now());
            if (viewers.size > 32) viewers.delete(viewers.keys().next().value!);
          }
        }
        if(restarting)throw new HttpError(409,'SERVICE_RESTARTING','The service is restarting. No command was accepted.');
        const counted=!body.data.passive&&!['activity','agent_session','workspace_view','describe'].includes(command.type);
        const finished=counted?monitor.begin(req.headers['x-vibeworks-adapter']==='mcp'):undefined;let failed=false;
        res.once('finish',()=>finished?.(failed||res.statusCode>=400));res.once('close',()=>finished?.(failed||!res.writableFinished));
        let outcome:Outcome;activeCommands++;
        try{outcome=await dispatch(body.data.requestId, command, body.data.sessionId, body.data.intent,body.data.passive,req.url === "/view-command");failed=outcome.result.status==='error';}
        catch(error){failed=true;throw error;}finally{activeCommands--;}

        outcome.result.requestId = body.data.requestId;
        sendJson(
          res,
          200,
          req.url === "/view-command"
            ? packDisplay(outcome)
            : resultSchema.parse(outcome.result),
        );
        return;
      }
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Use /health, /connection, /command, /view-command, /probe or read-only /storage.",
      );
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "BRIDGE_ERROR";
      if (!res.destroyed && !res.headersSent)
        sendJson(res, error instanceof HttpError ? error.status : 500, {
          status: "error",
          error: {
            code,
            message:
              error instanceof HttpError
                ? error.message
                : "Bridge request failed. See stderr.",
            requiresHuman: humanRecovery(code),
          },
        });
      if (!(error instanceof HttpError))
        (options.log ?? console.error)(
          `[bridge] ${String(error).replaceAll(token, "[redacted]")}`,
        );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? bridgePort(), "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Bridge did not bind TCP.");
    bridgeHost = `127.0.0.1:${address.port}`;
    const connection: LocalConnection = {
      httpUrl: `http://${bridgeHost}`,
      wsUrl: `ws://${bridgeHost}/runtime`,
      token,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      fingerprint,
    };
    const temporary = `${connectionFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(connection, null, 2));
      } finally {
        await file.close();
      }
      await rename(temporary, connectionFile);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return {
      connection,
      ready: () => authority.ready(),
      diagnostics: () => authority.diagnostics(),
      async close() {
        if (stopped) return;
        stopped = true;
        await authority.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        store.collaboration.disconnect();
        store.close();
        try {
          const current = JSON.parse(await readFile(connectionFile, "utf8"));
          if (current.token === token) await unlink(connectionFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            console.error("[bridge] could not remove connection file");
        }
      },
    };
  } catch (error) {
    await authority.close();
    server.close();
    store.close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startBridge({ workers: workerCount() })
    .then(async (bridge) => {
      console.error(
        `[bridge] listening at ${bridge.connection.httpUrl}; Node geometry initializing`,
      );
      const stop = () => {
        void bridge.close().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await bridge.ready();
      console.error(
        `[bridge] ${bridge.diagnostics().phase}; headless authority, ${bridge.diagnostics().workers.length} workers`,
      );
    })
    .catch((error) => {
      console.error("[bridge] startup failed:", error.message);
      process.exitCode = 1;
    });
}
