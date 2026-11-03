import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { PreparedDisplayCache } from '../src/bridge/prepared-display-cache';
import { CommandAuthority } from '../src/bridge/authority';
import { NodeGeometryWorker } from '../src/cad/node-worker';
import { emptyDocument } from '../src/cad/document';
import type { CadDocument } from '../src/shared/protocol';
import type { Evaluation } from '../src/cad/types';

const instance = (id: string, document: string, x = 0) => ({ id, kind: 'instance' as const, params: { document, translation: [x, 0, 0] as [number,number,number], rotationAxis: [0,0,1] as [number,number,number], origin: [0,0,0] as [number,number,number], angleDegrees: 0 } });
const part = (): CadDocument => ({ ...emptyDocument(), name: 'Source', features: [{ id: 'body', kind: 'box', params: { origin: [0,0,0], size: [10,20,5] }, appearance: { material: 'steel' } }] });

test('durable display reuse rebuilds changed transitive sources and never certifies analysis or supplies STEP geometry', async t => {
  const store = new SqliteStore(':memory:');
  const source = part(), nested = { ...emptyDocument(), features: [instance('inner', source.documentId)] };
  const root = { ...emptyDocument(), features: [instance('left', nested.documentId), instance('right', nested.documentId, 30)] };
  for (const doc of [source, nested, root]) await store.put(doc, null);
  let authority = new CommandAuthority(store, { workers: 1, preparedDisplay: store.preparedDisplay });
  t.after(async () => { await authority.close(); store.close(); });
  await authority.ready();
  const read = () => authority.execute({ type: 'inspect_model', params: { documentId: root.documentId } });
  const cold = await read();
  assert.equal(cold.result.status, 'success');
  assert.equal(cold.result.health?.analysis, 'unchecked', 'ordinary display does not run pair analysis');
  assert.equal(cold.evaluation?.analysis, undefined);
  assert.ok(cold.evaluation!.geometry.every(g => g.valid && /BRepCheck/.test(g.validationMethod)));
  assert.equal(cold.evaluation!.meshes[0].vertices, cold.evaluation!.meshes[1].vertices, 'shared source display arrays remain shared');
  const feed = await store.operation({ action: 'changes', after: 0 });
  await authority.close();
  authority = new CommandAuthority(store, { workers: 1, preparedDisplay: store.preparedDisplay });
  await authority.ready();
  const evaluations = () => authority.diagnostics().workers.flatMap(w => w.executions).filter(e => e.type === 'evaluate').length;
  const before = evaluations();
  const captured = await authority.execute({ type: 'inspect_model', params: { documentId: root.documentId, definitionsOnly: true, snapshot: {} } });
  assert.equal(captured.result.inspection?.displayCache, 'prepared', 'frozen discovery shares the runtime cache after restart');
  assert.equal(evaluations(), before);
  const reused = await read();
  assert.equal(reused.result.status, 'success');
  assert.equal(evaluations(), before, 'restarted authority uses checked derived display without a kernel evaluation');
  assert.deepEqual(reused.evaluation!.geometry, cold.evaluation!.geometry);
  assert.deepEqual(reused.evaluation!.references, cold.evaluation!.references);
  assert.equal(reused.evaluation!.meshes[0].vertices, reused.evaluation!.meshes[1].vertices);
  assert.equal(reused.result.health?.analysis, 'unchecked');
  assert.equal(reused.evaluation!.stats, undefined, 'old evaluation timings are not reported as a new run');
  assert.deepEqual(await store.operation({ action: 'changes', after: 0 }), feed, 'cache use writes no modeling feed');
  const exported = await authority.execute({ type: 'export_model', params: { documentId: root.documentId, format: 'step' } });
  assert.equal(exported.result.status, 'success', JSON.stringify(exported.result.error));
  assert.equal(exported.result.health?.analysis, 'current', 'export still performs whole-document preflight');
  assert.ok(exported.result.artifact!.byteLength > 1000);
  assert.ok(authority.diagnostics().workers.some(w=>w.executions.some(e=>e.type==='export')), 'STEP loads exact B-reps through the export worker; durable analysis owns its separate kernel');
  const changed = { ...source, revision: 1, features: [{ ...source.features[0], params: { origin: [0,0,0], size: [20,20,5] } }] } as CadDocument;
  await store.put(changed, 1);
  const refreshed = await read();
  assert.equal(refreshed.result.status, 'success');
  assert.equal(refreshed.result.revision, root.revision);
  assert.equal(refreshed.result.provenance?.sources.find(s => s.documentId === source.documentId)?.revision, 1);
  assert.ok(Math.abs(refreshed.evaluation!.geometry[0].volumeMm3 - 2000) < 1e-8);
});

