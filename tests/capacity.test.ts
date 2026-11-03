// Capacity behavior: display quality cache, meshless agent receipts, deadline-aware analysis, slot affinity, display transport.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { assemblyGraph } from '../src/cad/assemblies';
import { CommandAuthority } from '../src/bridge/authority';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { HeadlessRenderer } from '../src/bridge/renderer';
import { MemoryStore } from '../src/cad/store';
import { analysisBudget, ANALYSIS_SLICE_MS } from '../src/cad/worker-session';
import { decodeAssets, decodeValues, displayBytes, encodeValues, packDisplay } from '../src/shared/display';
import { displayDeliverySchema } from '../src/bridge/validation';
import { parseCommand, type CadResult } from '../src/shared/protocol';

const kernel = (async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  return initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} });
})();
const ok = (r: CadResult) => { assert.equal(r.status, 'success', JSON.stringify(r.error)); return r; };
const cylinder = (id: string, x: number) => ({ id, kind: 'cylinder' as const, params: { origin: [x, 0, 0] as [number, number, number], radius: 20, height: 30 } });

test('auto display remembers each result per quality: a repeat display tessellates nothing and agents can skip meshes', async () => {
  const oc = await kernel; setOC(oc);
  const engine = new GeometryEngine(oc);
  const tessellated: string[] = [];
  const boundary = engine as unknown as { tessellate: (...args: unknown[]) => unknown };
  const original = boundary.tessellate.bind(engine);
  boundary.tessellate = (entry: unknown, options: unknown) => { tessellated.push(JSON.stringify(options)); return original(entry, options); };
  const doc = validateDocument({ ...emptyDocument(), features: [cylinder('a', 0), cylinder('b', 60)] });
  try {
    const agent = engine.evaluate(doc, [], undefined, undefined, { meshes: false });
    assert.deepEqual(agent.meshes, []); assert.equal(agent.stats!.display, undefined); assert.equal(tessellated.length, 0);
    const first = engine.evaluate(doc);
    assert.equal(first.meshes.length, 2); assert.equal(tessellated.length, 2, 'two results at the first quality that fits');
    const again = engine.evaluate(doc);
    assert.equal(tessellated.length, 2, 'cached meshes are reused'); assert.deepEqual(again.meshes.map(m => m.vertices.length), first.meshes.map(m => m.vertices.length));
    const coarse = engine.evaluate(doc, [], undefined, { detail: 'coarse' });
    assert.equal(coarse.stats!.display!.requested, 'coarse');
    const count = tessellated.length;
    engine.evaluate(doc, [], undefined, { detail: 'coarse' });
    assert.equal(tessellated.length, count, 'coarse is cached too');
  } finally { engine.dispose(); }
});

test('a quality over budget is ruled out from remembered counts, without tessellating again', async () => {
  const oc = await kernel; setOC(oc);
  const doc = validateDocument({ ...emptyDocument(), features: [cylinder('a', 0), cylinder('b', 60), cylinder('c', 120)] });
  const probe = new GeometryEngine(oc);
  const fine = probe.evaluate(doc, [], undefined, { detail: 'fine' }).stats!.display!.values;
  probe.dispose();
  const engine = new GeometryEngine(oc, undefined, fine - 1);
  const tessellated: string[] = [];
  const boundary = engine as unknown as { tessellate: (...args: unknown[]) => unknown };
  const original = boundary.tessellate.bind(engine);
  boundary.tessellate = (entry: unknown, options: unknown) => { tessellated.push(JSON.stringify(options)); return original(entry, options); };
  try {
    const first = engine.evaluate(doc);
    assert.equal(first.stats!.display!.reduced, true);
    const count = tessellated.length;
    const second = engine.evaluate(doc);
    assert.equal(tessellated.length, count, 'the over-budget fine quality is not tried again');
    assert.equal(second.stats!.display!.toleranceMm, first.stats!.display!.toleranceMm);
  } finally { engine.dispose(); }
});

