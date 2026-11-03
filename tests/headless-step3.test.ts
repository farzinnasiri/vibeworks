import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CommandAuthority } from "../src/bridge/authority";
import { SqliteStore } from "../src/bridge/sqlite-store";
import { NodeGeometryWorker } from "../src/cad/node-worker";
import { emptyDocument, CadError } from "../src/cad/document";
import {
  parseCommand,
  type CadCommand,
  type CadResult,
  type StorageOperation,
} from "../src/shared/protocol";
const success = (r: CadResult) => {
  assert.equal(r.status, "success", JSON.stringify(r));
  return r;
};
const box = (id: string, size = 10) => ({
  op: "add" as const,
  feature: {
    id,
    kind: "box" as const,
    params: {
      origin: [0, 0, 0] as [number, number, number],
      size: [size, size, size] as [number, number, number],
    },
    appearance: { material: "aluminum" as const },
  },
});

test("real Node authority overlaps independent documents, serializes one document, bounds admission and preserves failed writes/restart undo", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-node-product-"));
  const path = join(dir, "workspace.db");
  let store = new SqliteStore(path);
  let authority = new CommandAuthority(store, { queueLimit: 4 });
  t.after(async () => {
    await authority.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await authority.ready();
  assert.equal(authority.phase, "ready");
  const run = async (value: unknown) =>
    success((await authority.execute(parseCommand(value))).result);
  const create = async (name: string) =>
    run({
      type: "documents",
      params: { action: "create", name, requestId: randomUUID() },
    });
  const a = await create("a"),
    b = await create("b");
  // Each first feature build is long enough to measure real worker execution overlap, not caller overlap.
  const edits = Array.from({ length: 18 }, (_, i) => ({
    ...box("body" + i, 15),
    feature: {
      ...box("body" + i, 15).feature,
      params: { origin: [i * 20, 0, 0], size: [15, 15, 15] },
    },
  }));
  const since = Date.now();
  const [ra, rb] = await Promise.all([
    run({
      type: "apply_edits",
      params: {
        documentId: a.documentId,
        expectedRevision: 0,
        edits,
        analyze: false,
      },
    }),
    run({
      type: "apply_edits",
      params: {
        documentId: b.documentId,
        expectedRevision: 0,
        edits,
        analyze: false,
      },
    }),
  ]);
  assert.equal(
    ra.geometry!.reduce((n, g) => n + g.volumeMm3, 0),
    60750,
  );
  assert.equal(rb.geometry!.length, 18);
  const events = authority
    .diagnostics()
    .workers.flatMap((w) => w.executions)
    .filter(
      (e) =>
        e.type === "evaluate" &&
        e.startedAt >= since &&
        [a.documentId, b.documentId].includes(e.documentId),
    );
  const overlap = events.some((x) =>
    events.some(
      (y) =>
        x.threadId !== y.threadId &&
        x.documentId !== y.documentId &&
        Math.min(x.finishedAt, y.finishedAt) >
          Math.max(x.startedAt, y.startedAt),
    ),
  );
  assert.ok(overlap, JSON.stringify(events));
  console.log(
    "NODE_CONCURRENCY",
    JSON.stringify({
      events,
      rssBytes: authority.diagnostics().rssBytes,
      workers: 2,
      queueLimit: 4,
    }),
  );
  const same = {
    type: "apply_edits",
    params: {
      documentId: a.documentId,
      expectedRevision: 1,
      edits: [box("next", 2)],
      analyze: false,
    },
  };
  const contenders = await Promise.all([
    authority.execute(parseCommand(same)),
    authority.execute(parseCommand(same)),
  ]);
  assert.equal(
    contenders.filter((o) => o.result.status === "success").length,
    1,
  );
  assert.equal(
    contenders.find((o) => o.result.error)?.result.error!.code,
    "REVISION_CONFLICT",
  );
  const before = await store.read(a.documentId!);
  const raw = new DatabaseSync(path);
  raw.exec(
    `CREATE TRIGGER reject_candidate BEFORE INSERT ON revisions WHEN NEW.document_id='${a.documentId}' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;`,
  );
  const failed = (
    await authority.execute(
      parseCommand({
        type: "apply_edits",
        params: {
          documentId: a.documentId,
          expectedRevision: 2,
          edits: [box("must_not_commit", 3)],
          analyze: false,
        },
      }),
    )
  ).result;
  assert.equal(failed.status, "error");
  assert.deepEqual(await store.read(a.documentId!), before);
  assert.ok(authority.diagnostics().workers.some((w) => w.replacements > 0));
  raw.exec("DROP TRIGGER reject_candidate");
  raw.close();
  // Four accepted jobs occupy the bound synchronously; the fifth receives a definite non-dispatch error.
  const jobs = Array.from({ length: 5 }, () =>
    authority.execute(
      parseCommand({
        type: "inspect_model",
        params: { documentId: a.documentId },
      }),
    ),
  );
  const bounded = await Promise.all(jobs);
  assert.equal(
    bounded.filter((o) => o.result.error?.code === "BRIDGE_BUSY").length,
    1,
  );
  await authority.close();
  store.close();
  store = new SqliteStore(path);
  authority = new CommandAuthority(store);
  await authority.ready();
  const restored = await run({
    type: "inspect_model",
    params: { documentId: a.documentId },
  });
  assert.equal(restored.revision, 2);
  assert.equal(restored.history?.canUndo, true);
  const undo = await run({
    type: "document_action",
    params: {
      documentId: a.documentId,
      expectedRevision: 2,
      action: "undo",
      analyze: false,
    },
  });
  assert.equal(undo.revision, 3);
  assert.equal(
    undo.document!.features.some((f) => f.id === "next"),
    false,
  );
});

test("source mutation racing real Node assembly evaluation fails atomic source CAS and read/output version checks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-node-race-"));
  let onRead: ((op: StorageOperation) => Promise<void>) | undefined;
  class RaceStore extends SqliteStore {
    override async operation(op: StorageOperation) {
      const value = await super.operation(op);
      if (onRead) await onRead(op);
      return value;
    }
  }
  const store = new RaceStore(join(dir, "db"));
  const authority = new CommandAuthority(store);
  t.after(async () => {
    await authority.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await authority.ready();
  const run = async (value: unknown) =>
    success((await authority.execute(parseCommand(value))).result);
  const source = await run({
    type: "documents",
    params: { action: "create", requestId: randomUUID() },
  });
  await run({
    type: "apply_edits",
    params: {
      documentId: source.documentId,
      expectedRevision: 0,
      edits: [box("part")],
      analyze: false,
    },
  });
  const assembly = await run({
    type: "documents",
    params: { action: "create", kind: "assembly", requestId: randomUUID() },
  });
  const instance = {
    op: "add",
    feature: {
      id: "placed",
      kind: "instance",
      params: {
        document: source.documentId,
        featureId: "part",
        translation: [0, 0, 0],
        rotationAxis: [0, 0, 1],
        angleDegrees: 0,
        origin: [0, 0, 0],
      },
    },
  };
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const observed = new Promise<void>((r) => {
    captured = r;
  });
  onRead = async (op) => {
    if ((op.action === "read" || op.action === "body") && op.documentId === source.documentId) {
      onRead = undefined;
      captured();
      await gate;
    }
  };
  const racing = authority.execute(
    parseCommand({
      type: "apply_edits",
      params: {
        documentId: assembly.documentId,
        expectedRevision: 0,
        edits: [instance],
        analyze: false,
      },
    }),
  );
  await observed;
  await run({
    type: "apply_edits",
    params: {
      documentId: source.documentId,
      expectedRevision: 1,
      edits: [{ op: "update", feature: box("part", 12).feature }],
      analyze: false,
    },
  });
  release();
  const failed = (await racing).result;
  assert.equal(failed.error?.code, "STORAGE_CONFLICT");
  assert.equal((await store.read(assembly.documentId!))!.document.revision, 0);
  assert.equal(
    (await store.read(assembly.documentId!))!.history.undo.length,
    0,
  );
  const built = await run({
    type: "apply_edits",
    params: {
      documentId: assembly.documentId,
      expectedRevision: 0,
      edits: [instance],
      analyze: false,
    },
  });
  assert.equal(built.geometry![0].volumeMm3, 1728);
  // On the final version read for output, advance the source. The output must fail, without bytes.
  onRead = async (op) => {
    if ((op.action === "read" || op.action === "body") && op.documentId === source.documentId) {
      onRead = undefined;
      const record = (await store.read(source.documentId!))!;
      await store.put(
        {
          ...record.document,
          revision: 3,
          features: [box("part", 14).feature],
        },
        record.version,
        record.history,
      );
    }
  };
  const output = (
    await authority.execute(
      parseCommand({
        type: "export_model",
        params: {
          documentId: assembly.documentId,
          format: "step",
          skipAnalysis: true,
        },
      }),
    )
  ).result;
  // A concurrent write before the final assertion is detected even if geometry itself succeeded.
  assert.equal(output.error?.code, "STORAGE_CONFLICT", JSON.stringify(output));
  assert.equal(output.artifact, undefined);
});

