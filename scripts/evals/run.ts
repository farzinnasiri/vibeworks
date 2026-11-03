/** Opt-in live evaluation. Do not run during offline implementation/verification. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { taskSchema, workspaceCaptureSchema, type TaskSpec, type TranscriptRecord } from './score';
import { AGENT_TOOLS, featureSchema, type CadDocument } from '../../src/shared/protocol';

const argvSchema = z.array(z.string()).min(1);
export const runConfigSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  agentCommand: argvSchema,
  browserOpen: argvSchema.default(['agent-browser', '--session', '{session}', 'open', '{url}']),
  browserClose: argvSchema.default(['agent-browser', '--session', '{session}', 'close']),
  bridgePort: z.number().int().min(1024).max(65535).default(14318),
  webPort: z.number().int().min(1024).max(65535).default(15173),
  agentTimeoutSeconds: z.number().min(1).max(7200).default(1200),
  startupTimeoutSeconds: z.number().min(1).max(180).default(60),
}).strict().refine(c => c.bridgePort !== c.webPort, 'Ports must differ.')
  .refine(c => c.agentCommand.includes('{mcpArgs}'), 'agentCommand must include the standalone {mcpArgs} placeholder.');
export type RunConfig = z.infer<typeof runConfigSchema>;
export function expandCommand(command: string[], values: Record<string, string>, mcpArgs: string[] = []): string[] {
  return command.flatMap(arg => arg === '{mcpArgs}' ? mcpArgs : [arg.replace(/\{([A-Za-z]+)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown command placeholder ${match}`);
    return values[key];
  })]);
}
export function agentMcpArgs(provider: RunConfig['provider'], configFile: string, adapter: string, loader: string, callsFile: string): string[] {
  if (provider === 'claude') return ['--strict-mcp-config', '--mcp-config', configFile, '--allowedTools', ...AGENT_TOOLS.map(tool => `mcp__cad__${tool}`)];
  return ['-c', `mcp_servers.cad.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.cad.args=${JSON.stringify(['--import', loader, adapter, callsFile])}`, '-c', 'mcp_servers.cad.tool_timeout_sec=70',
    ...AGENT_TOOLS.flatMap(tool => ['-c', `mcp_servers.cad.tools.${tool}.approval_mode="approve"`])];
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function checkPort(port: number) {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

export function assertTaskSupported(task: TaskSpec): void {
  const supported = featureSchema.options.map(option => option.shape.kind.value as string);
  for (const kind of task.requiresFeatureKinds) if (!supported.includes(kind)) throw new Error(`Task '${task.id}' requires '${kind}', unavailable in this build.`);
}
async function run(taskFile: string, configFile: string) {
  const task = taskSchema.parse(await json(taskFile)), config = runConfigSchema.parse(await json(configFile));
  assertTaskSupported(task);
  await checkPort(config.bridgePort); await checkPort(config.webPort);
  const parent = join(root, 'artifacts/evals'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, `${task.id}-`)), stack = join(directory, 'stack'), agentCwd = join(directory, 'agent');
  await mkdir(stack); await mkdir(agentCwd);
  // A fresh source copy isolates connection tokens, artifacts, browser origin/storage and agent cwd.
  for (const path of ['src', 'scripts/evals', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) await cp(join(root, path), join(stack, path), { recursive: true });
  await symlink(join(root, 'node_modules'), join(stack, 'node_modules'), 'dir');
  const callsFile = join(directory, 'calls.jsonl'), mcpConfig = join(directory, 'mcp.json'), promptFile = join(directory, 'prompt.txt');
  const adapter = join(stack, 'scripts/evals/mcp-record.ts'), loader = join(stack, 'node_modules/tsx/dist/loader.mjs');
  const prompt = task.prompt + '\nThe task is authorized in this isolated eval workspace. Keep all modeling in the cad MCP tools. Open the final document when finished.';
  await writeFile(promptFile, prompt); await writeFile(callsFile, '', { mode: 0o600 });
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { cad: { type: 'stdio', command: process.execPath, args: ['--import', loader, adapter, callsFile] } } }, null, 2));
  const url = `http://127.0.0.1:${config.webPort}`, session = `vw-eval-${directory.split('-').at(-1)}`;
  const values = { url, session, prompt, promptFile, mcpConfig, directory, stack };
  const env = { ...process.env, VIBEWORKS_BRIDGE_PORT: String(config.bridgePort), VIBEWORKS_WEB_PORT: String(config.webPort), VIBEWORKS_WEB_ORIGIN: url };
  const children = new Set<ChildProcess>();
  const exited = new Map<ChildProcess, Promise<number>>();
  const start = (argv: string[], cwd: string, label: string) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.add(child);
    const out = createWriteStream(join(directory, `${label}.stdout.log`)), err = createWriteStream(join(directory, `${label}.stderr.log`));
    child.stdout!.pipe(out); child.stderr!.pipe(err);
    const streams = Promise.all([finished(out), finished(err)]);
    const done = new Promise<number>((accept, reject) => { child.once('error', error => { out.end(); err.end(); reject(error); }); child.once('close', code => accept(code ?? 1)); }).then(async code => { await streams; return code; });
    // Long-lived stack failures are checked during readiness; avoid an unhandled rejection.
    void done.catch(() => {}); exited.set(child, done); return child;
  };
  const stop = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const wait = async (child: ChildProcess, timeoutMs: number): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exited.get(child)!, new Promise<never>((_, reject) => { timer = setTimeout(() => { stop(child); reject(new Error(`Process ${child.pid} exceeded ${timeoutMs / 1000} seconds; inspect logs in ${directory}.`)); }, timeoutMs); })]); }
    catch (error) { stop(child, 'SIGKILL'); throw error; }
    finally { clearTimeout(timer); }
  };
  let browserStarted = false;
  const interrupted = () => { for (const child of children) stop(child); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const records: TranscriptRecord[] = [{ type: 'message', role: 'user', content: prompt }];
  let failure: string | undefined;
  try {
    const bridge = start([process.execPath, '--import', loader, join(stack, 'src/bridge/server.ts')], stack, 'bridge');
    const web = start([process.execPath, '--input-type=module', '-e', "const { createServer } = await import('vite'); const server = await createServer({ cacheDir: '.vite-eval', configLoader: 'runner' }); await server.listen();"], stack, 'web');
    const until = Date.now() + config.startupTimeoutSeconds * 1000;
    // Query the isolated CLI so readiness includes geometry, not merely HTTP authentication.
    while (Date.now() < until) {
      if (bridge.exitCode !== null || web.exitCode !== null) throw new Error('Isolated stack exited during startup; inspect bridge/web logs.');
      try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Not listening yet. */ }
      await delay(250);
    }
    if (Date.now() >= until) throw new Error('Web startup timed out.');
    browserStarted = true;
    if (await wait(start(expandCommand(config.browserOpen, values), stack, 'browser-open'), 30_000)) throw new Error('Browser open command failed.');
    let ready = false;
    while (Date.now() < until) {
      const probe = start([process.execPath, '--import', loader, join(stack, 'src/bridge/cli.ts'), 'inspect_model'], stack, 'readiness');
      if (await wait(probe, 10_000) === 0) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw new Error('Browser geometry did not become ready before startup deadline.');
    const agentArgs = expandCommand(config.agentCommand, values, agentMcpArgs(config.provider, mcpConfig, adapter, loader, callsFile));
    await writeFile(join(directory, 'invocation.json'), JSON.stringify({ provider: config.provider, argv: agentArgs, config, task }, null, 2));
    const agentCode = await wait(start(agentArgs, agentCwd, 'agent'), config.agentTimeoutSeconds * 1000);
    await writeFile(join(directory, 'agent-exit.json'), JSON.stringify({ exitCode: agentCode }));
    if (agentCode) failure = `Agent exited ${agentCode}; recovered documents may be unfinished.`;
    // Capture all documents, including parts. This does not run output preflight and cannot hide agent omissions.
    const cli = join(stack, 'src/bridge/cli.ts');
    if (await wait(start([process.execPath, '--import', loader, cli, 'documents', '{"action":"list"}'], stack, 'workspace'), 70_000)) throw new Error('Cannot list final workspace.');
    const workspace = await json(join(directory, 'workspace.stdout.log'));
    await mkdir(join(directory, 'documents'));
    const captured: CadDocument[] = [];
    let activeDocumentId: string | undefined;
    for (const summary of workspace.documents) {
      if (!/^[a-f0-9-]{36}$/i.test(summary.documentId)) throw new Error('Invalid document id in workspace listing.');
      const label = `inspect-${summary.documentId}`;
      if (await wait(start([process.execPath, '--import', loader, cli, 'inspect_model', JSON.stringify({ documentId: summary.documentId })], stack, label), 70_000)) throw new Error(`Cannot inspect ${summary.documentId}.`);
      const inspected = await json(join(directory, `${label}.stdout.log`));
      captured.push(inspected.document);
      await writeFile(join(directory, 'documents', `${summary.documentId}.json`), JSON.stringify(inspected.document, null, 2));
      if (summary.active) {
        activeDocumentId = summary.documentId;
        await writeFile(join(directory, 'final.json'), JSON.stringify(inspected.document, null, 2));
        await writeFile(join(directory, 'agent-final-health.json'), JSON.stringify({ health: inspected.health, nextSteps: inspected.nextSteps }, null, 2));
      }
    }
    await writeFile(join(directory, 'workspace.json'), JSON.stringify(workspaceCaptureSchema.parse({
      format: 'vibeworks-workspace-v1', activeDocumentId, documents: captured,
    }), null, 2));
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    const lines = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean);
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch { failure ??= 'Truncated transcript record.'; } }
    try { records.push({ type: 'message', role: 'assistant', content: await readFile(join(directory, 'agent.stdout.log'), 'utf8'), note: 'Raw configured agent CLI output, possibly JSONL; not parsed as additional tool calls.' }); } catch { /* Agent may not have started. */ }
    await writeFile(join(directory, 'transcript.json'), JSON.stringify({ format: 'conversation-and-tools-v1', records, note: 'MCP proxy records all CAD calls including schema errors. Binary outputs are saved under stack/artifacts; raw agent output is in agent.stdout.log.' }, null, 2));
    if (browserStarted) {
      try { if (await wait(start(expandCommand(config.browserClose, values), stack, 'browser-close'), 15_000)) failure ??= 'Browser close command failed.'; }
      catch (error) { failure ??= String(error); }
    }
    for (const child of children) stop(child);
    await delay(300);
    for (const child of children) stop(child, 'SIGKILL');
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  // Separate scorer process isolates the WASM lifetime from stack/agent execution.
  try {
    await readFile(join(directory, 'workspace.json'));
    const score = start([process.execPath, '--import', loader, join(stack, 'scripts/evals/score.ts'), join(directory, 'workspace.json'), '--transcript', join(directory, 'transcript.json'), '--task', resolve(taskFile)], stack, 'score');
    const code = await wait(score, 120_000);
    if (code) failure ??= `Scorer exited ${code}; inspect score.stdout.log / score.stderr.log.`;
  } catch (error) { failure ??= String(error); }
  await writeFile(join(directory, 'run.json'), JSON.stringify({ directory, status: failure ? 'incomplete' : 'scored', failure }, null, 2));
  console.log(JSON.stringify({ directory, status: failure ? 'incomplete' : 'scored', failure }, null, 2));
  if (failure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [task, config, ...extra] = process.argv.slice(2);
  if (!task || !config || extra.length) { console.error('Usage: tsx scripts/evals/run.ts TASK.json CONFIG.json (starts paid live agent/browser work)'); process.exitCode = 2; }
  else run(task, config).catch(error => { console.error(error); process.exitCode = 2; });
}
