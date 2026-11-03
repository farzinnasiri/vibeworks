import {worldMesh} from '../src/shared/display';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { importSTEP, setOC } from 'replicad';
import * as THREE from 'three';
import { CadRuntime } from '../src/cad/runtime';
import { GeometryEngine } from '../src/cad/geometry';
import { GeometryWorker } from '../src/cad/worker-client';
import { GeometryWorkerSession } from '../src/cad/worker-session';
import { assemblyGraph } from '../src/cad/assemblies';
import { emptyDocument } from '../src/cad/document';
import { MemoryStore } from '../src/cad/store';
import { context } from '../src/cad/demo';
import { modelHealth } from '../src/cad/health';
import { instanceParamsSchema, MAX_INSTANCE_DEPTH, type CadDocument, type Feature, type Vector3 } from '../src/shared/protocol';
import { resultSchema } from '../src/bridge/validation';
import { receipt } from '../src/bridge/deliver';
import { createWorkbenchScene, createModelScene, disposeScene } from '../src/web/scene';
import { moveInstance, toolFeature } from '../src/web/modeling';

const kernel = readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  .then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }));
const block = (id = 'body', size: Vector3 = [10, 20, 5]): Extract<Feature, { kind: 'box' }> => ({ id, kind: 'box', params: { origin: [0, 0, 0], size }, appearance: { material: 'aluminum', color: '#ff0000' } });
const part = (features: Feature[] = [block()]): CadDocument => ({ ...emptyDocument(), kind: 'part', name: 'Bracket', revision: 3, features });
const instance = (id: string, source: CadDocument, translation: Vector3 = [0, 0, 0]): Extract<Feature, {kind: 'instance'}> => ({ id, kind: 'instance', params: { document: source.documentId, translation, rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] } });
const assembly = (features: Feature[]): CadDocument => ({ ...emptyDocument(), name: 'Assembly', kind: 'assembly', features });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
async function engineFixture(t: TestContext) { const oc = await kernel; setOC(oc); const engine = new GeometryEngine(oc); t.after(() => engine.dispose()); return engine; }
async function runtimeFixture(t: TestContext, store = new MemoryStore()) {
  const engine = await engineFixture(t);
  t.mock.method(GeometryWorker.prototype, 'initialize', async (doc: CadDocument, docs: CadDocument[] = []) => engine.evaluate(doc, docs));
  t.mock.method(GeometryWorker.prototype, 'evaluate', async (doc: CadDocument, _timeout?: number, analyze?: { featureIds?: string[] }, docs: CadDocument[] = []) => {
    const evaluated = engine.evaluate(doc, docs);
    return analyze ? { ...evaluated, analysis: engine.analyze(doc, evaluated.geometry, analyze.featureIds) } : evaluated;
  });
  t.mock.method(GeometryWorker.prototype, 'export', async (format: 'step' | 'stl', ids: string[], doc: CadDocument, docs: CadDocument[] = []) => { engine.evaluate(doc, docs); return engine.export(format, ids, doc); });
  const runtime = new CadRuntime(store); await runtime.initialize();
  assert.equal(runtime.getSnapshot().phase, 'ready');
  return { runtime, store, engine };
}

