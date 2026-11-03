import { featureCommand, toolFeature, tools } from '../src/web/modeling';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { analysisStatus } from '../src/cad/health';
import { CadRuntime } from '../src/cad/runtime';
import { GeometryWorker } from '../src/cad/worker-client';
import { GeometryEngine, loadTextFont } from '../src/cad/geometry';
import { buildDemo, context } from '../src/cad/demo';
import { emptyDocument } from '../src/cad/document';
import { modelDocument, MemoryStore } from '../src/cad/store';
import { loadDocumentFile } from '../src/web/load-document';
import type { CadDocument, CadResult } from '../src/shared/protocol';

const kernel = readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  .then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }));

// Storage is the in-memory adapter; geometry uses real OCCT in Node through the worker interface.
// These tests do not operate a browser or IndexedDB.
async function fixture(t: TestContext, store = new MemoryStore()): Promise<{ runtime: CadRuntime; store: MemoryStore; saved: () => unknown }> {
  setOC(await kernel);
  const engine = new GeometryEngine(await kernel);
  t.mock.method(GeometryWorker.prototype, 'initialize', async (document: CadDocument) => engine.evaluate(document));
  t.mock.method(GeometryWorker.prototype, 'evaluate', async (document: CadDocument, _timeout?: number, analyze?: { featureIds?: string[] }, documents: CadDocument[] = []) => {
    const evaluation = engine.evaluate(document, documents);
    return analyze ? { ...evaluation, analysis: engine.analyze(document, evaluation.geometry, analyze.featureIds) } : evaluation;
  });
  t.after(() => { engine.dispose(); });
  const runtime = new CadRuntime(store);
  await runtime.initialize();
  assert.equal(runtime.getSnapshot().phase, 'ready');
  return { runtime, store, saved: () => store.peek(runtime.getSnapshot().document.documentId) };
}

test('demo preserves an agent edit queued before its reset', async t => {
  const { runtime } = await fixture(t);
  const edit = runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'add', feature: { id: 'agent_box', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } } }] } });
  const demo = buildDemo(runtime);
  assert.equal((await edit).status, 'success');
  await assert.rejects(demo, /Expected revision 0, but the current revision is 1/);
  assert.deepEqual(runtime.getSnapshot().document.features.map(f => f.id), ['agent_box']);
  assert.equal(runtime.getSnapshot().document.revision, 1);
});

test('demo is one atomic edit: one revision, one undo step, visible in history', async t => {
  const { runtime } = await fixture(t);
  assert.equal((await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'add', feature: { id: 'mine', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } } }] } })).status, 'success');
  const result = await buildDemo(runtime);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.deleted, ['mine']);
  assert.deepEqual(runtime.getSnapshot().document.selectedFeatureIds, ['finished_plate']);
  assert.deepEqual(runtime.getSnapshot().evaluation.visibleFeatureIds, ['finished_plate']);
  assert.equal((await runtime.execute({ type: 'document_action', params: { ...context(runtime.getSnapshot().document), action: 'undo' } })).status, 'success');
  assert.deepEqual(runtime.getSnapshot().document.features.map(f => f.id), ['mine']);
});

