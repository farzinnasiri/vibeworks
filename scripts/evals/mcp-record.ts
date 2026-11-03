/** Transparent stdio proxy used only by eval runs. Records MCP calls/results before parsing or delivery. */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [logFile] = process.argv.slice(2);
if (!logFile) throw new Error('Usage: mcp-record.ts CALLS.jsonl');
const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../../src/bridge/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Set<string | number>();
const record = (value: object) => appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
// Binary output is already saved by deliver(). Keep structured receipts and text without duplicating image/resource bytes.
const compact = (result: Record<string, unknown>) => result.structuredContent ? { structuredContent: result.structuredContent, isError: result.isError } : result;
const parseLine = (line: string) => { try { return JSON.parse(line); } catch { return undefined; } };
createInterface({ input: process.stdin }).on('line', line => {
  const request = parseLine(line);
  if (request?.method === 'tools/call') {
    pending.add(request.id);
    record({ type: 'tool_call', tool: request.params.name, callId: `${process.pid}:${request.id}`, input: request.params.arguments });
  }
  // Forward malformed protocol bytes too; recording failures must not be silently swallowed.
  child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', line => {
  const response = parseLine(line);
  if (response && pending.delete(response.id)) record({ type: 'tool_result', callId: `${process.pid}:${response.id}`, output: response.result ? compact(response.result) : { protocolError: response.error } });
  process.stdout.write(line + '\n');
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
