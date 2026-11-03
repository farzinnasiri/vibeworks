import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine, loadTextFont } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { demoFeatures, demoParameters } from '../src/cad/demo';
import { applyEdits } from '../src/cad/edits';
import { fingerprint, ResultCache, type CachedResult } from '../src/cad/result-cache';
import { shouldRecycleWorker, MAX_WORKER_EVALUATIONS, MAX_WORKER_HEAP_BYTES, HARD_WORKER_HEAP_BYTES } from '../src/cad/worker-policy';
import type { CadDocument, Feature } from '../src/shared/protocol';
import type { Evaluation } from '../src/cad/types';
import { resultSchema } from '../src/bridge/validation';

const kernel = readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  .then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }));
const demo = (): CadDocument => ({ ...emptyDocument(), features: demoFeatures(), parameters: demoParameters() });

function equivalent(actual: Evaluation, expected: Evaluation): void {
  assert.deepEqual(actual.visibleFeatureIds, expected.visibleFeatureIds);
  // Compare every exact metric and every mesh value, not just total volume or triangle counts.
  const compare = (a: unknown, b: unknown, path: string) => {
    if (typeof a === 'number' && typeof b === 'number') {
      assert.ok(Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(b)), `${path}: ${a} != ${b}`);
    } else if (a && b && typeof a === 'object' && typeof b === 'object') {
      assert.deepEqual(Object.keys(a), Object.keys(b), path);
      for (const key of Object.keys(a)) compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    } else assert.equal(a, b, path);
  };
  compare(actual.geometry, expected.geometry, 'geometry');
  compare(actual.meshes, expected.meshes, 'meshes');
}

function largeDocument(): CadDocument {
  const features: Feature[] = [];
  for (let i = 0; i < 30; i++) {
    const x = i * 45;
    features.push(
      { id: `base_${i}`, kind: 'box', params: { origin: [x, 0, 0], size: [30, 20, 8] } },
      { id: `round_${i}`, kind: 'fillet', params: { target: `base_${i}`, radius: 1, edges: 'vertical' } },
      { id: `tool_${i}`, kind: 'cylinder', params: { origin: [x + 10, 10, -1], radius: 2, height: 10 } },
      { id: `cut_${i}`, kind: 'subtract', params: { target: `round_${i}`, tools: [`tool_${i}`] } },
      { id: `mirror_${i}`, kind: 'mirror', params: { target: `cut_${i}`, plane: 'XZ', origin: [0, -5, 0], copy: true } },
      { id: `pattern_${i}`, kind: 'pattern', params: { target: `mirror_${i}`, layout: { type: 'linear', direction: [0, 1, 0], count: 3, spacing: 50 } } },
    );
  }
  features.push({ id: 'engraved', kind: 'text', params: { target: 'cut_0', text: 'VW', plane: 'XY', origin: [20, 10, 8], size: 6, depth: 0.5, mode: 'engrave' } });
  return validateDocument({ ...emptyDocument(), features, analysis: { auto: false } });
}

async function cold(document: CadDocument): Promise<Evaluation> {
  const engine = new GeometryEngine(await kernel);
  try { return engine.evaluate(document); } finally { engine.dispose(); }
}