test('apply_edits dry run returns exact candidate geometry without committing; failures name the edit', async t => {
  const { runtime, saved } = await fixture(t);
  await buildDemo(runtime);
  const before = structuredClone(runtime.getSnapshot().document);
  const beforeSaved = saved();
  const lastBefore = runtime.getSnapshot().lastResult;
  const plate = before.features.find(f => f.id === 'plate')!;
  // A direct update replaces the whole feature, so drop the binding that would otherwise re-resolve size.2.
  const thick = { ...plate, params: { ...plate.params, size: [100, 60, 8] }, bindings: { 'size.0': 'width', 'size.1': 'depth' } } as typeof plate;
  const preview = await runtime.preview({ type: 'apply_edits', params: { ...context(before), edits: [{ op: 'update', feature: thick }] } });
  assert.equal(preview.result.status, 'success');
  assert.equal(preview.result.dryRun, true);
  assert.equal(preview.result.revision, before.revision);
  assert.ok(Math.abs(preview.result.geometry![0].bounds.size[2] - 8) < 1e-6);
  assert.ok(preview.evaluation!.meshes.some(mesh => mesh.featureId === 'finished_plate'));
  assert.deepEqual(runtime.getSnapshot().document, before);
  assert.deepEqual(saved(), beforeSaved);
  assert.equal(runtime.getSnapshot().lastResult, lastBefore);
  const failed = await runtime.execute({ type: 'apply_edits', params: { ...context(before), edits: [
    { op: 'update', feature: thick },
    { op: 'add', feature: { id: 'huge_round', kind: 'fillet', params: { target: 'plate', radius: 50, edges: 'vertical' } } },
  ] } });
  assert.equal(failed.status, 'error');
  assert.deepEqual(runtime.getSnapshot().document, before);
  const missing = await runtime.execute({ type: 'apply_edits', params: { ...context(before), edits: [{ op: 'update', feature: thick }, { op: 'delete', featureIds: ['nope'], cascade: false }] } });
  assert.match(missing.error!.message, /Edit 2 of 2 \(delete\)/);
  assert.equal((missing.error!.details as { editIndex: number }).editIndex, 1);
});

test('a delayed JSON read preserves agent edits made while the file was loading', async t => {
  const { runtime, saved } = await fixture(t);
  let finishRead!: (text: string) => void;
  const load = loadDocumentFile(runtime, { size: 200, text: () => new Promise(resolve => { finishRead = resolve; }) });
  const edit = await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'add', feature: { id: 'agent_box', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } } }] } });
  assert.equal(edit.status, 'success');
  const before = structuredClone(runtime.getSnapshot().document);
  finishRead(JSON.stringify(emptyDocument()));
  assert.equal((await load).error?.code, 'REVISION_CONFLICT');
  assert.deepEqual(runtime.getSnapshot().document, before);
  assert.deepEqual(saved(), before);
});

test('runtime failed edits preserve committed geometry, history and save; selection/reload retain revisions', async t => {
  const { runtime, store, saved } = await fixture(t);
  await buildDemo(runtime);
  const area = 100 * 60 - (4 - Math.PI) * 3 ** 2 - 4 * Math.PI * 2.5 ** 2;
  const check = (thickness: number) => {
    const state = runtime.getSnapshot();
    const solid = state.evaluation.geometry.find(g => g.featureId === 'finished_plate')!;
    assert.ok(Math.abs(solid.volumeMm3 - area * thickness) < 1e-5);
    [100, 60, thickness].forEach((value, i) => assert.ok(Math.abs(solid.bounds.size[i] - value) < 1e-5));
  };
  const thick = structuredClone(runtime.getSnapshot().document.features[0]);
  assert.equal(thick.kind, 'box');
  if (thick.kind === 'box') thick.params.size[2] = 8;
  const conflict = await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'update', feature: thick }] } });
  assert.equal(conflict.error?.code, 'BINDING_CONFLICT', 'A bound value cannot be overwritten while its binding stays.');
  delete thick.bindings!['size.2'];
  assert.equal((await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'update', feature: thick }] } })).status, 'success');
  check(8);
  const before = runtime.getSnapshot();
  const beforeDocument = structuredClone(before.document), beforeSaved = saved();
  const invalid = structuredClone(before.document.features.find(f => f.id === 'rounded_plate')!);
  assert.equal(invalid.kind, 'fillet');
  if (invalid.kind === 'fillet') invalid.params.radius = 500;
  delete invalid.bindings;
  const failure = await runtime.execute({ type: 'apply_edits', params: { ...context(before.document), edits: [{ op: 'update', feature: invalid }] } });
  assert.equal(failure.error?.code, 'GEOMETRY_FAILED');
  assert.deepEqual(runtime.getSnapshot().document, beforeDocument);
  assert.equal(runtime.getSnapshot().evaluation, before.evaluation);
  assert.equal(runtime.getSnapshot().canUndo, before.canUndo);
  assert.equal(runtime.getSnapshot().canRedo, before.canRedo);
  assert.deepEqual(saved(), beforeSaved);
  const action = (name: 'undo' | 'redo') => runtime.execute({ type: 'document_action', params: { ...context(runtime.getSnapshot().document), action: name } });
  assert.equal((await action('undo')).status, 'success'); check(5);
  const stale = context(runtime.getSnapshot().document);
  await runtime.select(['plate']);
  // Selection is shared attention: it never makes another operator's context stale.
  assert.equal(runtime.getSnapshot().document.revision, stale.expectedRevision);
  stale.expectedRevision -= 1;
  assert.equal(runtime.getSnapshot().canRedo, true);
  const inspection = await runtime.execute({ type: 'inspect_model', params: {} });
  assert.deepEqual(inspection.document?.selectedFeatureIds, ['plate']);
  assert.equal((await runtime.execute({ type: 'apply_edits', params: { ...stale, edits: [{ op: 'update', feature: thick }] } })).error?.code, 'REVISION_CONFLICT');
  assert.equal((await action('redo')).status, 'success'); check(8);
  const imported = { ...structuredClone(runtime.getSnapshot().document), documentId: emptyDocument().documentId, revision: 500, selectedFeatureIds: ['plate'] };
  const target = runtime.getSnapshot().document;
  assert.equal((await runtime.execute({ type: 'document_action', params: { ...context(target), action: 'load', document: imported } })).status, 'success');
  assert.equal(runtime.getSnapshot().document.documentId, target.documentId);
  assert.equal(runtime.getSnapshot().document.revision, target.revision + 1);
  check(8);
  assert.deepEqual(saved(), modelDocument(runtime.getSnapshot().document));
  const reloaded = new CadRuntime(store);
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().phase, 'ready');
  assert.deepEqual(reloaded.getSnapshot().document, runtime.getSnapshot().document);
  assert.deepEqual(reloaded.getSnapshot().evaluation.geometry, runtime.getSnapshot().evaluation.geometry);
  assert.equal(reloaded.getSnapshot().canUndo, true);
  assert.equal(reloaded.getSnapshot().canRedo, false);
});