test("Node worker terminates timed-out native work, reports crashes, recycles and reloads text with matched font", async () => {
  const timed = new NodeGeometryWorker({ timeoutMs: 1 });
  await assert.rejects(
    timed.evaluate({ ...emptyDocument(), features: [box("part").feature] }),
    (e) => (e as any).code === "WORKER_TIMEOUT",
  );
  assert.equal(timed.diagnostics.phase, "unavailable");
  timed.close();
  const crashed = new NodeGeometryWorker({
    entry: new URL("./headless-worker-fault.mjs", import.meta.url),
  });
  await assert.rejects(
    crashed.evaluate(emptyDocument()),
    (e) => (e as any).code === "WORKER_CRASH",
  );
  crashed.close();
  const worker = new NodeGeometryWorker();
  try {
    const doc = {
      ...emptyDocument(),
      features: [
        {
          id: "text",
          kind: "text" as const,
          params: {
            text: "Node CAD",
            plane: "XY" as const,
            origin: [0, 0, 0] as [number, number, number],
            size: 6,
            depth: 1,
          },
        },
      ],
    };
    const original = await worker.evaluate(doc);
    assert.ok(original.geometry[0].volumeMm3 > 1);
    for (let i = 0; i < 128; i++)
      await worker.evaluate({ ...emptyDocument(), features: [] });
    const next = await worker.evaluate(doc);
    assert.deepEqual(next.geometry, original.geometry);
    assert.ok(worker.diagnostics.generation >= 2);
    assert.ok(worker.diagnostics.replacements >= 1);
  } finally {
    worker.close();
  }
});