test('cache matches cold demo replay, exact leaf/dependent rebuilds, material changes and parameter bindings', async () => {
  const oc = await kernel; setOC(oc);
  const engine = new GeometryEngine(oc);
  let doc = demo();
  try {
    const first = engine.evaluate(doc);
    assert.equal(first.stats!.cache.misses, doc.features.length);
    const warm = engine.evaluate(doc);
    assert.equal(warm.stats!.cache.hits, doc.features.length);
    equivalent(warm, await cold(doc));
    const receipt = { operation: 'inspect_model', status: 'success', documentId: doc.documentId, revision: 0, created: [], updated: [], warnings: [], evaluationStats: warm.stats };
    assert.equal(resultSchema.safeParse(receipt).success, true);
    assert.equal(resultSchema.safeParse({ ...receipt, evaluationStats: { ...warm.stats, durationMs: Infinity } }).success, false);
    // A terminal feature rebuilds alone; a cutter rebuilds itself and the finished solid.
    const leaf = structuredClone(doc.features.at(-1)!);
    if (leaf.kind === 'subtract') leaf.params.tools.pop();
    doc = applyEdits(doc, [{ op: 'update', feature: leaf }]).document;
    assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt, ['finished_plate']);
    const tool = structuredClone(doc.features[2]);
    if (tool.kind === 'cylinder') tool.params.radius = 3;
    delete tool.bindings;
    doc = applyEdits(doc, [{ op: 'update', feature: tool }]).document;
    const changed = engine.evaluate(doc);
    assert.deepEqual(changed.stats!.cache.rebuilt, ['hole_1', 'finished_plate']);
    equivalent(changed, await cold(doc));

    const painted = structuredClone(doc);
    painted.features[0].label = 'A renamed plate';
    painted.features[0].appearance = { material: 'aluminum', color: '#ff0000' };
    const decorated = engine.evaluate(painted);
    assert.deepEqual(decorated.stats!.cache.rebuilt, []);
    equivalent(decorated, await cold(painted));
    assert.ok(decorated.geometry.at(-1)!.massG! > 0);
    assert.equal(engine.evaluate(doc).geometry.at(-1)!.massG, undefined, 'removing material clears mass');

    // Only the corner radius is bound to corner_r; the four cutters stay cached.
    doc = applyEdits(doc, [{ op: 'set_parameter', name: 'corner_r', value: 2 }]).document;
    const parametric = engine.evaluate(doc);
    assert.deepEqual(parametric.stats!.cache.rebuilt, ['rounded_plate', 'finished_plate']);
    equivalent(parametric, await cold(doc));
    // Changing an unused parameter or expression spelling with the same resolved value is free.
    doc = applyEdits(doc, [{ op: 'set_parameter', name: 'unused', value: 9 }]).document;
    assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt, []);
    const rebound = structuredClone(doc.features[1]);
    rebound.bindings = { radius: 'corner_r + 0' };
    doc = applyEdits(doc, [{ op: 'update', feature: rebound }]).document;
    assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt, []);
  } finally { engine.dispose(); }
  assert.equal(engine.cacheStats().liveShapes, 0);
});

test('failed candidate discards new entries, preserves prior export, and returned data cannot poison cache', async () => {
  const oc = await kernel; setOC(oc);
  const engine = new GeometryEngine(oc);
  const doc = demo();
  try {
    const good = engine.evaluate(doc);
    const original = structuredClone(good);
    const count = engine.cacheStats().entries;
    const failed = structuredClone(doc);
    failed.features.push(
      { id: 'new_box', kind: 'box', params: { origin: [200, 0, 0], size: [20, 20, 10] } },
      { id: 'bad_round', kind: 'fillet', params: { target: 'new_box', radius: 50, edges: 'all' } },
    );
    assert.throws(() => engine.evaluate(failed), /rebuild|valid|fillet/i);
    assert.equal(engine.cacheStats().entries, count);
    const emptyIntersection = structuredClone(doc);
    emptyIntersection.features.push(
      { id: 'far_box', kind: 'box', params: { origin: [500, 0, 0], size: [10, 10, 10] } },
      { id: 'empty_common', kind: 'intersect', params: { target: 'plate', tools: ['far_box'] } },
    );
    assert.throws(() => engine.evaluate(emptyIntersection), /valid nonempty solid|3D shape/i);
    assert.equal(engine.cacheStats().entries, count);
    assert.ok((await engine.export('stl', ['finished_plate'])).bytes.byteLength > 1000);
    failed.features.pop();
    assert.deepEqual(engine.evaluate(failed).stats!.cache.rebuilt, ['new_box'], 'failed candidate did not publish its valid prefix');
    // Successful dry-run candidates may warm the cache, but never overwrite another content key.
    const preview = structuredClone(doc);
    if (preview.features[0].kind === 'box') preview.features[0].params.size[2] = 7;
    engine.evaluate(preview);
    equivalent(engine.evaluate(doc), original);
    good.geometry[0].volumeMm3 = -1;
    good.geometry[0].bounds.min[0] = -999;
    good.meshes[0].vertices[0] = -999;
    equivalent(engine.evaluate(doc), original);
    assert.equal(engine.evaluate(doc).stats!.cache.misses, 0);
    engine.dispose();
    equivalent(engine.evaluate(doc), original);
    assert.equal(engine.cacheStats().entries, doc.features.length);
  } finally { engine.dispose(); }
});

