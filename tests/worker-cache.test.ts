import test from 'node:test';
import assert from 'node:assert/strict';
import { GeometryWorker } from '../src/cad/worker-client';
import { emptyDocument } from '../src/cad/document';
import type { WorkerReply } from '../src/cad/types';

// These tests exercise the real client lifecycle with a transport double, not a browser worker.
test('warm worker persists across evaluations and exports; recycling drains queued requests then replaces it', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances: FakeWorker[] = [];
  const result = { geometry: [], meshes: [], visibleFeatureIds: [] };
  class FakeWorker {
    onmessage?: (event: { data: WorkerReply }) => void;
    onerror?: unknown;
    onmessageerror?: unknown;
    requests: Array<{ id: number; type: string }> = [];
    terminated = false;
    constructor() { instances.push(this); }
    postMessage(request: { id: number; type: string }) { this.requests.push(request); }
    respond(index: number, recycle = false, fail = false) {
      this.onmessage?.({ data: { id: this.requests[index].id, recycle, ...(fail
        ? { ok: false as const, error: { code: 'GEOMETRY_FAILED', message: 'bad candidate' } }
        : { ok: true as const, value: this.requests[index].type === 'export' ? { bytes: new ArrayBuffer(4), mimeType: 'model/stl' } : result }) } });
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true });
  const worker = new GeometryWorker();
  try {
    const first = worker.evaluate(emptyDocument()); instances[0].respond(0); await first;
    const warm = worker.evaluate(emptyDocument()); instances[0].respond(1); await warm;
    assert.equal(instances.length, 1); assert.equal(instances[0].terminated, false);
    const exported = worker.export('stl', ['part'], emptyDocument()); instances[0].respond(2); await exported;
    assert.equal(instances[0].terminated, false);
    const one = worker.evaluate(emptyDocument()), two = worker.evaluate(emptyDocument());
    instances[0].respond(3, true); await one;
    assert.equal(instances[0].terminated, false, 'queued request is allowed to finish');
    instances[0].respond(4); await two;
    assert.equal(instances[0].terminated, true);
    const fresh = worker.evaluate(emptyDocument()); instances[1].respond(0); await fresh;
    assert.equal(instances.length, 2);
    const failed = worker.evaluate(emptyDocument()); instances[1].respond(1, true, true);
    await assert.rejects(failed, /bad candidate/);
    assert.equal(instances[1].terminated, true, 'failures also honor the recycle signal');
    const recovered = worker.evaluate(emptyDocument()); instances[2].respond(0); await recovered;
    assert.equal(instances.length, 3);
  } finally {
    worker.stop();
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});

test('real Node workers bound WASM capacity across 300 edits and reload text after recycling', async () => {
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const { demoFeatures } = await import('../src/cad/demo');
  const { MAX_WORKER_HEAP_BYTES } = await import('../src/cad/worker-policy');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const instances: NodeTransport[] = [];
  class NodeTransport {
    onmessage?: (event: { data: WorkerReply }) => void;
    onerror?: (event: { preventDefault: () => void; message: string }) => void;
    onmessageerror?: () => void;
    native = new NodeWorker(new URL('./cache-worker-fixture.mjs', import.meta.url));
    terminated?: Promise<number>;
    constructor() {
      instances.push(this);
      this.native.on('message', data => this.onmessage?.({ data }));
      this.native.on('error', error => this.onerror?.({ preventDefault: () => {}, message: error.stack ?? error.message }));
      this.native.on('messageerror', () => this.onmessageerror?.());
    }
    postMessage(request: unknown) { this.native.postMessage(request); }
    terminate() { this.terminated = this.native.terminate(); }
  }
  Object.defineProperty(globalThis, 'Worker', { value: NodeTransport, configurable: true });
  const worker = new GeometryWorker();
  const doc = { ...emptyDocument(), features: demoFeatures() };
  const heaps: number[] = [], restarts: Array<{ edit: number; heapBytes: number }> = [];
  let peakShapes = 0, peakHeap = 0;
  try {
    for (let i = 0; i < 300; i++) {
      const tool = doc.features[2];
      if (tool.kind === 'cylinder') tool.params.radius = 1 + (i % 160) / 200;
      const result = await worker.evaluate(doc);
      const stats = result.stats!.cache;
      peakShapes = Math.max(peakShapes, stats.liveShapes); peakHeap = Math.max(peakHeap, stats.wasmHeapBytes);
      if (result.stats!.cache.misses === 7) {
        restarts.push({ edit: i, heapBytes: stats.wasmHeapBytes });
        assert.ok(stats.wasmHeapBytes <= 128 * 1024 * 1024, 'new kernel starts near its 100 MiB initial capacity');
      } else assert.equal(stats.misses, 2);
      assert.ok(stats.liveShapes <= 500);
      // A single operation can grow capacity past the threshold before the reply triggers recycling.
      assert.ok(stats.wasmHeapBytes <= MAX_WORKER_HEAP_BYTES * 1.25);
      if (i % 50 === 0) heaps.push(stats.wasmHeapBytes);
    }
    assert.ok(restarts.length >= 3, 'the test must span multiple actual kernel lifetimes');
    const textDoc = { ...emptyDocument(), features: [{ id: 'letters', kind: 'text' as const, params: { text: 'VW', plane: 'XY' as const, origin: [0, 0, 0] as [number, number, number], size: 6, depth: 1 } }] };
    const before = await worker.evaluate(textDoc);
    worker.stop(); // Same disposal/recreation path as scheduled recycling and timeouts.
    const after = await worker.evaluate(textDoc);
    assert.deepEqual(after.geometry, before.geometry);
    assert.deepEqual(after.meshes, before.meshes);
    assert.equal(after.stats!.cache.misses, 1);
    console.log(`WORKER_MEMORY edits=300 peakLiveShapes=${peakShapes} peakWasmBytes=${peakHeap} samples=${JSON.stringify(heaps)} coldStarts=${JSON.stringify(restarts)}`);
  } finally {
    worker.stop();
    await Promise.all(instances.map(instance => instance.terminated));
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