test("a cold headless assembly with a deleted source mount stays inspectable and repairable after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-node-stale-mount-"));
  const store = new SqliteStore(join(dir, "db"));
  let authority = new CommandAuthority(store, { workers: 1 });
  t.after(async () => {
    await authority.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await authority.ready();
  const run = async (value: unknown) =>
    success((await authority.execute(parseCommand(value))).result);
  const source = await run({
    type: "documents",
    params: { action: "create", requestId: randomUUID() },
  });
  const mounted = {
    ...box("part").feature,
    mounts: [
      {
        name: "root",
        frame: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      },
    ],
  };
  await run({
    type: "apply_edits",
    params: {
      documentId: source.documentId,
      expectedRevision: 0,
      edits: [{ op: "add", feature: mounted }],
      analyze: false,
    },
  });
  const assembly = await run({
    type: "documents",
    params: { action: "create", kind: "assembly", requestId: randomUUID() },
  });
  const placed = {
    id: "placed",
    kind: "instance",
    params: {
      document: source.documentId,
      featureId: "part",
      translation: [0, 0, 0],
      rotationAxis: [0, 0, 1],
      angleDegrees: 0,
      origin: [0, 0, 0],
      attachment: {
        source: { featureId: "part", name: "root" },
        target: {
          frame: {
            origin: [0, 0, 0],
            normal: [0, 0, 1],
            xDirection: [1, 0, 0],
          },
        },
        mode: "align",
        offset: [0, 0, 0],
        twistDegrees: 0,
      },
    },
  };
  await run({
    type: "apply_edits",
    params: {
      documentId: assembly.documentId,
      expectedRevision: 0,
      edits: [{ op: "add", feature: placed }],
      analyze: false,
    },
  });
  await run({
    type: "apply_edits",
    params: {
      documentId: source.documentId,
      expectedRevision: 1,
      edits: [{ op: "update", feature: box("part").feature }],
      analyze: false,
    },
  });
  const warmStale = await run({ type: 'inspect_model', params: { documentId: assembly.documentId } });
  assert.match(warmStale.health!.referenceError!, /root/);
  await authority.close();
  authority = new CommandAuthority(store, { workers: 1 });
  await authority.ready();
  assert.equal(authority.phase, "ready");
  const inspected = await run({
    type: "inspect_model",
    params: { documentId: assembly.documentId },
  });
  assert.match(inspected.health!.referenceError!, /root/);
  const output = (
    await authority.execute(
      parseCommand({
        type: "export_model",
        params: {
          documentId: assembly.documentId,
          format: "step",
          skipAnalysis: true,
        },
      }),
    )
  ).result;
  assert.equal(output.error?.code, "ASSEMBLY_STALE");
  let failGraphRead = false;
  const originalOperation = store.operation.bind(store);
  t.mock.method(store, 'operation', async (op: StorageOperation) => {
    if (failGraphRead && (op.action === 'read' || op.action === 'body') && op.documentId === source.documentId) {
      failGraphRead = false;
      throw new CadError('STORAGE_UNAVAILABLE', 'Injected transient source read after commit');
    }
    const result = await originalOperation(op);
    if (op.action === 'write' && op.document.documentId === source.documentId) failGraphRead = true;
    return result;
  });
  const sourceRepair = await run({
    type: "apply_edits",
    params: {
      documentId: source.documentId,
      expectedRevision: 2,
      edits: [{ op: "update", feature: mounted }],
      analyze: false,
    },
  });
  assert.equal(failGraphRead, false);
  assert.ok(sourceRepair.warnings.some(w => w.includes('Injected transient source read after commit')));
  const committedSource = await store.read(source.documentId!);
  const committedAssembly = await store.read(assembly.documentId!);
  const committedFeed = await store.operation({ action: 'changes', after: 0 });
  const repaired = await run({
    type: "inspect_model",
    params: { documentId: assembly.documentId },
  });
  assert.equal(repaired.health!.referenceError, undefined);
  assert.ok(Math.abs(repaired.geometry![0].volumeMm3 - 1000) < 1e-8);
  assert.deepEqual(await store.read(source.documentId!), committedSource);
  assert.deepEqual(await store.read(assembly.documentId!), committedAssembly);
  assert.deepEqual(await store.operation({ action: 'changes', after: 0 }), committedFeed);
});