test('manual/MCP selection, linked copies and cascade deletion share transactional history', async t => {
  const { runtime } = await fixture(t);
  const exec = (type: string, params: Record<string, unknown>) => runtime.execute({ type, params: { ...context(runtime.getSnapshot().document), ...params } });
  assert.equal((await exec('apply_edits', { edits: [{ op: 'add', feature: { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [20, 30, 5] } } }] })).status, 'success');
  assert.equal((await exec('select_features', { featureIds: ['base'] })).status, 'success');
  assert.deepEqual(runtime.getSnapshot().document.selectedFeatureIds, ['base']);
  assert.equal((await exec('apply_edits', { edits: [{ op: 'add', feature: { id: 'copy', kind: 'transform', params: { target: 'base', translation: [40, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0], scale: 1, copy: true } } }] })).status, 'success');
  const before = structuredClone(runtime.getSnapshot());
  assert.equal((await exec('apply_edits', { edits: [{ op: 'delete', featureIds: ['base'], cascade: false }] })).error?.code, 'FEATURE_HAS_DEPENDENTS');
  assert.deepEqual(runtime.getSnapshot().document, before.document);
  assert.deepEqual(runtime.getSnapshot().evaluation, before.evaluation);
  assert.equal((await exec('apply_edits', { edits: [{ op: 'add', feature: { id: 'miss', kind: 'drill_holes', params: { target: 'base', axis: 'Z', diameter: 2, centers: [[500, 500, 0]] } } }] })).error?.code, 'HOLE_MISSES_SOLID');
  assert.deepEqual(runtime.getSnapshot().document, before.document);
  const deleted = await exec('apply_edits', { edits: [{ op: 'delete', featureIds: ['base'], cascade: true }] });
  assert.deepEqual(deleted.deleted, ['base', 'copy']);
  assert.equal(runtime.getSnapshot().document.features.length, 0);
  assert.deepEqual(runtime.getSnapshot().document.selectedFeatureIds, []);
  assert.equal((await exec('document_action', { action: 'undo' })).status, 'success');
  assert.deepEqual(runtime.getSnapshot().document.features, before.document.features);
  assert.deepEqual(runtime.getSnapshot().document.selectedFeatureIds, ['base']);
  assert.equal((await exec('document_action', { action: 'redo' })).status, 'success');
  assert.equal(runtime.getSnapshot().document.features.length, 0);
});

