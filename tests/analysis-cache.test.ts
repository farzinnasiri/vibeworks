import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { GeometryWorkerSession } from '../src/cad/worker-session';
import { AnalysisCache } from '../src/cad/analysis-cache';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import { fingerprint } from '../src/cad/result-cache';
import { emptyDocument } from '../src/cad/document';
import { modelHealth } from '../src/cad/health';
import { resultSchema } from '../src/bridge/validation';
import type { CadDocument, Feature, Vector3 } from '../src/shared/protocol';
import type { GeometryAnalysis } from '../src/cad/types';

const kernel = readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  .then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }));
const box = (id: string, origin: Vector3, size: Vector3): Extract<Feature, {kind: 'box'}> => ({ id, kind: 'box', params: { origin, size }, appearance: { material: 'steel' } });
async function engineFor(t: TestContext) { const oc = await kernel; setOC(oc); const engine = new GeometryEngine(oc); t.after(() => engine.dispose()); return engine; }
function equivalent(actual: unknown, expected: unknown, path = ''): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), path + ': ' + actual + ' != ' + expected);
  } else if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, path + ' length'); actual.forEach((v, i) => equivalent(v, expected[i], path + '.' + i));
  } else if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const A = actual as Record<string, unknown>, B = expected as Record<string, unknown>;
    const keys = Object.keys(B).filter(k => k !== 'durationMs');
    assert.deepEqual(Object.keys(A).filter(k => k !== 'durationMs').sort(), keys.sort(), path + ' keys');
    for (const key of keys) equivalent(A[key], B[key], path + '.' + key);
  } else assert.deepEqual(actual, expected, path);
}
async function assertCold(t: TestContext, document: CadDocument, actual: GeometryAnalysis, documents: CadDocument[] = []) {
  const cold = await engineFor(t), evaluated = cold.evaluate(document, documents), report = cold.analyze(document, evaluated.geometry);
  assert.equal(report.skipped, undefined); equivalent(actual, report);
  assert.deepEqual(modelHealth(document, { ...evaluated, analysis: actual }, null), modelHealth(document, { ...evaluated, analysis: report }, null));
}

test('150-part analysis reuses exact pairs, rebuilds one edited part and matches a cold full report and every overlap mesh value', async t => {
  const engine = await engineFor(t);
  const document: CadDocument = { ...emptyDocument(), analysis: { ground: 'ground' }, features: [
    box('ground', [0, 0, 0], [104, 28, 2]),
    ...Array.from({ length: 149 }, (_, i) => box('post_' + i, [(i % 25) * 4, Math.floor(i / 25) * 4, i % 11 === 0 ? 5 : i % 7 === 0 ? 1 : 2], [3, 3, 6])),
  ] };
  let evaluated = engine.evaluate(document), report = engine.analyze(document, evaluated.geometry);
  assert.equal(report.parts, 150); assert.equal(report.skipped, undefined);
  assert.ok(report.contacts.length > 100); assert.ok(report.interferences.length > 10); assert.ok(report.floating.length > 10);
  const coldMs = evaluated.stats!.analysis!.durationMs, coldMisses = evaluated.stats!.analysis!.pairMisses;
  evaluated = engine.evaluate(document);
  const warm = engine.analyze(document, evaluated.geometry), warmStats = evaluated.stats!.analysis!;
  equivalent(warm, report); assert.equal(warmStats.partMisses, 0); assert.equal(warmStats.pairMisses, 0);
  assert.equal(warmStats.pairHits, coldMisses);
  // External display consumers cannot poison cached overlap arrays or labels.
  report.interferenceMeshes![0].vertices[0] = 99999;
  equivalent(engine.analyze(document, evaluated.geometry), warm);
  document.revision++;
  document.features[149] = box('post_148', [92, 20, 1], [3, 3, 7]);
  evaluated = engine.evaluate(document); report = engine.analyze(document, evaluated.geometry);
  const editStats = evaluated.stats!.analysis!;
  assert.equal(evaluated.stats!.cache.misses, 1); assert.equal(editStats.partMisses, 1);
  assert.ok(editStats.pairHits > 100); assert.ok(editStats.pairMisses > 0 && editStats.pairMisses < 150);
  await assertCold(t, document, report);
  t.diagnostic(JSON.stringify({ benchmark: '150 visible parts / real OCCT / analysis only', coldMs, warmMs: warmStats.durationMs, onePartEditMs: editStats.durationMs, coldPairMisses: coldMisses, warmPairMisses: warmStats.pairMisses, editPairMisses: editStats.pairMisses, editPairHits: editStats.pairHits }));
});