test('large DAG benchmark: 181 features including booleans, rounds, mirrors, patterns and text', async () => {
  const oc = await kernel; setOC(oc);
  const font = await readFile(new URL('../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
  await loadTextFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
  const engine = new GeometryEngine(oc);
  const doc = largeDocument();
  try {
    const first = engine.evaluate(doc);
    const warm = engine.evaluate(doc);
    const replay = await cold(doc);
    equivalent(warm, first); equivalent(warm, replay);
    assert.equal(warm.stats!.cache.hits, 181);
    const changed = structuredClone(doc);
    const tool = changed.features.find(f => f.id === 'tool_29')!;
    if (tool.kind === 'cylinder') tool.params.radius = 2.2;
    const edited = engine.evaluate(changed);
    assert.deepEqual(edited.stats!.cache.rebuilt, ['tool_29', 'cut_29', 'mirror_29', 'pattern_29']);
    equivalent(edited, await cold(changed));
    const painted = structuredClone(changed);
    painted.features[0].appearance = { color: '#0099ff' };
    assert.equal(engine.evaluate(painted).stats!.cache.misses, 0);
    console.log(`CACHE_BENCH features=${doc.features.length} firstColdMs=${first.stats!.durationMs.toFixed(2)} independentColdMs=${replay.stats!.durationMs.toFixed(2)} warmMs=${warm.stats!.durationMs.toFixed(2)} edit4Ms=${edited.stats!.durationMs.toFixed(2)} heapBytes=${engine.cacheStats().wasmHeapBytes}`);
  } finally { engine.dispose(); }
});

test('LRU bounds retained shapes and mesh bytes over 160 real edits; WASM capacity is measured', async () => {
  const oc = await kernel; setOC(oc);
  const maxEntries = 20, maxMeshBytes = 2 * 1024 * 1024;
  const engine = new GeometryEngine(oc, { maxEntries, maxMeshBytes });
  const doc = demo();
  const samples: number[] = [];
  let maxShapes = 0, peakMeshBytes = 0, evictions = 0;
  try {
    for (let i = 0; i < 160; i++) {
      const tool = doc.features[2];
      if (tool.kind === 'cylinder') tool.params.radius = 1 + i / 200;
      const result = engine.evaluate(doc);
      const stats = engine.cacheStats();
      assert.ok(stats.liveShapes <= maxEntries);
      assert.ok(stats.meshBytes <= maxMeshBytes);
      assert.equal(result.stats!.cache.misses, i ? 2 : 7);
      maxShapes = Math.max(maxShapes, stats.liveShapes);
      peakMeshBytes = Math.max(peakMeshBytes, stats.meshBytes);
      evictions += result.stats!.cache.evictions;
      if (i % 20 === 0 || i === 159) samples.push(stats.wasmHeapBytes);
      // Worker requests yield between edits too; allow the library's finalizers to run.
      if (i % 10 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(evictions > 250);
    equivalent(engine.evaluate(doc), await cold(doc));
    console.log(`CACHE_MEMORY edits=160 maxLiveShapes=${maxShapes} peakMeshBytes=${peakMeshBytes} evictions=${evictions} wasmCapacitySamples=${JSON.stringify(samples)}`);
  } finally { engine.dispose(); }
  assert.equal(engine.cacheStats().liveShapes, 0);
  assert.equal(engine.cacheStats().meshBytes, 0);
});

test('content identity ignores semantic ids, copy visibility and key order; collisions are checked exactly', () => {
  const a: Feature = { id: 'a', kind: 'box', params: { size: [2, 3, 4], origin: [0, 0, 0] } };
  const b: Feature = { id: 'b', kind: 'box', label: 'renamed', params: { origin: [0, 0, 0], size: [2, 3, 4] } };
  assert.deepEqual(fingerprint(a, []), fingerprint(b, []));
  const first = fingerprint(a, []), different = fingerprint({ ...b, params: { ...b.params, size: [3, 3, 4] } }, []);
  different.hash = first.hash; // Deliberate collision must not reuse the wrong geometry.
  let deleted = 0;
  const entry = { fingerprint: first, shape: { delete: () => deleted++ }, meshBytes: 100 } as unknown as CachedResult;
  const cache = new ResultCache({ maxEntries: 1, maxMeshBytes: 100 });
  cache.add(entry);
  assert.equal(cache.find(fingerprint(b, [])), entry);
  assert.equal(cache.find(different), undefined);
  const child: Feature = { id: 'child', kind: 'mirror', params: { target: 'a', plane: 'XY', origin: [0, 0, 0], copy: false } };
  const childEntry = { ...entry, fingerprint: fingerprint(child, [first]) };
  cache.add(childEntry);
  assert.equal(cache.find(fingerprint(child, [different])), undefined, 'dependency collisions are checked too');
  assert.equal(cache.trim(new Set([childEntry])), 1);
  cache.dispose(); assert.equal(deleted, 2);
  assert.equal(shouldRecycleWorker(MAX_WORKER_EVALUATIONS - 1, MAX_WORKER_HEAP_BYTES - 1), false);
  assert.equal(shouldRecycleWorker(MAX_WORKER_EVALUATIONS, 1), true);
  // A model that needs the capacity stays warm; renewed growth above the soft limit (a leak) recycles.
  assert.equal(shouldRecycleWorker(1, MAX_WORKER_HEAP_BYTES, false, MAX_WORKER_HEAP_BYTES), false, 'the first evaluation may grow to its working set');
  assert.equal(shouldRecycleWorker(5, MAX_WORKER_HEAP_BYTES, false, 0), false, 'a stable large model keeps its cache');
  assert.equal(shouldRecycleWorker(5, MAX_WORKER_HEAP_BYTES, false, 65536), true);
  assert.equal(shouldRecycleWorker(5, 918 * 1024 * 1024, false, 65536), false, 'the reference F1 working set stays warm');
  assert.equal(shouldRecycleWorker(1, HARD_WORKER_HEAP_BYTES), true);
});

test('shared content keeps current ids and visibility; eviction pins active shapes and bounds retired meshes', async () => {
  const oc = await kernel; setOC(oc);
  const engine = new GeometryEngine(oc, { maxEntries: 1, maxMeshBytes: 1 });
  const doc: CadDocument = { ...emptyDocument(), features: [
    { id: 'one', kind: 'box', params: { origin: [0, 0, 0], size: [2, 3, 4] } },
    { id: 'two', kind: 'box', params: { origin: [0, 0, 0], size: [2, 3, 4] } },
    { id: 'mirror', kind: 'mirror', params: { target: 'one', plane: 'XY', origin: [0, 0, 0], copy: true } },
  ] };
  try {
    const first = engine.evaluate(doc);
    assert.deepEqual(first.stats!.cache.rebuilt, ['one', 'mirror']);
    assert.deepEqual(first.geometry.map(g => g.featureId), ['one', 'two', 'mirror']);
    assert.deepEqual(first.meshes.map(g => g.featureId), ['one', 'two', 'mirror']);
    assert.equal(engine.cacheStats().liveShapes, 2, 'active results may exceed custom cache limits');
    const mirrored = doc.features[2];
    if (mirrored.kind === 'mirror') { mirrored.params.copy = false; mirrored.params.target = 'two'; }
    const changed = engine.evaluate(doc);
    assert.equal(changed.stats!.cache.misses, 0);
    assert.deepEqual(changed.visibleFeatureIds, ['one', 'mirror']);
    equivalent(changed, await cold(doc));
    assert.ok((await engine.export('stl', ['one', 'mirror'])).bytes.byteLength > 100);
    engine.evaluate(emptyDocument());
    assert.equal(engine.cacheStats().liveShapes, 0, 'unpinned results are evicted to the mesh budget');
  } finally { engine.dispose(); }
});