test('analysis takes what is left of the caller deadline, capped at one slice', () => {
  assert.equal(analysisBudget(100_000, 0), ANALYSIS_SLICE_MS);
  assert.equal(analysisBudget(10_000, 0), 8_000, 'two seconds stay for the reply');
  assert.equal(analysisBudget(1_000, 0), 0);
});

test('agent receipts carry no display meshes; the first viewer read adds them without changing the commit', async t => {
  const store = new MemoryStore(), authority = new CommandAuthority(store, { workers: 1 });
  t.after(() => authority.close()); await authority.ready();
  const agent = async (type: string, params: unknown) => authority.execute(parseCommand({ type, params }), undefined, false);
  const view = async (type: string, params: unknown) => authority.execute(parseCommand({ type, params }), undefined, true);
  const documentId = ok((await agent('documents', { action: 'create', requestId: randomUUID() })).result).documentId!;
  const edited = await agent('apply_edits', { documentId, expectedRevision: 0, edits: [{ op: 'add', feature: cylinder('a', 0) }], analyze: false });
  ok(edited.result); assert.equal(edited.evaluation, undefined);
  assert.equal(edited.result.evaluationStats?.display, undefined, 'the commit did not tessellate');
  const before = await store.read(documentId);
  const shown = await view('inspect_model', { documentId });
  ok(shown.result); assert.equal(shown.evaluation!.meshes.length, 1); assert.ok(shown.evaluation!.meshes[0].vertices.length > 0);
  assert.deepEqual(await store.read(documentId), before, 'display is not a durable change');
});

test('a viewer edit whose display does not fit still commits, with the reason as a warning', async t => {
  const store = new MemoryStore(), authority = new CommandAuthority(store, { workers: 1 });
  t.after(() => authority.close()); await authority.ready();
  const view = async (type: string, params: unknown) => authority.execute(parseCommand({ type, params }), undefined, true);
  const documentId = ok((await view('documents', { action: 'create', requestId: randomUUID() })).result).documentId!;
  const worker = (authority as unknown as { slots: { worker: { evaluate: (...args: unknown[]) => Promise<any> } }[] }).slots[0].worker;
  const original = worker.evaluate.bind(worker);
  worker.evaluate = async (...args: unknown[]) => { const e = await original(...args); return { ...e, meshes: [], stats: { ...e.stats, display: undefined }, displayError: 'Requested display exceeds the bounded output capacity.' }; };
  const edited = await view('apply_edits', { documentId, expectedRevision: 0, edits: [{ op: 'add', feature: cylinder('a', 0) }], analyze: false });
  ok(edited.result); assert.equal(edited.result.revision, 1);
  assert.ok(edited.result.warnings.some(w => w.startsWith('Display unavailable') && w.includes('committed')));
  assert.equal((await store.read(documentId))!.document.revision, 1);
});

test('a document returns to the worker slot that has it cached while both slots are free', async t => {
  const store = new MemoryStore(), authority = new CommandAuthority(store, { workers: 2 });
  t.after(() => authority.close()); await authority.ready();
  const run = async (type: string, params: unknown) => ok((await authority.execute(parseCommand({ type, params }), undefined, false)).result);
  const first = (await run('documents', { action: 'create', requestId: randomUUID() })).documentId!;
  const second = (await run('documents', { action: 'create', requestId: randomUUID() })).documentId!;
  // Both edits are queued together: the second document takes slot 0, so the first document's home is slot 1.
  const edits = await Promise.all([second, first].map((documentId, i) => authority.execute(parseCommand({ type: 'apply_edits', params: { documentId, expectedRevision: 0, edits: [{ op: 'add', feature: cylinder(`c${i}`, 0) }], analyze: false } }), undefined, false)));
  const homeOfFirst = ok(edits[1].result).authority!.workerSlot;
  assert.equal(homeOfFirst, 1, 'precondition: the old dispatcher would now choose slot 0');
  for (let i = 0; i < 4; i++) assert.equal((await run('inspect_model', { documentId: first })).authority!.workerSlot, homeOfFirst);
});