test('one parameter change resizes a whole parametric part, exactly and atomically', async t => {
  const { runtime } = await fixture(t);
  await buildDemo(runtime);
  const before = structuredClone(runtime.getSnapshot().document);
  const area = (w: number, d: number, r: number, hole: number) => w * d - (4 - Math.PI) * r * r - 4 * Math.PI * (hole / 2) ** 2;
  const volume = () => runtime.getSnapshot().evaluation.geometry.find(g => g.featureId === 'finished_plate')!.volumeMm3;
  assert.ok(Math.abs(volume() - area(100, 60, 3, 5) * 5) < 1e-4);
  const result = await runtime.execute({ type: 'apply_edits', params: { ...context(before), edits: [{ op: 'set_parameter', name: 'thickness', value: 12 }, { op: 'set_parameter', name: 'width', value: 140 }] } });
  assert.equal(result.status, 'success', result.error?.message);
  assert.equal(result.revision, before.revision + 1);
  // Holes stay through because cutters are bound to thickness + 20; right-hand holes follow width.
  assert.ok(Math.abs(volume() - area(140, 60, 3, 5) * 12) < 1e-4, String(volume()));
  assert.deepEqual(result.updated.sort(), ['hole_1', 'hole_2', 'hole_3', 'hole_4', 'plate'].sort());
  const bad = await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'set_parameter', name: 'thickness', value: -1 }] } });
  assert.equal(bad.error?.code, 'BINDING_OUT_OF_RANGE');
  assert.match(bad.error!.message, /plate.*size\.2/);
  const inUse = await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'delete_parameter', name: 'hole_d' }] } });
  assert.equal(inUse.error?.code, 'PARAMETER_IN_USE');
  assert.equal(runtime.getSnapshot().document.parameters!.find(p => p.name === 'thickness')!.value, 12);
  assert.equal((await runtime.execute({ type: 'document_action', params: { ...context(runtime.getSnapshot().document), action: 'undo' } })).status, 'success');
  assert.deepEqual(runtime.getSnapshot().document.parameters, before.parameters);
  assert.ok(Math.abs(volume() - area(100, 60, 3, 5) * 5) < 1e-4);
});

test('analysis runs by default, can be skipped or forced per call, turned off per document, and run on demand', async t => {
  const { runtime } = await fixture(t);
  const ctx = () => context(runtime.getSnapshot().document);
  const add = (id: string, x: number) => ({ op: 'add' as const, feature: { id, kind: 'box' as const, params: { origin: [x, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number] } } });
  let result = await runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits: [add('base', 0), add('loose', 30)] } });
  assert.deepEqual(result.analysis?.floating.map(f => f.featureId), ['loose']);
  assert.ok(result.warnings.some(w => /loose 20 mm from 'base'/.test(w)), result.warnings.join(' | '));
  assert.equal(runtime.getSnapshot().evaluation.analysis?.floating.length, 1);
  result = await runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits: [add('skip', 60)], analyze: false } });
  assert.equal(result.analysis, undefined);
  result = await runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits: [{ op: 'set_analysis', auto: false }] } });
  assert.equal(result.analysis, undefined);
  result = await runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits: [add('later', 90)] } });
  assert.equal(result.analysis, undefined, 'auto off: no analysis unless asked');
  result = await runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits: [add('forced', 120)], analyze: true } });
  assert.equal(result.analysis?.floating.length, 4);
  const revision = runtime.getSnapshot().document.revision;
  result = await runtime.execute({ type: 'analyze_model', params: { featureIds: ['base', 'loose'] } });
  assert.equal(result.status, 'success'); assert.equal(result.analysis?.parts, 2);
  assert.equal(runtime.getSnapshot().document.revision, revision, 'analysis never changes the document');
});

