import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import type { CadDocument, Feature } from '../src/shared/protocol';
import { emptyDocument } from '../src/cad/document';
import { indexedShapes, topologyMesh } from '../src/cad/topology';
import { makeCylinder } from 'replicad';
import { triangulateFace } from 'replicad/shape-functions';

test('topology mesh releases native point temporaries and rejects excess values before extraction', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const shape = makeCylinder(10, 20), options = { tolerance: 0.05, angularTolerance: 0.15 };
  let points = 0, releases = 0;
  const point = oc.Poly_Triangulation.prototype.Node, dispose = oc.gp_Pnt.prototype.delete;
  t.mock.method(oc.Poly_Triangulation.prototype, 'Node', function(this: InstanceType<typeof oc.Poly_Triangulation>, ...args: Parameters<typeof point>) { points++; return point.apply(this, args); });
  t.mock.method(oc.gp_Pnt.prototype, 'delete', function(this: InstanceType<typeof oc.gp_Pnt>) { releases++; return dispose.call(this); });
  try {
    const mesh = topologyMesh(oc, shape, options);
    assert.ok(points > 50);
    assert.ok(releases >= points, 'native points must be released before the synchronous mesh call returns');
    const before = points;
    assert.throws(() => topologyMesh(oc, shape, options, 1), { code: 'MODEL_TOO_COMPLEX' });
    assert.equal(points, before, 'over-budget native triangulation is rejected before copying its vertices');
    const reference = { vertices: [] as number[], normals: [] as number[], triangles: [] as number[] };
    const faces = indexedShapes(oc, shape.wrapped, 'FACE');
    try {
      for (const raw of faces) {
        const face = oc.TopoDS.Face(raw);
        try {
          const prior = triangulateFace(face, reference.vertices.length / 3)!;
          reference.vertices.push(...prior.vertices); reference.normals.push(...prior.verticesNormals); reference.triangles.push(...prior.trianglesIndexes);
        } finally { face.delete(); }
      }
    } finally { faces.forEach(face => face.delete()); }
    assert.deepEqual(mesh.vertices, reference.vertices.map(Math.fround));
    assert.deepEqual(mesh.normals, reference.normals.map(Math.fround));
    assert.deepEqual(mesh.triangles, reference.triangles);
  } finally { shape.delete(); }
});

test('construction keeps face lineage without eagerly measuring every input face', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const surfaceProperties = oc.BRepGProp.SurfaceProperties;
  let faceMeasurements = 0;
  t.mock.method(oc.BRepGProp, 'SurfaceProperties', (...args: Parameters<typeof surfaceProperties>) => {
    if (args[0].ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faceMeasurements++;
    return surfaceProperties(...args);
  });
  const document: CadDocument = { ...emptyDocument(), features: [
    { id: 'stock', kind: 'box', params: { origin: [0, 0, 0], size: [30, 20, 10] } },
    { id: 'tool', kind: 'box', params: { origin: [10, -1, -1], size: [5, 22, 12] } },
    { id: 'cut', kind: 'subtract', params: { target: 'stock', tools: ['tool'] } },
  ] };
  try {
    const exact = engine.evaluate(document, [], undefined, undefined, { meshes: false });
    assert.equal(exact.geometry.at(-1)!.valid, true);
    assert.equal(faceMeasurements, 0, 'Construction needs face lineage, not full inspection metrics for consumed inputs.');
    const shown = engine.evaluate(document);
    assert.ok(faceMeasurements > 0, 'The final display still receives exact face metrics.');
    assert.ok(shown.meshes[0].topology!.faces.some(face => face.lineage.includes('in0:+Z')));
    assert.equal(shown.geometry.at(-1)!.volumeMm3, exact.geometry.at(-1)!.volumeMm3);
  } finally { engine.dispose(); }
});