test('ground, tolerance, scope, intent, rename/order and appearance are rebuilt from cached physical facts', async t => {
  const engine = await engineFor(t);
  const document: CadDocument = { ...emptyDocument(), features: [box('a', [0, 0, 0], [10, 10, 10]), box('b', [9, 0, 0], [10, 10, 10]), box('c', [19.05, 0, 0], [10, 10, 10])], analysis: { ground: 'a', checks: [{ id: 'gap', a: 'b', b: 'c', expect: 'clearance', minGapMm: 0.04, note: 'Exploded gap' }] } };
  let evaluated = engine.evaluate(document); engine.analyze(document, evaluated.geometry);
  document.analysis!.toleranceMm = 0.1; // The formerly separated pair now needs exact common volume.
  evaluated = engine.evaluate(document); let report = engine.analyze(document, evaluated.geometry);
  assert.ok(evaluated.stats!.analysis!.pairMisses > 0); await assertCold(t, document, report);
  document.analysis = { ground: 'b', toleranceMm: 0.01, checks: [{ id: 'fit', a: 'a', b: 'b', expect: 'overlap', note: 'Press fit' }, { id: 'gap', a: 'b', b: 'c', expect: 'clearance', minGapMm: 0.04, note: 'Exploded gap' }] };
  document.features[0].appearance = { color: '#ff0000' };
  evaluated = engine.evaluate(document); report = engine.analyze(document, evaluated.geometry);
  assert.equal(evaluated.stats!.analysis!.pairMisses, 0); assert.equal(report.interferences[0].intendedBy, 'fit'); await assertCold(t, document, report);
  engine.analyze(document, evaluated.geometry, ['a', 'b']);
  await assertCold(t, document, engine.analyze(document, evaluated.geometry));
  document.features.reverse();
  evaluated = engine.evaluate(document); report = engine.analyze(document, evaluated.geometry);
  assert.equal(evaluated.stats!.analysis!.pairMisses, 0); await assertCold(t, document, report);
  document.features.find(f => f.id === 'a')!.id = 'renamed';
  document.analysis.checks![0].a = 'renamed';
  evaluated = engine.evaluate(document); report = engine.analyze(document, evaluated.geometry);
  assert.equal(evaluated.stats!.analysis!.pairMisses, 0); await assertCold(t, document, report);
  // A spent budget defers only uncached work: fully cached facts still form a complete report.
  assert.equal(engine.analyze(document, evaluated.geometry, undefined, -1).skipped, undefined);
  const extended: CadDocument = { ...document, features: [...document.features, box('d', [29.05, 0, 0], [10, 10, 10])] };
  const grown = engine.evaluate(extended);
  const partial = engine.analyze(extended, grown.geometry, undefined, -1);
  assert.ok(partial.skipped); assert.equal(modelHealth(extended, { ...grown, analysis: partial }, null).ok, false);
  evaluated = engine.evaluate(document);
  await assertCold(t, document, engine.analyze(document, evaluated.geometry));
});