test('a workspace holds several documents: agents edit any of them by id while the human keeps their view', async t => {
  const store = new MemoryStore();
  const { runtime } = await fixture(t, store);
  const first = runtime.getSnapshot().document;
  const created = await runtime.execute({ type: 'documents', params: { action: 'create', name: 'Gearbox' } });
  assert.equal(created.status, 'success', created.error?.message);
  const gearbox = created.documentId!;
  assert.notEqual(gearbox, first.documentId);
  assert.equal(runtime.getSnapshot().document.documentId, first.documentId, 'creating does not change what the human sees');
  // An agent builds in the gearbox document while the human's view stays on the first part.
  const edit = await runtime.execute({ type: 'apply_edits', params: { documentId: gearbox, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'housing', kind: 'box', params: { origin: [0, 0, 0], size: [40, 30, 20] } } }] } });
  assert.equal(edit.status, 'success', edit.error?.message);
  assert.equal(edit.documentId, gearbox); assert.equal(edit.revision, 1);
  assert.equal(runtime.getSnapshot().document.documentId, first.documentId);
  assert.equal(runtime.getSnapshot().document.features.length, 0);
  // A reload keeps the human's part even though the agent's part was saved more recently.
  const meanwhile = new CadRuntime(store);
  await meanwhile.initialize();
  assert.equal(meanwhile.getSnapshot().document.documentId, first.documentId);
  // Reads can target it too, and the listing reflects both documents.
  const inspected = await runtime.execute({ type: 'inspect_model', params: { documentId: gearbox } });
  assert.deepEqual(inspected.document?.features.map(f => f.id), ['housing']);
  assert.deepEqual(inspected.documents?.map(d => [d.name, d.active]).sort(), [['Gearbox', false], ['Untitled part', true]]);
  // Undo history belongs to each document.
  assert.equal((await runtime.execute({ type: 'document_action', params: { documentId: first.documentId, expectedRevision: first.revision, action: 'undo' } })).error?.code, 'HISTORY_EMPTY');
  assert.equal((await runtime.execute({ type: 'document_action', params: { documentId: gearbox, expectedRevision: 1, action: 'undo' } })).status, 'success');
  assert.equal((await runtime.execute({ type: 'document_action', params: { documentId: gearbox, expectedRevision: 2, action: 'redo' } })).status, 'success');
  // Opening switches the human's view; renaming keeps the revision.
  assert.equal((await runtime.openDocument(gearbox)).status, 'success');
  assert.equal(runtime.getSnapshot().document.documentId, gearbox);
  assert.deepEqual(runtime.getSnapshot().document.features.map(f => f.id), ['housing']);
  const renamed = await runtime.execute({ type: 'documents', params: { action: 'rename', documentId: gearbox, name: 'Gearbox housing', expectedStorageVersion: (await store.read(gearbox))!.version } });
  assert.equal(renamed.revision, 3);
  assert.equal(runtime.getSnapshot().document.name, 'Gearbox housing');
  // Deletion needs the current revision and never removes the last document.
  assert.equal((await runtime.execute({ type: 'documents', params: { action: 'delete', documentId: first.documentId, expectedRevision: 99 } })).error?.code, 'REVISION_CONFLICT');
  assert.equal((await runtime.execute({ type: 'documents', params: { action: 'delete', documentId: first.documentId, expectedRevision: first.revision } })).status, 'success');
  assert.equal((await runtime.execute({ type: 'documents', params: { action: 'delete', documentId: gearbox, expectedRevision: 3 } })).error?.code, 'LAST_DOCUMENT');
  assert.equal((await runtime.execute({ type: 'inspect_model', params: { documentId: first.documentId } })).error?.code, 'DOCUMENT_NOT_FOUND');
  // The workspace, and which document was open, survive a reload from the same store.
  const reloaded = new CadRuntime(store);
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().document.documentId, gearbox);
  assert.deepEqual(reloaded.getSnapshot().documents.map(d => d.name), ['Gearbox housing']);
});