test('display assets travel as checked base64 typed arrays at about a third of JSON size', () => {
  const vertices = Array.from(Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i) * 123.456));
  assert.deepEqual(decodeValues(encodeValues(vertices, false), false), vertices, 'float32 display values round-trip exactly');
  assert.deepEqual(decodeValues(encodeValues([0, 1, 4294967295], true), true), [0, 1, 4294967295]);
  for (const bad of ['', 'abc', 'AAA*', 'A=AA', 7]) assert.ok(bad === '' ? decodeValues(bad, false)!.length === 0 : decodeValues(bad, false) === undefined, String(bad));
  assert.equal(decodeAssets([{ vertices: '', normals: '', triangles: '', lines: '' , extra: '' }]), undefined);
  const mesh = { featureId: 'a', vertices, normals: vertices, triangles: [0, 1, 2], lines: vertices };
  const result = { operation: 'inspect_model' as const, status: 'success' as const, documentId: '00000000-0000-4000-8000-000000000000', revision: 0, created: [], updated: [], warnings: [] };
  const json = JSON.stringify(packDisplay({ result, evaluation: { geometry: [], visibleFeatureIds: ['a'], meshes: [mesh] } }));
  assert.ok(json.length < JSON.stringify(mesh).length / 2.5, `${json.length} vs ${JSON.stringify(mesh).length}`);
  assert.ok(displayBytes(3 * 3000 + 3, 1) >= json.length - JSON.stringify(result).length);
  const decoded = displayDeliverySchema.parse(JSON.parse(json)).evaluation!;
  assert.deepEqual(decoded.meshes[0].vertices, vertices);
  const tampered = JSON.parse(json); tampered.evaluation.assetEncoding = 'json';
  assert.equal(displayDeliverySchema.safeParse(tampered).success, false);
});

test('outputs never outlive their command: a spent budget fails before launching Chromium', async () => {
  const renderer = new HeadlessRenderer();
  try {
    await assert.rejects(renderer.render({ geometry: [], meshes: [], visibleFeatureIds: [] }, parseCommand({ type: 'render_views', params: {} }) as never, emptyDocument(), {} as never, 0), /RENDER_TIMEOUT|expired/i);
    assert.equal(renderer.status.phase, 'idle');
  } finally { await renderer.close(); }
});

test('assembly validation reads only reachable documents, and SQLite serves bodies per version', async t => {
  const part = validateDocument({ ...emptyDocument(), features: [cylinder('a', 0)] });
  const root = validateDocument({ ...emptyDocument(), features: [{ id: 'placed', kind: 'instance', params: { document: part.documentId, translation: [0, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] } }] });
  const unrelated = { ...emptyDocument(), features: [{ id: 'bad', kind: 'nonsense' }] } as never;
  assert.deepEqual(assemblyGraph(root, [part, unrelated]).map(d => d.documentId), [part.documentId, root.documentId]);
  const dir = await mkdtemp(join(tmpdir(), 'cad-capacity-'));
  const store = new SqliteStore(join(dir, 'db'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const version = await store.put(part, null);
  const body = (await store.body(part.documentId))!;
  assert.equal(body.version, version); assert.equal(body.document.features[0].id, 'a');
  body.document.features.length = 0;
  assert.equal((await store.body(part.documentId))!.document.features.length, 1, 'callers receive copies');
  const next = await store.put({ ...part, revision: 1, features: [cylinder('b', 0)] }, version);
  assert.deepEqual([(await store.body(part.documentId))!.version, (await store.body(part.documentId))!.document.features[0].id], [next, 'b']);
  const probed = store.probe();
  await store.put({ ...part, revision: 2 }, next);
  assert.ok(store.probe().changes > probed.changes, 'the viewer probe moves with every write');
});
