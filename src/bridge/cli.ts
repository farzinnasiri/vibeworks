import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AGENT_GUIDE, AGENT_TOOLS, APP, uncertainOutcome, withCreationRequestId, knownCreatedDocumentId, commandInfo, commandSchemas, commandInputSchema, commandRequirements, FEATURE_KINDS, isAgentTool, parseCommand, toolCatalog, type CadCommand, type CadResult, type CommandName } from '../shared/protocol.ts';
import { forwardCommand, useAgentSession, recordRejectedAttempt } from './client.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { deliver } from './deliver.ts';

/** What differs from MCP: how arguments, context and binary outputs travel through a shell. */
const CLI_FLOW = `${APP.title} CLI: the same tools, schemas and results as the MCP server, for shells and scripts.

  npm run -s cad -- doctor [--json]        Diagnose bridge, browser and contract versions
  npm run -s cad -- help                    This guide, then every tool
  npm run -s cad -- help <tool> [kind/action] Concise tool help; optional feature kind or documents action
  npm run -s cad -- tools [--json]          One line per tool, or the full catalog as JSON (what MCP lists)
  npm run -s cad -- schema <tool> [--kind <kind>]  Compact JSON input schema with shared definitions
  npm run -s cad -- <tool> [args] [--latest]
      args       Inline JSON, @file.json, or - for stdin. Defaults to {}.
      --session  Session UUID from agent_session join/resume. Also VIBEWORKS_AGENT_SESSION.
      --latest   Fill a missing documentId/expectedRevision from inspect_model just before sending.
                 An edit landing in between still fails with REVISION_CONFLICT.

Results print as JSON on stdout: a compact receipt, or full detail for inspect_model and errors.
render_views writes its PNG and export_model its file beneath artifacts/ and print the path;
open the PNG with your image viewer or tool to look at it. Exit status: 0 success,
1 command error, 2 usage error. Start the Node authority with npm run headless.`;

const isCommandName = isAgentTool;
const needsContext = (name: CommandName) => ['apply_edits', 'select_features', 'document_action'].includes(name);
const schemaOf = (name: CommandName, kind?: string) => ({ description: commandInfo[name].description, ...commandInputSchema(name, kind as typeof FEATURE_KINDS[number]) });
function summary(name: CommandName): string {
  const firstSentence = commandInfo[name].description.replace(/\s+/g, ' ').trim().split('. ')[0];
  return `${name.padEnd(17)} ${commandInfo[name].effect.padEnd(5)} ${firstSentence}.`;
}

async function readParams(input: string | undefined): Promise<unknown> {
  if (input === undefined) return {};
  const text = input === '-' ? await new Promise<string>((resolve, reject) => {
    let data = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; }).on('end', () => resolve(data)).on('error', reject);
  }) : input.startsWith('@') ? await readFile(input.slice(1), 'utf8') : input;
  return JSON.parse(text);
}

