import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startBridge } from '../src/bridge/server';

test('video downloads require bridge authentication and a completed job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibeworks-video-http-'));
  const bridge = await startBridge({ port: 0, workers: 1, databasePath: join(dir, 'workspace.db'), connectionFile: join(dir, 'connection.json') });
  try {
    const headers = { Authorization: `Bearer ${bridge.connection.token}`, 'X-Vibeworks-Fingerprint': bridge.connection.fingerprint };
    const url = bridge.connection.httpUrl + '/studio-video/result?jobId=';
    const resultUrl = url + randomUUID();
    assert.equal((await fetch(resultUrl)).status, 401);
    assert.equal((await fetch(resultUrl, { headers: { ...headers, 'X-Vibeworks-Fingerprint': 'old' } })).status, 409);
    assert.equal((await fetch(resultUrl, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + 'invalid', { headers })).status, 400);
    assert.equal((await fetch(resultUrl, { headers })).status, 404);
  } finally {
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