test('assembly placements, nested sources, source edits and unchanged instances match cold analysis', async t => {
  const engine = await engineFor(t);
  const source: CadDocument = { ...emptyDocument(), kind: 'part', features: [box('body', [0, 0, 0], [10, 10, 10])] };
  const instance = (id: string, document: CadDocument, translation: Vector3): Extract<Feature, {kind: 'instance'}> => ({ id, kind: 'instance', params: { document: document.documentId, translation, rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0] } });
  const nested: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance('child', source, [0, 0, 0])] };
  const document: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [instance('left', nested, [0, 0, 0]), instance('touching', source, [10, 0, 0]), instance('piercing', source, [5, 5, 0]), instance('loose', source, [30, 0, 0])], analysis: { ground: 'left' } };
  let evaluated = engine.evaluate(document, [source, nested]), report = engine.analyze(document, evaluated.geometry);
  await assertCold(t, document, report, [source, nested]);
  evaluated = engine.evaluate(document, [source, nested]); equivalent(engine.analyze(document, evaluated.geometry), report);
  assert.equal(evaluated.stats!.analysis!.pairMisses, 0);
  (document.features[3] as Extract<Feature, {kind: 'instance'}>).params.translation = [25, 0, 0];
  evaluated = engine.evaluate(document, [source, nested]); report = engine.analyze(document, evaluated.geometry);
  assert.equal(evaluated.stats!.analysis!.partMisses, 1); assert.ok(evaluated.stats!.analysis!.pairHits > 0); await assertCold(t, document, report, [source, nested]);
  source.revision++; source.features[0] = box('body', [0, 0, 0], [12, 10, 10]);
  evaluated = engine.evaluate(document, [source, nested]); report = engine.analyze(document, evaluated.geometry);
  assert.equal(evaluated.stats!.analysis!.partMisses, 4); await assertCold(t, document, report, [source, nested]);
});

test('analysis statistics travel through the production worker dispatcher and strict bridge result schema', async t => {
  const engine = await engineFor(t), session = new GeometryWorkerSession(async () => engine, async () => {});
  const document: CadDocument = { ...emptyDocument(), features: [box('a', [0, 0, 0], [10, 10, 10]), box('b', [10, 0, 0], [10, 10, 10])] };
  for (const id of [1, 2]) {
    const reply = await session.handle({ id, type: 'evaluate', document, analyze: {} });
    assert.equal(reply.ok, true); if (!reply.ok || !('geometry' in reply.value)) throw new Error('Missing evaluation');
    const stats = reply.value.stats!;
    assert.equal(stats.analysis!.pairMisses, id === 1 ? 1 : 0);
    assert.equal(stats.analysis!.pairHits, id === 1 ? 0 : 1);
    assert.doesNotThrow(() => resultSchema.parse({ operation: 'inspect_model', status: 'success', documentId: document.documentId, revision: 0, created: [], updated: [], warnings: [], evaluationStats: stats }));
  }
});

test('analysis cache checks full fingerprint descriptors on collisions and bounds numeric/mesh retention', async t => {
  const engine = await engineFor(t), a = box('a', [0, 0, 0], [1, 1, 1]), b = box('b', [2, 0, 0], [1, 1, 1]);
  const evaluated = engine.evaluate({ ...emptyDocument(), features: [a, b] });
  const cache = new AnalysisCache({ parts: 2, pairs: 1, meshBytes: 80 });
  const fa = fingerprint(a, []), fb = { ...fingerprint(b, []), hash: fa.hash };
  const A = cache.part(fa, evaluated.geometry[0]).part, B = cache.part(fb, evaluated.geometry[1]).part;
  assert.notEqual(A.key, B.key); assert.equal(cache.part({ ...fa }, evaluated.geometry[0]).hit, true);
  cache.set(A, B, { gap: 1 }); assert.equal(cache.get(B, A)!.gap, 1);
  cache.set(A, A, { gap: 0 }); assert.equal(cache.get(A, B), undefined); assert.equal(cache.stats().pairEntries, 1);
  cache.set(A, B, { gap: 0, common: { overlap: 1, mesh: { vertices: Array(30).fill(0), normals: [], triangles: [] } } });
  assert.equal(cache.get(A, B), undefined);
  cache.part(fingerprint(box('c', [5, 0, 0], [1, 1, 1]), []), evaluated.geometry[0]);
  assert.equal(cache.stats().partEntries, 2); cache.dispose();
  assert.deepEqual(cache.stats(), { partEntries: 0, pairEntries: 0, meshBytes: 0 });
});