test('rigid instances have exact placed bounds, independent appearance/mass, and one source evaluation for N copies', async t => {
  const engine = await engineFixture(t), source = part();
  const one = instance('left', source, [30, 0, 0]); one.params.angleDegrees = 90; one.params.origin = [1, 2, 0]; one.appearance = { material: 'steel', color: '#0000ff' };
  const copies = Array.from({ length: 12 }, (_, i) => instance(`bolt_${i}`, source, [i * 30, 50, 0]));
  const doc = assembly([one, ...copies]);
  const evaluated = engine.evaluate(doc, [source]);
  assert.equal(evaluated.stats!.referencedDocuments!.length, 1);
  assert.deepEqual(evaluated.stats!.referencedDocuments![0].rebuilt, ['body']);
  assert.equal(evaluated.stats!.cache.misses, 14, 'one part history plus thirteen placed shapes');
  assert.equal(evaluated.instances!.length, 13);
  assert.equal(evaluated.instances![0].revision, 3);
  assert.equal(evaluated.instances![0].name, 'Bracket');
  const info = evaluated.geometry[0]; close(info.volumeMm3, 1000);
  info.bounds.size.forEach((n, i) => close(n, [20, 10, 5][i]));
  info.bounds.min.forEach((n, i) => close(n, [13, 1, 0][i]));
  close(info.massG!, 7.85); close(evaluated.geometry[1].massG!, 2.7);
  assert.equal(evaluated.meshes[0].appearance!.color, '#0000ff');
  assert.equal(evaluated.meshes[1].appearance!.color, '#ff0000');
  const warm = engine.evaluate(doc, [source]); assert.equal(warm.stats!.cache.misses, 0);
  const painted = structuredClone(source); painted.revision++; painted.features[0].appearance = { material: 'copper', color: '#00ff00' };
  const repainted = engine.evaluate(doc, [painted]); assert.equal(repainted.stats!.cache.misses, 0);
  close(repainted.geometry[0].massG!, 7.85); assert.equal(repainted.geometry[1].material, 'copper');
  assert.equal(repainted.instances![0].revision, 4);
  painted.features[0] = block('body', [10, 20, 10]);
  const resized = engine.evaluate(doc, [painted]); close(resized.geometry[0].volumeMm3, 2000);
  assert.deepEqual(resized.stats!.referencedDocuments![0].rebuilt, ['body']);
  // Display arrays are transformed copies and agree with the exact bounds.
  const xs = worldMesh(resized.meshes[0]).vertices.filter((_, i) => i % 3 === 0);
  close(Math.min(...xs), resized.geometry[0].bounds.min[0]); close(Math.max(...xs), resized.geometry[0].bounds.max[0]);
});

test('all visible results expose internal analysis leaves; selected hidden results and empty parts fail transactionally', async t => {
  const engine = await engineFixture(t);
  const source = part([block(), { ...block('other'), params: { origin: [30, 0, 0], size: [10, 20, 5] }, appearance: { material: 'steel', color: '#0000ff' } }]);
  const sub = assembly([instance('pair', source, [0, 10, 0])]);
  const top = assembly([instance('nested', sub, [0, 0, 20])]);
  const evaluated = engine.evaluate(top, [source, sub]);
  assert.equal(evaluated.geometry[0].solidCount, 2); close(evaluated.geometry[0].volumeMm3, 2000); close(evaluated.geometry[0].massG!, 10.55);
  assert.equal(evaluated.meshes.length, 2); assert.equal(evaluated.geometry[0].material, undefined);
  assert.equal(engine.analyze(top, evaluated.geometry).parts, 2);
  const single = instance('only', source); single.params.featureId = 'other';
  close(engine.evaluate(assembly([single]), [source]).geometry[0].volumeMm3, 1000);
  const hidden = part([block(), { id: 'finished', kind: 'fillet', params: { target: 'body', radius: 1, edges: 'vertical' } }]);
  const invalid = instance('hidden', hidden); invalid.params.featureId = 'body';
  assert.throws(() => engine.evaluate(assembly([invalid]), [hidden]), /visible result/);
  const empty = part([]); assert.throws(() => engine.evaluate(assembly([instance('empty', empty)]), [empty]), /visible result/);
  const recovered = engine.evaluate(top, [source, sub]); assert.equal(recovered.stats!.cache.misses, 0);
});