test('health stays honest across skipped edits, subset analysis, output, dry runs, undo and reload', async t => {
  const { runtime, store } = await fixture(t);
  const ctx = () => context(runtime.getSnapshot().document);
  const edit = (edits: unknown[], extra = {}) => runtime.execute({ type: 'apply_edits', params: { ...ctx(), edits, ...extra } });
  const part = { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] }, appearance: { material: 'steel' } };
  let result = await edit([{ op: 'add', feature: part }]);
  assert.equal(result.health?.ok, true);
  assert.equal(result.health?.checkedRevision, 1);
  await edit([{ op: 'set_analysis', auto: false }]);
  result = await edit([{ op: 'add', feature: { ...part, id: 'loose', appearance: undefined, params: { origin: [30, 0, 0], size: [5, 5, 5] } } }]);
  assert.equal(result.health?.checkedRevision, 1);
  assert.equal(result.health?.uncheckedChanges, 2);
  assert.equal(result.health?.floating, null);
  assert.equal(result.health?.partsWithoutAppearance, 1);
  assert.equal(result.health?.ok, false);
  assert.match(result.nextSteps!.join(' '), /Analysis is off.*Not checked since r1 \(2 changes\)/);
  let renderHealth: CadResult['health'];
  runtime.setRenderer(async (_evaluation, _command, _document, health) => {
    renderHealth = health;
    return { mimeType: 'image/png', base64: 'test-renderer', width: 128, height: 128, tiles: [{ label: 'FRONT', projection: 'orthographic' as const, eye: [0, -10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], widthMm: 10, heightMm: 10, mmPerPixel: 0.1 }] };
  });
  result = await runtime.execute({ type: 'render_views', params: { skipAnalysis: true, appearance: 'issues' } });
  assert.equal(result.status, 'success', result.error?.message);
  assert.deepEqual(renderHealth, result.health, 'review images receive the same session health as the receipt');
  assert.equal(analysisStatus(renderHealth!), 'Not checked since r1 (2 changes)');
  result = await runtime.execute({ type: 'analyze_model', params: { featureIds: ['base'] } });
  assert.equal(result.analysis?.scope, 'subset');
  assert.equal(result.health?.checkedRevision, 1, 'subset cannot certify the document');
  result = await runtime.execute({ type: 'export_model', params: { format: 'json', skipAnalysis: true } });
  assert.ok(result.artifact);
  assert.equal(result.health?.analysis, 'unchecked');
  result = await runtime.execute({ type: 'export_model', params: { format: 'json' } });
  assert.ok(result.artifact);
  assert.equal(result.health?.analysis, 'current');
  assert.equal(result.health?.checkedRevision, 3);
  assert.equal(result.health?.floating, 1);
  assert.equal(runtime.getSnapshot().document.analysis?.auto, false, 'output does not change the toggle');
  result = await edit([{ op: 'set_parameter', name: 'width', value: 10 }]);
  assert.equal(result.health?.uncheckedChanges, 1);
  let rendered = 0;
  runtime.setRenderer(async evaluation => {
    assert.equal(evaluation.analysis?.revision, 4);
    rendered++;
    return { mimeType: 'image/png', base64: 'test-renderer', width: 128, height: 128, tiles: [{ label: 'FRONT', projection: 'orthographic' as const, eye: [0, -10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], widthMm: 10, heightMm: 10, mmPerPixel: 0.1 }] };
  });
  result = await runtime.execute({ type: 'render_views', params: { appearance: 'issues' } });
  assert.equal(result.status, 'success', result.error?.message);
  assert.equal(rendered, 1);
  assert.equal(result.health?.checkedRevision, 4);
  const before = runtime.getSnapshot();
  result = await edit([{ op: 'set_parameter', name: 'width', value: 12 }], { dryRun: true, analyze: true });
  assert.equal(result.dryRun, true);
  assert.equal(runtime.getSnapshot().health, before.health, 'dry runs do not publish candidate health');
  result = await edit([{ op: 'delete', featureIds: ['missing'], cascade: false }]);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.health, before.health, 'failed edit reports committed health');
  result = await runtime.execute({ type: 'document_action', params: { ...ctx(), action: 'undo', analyze: false } });
  assert.equal(result.health?.uncheckedChanges, 1);
  assert.equal(result.health?.analysis, 'unchecked');
  const reloaded = new CadRuntime(store);
  await reloaded.initialize();
  assert.equal(reloaded.getSnapshot().health.checkedRevision, null, 'a reload must recompute analysis rather than trust old findings');
  assert.equal(reloaded.getSnapshot().health.ok, false);
});

