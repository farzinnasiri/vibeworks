import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, validateDocument } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { checkSchema, type CadDocument, type Feature } from '../src/shared/protocol';

const features: Feature[] = [
  { id: 'plate', kind: 'box', params: { origin: [-20, -20, 0], size: [40, 40, 4] } },
  { id: 'boss', kind: 'cylinder', params: { origin: [0, 0, 2], radius: 5, height: 20 } },
  { id: 'body', kind: 'union', params: { target: 'plate', tools: ['boss'] } },
  { id: 'pin', kind: 'cylinder', params: { origin: [30, 0, 0], radius: 1, height: 30 } },
];

test('exact sections and design targets measure the model and count in analysis', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    const checks = [
      { id: 'height', expect: 'size', a: 'body', axis: 'Z', mm: 22, toleranceMm: 0.01 },
      { id: 'width', expect: 'size', axis: 'X', mm: 50, toleranceMm: 0.5, note: 'plate plus pin, from the reference' },
      { id: 'boxed', expect: 'within', a: 'body', min: [-20, -20, 0], max: [20, 20, 20] },
      { id: 'boss_dia', expect: 'section', a: 'body', axis: 'Z', offset: 10, widthMm: 10, heightMm: 10, toleranceMm: 0.01 },
      { id: 'mid', expect: 'section', axis: 'X', offset: 0, widthMm: 40, heightMm: 22, toleranceMm: 0.01 },
      { id: 'air', expect: 'section', a: 'body', axis: 'Z', offset: 50, widthMm: 10, toleranceMm: 1 },
    ] as const;
    const document: CadDocument = validateDocument({ ...emptyDocument(), features, analysis: { checks } });
    const evaluation = engine.evaluate(document);
    const [plateCut, bossCut, nothing, pinCut] = engine.sections(document, undefined, [{ axis: 'X', offset: 0 }, { axis: 'Z', offset: 10 }, { axis: 'Z', offset: 99 }, { axis: 'X', offset: 30 }]);
    assert.deepEqual([plateCut.widthMm, plateCut.heightMm, plateCut.results], [40, 22, ['body']]);
    // The whole model at Z = 10 cuts the boss (x −5..5) and the pin (x 29..31).
    assert.deepEqual([bossCut.widthMm, bossCut.heightMm, bossCut.results.sort()], [36, 10, ['body', 'pin']]);
    assert.equal(nothing.empty, true);
    assert.deepEqual([pinCut.widthMm, pinCut.heightMm, pinCut.results], [2, 30, ['pin']]);
    const report = engine.analyze(document, evaluation.geometry);
    const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
    assert.equal(byId.height.ok, true); assert.equal(byId.height.measuredMm, 22);
    assert.equal(byId.width.ok, false); assert.equal(byId.width.measuredMm, 51); assert.match(byId.width.message, /failed by 0\.5 mm/);
    assert.equal(byId.boxed.ok, false); assert.match(byId.boxed.message, /Z max 22 > 20/);
    assert.equal(byId.boss_dia.ok, true); assert.equal(byId.boss_dia.widthMm, 10);
    assert.equal(byId.mid.ok, true);
    assert.equal(byId.air.ok, false); assert.match(byId.air.message, /no material at Z = 50/);
    // Deleting the measured feature removes its targets with it; whole-model targets stay.
    const { document: trimmed, removedChecks } = applyEdits(document, [{ op: 'delete', featureIds: ['plate'], cascade: true }]) as unknown as { document: CadDocument; removedChecks: string[] };
    assert.deepEqual(trimmed.analysis!.checks!.map(c => c.id), ['width', 'mid']);
    assert.deepEqual(removedChecks.sort(), ['air', 'boss_dia', 'boxed', 'height']);
  } finally { engine.dispose(); }
});

test('target checks validate their own fields', () => {
  const ok = (check: unknown) => checkSchema.safeParse(check).success;
  assert.ok(ok({ id: 'w', expect: 'size', axis: 'X', mm: 10, toleranceMm: 0 }));
  assert.ok(!ok({ id: 'w', expect: 'size', axis: 'X', mm: 10 }));
  assert.ok(!ok({ id: 's', expect: 'section', axis: 'X', offset: 0, toleranceMm: 1 }));
  assert.ok(!ok({ id: 'e', expect: 'within', min: [0, 0, 1], max: [1, 1, 0] }));
  assert.ok(!ok({ id: 'c', expect: 'contact', a: 'x' }));
  assert.ok(ok({ id: 'c', expect: 'contact', a: 'x', b: 'y' }));
});

test('a sweep follows a smooth 3D path through points and can scale its section along it', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const tube = (extra: Record<string, unknown>, points: [number, number, number][] = [[0, 0, 0], [0, 0, 100]]): Feature =>
    ({ id: 'tube', kind: 'sweep', params: { profile: { type: 'circle', radius: 5 }, path: { points }, ...extra } } as Feature);
  const volume = (feature: Feature) => engine.evaluate({ ...emptyDocument(), features: [feature] }).geometry[0].volumeMm3;
  try {
    // Straight two-point paths are exact cylinders and cones (endScale 2 doubles the end radius).
    // Pipe shells are exact to the kernel's approximation tolerance (about one part per million here).
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual / expected - 1) < 1e-6, `${actual} vs ${expected}`);
    near(volume(tube({})), Math.PI * 25 * 100);
    near(volume(tube({ endScale: 2 })), Math.PI * 100 * (25 + 50 + 100) / 3);
    // A curved 3D path passes through every point; a rectangle keeps its long side along profileX.
    const bent = engine.evaluate({ ...emptyDocument(), features: [tube({}, [[0, 0, 0], [40, 10, 20], [80, 40, 20], [100, 100, 60]])] }).geometry[0];
    assert.ok(bent.valid && bent.bounds.min.every((v, i) => v <= [0, 0, 0][i] + 5.01) && bent.bounds.max[1] > 100 && bent.bounds.max[2] > 60);
    const slab = engine.evaluate({ ...emptyDocument(), features: [{ id: 'slab', kind: 'sweep', params: { profile: { type: 'rectangle', width: 20, height: 2 }, path: { points: [[0, 0, 0], [100, 0, 0]] }, profileX: [0, 1, 0] } } as Feature] }).geometry[0];
    assert.deepEqual(slab.bounds.size.map(v => Math.round(v * 1000) / 1000), [100, 20, 2]);
    assert.throws(() => engine.evaluate({ ...emptyDocument(), features: [tube({ profileX: [0, 0, 1] })] }), /parallel to the path/);
  } finally { engine.dispose(); }
});