test('assembly graph rejects cycles, missing sources, excessive depth/size and validates shared paths without expansion', () => {
  const a = assembly([]), b = assembly([instance('a', a)]); a.features = [instance('b', b)];
  assert.throws(() => assemblyGraph(a, [b]), /cycle/);
  assert.throws(() => assemblyGraph(b, []), /missing document/);
  const chain = [part()]; for (let i = 0; i < MAX_INSTANCE_DEPTH; i++) chain.push(assembly([instance('child', chain.at(-1)!)]));
  assert.equal(assemblyGraph(chain.at(-1)!, chain.slice(0, -1)).length, 5);
  const tooDeep = assembly([instance('child', chain.at(-1)!)]); assert.throws(() => assemblyGraph(tooDeep, chain), /nest at most 4/);
  // Each level shares the same child 250 times. Validation visits unique documents, not 250^4 paths.
  const shared = [part()]; for (let i = 0; i < 4; i++) shared.push(assembly(Array.from({ length: 250 }, (_, j) => instance(`child_${j}`, shared.at(-1)!))));
  assert.equal(assemblyGraph(shared.at(-1)!, shared).length, 5);
  const many = Array.from({ length: 65 }, () => part());
  assert.throws(() => assemblyGraph(assembly(many.map((d, i) => instance(`p_${i}`, d))), many), /64 documents/);
  const huge = Array.from({ length: 9 }, () => part(Array.from({ length: 250 }, (_, i) => block(`b_${i}`))));
  assert.throws(() => assemblyGraph(assembly(huge.map((d, i) => instance(`p_${i}`, d))), huge), /2000 total features/);
  const valid = instance('i', part()).params;
  for (const params of [{ ...valid, scale: 2 }, { ...valid, rotationAxis: [0, 0, 0] }, { ...valid, angleDegrees: Infinity }, { ...valid, document: 'unknown' }, { ...valid, translation: [100001, 0, 0] }]) assert.equal(instanceParamsSchema.safeParse(params).success, false);
});

test('contact, floating, interference and health use instance IDs and exact geometry', async t => {
  const engine = await engineFixture(t), plate = part([{ ...block('plate', [100, 100, 2]), appearance: { material: 'aluminum' } }]);
  const rod = part([{ id: 'rod', kind: 'cylinder', params: { origin: [0, 0, 0], radius: 1, height: 10 }, appearance: { material: 'steel' } }]);
  const doc = assembly([instance('base', plate), instance('piercing', rod, [20, 20, -5]), instance('touching', rod, [40, 20, 2]), instance('loose', rod, [60, 20, 5])]);
  doc.analysis = { ground: 'base', checks: [{ id: 'mount', a: 'piercing', b: 'base', expect: 'contact' }] };
  const evaluated = engine.evaluate(doc, [plate, rod]), analysis = engine.analyze(doc, evaluated.geometry);
  assert.deepEqual(analysis.contacts.map(c => c.b), ['touching']); assert.deepEqual(analysis.floating.map(f => f.featureId), ['piercing', 'loose']);
  close(analysis.interferences[0].overlapMm3, Math.round(Math.PI * 2 * 1000) / 1000); assert.equal(analysis.checks[0].ok, false);
  const health = modelHealth(doc, { ...evaluated, analysis }, null); assert.equal(health.interferences, 1); assert.equal(health.partsWithoutAppearance, 0); assert.equal(health.ok, false);
  assert.equal(health.references!.length, 2);
});