test('incomplete output analysis refuses output until explicitly bypassed', async t => {
  const { runtime } = await fixture(t);
  await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'add', feature: { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [5, 5, 5] } } }] } });
  await runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'set_analysis', auto: false }] } });
  const actual = GeometryWorker.prototype.evaluate;
  t.mock.method(GeometryWorker.prototype, 'evaluate', async function (this: GeometryWorker, ...args: Parameters<typeof actual>) {
    const evaluation = await actual.apply(this, args);
    if (evaluation.analysis) evaluation.analysis.skipped = 'Test budget exhausted';
    return evaluation;
  });
  const failed = await runtime.execute({ type: 'export_model', params: { format: 'json' } });
  assert.equal(failed.error?.code, 'ANALYSIS_INCOMPLETE');
  assert.equal(failed.artifact, undefined);
  assert.equal(failed.health?.analysis, 'incomplete');
  assert.equal(failed.health?.checkedRevision, 1);
  const skipped = await runtime.execute({ type: 'export_model', params: { format: 'json', skipAnalysis: true } });
  assert.equal(skipped.status, 'success');
  assert.ok(skipped.artifact);
  assert.equal(skipped.health?.ok, false);
});

test('a reloaded document with automatic analysis on is checked on load', async t => {
  const store = new MemoryStore();
  const { runtime } = await fixture(t, store);
  const doc = runtime.getSnapshot().document;
  const edit = await runtime.execute({ type: 'apply_edits', params: { ...context(doc), analyze: false, edits: [{ op: 'add', feature: { id: 'b', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] }, appearance: { material: 'steel' } } }] } });
  assert.equal(edit.health?.analysis, 'unchecked');
  const reloaded = new CadRuntime(store);
  await reloaded.initialize();
  const inspected = await reloaded.execute({ type: 'inspect_model', params: {} });
  assert.equal(inspected.health?.analysis, 'current');
  assert.equal(inspected.health?.checkedRevision, inspected.revision);
});


