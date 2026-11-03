import { logMcpCall } from './effort-log';
import {startMcpPresence} from './mcp-presence';
import { pathToFileURL } from 'node:url';
import { McpServer, type CallToolResult, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { AGENT_GUIDE, AGENT_TOOLS, APP, uncertainOutcome, withCreationRequestId, knownCreatedDocumentId, commandError, commandInfo, commandInputSchema, parseCommand, type CadCommand, type CadResult, type CommandName } from '../shared/protocol.ts';
import { forwardCommand,recordRejectedAttempt } from './client.ts';
import { deliver } from './deliver.ts';

// Advertise exactly the shared JSON schema, then parse in the callback so input
// failures retain our actionable structured code. The SDK's default input error
// contains only text. No command reaches the bridge without parseCommand.
function toolInput(name: CommandName): StandardSchemaWithJSON {
  const schema = commandInputSchema(name);
  return { '~standard': { version: 1, vendor: 'vibeworks', validate: (value) => ({ value }), jsonSchema: { input: () => schema, output: () => schema } } };
}

function textResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

export async function toMcpResult(command: CadCommand, result: CadResult): Promise<CallToolResult> {
  const delivery = await deliver(command, result);
  const measured = { ...delivery.result, meta: { replyBytes: 0 } };
  for (let i=0;i<4;i++) measured.meta.replyBytes=Buffer.byteLength(JSON.stringify(measured));
  const answer = textResult(measured, delivery.isError);
  if (delivery.png) answer.content.push({ type: 'image', mimeType: 'image/png', data: delivery.png });
  for(const data of delivery.pngs??[])answer.content.push({type:'image',mimeType:'image/png',data});
  if (delivery.resource) answer.content.push({ type: 'resource', resource: delivery.resource });
  return answer;
}

export function createMcpServer(forward: (command: CadCommand) => Promise<CadResult> = forwardCommand): McpServer {
  const server = new McpServer({ name: 'vibeworks-cad', title: APP.title, version: APP.version }, { instructions: AGENT_GUIDE });
  if(forward===forwardCommand){let stop:(()=>void)|undefined;server.server.oninitialized=()=>{stop?.();stop=startMcpPresence();};server.server.onclose=()=>stop?.();}
  for (const name of AGENT_TOOLS) {
    const readOnly = commandInfo[name].effect === 'read';
    server.registerTool(name, {
      description: commandInfo[name].description, inputSchema: toolInput(name),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly && name !== 'export_model' && name !== 'render_image', openWorldHint: false },
    }, async (params) => {
      const started = performance.now();
      const measured = (reply:CallToolResult) => { logMcpCall(name,params,reply,started); return reply; };
      let command: CadCommand;
      try { command = withCreationRequestId(parseCommand({ type: name, params })); }
      catch (error) {
        const issues = error instanceof z.ZodError ? error.issues : undefined;
        const fields=issues?.map(i=>i.path.join('.'))??[];
        const message=issues?.map(i=>(i.path.length?i.path.join('.')+': ':'')+i.message).join('; ').slice(0,1600)??'Arguments do not match the schema.';
        const failure=commandError(name,'INVALID_COMMAND',`${message} Use describe {tool:"${name}"} for syntax.`,issues);
        if(forward===forwardCommand){try{const value=params as any;const tracked=await recordRejectedAttempt({operation:name,sessionId:value?.sessionId,documentId:z.string().uuid().safeParse(value?.documentId).success?value.documentId:undefined,code:'INVALID_COMMAND',message:failure.error!.message,fields});if(tracked){failure.actor=tracked.actor;failure.requestId=tracked.requestId;}}catch{/* Original validation error remains useful when tracking is offline. */}}
        return measured(textResult(failure as unknown as Record<string,unknown>,true));
      }
      let result: CadResult | undefined;
      try { return measured(await toMcpResult(command, result = await forward(command))); }
      catch (error) {
        const failure = uncertainOutcome(command, 'ADAPTER_ERROR', 'Adapter could not deliver the result.', 'requestId' in command.params ? command.params.requestId : undefined, true, { cause: error instanceof Error ? error.message : 'Unknown adapter failure' }, knownCreatedDocumentId(command, result));
        return measured(textResult(failure as unknown as Record<string, unknown>, true));
      }
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.VIBEWORKS_ADAPTER='mcp';
  const handle = serveStdio(() => createMcpServer(), { onerror: (error) => console.error('[cad-mcp]', error.message) });
  const stop = () => { void handle.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
