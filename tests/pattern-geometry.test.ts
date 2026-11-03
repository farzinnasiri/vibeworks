import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, visibleFeatures } from '../src/cad/document';
import type { CadDocument, Feature } from '../src/shared/protocol';

test('patterns repeat a solid as one feature and cut all copies in one boolean; kernel errors are decoded', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);
  try {
    const fin: Feature = { id: 'fin', kind: 'box', params: { origin: [0, 0, 0], size: [2, 10, 5] } };
    const fins: Feature = { id: 'fins', kind: 'pattern', params: { target: 'fin', layout: { type: 'linear', direction: [1, 0, 0], spacing: 5, count: 8 } } };
    let doc: CadDocument = { ...emptyDocument(), features: [fin, fins] };
    let result = engine.evaluate(doc);
    const finsInfo = result.geometry.find(g => g.featureId === 'fins')!;
    assert.equal(finsInfo.solidCount, 8); close(finsInfo.volumeMm3, 8 * 100); close(finsInfo.bounds.size[0], 37);
    assert.deepEqual(visibleFeatures(doc), ['fins']);

    // A bolt circle: one cutter, one circular pattern, one subtract.
    const plate: Feature = { id: 'plate', kind: 'cylinder', params: { origin: [0, 0, 0], radius: 40, height: 6 } };
    const cutter: Feature = { id: 'cutter', kind: 'cylinder', params: { origin: [30, 0, -1], radius: 3, height: 8 } };
    const ring: Feature = { id: 'ring', kind: 'pattern', params: { target: 'cutter', layout: { type: 'circular', axis: [0, 0, 1], origin: [0, 0, 0], count: 6, angleDegrees: 360 } } };
    const flange: Feature = { id: 'flange', kind: 'subtract', params: { target: 'plate', tools: ['ring'] } };
    doc = { ...emptyDocument(), features: [plate, cutter, ring, flange] };
    result = engine.evaluate(doc);
    const flangeInfo = result.geometry.find(g => g.featureId === 'flange')!;
    assert.equal(flangeInfo.valid, true); assert.equal(flangeInfo.solidCount, 1);
    close(flangeInfo.volumeMm3, Math.PI * 40 ** 2 * 6 - 6 * Math.PI * 3 ** 2 * 6);

    // An impossible fillet names its kernel cause instead of [object WebAssembly.Exception].
    const box: Feature = { id: 'b', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 2] } };
    const round: Feature = { id: 'r', kind: 'fillet', params: { target: 'b', radius: 4, edges: 'all' } };
    assert.throws(() => engine.evaluate({ ...emptyDocument(), features: [box, round] }), (error: Error) => {
      assert.doesNotMatch(error.message, /object WebAssembly\.Exception/);
      assert.match(error.message, /Could not rebuild 'r' \(fillet\).*radius/);
      return true;
    });
  } finally { engine.dispose(); }
});
