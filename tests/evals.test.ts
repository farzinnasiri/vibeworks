import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreDocument, transcriptMetrics, taskSchema, checkExpectations } from '../scripts/evals/score';
import { expandCommand, agentMcpArgs, runConfigSchema, assertTaskSupported } from '../scripts/evals/run';
import { emptyDocument } from '../src/cad/document';
import type { CadDocument, Feature } from '../src/shared/protocol';

const success = { operation: 'apply_edits', status: 'success' };
const error = { operation: 'apply_edits', status: 'error', error: { code: 'GEOMETRY_FAILED' } };
test('transcript scorer reads wrapped and direct CAD results once and never treats missing evidence as success', () => {
  const transcript = { format: 'conversation-and-tools-v1', records: [
    { type: 'tool_call', callId: 'a', tool: 'apply_edits' },
    { type: 'tool_result', callId: 'a', output: { structuredContent: success, content: [{ type: 'text', text: JSON.stringify(success) }] } },
    { type: 'tool_call', callId: 'b', tool: 'exec' },
    { type: 'tool_result', callId: 'b', output: [{ type: 'input_text', text: JSON.stringify({ structuredContent: error, content: [{ type: 'text', text: JSON.stringify(error) }] }) }] },
    { type: 'tool_call', callId: 'c', tool: 'mcp__cad__inspect_model' },
    { type: 'tool_result', callId: 'd', output: 'Warning: truncated output {"operation":"apply_edits"' },
  ] };
  const metrics = transcriptMetrics(transcript);
  assert.equal(metrics.toolCalls, 3); assert.equal(metrics.observedCadResults, 2);
  assert.equal(metrics.errorRate, 0.5); assert.equal(metrics.errorsByCode.GEOMETRY_FAILED.count, 1);
  assert.equal(metrics.unansweredCadCalls, 1); assert.match(metrics.coverage, /unknown/);
  assert.equal(transcriptMetrics({ ...transcript, records: [] }).errorRate, null);
  assert.throws(() => transcriptMetrics({ format: 'other', records: [] }));
});

test('offline scorer computes real health and distinguishes original settings from fresh evidence', async () => {
  const document = { ...emptyDocument(), revision: 4, analysis: { auto: false }, parameters: [{ name: 'length', value: 10 }], features: [
    { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] }, bindings: { 'size.0': 'length' }, appearance: { material: 'steel' } },
    { id: 'loose', kind: 'rod', params: { from: [30, 0, 0], to: [40, 0, 0], radius: 1 } },
  ], selectedFeatureIds: [] };
  const score = await scoreDocument(document);
  assert.equal(score.counts.results, 2); assert.equal(score.health.analysis, 'current');
  assert.equal(score.health.autoAnalysis, false); assert.equal(score.savedAnalysis.evidencePersisted, false);
  assert.equal(score.health.floating, 1); assert.equal(score.health.interferences, 0);
  assert.equal(score.health.partsWithoutAppearance, 1); assert.equal(score.health.ok, false);
  assert.equal(score.parameters.used, 1); assert.equal(score.parameters.bindings, 1);
  assert.ok(Math.abs(score.geometry.summedVolumeMm3 - (1000 + 10 * Math.PI)) < 1e-5);
  const partial = await scoreDocument(document, undefined, 0);
  assert.equal(partial.health.analysis, 'incomplete'); assert.equal(partial.health.ok, false);
  for (const task of ['mounting-bracket', 'planetary-gearbox', 'f1-assembly']) {
    const spec = taskSchema.parse(JSON.parse(await readFile(new URL(`../scripts/evals/tasks/${task}.json`, import.meta.url), 'utf8')));
    assert.ok(checkExpectations(score, spec).some(e => !e.passed));
  }
  const spec = taskSchema.parse({ id: 'dimension', prompt: 'x', humanReview: [], expectations: [{ path: 'geometry.bounds.size.0', min: 39.999, max: 40.001 }, { path: 'missing', min: 0 }] });
  assert.deepEqual(checkExpectations(score, spec).map(e => e.passed), [true, false]);
});

