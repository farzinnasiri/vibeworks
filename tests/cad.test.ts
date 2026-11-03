import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC, importSTEP } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument, visibleFeatures } from '../src/cad/document';
import { demoFeatures } from '../src/cad/demo';
import { GeometryWorker } from '../src/cad/worker-client';
import type { CadDocument } from '../src/shared/protocol';

function acceptanceDocument(): CadDocument {
  return validateDocument({ ...emptyDocument(), features: demoFeatures() });
}

test('ordered document rejects duplicate IDs, forward references, duplicate tools and missing selection', () => {
  const doc = acceptanceDocument();
  assert.deepEqual(visibleFeatures(doc), ['finished_plate']);
  assert.throws(() => validateDocument({ ...doc, features: [...doc.features, doc.features[0]] }), /already exists/);
  assert.throws(() => validateDocument({ ...doc, features: [...doc.features].reverse() }), /earlier feature/);
  const subtract = doc.features.at(-1)!;
  assert.throws(() => validateDocument({ ...doc, features: [...doc.features.slice(0, -1), { ...subtract, params: { target: 'rounded_plate', tools: ['hole_1', 'hole_1'] } }] }), /repeats/);
  assert.throws(() => validateDocument({ ...doc, selectedFeatureIds: ['missing'] }), /does not exist/);
});

test('real OCCT replay, transaction failure, thickness edit, exact metrics and STEP/STL exports', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} });
  setOC(oc);
  const engine = new GeometryEngine(oc);
  const document = acceptanceDocument();
  const area = 100 * 60 - (4 - Math.PI) * 3 ** 2 - 4 * Math.PI * 2.5 ** 2;
  const check = (thickness: number) => {
    const evaluation = engine.evaluate(document);
    assert.deepEqual(evaluation.visibleFeatureIds, ['finished_plate']);
    const info = evaluation.geometry.find(g => g.featureId === 'finished_plate')!;
    assert.equal(info.valid, true); assert.equal(info.solidCount, 1);
    assert.ok(Math.abs(info.volumeMm3 - area * thickness) < 1e-5, `${info.volumeMm3} vs ${area * thickness}`);
    [100, 60, thickness].forEach((value, i) => assert.ok(Math.abs(info.bounds.size[i] - value) < 1e-5));
    assert.ok(evaluation.meshes.at(-1)!.triangles.length > 100);
    return info;
  };
  try {
    check(5);
    const failed = structuredClone(document);
    const round = failed.features.find(f => f.id === 'rounded_plate')!;
    assert.equal(round.kind, 'fillet'); if (round.kind === 'fillet') round.params.radius = 500;
    assert.throws(() => engine.evaluate(failed), /rebuild|valid|fillet/i);
    // A failed candidate must leave the previous evaluated solid exportable.
    const originalStep = await engine.export('step', ['finished_plate']);
    assert.ok(originalStep.bytes.byteLength > 10_000);
    const plate = document.features[0]; assert.equal(plate.kind, 'box');
    if (plate.kind === 'box') plate.params.size[2] = 8;
    const thick = check(8);
    const step = await engine.export('step', ['finished_plate']);
    const imported = (await importSTEP(new Blob([step.bytes]))).asShape3D();
    try {
      const metrics = engine.measure('roundtrip', imported);
      assert.equal(metrics.valid, true); assert.equal(metrics.solidCount, 1);
      assert.ok(Math.abs(metrics.volumeMm3 - thick.volumeMm3) < 1e-5);
    } finally { imported.delete(); }
    const stl = await engine.export('stl', ['finished_plate']);
    const data = new DataView(stl.bytes), triangles = data.getUint32(80, true);
    assert.ok(triangles > 100); assert.equal(stl.bytes.byteLength, 84 + triangles * 50);
    for (let triangle = 0; triangle < triangles; triangle++) for (let value = 0; value < 12; value++) assert.ok(Number.isFinite(data.getFloat32(84 + triangle * 50 + value * 4, true)));
    const restored = validateDocument(JSON.parse(JSON.stringify(document)));
    assert.ok(Math.abs(engine.evaluate(restored).geometry.at(-1)!.volumeMm3 - thick.volumeMm3) < 1e-5);
    if (plate.kind === 'box') plate.params.size[2] = 5;
    check(5);
    // Exercise the separate all-edges path on a curved primitive.
    const emptySelector = emptyDocument();
    emptySelector.features = [{ id: 'c', kind: 'cylinder', params: { origin: [0, 0, 0], radius: 4, height: 5 } }, { id: 'f', kind: 'fillet', params: { target: 'c', radius: 1, edges: 'all' } }];
    assert.equal(engine.evaluate(emptySelector).geometry.at(-1)!.valid, true);
  } finally { engine.dispose(); }
});

test('a timed-out worker is terminated, late messages are ignored, and the next evaluation uses a new worker', async () => {
  const original = globalThis.Worker;
  const instances: FakeWorker[] = [];
  const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
  class FakeWorker {
    onmessage?: (event: {data: unknown}) => void;
    onerror?: unknown;
    onmessageerror?: unknown;
    terminated = false;
    lastId = 0;
    constructor() { instances.push(this); }
    postMessage(request: {id: number}) {
      this.lastId = request.id;
      if (instances.length > 1) setTimeout(() => this.onmessage?.({ data: { id: request.id, ok: true, value: evaluation } }), 0);
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
  const worker = new GeometryWorker();
  try {
    await assert.rejects(worker.evaluate(emptyDocument(), 10), /terminated/);
    assert.equal(instances[0].terminated, true);
    // Even an artificial delivery from the dead worker has no pending request to resolve.
    instances[0].onmessage?.({ data: { id: instances[0].lastId, ok: true, value: evaluation } });
    assert.deepEqual(await worker.evaluate(emptyDocument(), 100), evaluation);
    assert.equal(instances.length, 2); assert.equal(instances[1].terminated, false);
  } finally {
    worker.stop();
    if (original === undefined) Reflect.deleteProperty(globalThis, 'Worker');
    else Object.defineProperty(globalThis, 'Worker', { value: original, configurable: true, writable: true });
  }
});

for (const event of ['error', 'messageerror'] as const) test(`a late ${event} event from a disposed worker cannot stop its replacement`, async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances: FakeWorker[] = [];
  const evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault: () => void; message: string }) => void;
    onmessageerror?: () => void;
    terminated = false;
    constructor() { instances.push(this); }
    postMessage(request: { id: number }) {
      if (instances.length > 1) setTimeout(() => this.onmessage?.({ data: { id: request.id, ok: true, value: evaluation } }), 0);
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true });
  const worker = new GeometryWorker();
  try {
    await assert.rejects(worker.evaluate(emptyDocument(), 10), /terminated/);
    const staleEvent = event === 'error'
      ? () => instances[0].onerror?.({ preventDefault: () => {}, message: 'Failure from the old worker' })
      : () => instances[0].onmessageerror?.();
    const next = worker.evaluate(emptyDocument(), 100);
    staleEvent();
    const replacementWasTerminated = instances[1].terminated;
    assert.deepEqual(await next, evaluation);
    assert.equal(replacementWasTerminated, false);
    assert.equal(instances[1].terminated, false);
  } finally {
    worker.stop();
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