test('blend context finds adjacent source faces without full topology measurements', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const surfaceProperties = oc.BRepGProp.SurfaceProperties;
  let faceMeasurements = 0;
  t.mock.method(oc.BRepGProp, 'SurfaceProperties', (...args: Parameters<typeof surfaceProperties>) => {
    if (args[0].ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faceMeasurements++;
    return surfaceProperties(...args);
  });
  const document: CadDocument = { ...emptyDocument(), features: [
    { id: 'stock', kind: 'box', params: { origin: [0, 0, 0], size: [30, 20, 10] } },
    { id: 'blend', kind: 'fillet', params: { target: 'stock', radius: 1, edges: { near: [[0, 0, 5]], toleranceMm: 0.001 } } },
  ] };
  try {
    const exact = engine.evaluate(document, [], undefined, undefined, { meshes: false });
    assert.equal(faceMeasurements, 0, 'Blend context needs adjacency and lineage, not every face metric.');
    const context = exact.geometry.at(-1)!.diagnostics!.adjacentFaces as { selectedFaces: number; patches: { names: string[] }[] };
    assert.equal(context.selectedFaces, 2);
    assert.equal(context.patches.length, 2);
    assert.ok(context.patches.every(patch => patch.names.length > 0));
  } finally { engine.dispose(); }
});

test('exact edge deduplication scales with topology and remains correct when shape hashes collide', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const original = oc.TopoDS_Shape.prototype.IsSame;
  let comparisons = 0;
  t.mock.method(oc.TopoDS_Shape.prototype, 'IsSame', function (this: InstanceType<typeof oc.TopoDS_Shape>, other: InstanceType<typeof oc.TopoDS_Shape>) {
    comparisons++; return original.call(this, other);
  });
  const document: CadDocument = { ...emptyDocument(), features: [
    { id: 'box', kind: 'box' as const, params: { origin: [0, 0, 0], size: [1, 1, 1] } },
    { id: 'copies', kind: 'pattern' as const, params: { target: 'box', layout: { type: 'linear' as const, direction: [1, 0, 0], spacing: 3, count: 64 } } },
  ] };
  try {
    const result = engine.evaluate(document, [], undefined, undefined, { meshes: false });
    assert.equal(result.geometry[1].edgeCount, 768);
    assert.equal(result.geometry[1].solidCount, 64);
    assert.ok(Math.abs(result.geometry[1].volumeMm3 - 64) < 1e-6);
    assert.ok(comparisons < 10000, `${comparisons} native equality calls for 768 edges`);
    t.mock.method(oc.ReplicadShapeHasher, 'HashCode', () => 1);
    // A collision cannot merge different edges. Use the real topology iterator, outside its result cache.
    const measured = engine.measure('again', engine['shapes'].get('copies')!);
    assert.equal(measured.edgeCount, 768);
  } finally { engine.dispose(); }
});

test('translated compound bounds match independent OCCT measurement; rotations and nested instances remain exact', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const source: CadDocument = { ...emptyDocument(), features: [
    { id: 'curve', kind: 'cylinder', params: { origin: [4, -7, 3], radius: 3, height: 9 } },
    { id: 'block', kind: 'box', params: { origin: [-12, 5, -2], size: [2, 8, 4] } },
  ] };
  const instance = (id: string, document: string, angleDegrees: number): Feature => ({ id, kind: 'instance', params: {
    document, translation: [13, -28, 47], origin: [3, -6, 2], rotationAxis: [0, 0, 1], angleDegrees,
  } });
  const nested: CadDocument = { ...emptyDocument(), features: [instance('rotated', source.documentId, 37)] };
  const root: CadDocument = { ...emptyDocument(), features: [instance('translated', source.documentId, 0), instance('rotated', source.documentId, 23), instance('nested', nested.documentId, 0)] };
  try {
    const evaluation = engine.evaluate(root, [source, nested]);
    for (const info of evaluation.geometry) {
      const independent = engine.measure(info.featureId, engine['shapes'].get(info.featureId)!);
      for (const field of ['min', 'max', 'size'] as const) for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(independent.bounds[field][i] - info.bounds[field][i]) < 1e-5);
      }
      assert.equal(info.valid, true);
      assert.equal(info.volumeMm3, independent.volumeMm3);
      assert.equal(info.solidCount, independent.solidCount);
    }
  } finally { engine.dispose(); }
});
