import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { startBridge, type BridgeOptions } from '../src/bridge/server.ts';
import { CONTRACT_FINGERPRINT, workspaceFingerprint } from '../src/bridge/fingerprint.ts';
import { forwardCommand, adapterResultSchema } from '../src/bridge/client.ts';
import { doctor, formatDoctor } from '../src/bridge/doctor.ts';
import { deduplicateIssues, diagnosisError } from '../src/bridge/diagnosis.ts';
import { runCli } from '../src/bridge/cli.ts';
import { resultSchema } from '../src/bridge/validation.ts';
import { commandError, WEB_ORIGIN, type CadCommand, type CadResult } from '../src/shared/protocol.ts';
import { bridgePort, webPort } from '../src/bridge/config.ts';

const inspect: CadCommand = { type: 'inspect_model', params: {} };
const documentId = randomUUID();
const success: CadResult = { operation: 'inspect_model', status: 'success', documentId, revision: 0, created: [], updated: [], warnings: [] };
const old = 'a'.repeat(64);

test('diagnosis deduplicates code/message pairs and merges unique human steps without losing distinct causes', () => {
  const issue = { code: 'VERSION_SKEW', message: 'Restart bridge.', requiresHuman: { reason: 'Stale', steps: ['Restart', 'Restart'] } };
  const issues = [issue, { ...issue, requiresHuman: { reason: 'Stale', steps: ['Restart', 'Inspect'] } }, { ...issue, message: 'Reload browser.' }];
  const unique = deduplicateIssues(issues);
  assert.equal(unique.length, 2);
  assert.deepEqual(unique[0].requiresHuman!.steps, ['Restart', 'Inspect']);
  const diagnosis = { bridgeReachable: true, browserConnected: false, fingerprints: {}, issues };
  const error = diagnosisError(diagnosis)!;
  assert.equal(error.message, 'Restart bridge. Reload browser.');
  assert.deepEqual(error.requiresHuman!.steps, ['Restart', 'Inspect']);
  assert.equal(formatDoctor(diagnosis).match(/VERSION_SKEW: Restart bridge/g)?.length, 1);
  assert.equal(issues.length, 3);
});

test('thin adapter accepts new result content, retains envelope checks and structured human errors', () => {
  const extended = { ...success, geometry: [{ futureShape: true }], futureResult: true };
  assert.equal(resultSchema.safeParse(extended).success, false);
  assert.equal(adapterResultSchema.parse(extended).futureResult, true);
  assert.equal(adapterResultSchema.safeParse({ ...success, status: 'error' }).success, false);
  assert.equal(adapterResultSchema.safeParse({ ...success, revision: -1 }).success, false);
  const error = commandError('inspect_model', 'BROWSER_DISCONNECTED', 'Wait for human recovery, then inspect.');
  assert.deepEqual(resultSchema.parse(error), error);
  assert.deepEqual(adapterResultSchema.parse(error), error);
  assert.equal(commandError('inspect_model', 'INVALID_COMMAND', 'Correct the input.').error?.requiresHuman, undefined);
});

test('port environment rejects invalid ports and keeps defaults', () => {
  const before = { bridge: process.env.VIBEWORKS_BRIDGE_PORT, web: process.env.VIBEWORKS_WEB_PORT };
  try {
    delete process.env.VIBEWORKS_BRIDGE_PORT; delete process.env.VIBEWORKS_WEB_PORT;
    assert.equal(bridgePort(), 4318); assert.equal(webPort(), 5173);
    process.env.VIBEWORKS_BRIDGE_PORT = '14318'; process.env.VIBEWORKS_WEB_PORT = '15173';
    assert.equal(bridgePort(), 14318); assert.equal(webPort(), 15173);
    for (const value of ['0', '65536', '-1', '1.5', 'bad']) { process.env.VIBEWORKS_BRIDGE_PORT = value; assert.throws(bridgePort); }
  } finally {
    if (before.bridge === undefined) delete process.env.VIBEWORKS_BRIDGE_PORT; else process.env.VIBEWORKS_BRIDGE_PORT = before.bridge;
    if (before.web === undefined) delete process.env.VIBEWORKS_WEB_PORT; else process.env.VIBEWORKS_WEB_PORT = before.web;
  }
});

test('Vite embeds the same fingerprint and routes both proxies and preview to configured ports', async () => {
  const { default: configure } = await import('../vite.config.ts');
  const previousBridge = process.env.VIBEWORKS_BRIDGE_PORT, previousWeb = process.env.VIBEWORKS_WEB_PORT;
  try {
    process.env.VIBEWORKS_BRIDGE_PORT = '14318'; process.env.VIBEWORKS_WEB_PORT = '15173';
    assert.equal(typeof configure, 'function');
    if (typeof configure !== 'function') throw new Error('Expected a Vite config factory.');
    const config = await configure({ command: 'serve', mode: 'development' });
    assert.equal(config.define?.__VIBEWORKS_FINGERPRINT__, JSON.stringify(CONTRACT_FINGERPRINT));
    assert.equal(config.server?.port, 15173); assert.equal(config.preview?.port, 15173);
    const http = config.server?.proxy?.['/api'], ws = config.server?.proxy?.['/api/runtime'];
    assert.ok(http && typeof http !== 'string'); assert.ok(ws && typeof ws !== 'string');
    assert.equal(http.target, 'http://127.0.0.1:14318'); assert.equal(ws.target, 'ws://127.0.0.1:14318');
  } finally {
    if (previousBridge === undefined) delete process.env.VIBEWORKS_BRIDGE_PORT; else process.env.VIBEWORKS_BRIDGE_PORT = previousBridge;
    if (previousWeb === undefined) delete process.env.VIBEWORKS_WEB_PORT; else process.env.VIBEWORKS_WEB_PORT = previousWeb;
  }
});

test('unexpected CLI adapter failures preserve cause and order safe reads before conditional human recovery', async () => {
  const output: string[] = [];
  const args = { documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'box', kind: 'box', params: { origin: [0, 0, 0], size: [1, 1, 1] } } }] };
  const code = await runCli(['apply_edits', JSON.stringify(args)], async () => { throw new Error('delivery fixture failure'); }, line => output.push(line));
  assert.equal(code, 1);
  const result = JSON.parse(output[0]);
  assert.equal(result.error.code, 'ADAPTER_ERROR'); assert.equal(result.error.outcomeUnknown, true);
  assert.equal(result.error.details.cause, 'delivery fixture failure'); assert.equal(result.error.requiresHuman, undefined);
  assert.equal(result.error.recovery.first, 'read'); assert.ok(result.error.recovery.ifReadUnavailable.steps.length);
});
