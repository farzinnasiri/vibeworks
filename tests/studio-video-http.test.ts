import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startBridge } from '../src/bridge/server';

test('video endpoints enforce bridge authentication, version checks and bounded input before launching encoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibeworks-video-http-'));
  const bridge = await startBridge({ port: 0, workers: 1, connectionFile: join(dir, 'connection.json') });
  const id = randomUUID();
  const input = { action: 'start', encoding: { id, width: 1920, height: 1080, fps: 24, frames: 12 } };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.connection.token}`, 'X-Vibeworks-Fingerprint': bridge.connection.fingerprint };
  const send = (body: unknown, extra = {}) => fetch(bridge.connection.httpUrl + '/studio-video', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await send(input, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await send(input, { 'X-Vibeworks-Fingerprint': 'old' })).status, 409);
    assert.equal((await send(input, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await send({ ...input, encoding: { ...input.encoding, frames: 10000 } })).status, 400);
    assert.equal((await send({ ...input, encoding: { ...input.encoding, width: 3840, height: 2160 } })).status, 400);
    assert.equal((await send({ action: 'finish', id })).status, 404);
    assert.equal((await send({ action: 'cancel', id })).status, 200, 'cancel remains safe after an uncertain start outcome');
    const badFrame = await fetch(bridge.connection.httpUrl + `/studio-video/frame?id=${id}&index=0`, { method: 'POST', headers, body: '{}' });
    assert.equal(badFrame.status, 415);
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