test('STEP keeps instance names/colors and nested multi-result placement; material scenes use inherited colors', async t => {
  const engine = await engineFixture(t), source = part();
  const one = instance('left_mount', source, [40, 0, 0]), two = instance('right_mount', source, [80, 0, 0]); two.appearance = { color: '#0000ff' };
  const doc = assembly([one, two]), evaluated = engine.evaluate(doc, [source]);
  const step = await engine.export('step', evaluated.visibleFeatureIds, doc), text = new TextDecoder().decode(step.bytes);
  assert.match(text, /left_mount/); assert.match(text, /right_mount/); const colors = (text.match(/(?:COLOUR|COLOR)[^;]+/g) ?? []).join('\n'); assert.match(colors, /(?:,1\.,0\.,0\.\)|'red')/); assert.match(colors, /(?:,0\.,0\.,1\.\)|'blue')/);
  const imported = await importSTEP(new Blob([step.bytes]));
  try { const info = engine.measure('roundtrip', imported.asShape3D()); close(info.volumeMm3, 2000); close(info.bounds.min[0], 40); close(info.bounds.max[0], 90); } finally { imported.delete(); }
  for (const scene of [createWorkbenchScene(evaluated, [], []).scene, createModelScene(evaluated, [], evaluated.visibleFeatureIds, undefined, new Map())]) {
    try { const meshes = scene.children.filter(o => o instanceof THREE.Mesh) as THREE.Mesh[]; assert.equal((meshes[0].material as THREE.MeshPhysicalMaterial).color.getHexString(), 'ff0000'); assert.equal((meshes[1].material as THREE.MeshPhysicalMaterial).color.getHexString(), '0000ff'); } finally { disposeScene(scene); }
  }
  const stl = await engine.export('stl', evaluated.visibleFeatureIds, doc); assert.ok(stl.bytes.byteLength > 84);
  const initReader = createRequire(import.meta.url)('occt-import-js');
  const reader = await initReader();
  const read = reader.ReadStepFile(new Uint8Array(step.bytes), { linearUnit: 'millimeter' });
  assert.equal(read.success, true); assert.equal(read.meshes.length, 2);
  assert.match(JSON.stringify(read.root), /left_mount/); assert.match(JSON.stringify(read.root), /right_mount/);
  assert.deepEqual(read.meshes.map((m: { color: number[] }) => m.color), [[1, 0, 0], [0, 0, 1]]);
  const multicolor = part([block(), { ...block('other'), params: { origin: [30, 0, 0], size: [10, 20, 5] }, appearance: { color: '#0000ff' } }]);
  const sub = assembly([instance('inner', multicolor, [10, 0, 0])]), nested = assembly([instance('outer', sub, [0, 0, 20])]);
  engine.evaluate(nested, [multicolor, sub]);
  const nestedStep = await engine.export('step', ['outer'], nested), nestedRead = reader.ReadStepFile(new Uint8Array(nestedStep.bytes), { linearUnit: 'millimeter' });
  assert.equal(nestedRead.success, true); assert.equal(nestedRead.meshes.length, 2);
  assert.match(JSON.stringify(nestedRead.root), /outer\/inner\/body/);
  assert.deepEqual(nestedRead.meshes.map((m: { color: number[] }) => m.color), [[1, 0, 0], [0, 0, 1]]);
  const positions = nestedRead.meshes.flatMap((m: { attributes: { position: { array: number[] } } }) => m.attributes.position.array);
  const xs = positions.filter((_: number, i: number) => i % 3 === 0), zs = positions.filter((_: number, i: number) => i % 3 === 2);
  close(Math.min(...xs), 10); close(Math.max(...xs), 50); close(Math.min(...zs), 20); close(Math.max(...zs), 25);

});