test("terminating a real in-flight product kernel and native deadline preserve SQLite model/history/feed and recover", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cad-node-inflight-"));
  const store = new SqliteStore(join(dir, "db"));
  const authority = new CommandAuthority(store, { workers: 1 });
  t.after(async () => {
    await authority.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await authority.ready();
  const initial = success(
    (
      await authority.execute(
        parseCommand({ type: "inspect_model", params: {} }),
      )
    ).result,
  );
  success(
    (
      await authority.execute(
        parseCommand({
          type: "apply_edits",
          params: {
            documentId: initial.documentId,
            expectedRevision: 0,
            edits: [box("part")],
            analyze: false,
          },
        }),
      )
    ).result,
  );
  const prior = await store.read(initial.documentId!);
  const feed = (await store.operation({ action: "changes", after: 0 })).cursor;
  const slots = (
    authority as unknown as { slots: { worker: NodeGeometryWorker }[] }
  ).slots;
  const heavy = (prefix: string) =>
    Array.from({ length: 40 }, (_, i) => ({
      ...box(prefix + i),
      feature: {
        ...box(prefix + i).feature,
        params: { origin: [i * 20, 20, 0], size: [10, 10, 10] },
      },
    }));
  const command = (prefix: string) =>
    parseCommand({
      type: "apply_edits",
      params: {
        documentId: initial.documentId,
        expectedRevision: 1,
        edits: heavy(prefix),
        analyze: false,
      },
    });
  const pending = authority.execute(command("crash_"));
  const until = Date.now() + 5000;
  while (!slots[0].worker.diagnostics.active && Date.now() < until)
    await new Promise((r) => setTimeout(r, 1));
  assert.equal(
    slots[0].worker.diagnostics.active?.documentId,
    initial.documentId,
  );
  const started = slots[0].worker.diagnostics.active;
  slots[0].worker.stop(
    new CadError(
      "WORKER_CRASH",
      "Controlled termination of an active exact product kernel",
    ),
  );
  assert.equal((await pending).result.error?.code, "WORKER_CRASH");
  assert.deepEqual(await store.read(initial.documentId!), prior);
  assert.equal(
    (await store.operation({ action: "changes", after: 0 })).cursor,
    feed,
  );
  const recovered = success(
    (
      await authority.execute(
        parseCommand({
          type: "inspect_model",
          params: { documentId: initial.documentId },
        }),
      )
    ).result,
  );
  assert.ok(Math.abs(recovered.geometry![0].volumeMm3 - 1000) < 1e-8);
  const original = slots[0].worker.evaluate.bind(slots[0].worker);
  t.mock.method(slots[0].worker, "evaluate", ((
    document,
    timeout,
    analyze,
    references,
  ) =>
    original(
      document,
      document.features.some((f) => f.id.startsWith("timeout_")) ? 1 : timeout,
      analyze,
      references,
    )) as NodeGeometryWorker["evaluate"]);
  assert.equal(
    (await authority.execute(command("timeout_"))).result.error?.code,
    "WORKER_TIMEOUT",
  );
  assert.deepEqual(await store.read(initial.documentId!), prior);
  assert.equal(
    (await store.operation({ action: "changes", after: 0 })).cursor,
    feed,
  );
  const final = success(
    (
      await authority.execute(
        parseCommand({
          type: "inspect_model",
          params: { documentId: initial.documentId },
        }),
      )
    ).result,
  );
  assert.equal(final.revision, 1);
  assert.equal(final.history?.canUndo, true);
  assert.equal(final.geometry!.length, 1);
  console.log(
    "INFLIGHT_RECOVERY",
    JSON.stringify({
      started,
      replacements: slots[0].worker.diagnostics.replacements,
      revision: final.revision,
      feed,
    }),
  );
});

for (const code of ['WORKER_TIMEOUT', 'WORKER_CRASH'] as const) {
  for (const path of ['inactive', 'active', 'poll'] as const) {
    test(`${code} during ${path} assembly refresh retries current geometry without changing durable state`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'cad-refresh-retry-'));
      const store = new SqliteStore(join(dir, 'db'));
      const authority = new CommandAuthority(store, { workers: 1 });
      t.after(async () => { await authority.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
      await authority.ready();
      const run = async (value: unknown) => (await authority.execute(parseCommand(value))).result;
      const source = success(await run({ type: 'documents', params: { action: 'create', name: 'source', requestId: randomUUID() } }));
      success(await run({ type: 'apply_edits', params: { documentId: source.documentId, expectedRevision: 0, analyze: false, edits: [box('part')] } }));
      const assembly = success(await run({ type: 'documents', params: { action: 'create', kind: 'assembly', name: 'assembly', requestId: randomUUID() } }));
      success(await run({ type: 'apply_edits', params: { documentId: assembly.documentId, expectedRevision: 0, analyze: false, edits: [{ op: 'add', feature: {
        id: 'placed', kind: 'instance', params: { document: source.documentId, featureId: 'part', translation: [0, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] },
      } }] } }));
      if (path !== 'inactive') success(await run({ type: 'documents', params: { action: 'open', documentId: assembly.documentId } }));
      const slot = (authority as unknown as { slots: { worker: NodeGeometryWorker; runtime: import('../src/cad/runtime').CadRuntime }[] }).slots[0];
      let injected = false;
      const original = slot.worker.evaluate.bind(slot.worker);
      t.mock.method(slot.worker, 'evaluate', (async (document, timeout, analyze, references) => {
        if (injected || document.documentId !== assembly.documentId) return original(document, timeout, analyze, references);
        injected = true;
        if (code === 'WORKER_TIMEOUT') {
          // A cold real kernel cannot initialize inside 1 ms. Exercise its actual timer/replacement path.
          slot.worker.stop();
          return original(document, 1, analyze, references);
        }
        // Observe the real worker start event in the same event-loop turn. Polling can miss
        // a cached evaluation which starts and finishes between two timer callbacks.
        const native = (slot.worker as unknown as { worker?: import('node:worker_threads').Worker }).worker;
        assert.ok(native);
        let sawStart = false;
        const terminate = (reply: { executionStarted?: { documentId?: string } }) => {
          if (reply.executionStarted?.documentId !== assembly.documentId) return;
          sawStart = true;
          slot.worker.stop(new CadError('WORKER_CRASH', 'Controlled termination during assembly refresh'));
        };
        native.on('message', terminate);
        const pending = original(document, timeout, analyze, references);
        try { await pending.catch(() => undefined); assert.equal(sawStart, true); }
        finally { native.off('message', terminate); }
        return pending;
      }) as NodeGeometryWorker['evaluate']);
      const sourceBefore = (await store.read(source.documentId!))!;
      const sourceFeature = { ...box('part').feature, params: { origin: [0, 0, 0], size: [12, 10, 10] } };
      if (path === 'poll') {
        // A different slot/process committed before this active runtime consumes the feed.
        await store.put({ ...sourceBefore.document, revision: 2, features: [sourceFeature as typeof sourceBefore.document.features[number]] }, sourceBefore.version, sourceBefore.history);
      } else {
        const edited = success(await run({ type: 'apply_edits', params: { documentId: source.documentId, expectedRevision: 1, analyze: false, edits: [{ op: 'update', feature: sourceFeature }] } }));
        assert.equal(edited.revision, 2);
        assert.ok(edited.warnings.some(w => /next command/.test(w)));
      }
      const durable = async () => ({ source: await store.read(source.documentId!), assembly: await store.read(assembly.documentId!), feed: await store.operation({ action: 'changes', after: 0 }), history: await store.operation({ action: 'history', documentId: assembly.documentId! }) });
      const committed = await durable();
      {
        // Headless authority defers every ancestor refresh until its own read.
        const failed = await run({ type: 'inspect_model', params: { documentId: assembly.documentId } });
        assert.equal(failed.status, 'error');
        assert.equal(failed.error?.code, code);
        assert.equal(failed.health?.referenceError, undefined);
        assert.equal(failed.geometry, undefined);
        assert.equal(failed.artifact, undefined);
      }
      assert.equal(injected, true);
      assert.deepEqual(await durable(), committed);
      const retried = success(await run({ type: 'inspect_model', params: { documentId: assembly.documentId } }));
      assert.ok(Math.abs(retried.geometry![0].volumeMm3 - 1200) < 1e-8, JSON.stringify(retried));
      assert.equal(retried.health?.referenceError, undefined);
      assert.equal(retried.provenance?.sources.find(s => s.documentId === source.documentId)?.revision, 2);
      const exported = success(await run({ type: 'export_model', params: { documentId: assembly.documentId, format: 'step', skipAnalysis: true } }));
      assert.ok(exported.artifact!.byteLength > 1000);
      assert.deepEqual(await durable(), committed);
      console.log('REFRESH_RECOVERY', JSON.stringify({ code, path, volume: retried.geometry![0].volumeMm3, sourceRevision: 2, assemblyRevision: retried.revision, replacements: slot.worker.diagnostics.replacements }));
    });
  }
}

test('deleting a populated project reconciles the authority default document', async t => {
 const store=new SqliteStore(':memory:');
 const projectId=randomUUID();
 await store.operation({action:'project',project:{projectId,name:'Disposable',version:1},expectedVersion:null});
 const original={...emptyDocument(),projectId}; const remaining=emptyDocument();
 await store.put(original,null); await store.put(remaining,null);
 await store.setPreference('activeDocumentId',original.documentId);
 const authority=new CommandAuthority(store,{workers:1});
 t.after(async()=>{await authority.close();store.close();});await authority.ready();
 const removed=await authority.execute(parseCommand({type:'documents',params:{action:'delete_project',projectId,expectedStorageVersion:1,documentVersions:{[original.documentId]:1}}}));
 success(removed.result);
 const read=await authority.execute(parseCommand({type:'inspect_model',params:{definitionsOnly:true}}));
 success(read.result); assert.equal(read.result.documentId,remaining.documentId);
});