test('an in-flight exact pair finishes with its display mesh before yielding, then reuses the completed fact', async t => {
  // c touches b, so a second exact pair remains for the next slice.
  const engine = await engineFor(t), document: CadDocument = { ...emptyDocument(), features: [box('a', [0, 0, 0], [10, 10, 10]), box('b', [5, 0, 0], [10, 10, 10]), box('c', [15, 0, 0], [10, 10, 10])] };
  const evaluated = engine.evaluate(document);
  const boundary = engine as unknown as { boolean: (...args: unknown[]) => import('replicad').Shape3D };
  const original = boundary.boolean.bind(engine);
  let exhausted = false;
  const time = t.mock.method(performance, 'now', () => exhausted ? 1000 : 0);
  const operation = t.mock.method(boundary, 'boolean', (...args: unknown[]) => { const common = original(...args); exhausted = true; return common; });
  let report: GeometryAnalysis;
  try { report = engine.analyze(document, evaluated.geometry, undefined, 1); }
  finally { operation.mock.restore(); time.mock.restore(); }
  assert.ok(report.skipped); assert.equal(report.interferenceMeshes!.length, 1);
  assert.equal(evaluated.stats!.analysis!.pairEntries, 1);
  const retry = engine.analyze(document, evaluated.geometry);
  assert.equal(retry.skipped, undefined); assert.equal(retry.interferenceMeshes!.length, 1);
  assert.equal(evaluated.stats!.analysis!.pairMisses, 2, 'only deferred work is measured: b–c contact and c to ground');
  const warm = engine.analyze(document, evaluated.geometry);
  equivalent(warm, retry); assert.equal(evaluated.stats!.analysis!.pairMisses, 0);
});

test('partial exact analysis continues after checkpoint transfer, without repeating completed pairs or trusting edited geometry',async t=>{
 const engine=await engineFor(t),document:CadDocument={...emptyDocument(),features:[box('a',[0,0,0],[10,10,10]),box('b',[5,0,0],[10,10,10]),box('c',[7,0,0],[10,10,10])],analysis:{ground:'a',checks:[{id:'clear',a:'b',b:'c',expect:'clearance',minGapMm:1,note:'Required separation'}]}};
 const evaluation=engine.evaluate(document);
 const boundary=engine as unknown as {boolean:(...args:unknown[])=>import('replicad').Shape3D},original=boundary.boolean.bind(engine);
 let exhausted=false;
 const time=t.mock.method(performance,'now',()=>exhausted?1000:0);
 const operation=t.mock.method(boundary,'boolean',(...args:unknown[])=>{const value=original(...args);exhausted=true;return value;});
 let partial:GeometryAnalysis;
 try{partial=engine.analyze(document,evaluation.geometry,undefined,1);}finally{operation.mock.restore();time.mock.restore();}
 assert.equal(partial.coverage!.completedPairs,1);assert.equal(partial.checks[0].ok,null);
 assert.equal(modelHealth(document,{...evaluation,analysis:partial},null).failedChecks,0);
 const restored=await engineFor(t);restored.restoreAnalysis(structuredClone(engine.analysisCheckpoint()));
 const next=restored.evaluate(document),report=restored.analyze(document,next.geometry);
 assert.equal(report.skipped,undefined);assert.equal(report.checks[0].ok,false);assert.ok(next.stats!.analysis!.pairHits>0);assert.equal(next.stats!.analysis!.pairMisses,2);
 await assertCold(t,document,report);
 document.features[1]=box('b',[30,0,0],[10,10,10]);const changed=restored.evaluate(document),updated=restored.analyze(document,changed.geometry);
 assert.equal(updated.checks[0].ok,true);await assertCold(t,document,updated);
});

test('real Node worker replacement retains bounded numeric analysis facts', {timeout:30000},async t=>{
 const worker=new NodeGeometryWorker();t.after(()=>worker.close());
 const document:CadDocument={...emptyDocument(),features:[box('a',[0,0,0],[10,10,10]),box('b',[5,0,0],[10,10,10])]};
 await worker.initialize(document);
 const first=await worker.evaluate(document,undefined,{});assert.equal(first.stats!.analysis!.pairMisses,1);
 worker.stop();
 const next=await worker.evaluate(document,undefined,{});assert.equal(next.stats!.analysis!.pairMisses,0);assert.equal(next.stats!.analysis!.pairHits,1);
 equivalent(next.analysis,first.analysis);assert.ok(worker.diagnostics.generation>=2);
});
