import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { featureSchema, parseCommand, type Feature, type Vector3 } from '../src/shared/protocol';
import { toolFeature, featureCommand } from '../src/web/modeling';

const rod = (from: Vector3, to: Vector3, radius = 2): Feature => ({ id: 'link', kind: 'rod', params: { from, to, radius }, appearance: { material: 'steel' } });
const close = (a: number, b: number, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('rod validates endpoints in both agent batches and manual tool commands', () => {
  const doc = emptyDocument();
  for (const to of [[0, 0, 0], [0, 0, 0.009], [10001, 0, 0], [Infinity, 0, 0]] as Vector3[]) {
    const f = rod([0, 0, 0], to);
    assert.throws(() => featureSchema.parse(f));
    assert.throws(() => parseCommand({ type: 'apply_edits', params: { documentId: doc.documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: f.id, kind: 'rod', params: { ...f.params } } }] } }));
    assert.throws(() => parseCommand({ type: 'apply_edits', params: { documentId: doc.documentId, expectedRevision: 0, edits: [{ op: 'add', feature: f }] } }));
  }
  assert.throws(() => featureSchema.parse({ ...rod([0, 0, 0], [10, 0, 0]), params: { from: [0, 0, 0], to: [10, 0, 0], radius: 2, capped: false } }));
  const f = toolFeature('rod', doc, [])!;
  assert.equal(featureCommand(doc, f).type, 'apply_edits');
});

test('real OCCT rods have exact volume, endpoints, binding rebuilds, cache reuse and transactional failure', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    for (const to of [[20, 0, 0], [0, -20, 0], [0, 0, -20], [6, 8, 12]] as Vector3[]) {
      const from: Vector3 = [1, 2, 3];
      const doc = { ...emptyDocument(), features: [rod(from, to)] };
      const evaluation = engine.evaluate(doc), g = evaluation.geometry[0];
      const length = Math.hypot(...to.map((v, i) => v - from[i]));
      assert.equal(g.valid, true); assert.equal(g.solidCount, 1);
      close(g.volumeMm3, Math.PI * 4 * length);
      // Analytical bounds of a finite cylinder: circular section projected onto each world axis.
      to.forEach((v, i) => {
        const extent = 2 * Math.sqrt(1 - ((v - from[i]) / length) ** 2);
        close(g.bounds.min[i], Math.min(v, from[i]) - extent);
        close(g.bounds.max[i], Math.max(v, from[i]) + extent);
      });
      assert.equal(engine.evaluate(doc).stats!.cache.hits, 1);
    }
    let doc = { ...emptyDocument(), parameters: [{ name: 'length', value: 20 }], features: [{ ...rod([0, 0, 0], [20, 0, 0]), bindings: { 'to.0': 'length' } }] };
    engine.evaluate(doc);
    doc = applyEdits(doc, [{ op: 'set_parameter', name: 'length', value: 30 }]).document as typeof doc;
    const changed = engine.evaluate(doc);
    assert.deepEqual(changed.stats!.cache.rebuilt, ['link']); close(changed.geometry[0].volumeMm3, 120 * Math.PI);
    assert.throws(() => applyEdits(doc, [{ op: 'set_parameter', name: 'length', value: 0 }]), /endpoint distance/);
    assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt, []);
    const cold = new GeometryEngine(oc);
    try { close(cold.evaluate(doc).geometry[0].volumeMm3, changed.geometry[0].volumeMm3); } finally { cold.dispose(); }
    assert.ok((await engine.export('step', ['link'], doc)).bytes.byteLength > 1000);
    // Flat end at x=30 contacts a plate, moving the endpoint inside it creates an interference.
    const plate: Feature = { id: 'plate', kind: 'box', params: { origin: [30, -4, -4], size: [2, 8, 8] } };
    const touching = { ...doc, features: [...doc.features, plate] };
    let ev = engine.evaluate(touching), analysis = engine.analyze(touching, ev.geometry);
    assert.equal(analysis.contacts.length, 1); assert.equal(analysis.interferences.length, 0);
    const piercing = applyEdits(touching, [{ op: 'set_parameter', name: 'length', value: 31 }]).document;
    ev = engine.evaluate(piercing); analysis = engine.analyze(piercing, ev.geometry);
    close(analysis.interferences[0].overlapMm3, 4 * Math.PI, 0.001);
  } finally { engine.dispose(); }
});
