import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBridge } from "../src/bridge/server";
import { CONTRACT_FINGERPRINT } from "../src/bridge/fingerprint";
import { forwardCommand, useAgentSession } from "../src/bridge/client";
import { doctor, formatDoctor } from "../src/bridge/doctor";
import { WEB_ORIGIN, type CadCommand } from "../src/shared/protocol";

test("headless HTTP authority preserves authentication, origin, fingerprint, validation, replay and creation recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-headless-http-"));
  const file = join(dir, "connection.json");
  const b = await startBridge({ port: 0, connectionFile: file, workers: 1 });
  t.after(async () => {
    await b.close();
    await rm(dir, { recursive: true, force: true });
  });
  await b.ready();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).token,
    b.connection.token,
  );
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + b.connection.token,
    "X-Vibeworks-Fingerprint": CONTRACT_FINGERPRINT,
  };
  let sessionId:string|undefined;
  const call = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(b.connection.httpUrl + "/command", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: typeof body === "string" ? body : JSON.stringify({...body as object,...(sessionId?{sessionId}:{})}),
    });
  const inspect = {
    requestId: randomUUID(),
    command: { type: "inspect_model", params: {detail:"full"} },
  };
  assert.equal(
    (await call(inspect, { Authorization: "Bearer wrong" })).status,
    401,
  );
  assert.equal(
    (await call(inspect, { "X-Vibeworks-Fingerprint": "old" })).status,
    409,
  );
  assert.equal(
    (await call(inspect, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await call(inspect, { "Sec-Fetch-Site": "cross-site" })).status,
    403,
  );
  const badHost = await new Promise<number>((resolve) => {
    const req = request(
      b.connection.httpUrl + "/health",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await call("{")).status, 400);
  assert.equal((await call({ command: {} })).status, 400);
  assert.equal(
    (
      await call({
        requestId: randomUUID(),
        command: { type: "inspect_model", params: { typo: 1 } },
      })
    ).status,
    400,
  );
  assert.equal((await call("x".repeat(262145))).status, 413);
  assert.equal((await fetch(b.connection.httpUrl + "/connection")).status, 403);
  const bootstrap = await new Promise<number>((resolve) => {
    const req = request(
      b.connection.httpUrl + "/connection",
      {
        headers: {
          Host: new URL(WEB_ORIGIN).host,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.end();
  });
  assert.equal(bootstrap, 200);
  const enrollment=await(await call({requestId:randomUUID(),command:{type:'agent_session',params:{action:'join',client:'http-test'}}})).json();sessionId=enrollment.session.sessionId;useAgentSession(sessionId);t.after(()=>useAgentSession(undefined));
  const first = await (await call(inspect)).json();
  assert.equal(first.status, "success");
  assert.equal(first.authority.kind, "node");
  const replay = await (await call(inspect)).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.durationMs, 0);
  const conflict = await (
    await call({
      ...inspect,
      command: { type: "documents", params: { action: "list" } },
    })
  ).json();
  assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
  const create = {
    requestId: randomUUID(),
    command: {
      type: "documents",
      params: { action: "create", name: "recoverable" },
    },
  };
  const created = await (await call(create)).json();
  assert.equal(created.createdDocumentId, create.requestId);
  const found = await forwardCommand(
    {
      type: "documents",
      params: { action: "list", requestId: create.requestId },
    },
    async () => b.connection,
  );
  assert.equal(found.documents?.[0].documentId, create.requestId);
  const write = await fetch(b.connection.httpUrl + "/storage", {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: randomUUID(),
      operation: {
        action: "write",
        document: first.document,
        expectedVersion: first.storageVersion,
        history: { undo: [], redo: [] },
      },
    }),
  });
  assert.equal(write.status, 403);
  const health = await doctor(async () => b.connection);
  assert.equal(health.browserConnected, false);
  assert.equal(health.kernel?.phase, "ready");
  assert.deepEqual(health.issues, []);
  assert.match(formatDoctor(health), /Node authority/);
  const stale = await forwardCommand(
    { type: "inspect_model", params: {detail:"full"} },
    async () => b.connection,
    "a".repeat(64),
  );
  assert.equal(stale.error?.code, "VERSION_SKEW");
  assert.equal(stale.error?.outcomeUnknown, undefined);
  const removed = await forwardCommand(
    {
      type: "documents",
      params: {
        action: "delete",
        documentId: first.documentId,
        expectedRevision: 0,
      },
    },
    async () => b.connection,
  );
  assert.equal(removed.status, "success");
  const nextDefault = await forwardCommand(
    { type: "inspect_model", params: {detail:"full"} },
    async () => b.connection,
  );
  assert.equal(nextDefault.documentId, create.requestId);
  await b.close();
  await assert.rejects(readFile(file));
});


test('browser bootstrap has a stable per-launch identity distinct from the unchanged contract', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cad-bridge-lifetime-'));
  let bridge = await startBridge({ port: 0, connectionFile: join(dir, 'connection.json'), workers: 1 });
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const bootstrap = () => new Promise<{ bridgeId: string; fingerprint: string }>((resolve, reject) => {
    request(bridge.connection.httpUrl + '/connection', { headers: {
      Host: new URL(WEB_ORIGIN).host, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    } }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body))); }).on('error', reject).end();
  });
  const first = await bootstrap(), again = await bootstrap();
  assert.match(first.bridgeId, /^[a-f0-9-]{36}$/);
  assert.equal(first.bridgeId, again.bridgeId);
  await bridge.close();
  bridge = await startBridge({ port: 0, connectionFile: join(dir, 'connection.json'), workers: 1 });
  const restarted = await bootstrap();
  assert.equal(restarted.fingerprint, first.fingerprint);
  assert.notEqual(restarted.bridgeId, first.bridgeId);
});