export async function runCli(argv: string[], forward: (command: CadCommand) => Promise<CadResult> = forwardCommand, print = (text: string) => console.log(text), diagnose = doctor): Promise<number> {
  const sessionIndex=argv.indexOf('--session');
  if(sessionIndex>=0){const id=argv[sessionIndex+1];if(!id||!z.string().uuid().safeParse(id).success){print('--session requires the registered session UUID.');return 2;}useAgentSession(id);argv=argv.filter((_,i)=>i!==sessionIndex&&i!==sessionIndex+1);}
  const latest = argv.includes('--latest'), json = argv.includes('--json');
  const kindIndex = argv.indexOf('--kind');
  const kind = kindIndex < 0 ? undefined : argv[kindIndex + 1];
  if (kindIndex >= 0 && !kind) { print('Supply a feature kind after --kind.'); return 2; }
  const [name, input, ...extra] = argv.filter((arg, i) => arg !== '--latest' && arg !== '--json' && (kindIndex < 0 || i !== kindIndex && i !== kindIndex + 1));
  const tools = [...AGENT_TOOLS];
  if (kindIndex >= 0 && name !== 'schema' && name !== 'help') { print('--kind is only accepted by help/schema.'); return 2; }
  if (name === 'help' || name === '--help') {
    if (input !== undefined) {
      if (!isCommandName(input)) { console.error(`Unknown tool '${input}'. Run: npm run -s cad -- tools`); return 2; }
      const detail = extra[0] ?? kind;
      if (extra.length > 1 || detail && input !== 'apply_edits' && input !== 'documents') { print('Only apply_edits feature kinds and documents actions have detail help.'); return 2; }
      if (input === 'apply_edits' && detail && !FEATURE_KINDS.includes(detail as typeof FEATURE_KINDS[number])) { print(`Unknown feature kind '${detail}'. Kinds: ${FEATURE_KINDS.join(', ')}`); return 2; }
      if (input === 'documents' && detail && !commandSchemas.documents.shape.action.options.includes(detail as never)) { print(`Unknown documents action '${detail}'.`); return 2; }
      const heading = input === 'documents' ? detail ? `documents ${detail} (${detail === 'list' ? 'read' : 'edit'})` : 'documents (effect and requirements vary by action)' : `${input} (${commandInfo[input].effect})`;
      const overview = `${heading}\n${commandRequirements(input, input === 'documents' ? detail : undefined)}\n\n${commandInfo[input].description}`;
      print(input === 'apply_edits' && !detail
        ? `${overview}\n\nFeature kinds: ${FEATURE_KINDS.join(', ')}.\nDetail: cad help apply_edits <kind>. Compact schema: cad schema apply_edits [--kind <kind>].`
        : `${overview}\n\nInput schema${detail ? ` (${detail})` : ''}:\n${JSON.stringify(commandInputSchema(input, input === 'apply_edits' ? detail as typeof FEATURE_KINDS[number] : undefined))}`);
      return 0;
    }
    print(`${CLI_FLOW}\n\n${AGENT_GUIDE}\n\nTools\n${tools.map(summary).join('\n')}`);
    return 0;
  }
  if (!name || extra.length) { print(CLI_FLOW); return 2; }
  if (name === 'doctor') {
    if (input || latest) { print('Usage: cad doctor [--json]'); return 2; }
    const result = await diagnose(); print(json ? JSON.stringify(result, null, 2) : formatDoctor(result)); return result.issues.length ? 1 : 0;
  }
  if (name === 'tools') { print(json ? JSON.stringify({ app: APP, instructions: AGENT_GUIDE, tools: toolCatalog() }) : tools.map(summary).join('\n')); return 0; }
  if (name === 'schema') {
    if (!isCommandName(input)) { console.error(`Unknown tool '${input ?? ''}'. Run: npm run -s cad -- tools`); return 2; }
    try { print(JSON.stringify(schemaOf(input, kind))); return 0; }
    catch (error) { print(error instanceof Error ? error.message : String(error)); return 2; }
  }
  if (!isCommandName(name)) { console.error(`Unknown tool '${name}'. Run: npm run -s cad -- tools`); return 2; }

  let params: unknown;
  try { params = await readParams(input); }
  catch (error) { console.error(`Arguments must be JSON: ${error instanceof Error ? error.message : String(error)}`); return 2; }
  if (latest && name !== 'documents') {
    const target = (params as { documentId?: unknown } | null)?.documentId;
    const inspected = await forward({ type: 'inspect_model', params: typeof target === 'string' ? { documentId: target } : {} });
    if (inspected.status === 'error') { print(JSON.stringify(inspected, null, 2)); return 1; }
    params = { documentId: inspected.documentId, ...(needsContext(name) ? { expectedRevision: inspected.revision, ...(inspected.storageVersion ? { expectedStorageVersion: inspected.storageVersion } : {}) } : {}), ...(params as object) };
  }
  let command: CadCommand;
  try { command = withCreationRequestId(parseCommand({ type: name, params })); }
  catch (error) {
    const issues = error instanceof z.ZodError ? error.issues : undefined;
    const message=issues?.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ').slice(0,1600)??'Arguments do not match the schema.';
    const failure:Record<string,unknown>={operation:name,status:'error',error:{code:'INVALID_COMMAND',message:`${message}${needsContext(name)&&issues?.some(i=>i.path[0]==='documentId'||i.path[0]==='expectedRevision')?' Pass documentId/expectedRevision or use --latest.':''} See: npm run -s cad -- help ${name}`,details:issues}};
    if(forward===forwardCommand)try{const p=params as any;const tracked=await recordRejectedAttempt({operation:name,sessionId:p?.sessionId,documentId:z.string().uuid().safeParse(p?.documentId).success?p.documentId:undefined,code:'INVALID_COMMAND',message,fields:issues?.map(i=>i.path.join('.'))??[]});if(tracked)Object.assign(failure,tracked);}catch{/* Preserve the input error if tracking is offline. */}
    print(JSON.stringify(failure,null,2));
    return 2;
  }
  let result: CadResult | undefined;
  try {
    const delivery = await deliver(command, result = await forward(command));
    print(JSON.stringify(delivery.result, null, 2));
    return delivery.isError ? 1 : 0;
  } catch (error) {
    const failure = uncertainOutcome(command, 'ADAPTER_ERROR', 'CLI could not deliver the result.', 'requestId' in command.params ? command.params.requestId : undefined, true, { cause: error instanceof Error ? error.message : 'Unknown adapter failure' }, knownCreatedDocumentId(command, result));
    print(JSON.stringify(failure, null, 2)); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error('[cad]', error instanceof Error ? error.message : error); process.exitCode = 1; });
}