test('source commits refresh open assemblies without changing their revision; previews do not invalidate them', async t => {
  const source = part(), doc = assembly([instance('mount', source)]), store = new MemoryStore(); await store.put(source); await store.put(doc); await store.setPreference('activeDocumentId', doc.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const before = runtime.getSnapshot();
  const preview = await runtime.preview({ type: 'apply_edits', params: { ...context(source), edits: [{ op: 'update', feature: block('body', [10, 20, 10]) }] } });
  assert.equal(preview.result.status, 'success'); close(runtime.getSnapshot().evaluation.geometry[0].volumeMm3, 1000);
  assert.equal(runtime.getSnapshot().evaluation, before.evaluation);
  const edit = await runtime.execute({ type: 'apply_edits', params: { ...context(source), edits: [{ op: 'update', feature: block('body', [10, 20, 10]) }] } });
  assert.equal(edit.status, 'success'); assert.equal(runtime.getSnapshot().document.documentId, doc.documentId);
  const inspected = await runtime.execute({ type: 'inspect_model', params: {} });
  close(inspected.geometry![0].volumeMm3, 2000); assert.equal(inspected.revision, 0); assert.equal(inspected.instances![0].revision, 4); assert.equal(inspected.health!.referencesChanged, true); assert.equal(inspected.health!.analysis, 'current'); resultSchema.parse(inspected);
  const compact = receipt({ type: 'apply_edits', params: { ...context(doc), edits: [{ op: 'add', feature: instance('extra', source) }] } }, inspected);
  assert.deepEqual(compact.instances, inspected.instances);
  const conflict = await runtime.execute({ type: 'apply_edits', params: { ...context(source), edits: [{ op: 'update', feature: block() }] } }); assert.equal(conflict.error!.code, 'REVISION_CONFLICT');
  const undo = await runtime.execute({ type: 'document_action', params: { documentId: source.documentId, expectedRevision: 4, action: 'undo' } }); assert.equal(undo.status, 'success'); close(runtime.getSnapshot().evaluation.geometry[0].volumeMm3, 1000); assert.equal(runtime.getSnapshot().document.revision, 0);
  const json = await runtime.execute({ type: 'export_model', params: { documentId: doc.documentId, format: 'json', skipAnalysis: true } });
  const saved = JSON.parse(Buffer.from(json.artifact!.base64, 'base64').toString()); assert.equal(saved.features[0].params.document, source.documentId); assert.equal(saved.features.length, 1); assert.equal(saved.documents, undefined);
});

test('referenced-document deletion is blocked; broken result references stay inspectable, preserve geometry, and can be repaired after reload', async t => {
  const source = part(), placed = instance('mount', source); placed.params.featureId = 'body'; const doc = assembly([placed]);
  const store = new MemoryStore(); await store.put(source); await store.put(doc); await store.setPreference('activeDocumentId', doc.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const deletion = await runtime.execute({ type: 'documents', params: { action: 'delete', documentId: source.documentId, expectedRevision: 3 } });
  assert.equal(deletion.error!.code, 'DOCUMENT_IN_USE'); assert.deepEqual((deletion.error!.details as { referencingDocuments: unknown[] }).referencingDocuments, [{ documentId: doc.documentId, name: 'Assembly', featureIds: ['mount'] }]);
  const changed = await runtime.execute({ type: 'apply_edits', params: { ...context(source), edits: [{ op: 'add', feature: { id: 'rounded', kind: 'fillet', params: { target: 'body', radius: 1, edges: 'vertical' } } }] } });
  assert.equal(changed.status, 'success'); assert.ok(changed.warnings.some(w => /could not refresh/.test(w)));
  const stale = runtime.getSnapshot(); close(stale.evaluation.geometry[0].volumeMm3, 1000); assert.equal(stale.health.ok, false); assert.ok(stale.health.referenceError);
  const exported = await runtime.execute({ type: 'export_model', params: { format: 'step', skipAnalysis: true } }); assert.equal(exported.error!.code, 'ASSEMBLY_STALE');
  assert.equal((await runtime.execute({ type: 'inspect_model', params: {} })).status, 'success');
  // No evaluated geometry is persisted. Loading a broken assembly must still allow its JSON to be repaired.
  await runtime.retryInitialization(); assert.equal(runtime.getSnapshot().phase, 'ready'); assert.ok(runtime.getSnapshot().health.referenceError);
  const repaired = await runtime.execute({ type: 'apply_edits', params: { ...context(doc), edits: [{ op: 'update', feature: { ...placed, params: { ...placed.params, featureId: 'rounded' } } }] } }); assert.equal(repaired.status, 'success'); assert.equal(repaired.health!.referenceError, undefined); assert.equal(repaired.instances![0].revision, 4);
  const remove = await runtime.execute({ type: 'apply_edits', params: { documentId: doc.documentId, expectedRevision: 1, edits: [{ op: 'delete', featureIds: ['mount'], cascade: false }] } }); assert.equal(remove.status, 'success');
  assert.equal((await runtime.execute({ type: 'documents', params: { action: 'delete', documentId: source.documentId, expectedRevision: 4 } })).status, 'success');
});

test('cycle edits roll back and depth checks include unopened ancestor assemblies', async t => {
  const leaf = part(), chain = [leaf]; for (let i = 0; i < 4; i++) chain.push(assembly([instance('child', chain.at(-1)!)]));
  const other = part(), store = new MemoryStore(); for (const d of [...chain, other]) await store.put(d); await store.setPreference('activeDocumentId', leaf.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const tooDeep = await runtime.execute({ type: 'apply_edits', params: { ...context(leaf), edits: [{ op: 'add', feature: instance('extra', other) }] } }); assert.equal(tooDeep.error!.code, 'INSTANCE_DEPTH'); assert.equal(store.peek(leaf.documentId)!.revision, 3);
  const cycle = await runtime.execute({ type: 'apply_edits', params: { ...context(leaf), edits: [{ op: 'add', feature: instance('cycle', chain[1]) }] } }); assert.equal(cycle.error!.code, 'INSTANCE_CYCLE'); assert.equal(runtime.getSnapshot().document.revision, 3);
});

test('worker dispatcher includes referenced documents for evaluation/export and keeps geometry after unrelated work', async t => {
  const engine = await engineFixture(t), source = part(), doc = assembly([instance('mount', source, [30, 0, 0])]);
  const session = new GeometryWorkerSession(async () => engine, async () => {});
  const first = await session.handle({ id: 1, type: 'evaluate', document: doc, documents: [source], analyze: {} }); assert.equal(first.ok, true);
  await session.handle({ id: 2, type: 'evaluate', document: part([block('other', [2, 2, 2])]) });
  const exported = await session.handle({ id: 3, type: 'export', document: doc, documents: [source], format: 'step', featureIds: ['mount'] });
  assert.equal(exported.ok, true); if (!exported.ok || !('bytes' in exported.value)) assert.fail('expected STEP bytes');
  const imported = await importSTEP(new Blob([exported.value.bytes])); try { const info = engine.measure('read', imported.asShape3D()); close(info.volumeMm3, 1000); close(info.bounds.min[0], 30); } finally { imported.delete(); }
});

test('numeric and handle moves preserve instance identity and compose rigid placements exactly', async t => {
  const engine = await engineFixture(t), source = part(), placed = instance('mount', source, [20, 0, 0]); placed.params.origin = [1, 2, 0]; placed.params.angleDegrees = 35;
  const doc = assembly([placed]); doc.selectedFeatureIds = ['mount'];
  assert.equal(toolFeature('move', doc, [])!.id, 'mount'); assert.equal(toolFeature('rotate', doc, [])!.kind, 'instance');
  const delta = { translation: [3, 4, 5] as Vector3, rotationAxis: [1, 0, 0] as Vector3, angleDegrees: 40, origin: [5, 2, 1] as Vector3 };
  const moved = moveInstance(placed, delta);
  const expected = engine.evaluate(assembly([placed, { id: 'moved', kind: 'transform', params: { ...delta, target: 'mount', copy: false, scale: 1 } }]), [source]).geometry[1];
  const actual = engine.evaluate(assembly([moved]), [source]).geometry[0];
  for (let i = 0; i < 3; i++) { close(actual.bounds.min[i], expected.bounds.min[i]); close(actual.bounds.max[i], expected.bounds.max[i]); }
});

test('auto-analysis off stays unchecked after a source changes, including transitive references', async t => {
  const source = part(), sub = assembly([instance('child', source)]), top = assembly([instance('nested', sub)]);
  top.analysis = { auto: false };
  const store = new MemoryStore(); for (const d of [source, sub, top]) await store.put(d); await store.setPreference('activeDocumentId', top.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const checked = await runtime.execute({ type: 'analyze_model', params: {} }); assert.equal(checked.health!.analysis, 'current');
  const edit = await runtime.execute({ type: 'apply_edits', params: { ...context(source), edits: [{ op: 'update', feature: block('body', [10, 20, 10]) }] } }); assert.equal(edit.status, 'success');
  const state = runtime.getSnapshot(); assert.equal(state.document.revision, 0); assert.equal(state.health.analysis, 'unchecked'); assert.equal(state.health.checkedRevision, null); assert.equal(state.health.referencesChanged, true); close(state.evaluation.geometry[0].volumeMm3, 2000);
  assert.ok(state.health.references!.some(ref => ref.documentId === source.documentId && ref.revision === 4));
  const output = await runtime.execute({ type: 'export_model', params: { format: 'step' } }); assert.equal(output.status, 'success'); assert.equal(output.health!.analysis, 'current'); assert.equal(output.health!.autoAnalysis, false); assert.equal(output.instances![0].revision, sub.revision);
});

test('expanded instance pieces are bounded before copying an oversized nested part', async t => {
  const engine = await engineFixture(t), source = part();
  const sub = assembly(Array.from({ length: 250 }, (_, i) => instance(`item_${i}`, source)));
  const top = assembly(Array.from({ length: 9 }, (_, i) => instance(`row_${i}`, sub)));
  assert.throws(() => engine.evaluate(top, [source, sub]), /2000 expanded result pieces/);
  assert.equal(engine.cacheStats().entries, 0, 'failure discards staged shapes');
  close(engine.evaluate(source).geometry[0].volumeMm3, 1000);
});

test('GLB retains each instance material and name', async t => {
  const engine = await engineFixture(t), source = part(), one = instance('left', source), two = instance('right', source, [30, 0, 0]); two.appearance = { color: '#0000ff' };
  const doc = assembly([one, two]), evaluated = engine.evaluate(doc, [source]);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  class BlobReader {
    result?: ArrayBuffer; onloadend?: () => void;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = bytes; this.onloadend?.(); }); }
  }
  Object.defineProperty(globalThis, 'FileReader', { value: BlobReader, configurable: true });
  try {
    const { exportGlb } = await import('../src/web/glb-export');
    const glb = await exportGlb(evaluated, doc, evaluated.visibleFeatureIds), view = new DataView(glb.bytes);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb.bytes, 20, view.getUint32(12, true))));
    assert.ok(json.nodes.some((n: { name: string }) => n.name === 'left')); assert.ok(json.nodes.some((n: { name: string }) => n.name === 'right'));
    const colors = json.materials.map((m: { pbrMetallicRoughness: { baseColorFactor: number[] } }) => m.pbrMetallicRoughness.baseColorFactor);
    assert.deepEqual(colors, [[1, 0, 0, 1], [0, 0, 1, 1]]);
  } finally { if (original) Object.defineProperty(globalThis, 'FileReader', original); else Reflect.deleteProperty(globalThis, 'FileReader'); }
});