test('every manual tool draft uses apply_edits and previews exact geometry without committing', async t => {
  const { runtime, saved } = await fixture(t);
  const font = await readFile(new URL('../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
  await loadTextFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  const source = await runtime.execute({ type: 'documents', params: { action: 'create', name: 'Preview source' } });
  await runtime.execute({ type: 'apply_edits', params: {
    documentId: source.documentId!, expectedRevision: 0, edits: [{ op: 'add', feature: {
      id: 'source_body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 5] },
    } }],
  } });
  assert.equal((await runtime.execute({ type: 'apply_edits', params: {
    ...context(runtime.getSnapshot().document), edits: [
      { op: 'add', feature: { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [40, 30, 5] } } },
      { op: 'add', feature: { id: 'tool', kind: 'box', params: { origin: [10, 10, 0], size: [10, 10, 5] } } },
    ],
  } })).status, 'success');
  // Construction tasks require an inspected boundary/face and sheets before a valid preview.
  // Their actual selections, preview and rollback are covered by foundations shaping command tests.
  for (const spec of tools.filter(s=>s.tool!=='fill'&&s.tool!=='join')) {
    const ids = spec.needs === 'two' ? ['base', 'tool'] : spec.needs === 'none' ? [] : ['base'];
    await runtime.select(ids);
    const before = structuredClone(runtime.getSnapshot().document);
    const beforeSaved = structuredClone(saved());
    const lastResult = runtime.getSnapshot().lastResult;
    const feature = toolFeature(spec.tool, before, runtime.getSnapshot().evaluation.geometry);
    if (feature?.kind === 'instance') feature.params.document = source.documentId!;
    if (feature) feature.label = 'Preview draft';
    const command = feature ? featureCommand(before, feature) : {
      type: 'apply_edits' as const, params: { ...context(before), edits: [{
        op: 'delete' as const, featureIds: ids, cascade: true,
      }] },
    };
    assert.equal(command.type, 'apply_edits', spec.tool);
    if (feature) assert.deepEqual(command.params.edits, [{ op: 'add', feature }]);
    const preview = await runtime.preview(command);
    assert.equal(preview.result.status, 'success', `${spec.tool}: ${preview.result.error?.message}`);
    assert.equal(preview.result.dryRun, true, spec.tool);
    assert.ok(preview.result.geometry!.every(info => info.valid), spec.tool);
    assert.deepEqual(runtime.getSnapshot().document, before, spec.tool);
    assert.deepEqual(saved(), beforeSaved, spec.tool);
    assert.equal(runtime.getSnapshot().lastResult, lastResult, spec.tool);
  }
  const doc = runtime.getSnapshot().document;
  const feature = { ...doc.features[0], label: 'Edited body', appearance: { material: 'steel' as const }, bindings: { 'size.2': '5' } };
  const update = featureCommand(doc, feature, true);
  assert.deepEqual(update.params.edits, [{ op: 'update', feature }]);
  assert.equal((await runtime.preview(update)).result.status, 'success');
});

test('creation request IDs recover one document across restarts, later edits and duplicate retries', async t => {
  const { runtime, store } = await fixture(t);
  const requestId = crypto.randomUUID();
  const command = { type: 'documents', params: { action: 'create', name: 'Retry part', requestId } };
  const created = await runtime.execute(command);
  assert.equal(created.status, 'success'); assert.equal(created.createdDocumentId, requestId); assert.equal(created.requestId, requestId);
  const documentId = created.documentId!;
  const edited = await runtime.execute({ type: 'apply_edits', params: { documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 20, 5] } } }] } });
  assert.equal(edited.status, 'success');
  await runtime.execute({ type: 'documents', params: { action: 'rename', documentId, name: 'Renamed after create', expectedStorageVersion: (await store.read(documentId))!.version } });
  const reloaded = new CadRuntime(store); await reloaded.initialize();
  const recovered = await reloaded.execute(command);
  assert.equal(recovered.documentId, documentId); assert.equal(recovered.revision, 1);
  assert.equal((await store.list()).length, 2);
  const listed = await reloaded.execute({ type: 'documents', params: { action: 'list', requestId } });
  assert.deepEqual(listed.documents?.map(d => d.name), ['Renamed after create']);
  assert.equal((await reloaded.execute({ ...command, params: { ...command.params, name: 'Different request' } })).error?.code, 'REQUEST_ID_CONFLICT');
  const duplicateId = crypto.randomUUID();
  const duplicate = { type: 'documents', params: { action: 'duplicate', documentId, name: 'Copy', requestId: duplicateId } };
  assert.equal((await reloaded.execute(duplicate)).documentId, duplicateId);
  assert.equal((await reloaded.execute(duplicate)).documentId, duplicateId);
  assert.equal((await store.list()).length, 3);
  const copy = await reloaded.execute({ type: 'inspect_model', params: { documentId: duplicateId } });
  assert.equal(copy.revision, 0); assert.equal(copy.document?.features.length, 1);
  assert.equal(copy.document?.creation?.requestId, duplicateId);
  assert.equal((await reloaded.execute({ type: 'documents', params: { action: 'list', name: 'Copy' } })).documents?.[0].documentId, duplicateId);
  const invalid = await reloaded.execute({ type: 'documents', params: { action: 'create', documentId, name: 'Ignored target' } });
  assert.equal(invalid.status, 'error'); assert.match(invalid.error!.message, /does not accept documentId/);
  assert.equal((await store.list()).length, 3);
});

test('receipts separate queued time from new work and never reuse prior evaluation timings on reads', async t => {
  const { runtime } = await fixture(t);
  const first = runtime.execute({ type: 'apply_edits', params: { ...context(runtime.getSnapshot().document), edits: [{ op: 'add', feature: { id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 20, 5] } } }] } });
  const second = runtime.execute({ type: 'inspect_model', params: {} });
  const [edited, inspected] = await Promise.all([first, second]);
  assert.equal(edited.status, 'success'); assert.ok(edited.timings!.geometryEvaluationMs > 0);
  assert.ok(inspected.timings!.queueWaitMs > 0);
  assert.equal(inspected.timings!.geometryEvaluationMs, 0); assert.equal(inspected.timings!.analysisMs, 0);
  for (const result of [edited, inspected]) {
    const sum = Object.values(result.timings!).reduce((total, ms) => total + ms, 0);
    assert.ok(Math.abs(sum - result.durationMs!) < 0.5);
  }
});