test('a source version moving during a cached read rejects delivery at the existing freshness boundary', async t => {
  const store = new SqliteStore(':memory:');
  const source = part(), root = { ...emptyDocument(), features: [instance('placed', source.documentId)] };
  await store.put(source, null); await store.put(root, null);
  let authority = new CommandAuthority(store, { workers: 1, preparedDisplay: store.preparedDisplay });
  t.after(async () => { await authority.close(); store.close(); });
  await authority.ready();
  assert.equal((await authority.execute({ type: 'inspect_model', params: { documentId: root.documentId } })).result.status, 'success');
  await authority.close();
  authority = new CommandAuthority(store, { workers: 1, preparedDisplay: store.preparedDisplay });
  await authority.ready();
  const get = store.preparedDisplay.get.bind(store.preparedDisplay);
  let write: Promise<number> | undefined;
  t.mock.method(store.preparedDisplay, 'get', (doc: CadDocument, docs: CadDocument[]) => {
    const cached = get(doc, docs);
    assert.ok(cached);
    write = store.put({ ...source, revision: 1, name: 'Changed during read' }, 1);
    return cached;
  });
  const outcome = await authority.execute({ type: 'inspect_model', params: { documentId: root.documentId } });
  await write;
  assert.equal(outcome.result.error?.code, 'STORAGE_CONFLICT');
  assert.equal(outcome.evaluation, undefined);
});

test('cache keys include engine, complete source definitions, presentation and selection; malformed entries fall back and retention is bounded', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const cache = new PreparedDisplayCache(db, 'engine-a', 1000), doc = part();
    const evaluation: Evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
    cache.put(doc, [], evaluation);
    assert.ok(cache.get(doc, []));
    assert.equal(cache.get({ ...doc, selectedFeatureIds: ['body'] }, []), undefined);
    cache.put(doc, [], evaluation);
    assert.equal(new PreparedDisplayCache(db, 'engine-b').get(doc, []), undefined);
    cache.put(doc, [], evaluation);
    assert.equal(cache.get({ ...doc, name: 'New metadata at the same revision' }, []), undefined);
    cache.put(doc, [doc], evaluation);
    assert.equal(cache.get(doc, [{ ...doc, revision: 1 }]), undefined);
    cache.put(doc, [], evaluation);
    db.prepare("UPDATE prepared_displays SET body='{}'").run();
    assert.equal(cache.get(doc, []), undefined);
    for (let i = 0; i < 20; i++) cache.put({ ...doc, documentId: randomUUID() }, [], evaluation);
    assert.ok(Number(db.prepare('SELECT SUM(bytes) AS total FROM prepared_displays').get()!.total) <= 1000);
    assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM prepared_displays').get()!.n) < 20);
  } finally { db.close(); }
});

test('prepared display keys ignore object field order while retaining array order and values', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const cache = new PreparedDisplayCache(db, 'field-order'), doc = part(), source = part();
    const reordered = JSON.parse(JSON.stringify(source, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)) as CadDocument;
    const evaluation: Evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
    cache.put(doc, [source], evaluation);
    assert.ok(cache.get(doc, [reordered]), 'equivalent source definitions reuse the checked display');
    reordered.features[0] = { ...reordered.features[0], params: { origin: [0, 0, 0], size: [20, 10, 5] } } as CadDocument['features'][number];
    assert.equal(cache.get(doc, [reordered]), undefined, 'coordinate order remains part of model identity');
  } finally { db.close(); }
});

test('project definitions bypass a full geometry queue and do not discard its worker cache', async t => {
  const store = new SqliteStore(':memory:'), doc = part();
  await store.put(doc, null);
  const authority = new CommandAuthority(store, { workers: 1, queueLimit: 1 });
  t.after(async () => { await authority.close(); store.close(); });
  await authority.ready();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  const evaluate = NodeGeometryWorker.prototype.evaluate;
  t.mock.method(NodeGeometryWorker.prototype, 'evaluate', async function(this: NodeGeometryWorker, ...args: Parameters<typeof evaluate>) { enter(); await gate; return evaluate.apply(this, args); });
  const pending = authority.execute({ type: 'inspect_model', params: { documentId: doc.documentId } });
  await entered;
  try {
    const definitions = await authority.execute({ type: 'inspect_model', params: { documentId: doc.documentId, definitionsOnly: true } });
    assert.equal(definitions.result.status, 'success');
    assert.equal(definitions.result.documentId, doc.documentId);
    assert.equal(definitions.evaluation, undefined);
    assert.equal(authority.diagnostics().pending, 1);
    assert.equal(authority.diagnostics().workers[0].replacements, 0);
  } finally { release(); await pending; }
});

test('a prepared topology entry without a display identity is discarded before face picking',()=>{
 const db=new DatabaseSync(':memory:');try{
  const cache=new PreparedDisplayCache(db,'topology-identity'),doc=part();
  const mesh={featureId:'body',vertices:[0,0,0,1,0,0,0,1,0],normals:[0,0,1,0,0,1,0,0,1],triangles:[0,1,2],lines:[],faceRanges:[0,1,0,0],edgeRanges:[],topology:{faces:[{lineage:['+Z'],surface:'PLANE',areaMm2:0.5,center:[0.3,0.3,0] as [number,number,number],normal:[0,0,1] as [number,number,number],neighbours:[]}],edges:[]}};
  const evaluation:Evaluation={geometry:[],meshes:[mesh],visibleFeatureIds:['body']};cache.put(doc,[],evaluation);assert.equal(cache.get(doc,[]),undefined);
  evaluation.displayKey='a'.repeat(64);cache.put(doc,[],evaluation);assert.equal(cache.get(doc,[])!.displayKey,evaluation.displayKey);
 }finally{db.close();}
});