test('real Node worker transfers referenced documents, loads referenced fonts, and exports the requested assembly', async () => {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(new URL('./cache-worker-fixture.mjs', import.meta.url));
  type Reply = import('../src/cad/types').WorkerReply;
  const request = (message: import('../src/cad/types').WorkerRequest): Promise<Reply> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Node worker request timed out')); }, 20000);
    const cleanup = () => { clearTimeout(timer); worker.off('message', done); worker.off('error', failed); };
    const done = (reply: Reply) => { cleanup(); resolve(reply); }, failed = (error: Error) => { cleanup(); reject(error); };
    worker.once('message', done); worker.once('error', failed); worker.postMessage(message);
  });
  try {
    const source = part([{ id: 'letters', kind: 'text', params: { text: 'VW', plane: 'XY', origin: [0, 0, 0], size: 6, depth: 1 }, appearance: { material: 'steel' } }]);
    const doc = assembly([instance('badge', source, [10, 0, 0])]);
    const first = await request({ id: 1, type: 'evaluate', document: doc, documents: [source] }); assert.equal(first.ok, true); if (!first.ok || !('geometry' in first.value)) assert.fail('expected geometry');
    assert.equal(first.value.instances![0].revision, 3); assert.ok(first.value.geometry[0].volumeMm3 > 0);
    const warm = await request({ id: 2, type: 'evaluate', document: doc, documents: [source] }); if (!warm.ok || !('geometry' in warm.value)) assert.fail('expected warm geometry'); assert.equal(warm.value.stats!.cache.misses, 0);
    const output = await request({ id: 3, type: 'export', document: doc, documents: [source], featureIds: ['badge'], format: 'step' }); if (!output.ok || !('bytes' in output.value)) assert.fail('expected STEP'); assert.match(new TextDecoder().decode(output.value.bytes), /badge/);
  } finally { await worker.terminate(); }
});