test('live runner command preparation is shell-free, bounded and process-local; no live processes start here', () => {
  const config = runConfigSchema.parse({ provider: 'codex', agentCommand: ['codex', 'exec', '{mcpArgs}', '{prompt}'] });
  assert.equal(config.bridgePort, 14318); assert.equal(config.webPort, 15173);
  assert.throws(() => runConfigSchema.parse({ ...config, webPort: config.bridgePort }));
  assert.throws(() => runConfigSchema.parse({ ...config, agentCommand: ['codex'] }));
  const prompt = 'Keep $(literal) and `literal` and "quotes"\nnewlines';
  const args = agentMcpArgs('codex', '/config', '/adapter path', '/loader', '/calls');
  const expanded = expandCommand(config.agentCommand, { prompt }, args);
  assert.equal(expanded.at(-1), prompt); assert.ok(expanded.includes('mcp_servers.cad.tool_timeout_sec=70'));
  assert.match(expanded.join(' '), /approval_mode="approve"/);
  assert.throws(() => expandCommand(['{unknown}'], {}));
  assert.ok(agentMcpArgs('claude', '/config', '/adapter', '/loader', '/calls').includes('--strict-mcp-config'));
});

test('offline workspace scoring resolves nested instances, bindings, inherited appearance and exact assembly health', async () => {
  const part: CadDocument = { ...emptyDocument(), kind: 'part', revision: 3, parameters: [{ name: 'width', value: 10 }], features: [{ id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [7, 10, 10] }, bindings: { 'size.0': 'width' }, appearance: { material: 'steel' } }] };
  const instance = (id: string, document: CadDocument, x: number): Feature => ({ id, kind: 'instance', params: { document: document.documentId, featureId: document.features[0].id, translation: [x, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] } });
  const nested: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance('child', part, 0)] };
  const assembly: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance('left', nested, 0), instance('right', part, 10)], analysis: { ground: 'left', checks: [{ id: 'mounted', a: 'left', b: 'right', expect: 'contact' }] } };
  const workspace = { format: 'vibeworks-workspace-v1', activeDocumentId: assembly.documentId, documents: [assembly, part, nested] };
  const score = await scoreDocument(workspace);
  assert.equal(score.health.ok, true); assert.equal(score.health.analysis, 'current');
  assert.equal(score.counts.byKind.instance, 2); assert.equal(score.counts.results, 2);
  assert.equal(score.health.partsWithoutAppearance, 0); assert.equal(score.analysis.contacts.length, 1);
  assert.equal(score.analysis.checks[0].ok, true); assert.ok(Math.abs(score.geometry.summedVolumeMm3 - 2000) < 1e-5);
  assert.ok(Math.abs(score.geometry.bounds!.size[0] - 20) < 1e-5);
  assert.equal(score.workspace.capturedDocuments, 3); assert.equal(score.workspace.resolvedDocuments.length, 3);
  assert.equal(score.instances[1].revision, 3); assert.equal(score.health.references!.length, 2);
  assert.equal((part.features[0] as Extract<Feature, {kind: 'box'}>).params.size[0], 7, 'scorer does not mutate captured input');
  const partScore = await scoreDocument(workspace, undefined, undefined, part.documentId);
  assert.equal(partScore.health.ok, true); assert.equal(partScore.parameters.used, 1);
  (assembly.features[1] as Extract<Feature, {kind: 'instance'}>).params.translation = [9, 0, 0];
  const interference = await scoreDocument(workspace);
  assert.equal(interference.health.ok, false); assert.equal(interference.health.interferences, 1); assert.equal(interference.health.failedChecks, 1);
  await assert.rejects(scoreDocument({ ...workspace, documents: [assembly, nested] }), /missing document/);
  await assert.rejects(scoreDocument({ ...workspace, documents: [...workspace.documents, part] }), /duplicate document IDs/);
  const task = taskSchema.parse(JSON.parse(await readFile(new URL('../scripts/evals/tasks/f1-assembly.json', import.meta.url), 'utf8')));
  assert.doesNotThrow(() => assertTaskSupported(task));
  assert.throws(() => assertTaskSupported({ ...task, requiresFeatureKinds: ['nonexistent'] }), /unavailable/);
});

test('eval MCP recorder preserves discovery and records schema errors without a browser or bridge', async t => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AGENT_GUIDE, AGENT_TOOLS } = await import('../src/shared/protocol');
  const directory = await mkdtemp(join(tmpdir(), 'vibeworks-eval-proxy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = `${directory}/calls.jsonl`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../scripts/evals/mcp-record.ts', import.meta.url)), log] });
  const client = new Client({ name: 'eval-proxy-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getInstructions(), AGENT_GUIDE);
  assert.equal((await client.listTools()).tools.length, AGENT_TOOLS.length);
  const result = await client.callTool({ name: 'apply_edits', arguments: { invalid: true } });
  assert.equal(result.isError, true);
  const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(r => r.type), ['tool_call', 'tool_result']);
  assert.equal(records[0].callId, records[1].callId);
  assert.equal(transcriptMetrics({ format: 'conversation-and-tools-v1', records }).errorsByCode.INVALID_COMMAND.count, 1);
});