test('storage rejects a cyclic assembly and still permits editing a healthy part', async t => {
  const healthy = part(), bad = assembly([]); bad.features = [instance('self', bad)];
  const store = new MemoryStore(); await store.put(healthy); await assert.rejects(store.put(bad), /cycle/); await store.setPreference('activeDocumentId', healthy.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const edited = await runtime.execute({ type: 'apply_edits', params: { ...context(healthy), edits: [{ op: 'update', feature: block('body', [10, 20, 10]) }] } });
  assert.equal(edited.status, 'success'); close(edited.geometry![0].volumeMm3, 2000);
});


test('renaming a source updates instance names without claiming that its revision changed', async t => {
  const source = part(), doc = assembly([instance('mount', source)]), store = new MemoryStore();
  await store.put(source); await store.put(doc); await store.setPreference('activeDocumentId', doc.documentId);
  const { runtime } = await runtimeFixture(t, store);
  const renamed = await runtime.execute({ type: 'documents', params: { action: 'rename', documentId: source.documentId, name: 'Renamed bracket', expectedStorageVersion: (await store.read(source.documentId))!.version } });
  assert.equal(renamed.status, 'success'); assert.equal(renamed.revision, 3);
  const inspected = await runtime.execute({ type: 'inspect_model', params: {} });
  assert.equal(inspected.instances![0].name, 'Renamed bracket'); assert.equal(inspected.instances![0].revision, 3); assert.equal(inspected.revision, 0); assert.equal(inspected.health!.referencesChanged, undefined);
});

test('inactive assemblies refresh once on demand, use latest source revisions and carry render provenance', async t => {
  const source = part(), doc = assembly([instance('mount', source)]), active = part([]);
  const store = new MemoryStore();
  for (const document of [source, doc, active]) await store.put(document);
  await store.setPreference('activeDocumentId', active.documentId);
  const { runtime, engine } = await runtimeFixture(t, store);
  await runtime.execute({ type: 'inspect_model', params: { documentId: doc.documentId } });
  const evaluate = t.mock.method(engine, 'evaluate');
  for (let revision = source.revision; revision < source.revision + 2; revision++) {
    const edit = await runtime.execute({ type: 'apply_edits', params: { documentId: source.documentId, expectedRevision: revision, edits: [{ op: 'update', feature: block('body', [10, 20, 10 + revision]) }] } });
    assert.equal(edit.status, 'success');
  }
  assert.equal(evaluate.mock.calls.filter(call => call.arguments[0].documentId === doc.documentId).length, 0, 'Source edits do not evaluate an inactive assembly.');
  runtime.setRenderer(async (evaluation, _command, document) => {
    assert.equal(evaluation.instances![0].revision, source.revision + 2);
    assert.equal(document.revision, doc.revision);
    return { mimeType: 'image/png', base64: 'fixture', width: 768, height: 800, tiles: [{ label: 'TOP', projection: 'orthographic' as const, eye: [0, -10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], widthMm: 10, heightMm: 10, mmPerPixel: 0.1 }] };
  });
  const rendered = await runtime.execute({ type: 'render_views', params: { documentId: doc.documentId } });
  assert.equal(rendered.status, 'success');
  assert.equal(evaluate.mock.calls.filter(call => call.arguments[0].documentId === doc.documentId).length, 1);
  assert.deepEqual(rendered.provenance, { documentId: doc.documentId, revision: doc.revision, sources: [{ documentId: source.documentId, revision: source.revision + 2 }] });
  assert.equal(rendered.health!.analysis, 'current');
  assert.ok(rendered.timings!.geometryEvaluationMs > 0);
  assert.ok(rendered.timings!.renderExportMs >= 0);
  resultSchema.parse(rendered);
  const compact = receipt({ type: 'render_views', params: { documentId: doc.documentId } }, rendered);
  assert.deepEqual(compact.provenance, rendered.provenance);
});
