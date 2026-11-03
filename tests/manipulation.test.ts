import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { deletionIds, emptyDocument, visibleFeatures } from '../src/cad/document';
import { parseCommand, type Feature, type GeometryInfo } from '../src/shared/protocol';

const box: Feature = { id: 'base', kind: 'box', params: { origin: [0, 0, 0], size: [10, 20, 5] } };
const transform = { target: 'base', translation: [10, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 90, origin: [0, 0, 0], scale: 2, copy: false };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('real OCCT mechanical operations: profiles, revolve, holes, transforms, mirror, Booleans and chamfer', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const evaluate = (features: Feature[]): GeometryInfo => {
    const result = engine.evaluate({ ...emptyDocument(), features });
    const geometry = result.geometry.at(-1)!;
    assert.equal(geometry.valid, true); return geometry;
  };
  try {
    let g = evaluate([box, { id: 'moved', kind: 'transform', params: transform as Extract<Feature, {kind: 'transform'}>['params'] }]);
    close(g.volumeMm3, 8000);
    [-30, 0, 0].forEach((v, i) => close(g.bounds.min[i], v));
    [40, 20, 10].forEach((v, i) => close(g.bounds.size[i], v));
    g = evaluate([box, { id: 'mirrored', kind: 'mirror', params: { target: 'base', plane: 'YZ', origin: [3, 0, 0], copy: true } }]);
    close(g.volumeMm3, 1000); close(g.bounds.min[0], -4); close(g.bounds.max[0], 6);
    g = evaluate([box, { id: 'bevel', kind: 'chamfer', params: { target: 'base', edges: 'vertical', distance: 1 } }]);
    close(g.volumeMm3, 990);
    const cube: Feature = { ...box, params: { origin: [0, 0, 0], size: [10, 10, 10] } };
    const tool: Feature = { id: 'tool', kind: 'box', params: { origin: [5, 0, 0], size: [10, 10, 10] } };
    for (const [kind, volume] of [['union', 1500], ['intersect', 500], ['subtract', 500]] as const) {
      g = evaluate([cube, tool, { id: 'result', kind, params: { target: 'base', tools: ['tool'] } }]); close(g.volumeMm3, volume);
    }
    g = evaluate([{ id: 'profile', kind: 'extrude', params: { profile: { type: 'rectangle', width: 10, height: 20 }, origin: [3, 4, 5], plane: 'XY', distance: 6 } }]);
    close(g.volumeMm3, 1200); [-2, -6, 5].forEach((v, i) => close(g.bounds.min[i], v));
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      g = evaluate([{ id: 'profile', kind: 'extrude', params: { profile: { type: 'polygon', points: [[0, 0], [10, 0], [0, 10]] }, origin: [0, 0, 0], plane, distance: 4 } }]); close(g.volumeMm3, 200);
    }
    g = evaluate([{ id: 'profile', kind: 'extrude', params: { profile: { type: 'circle', radius: 4 }, origin: [0, 0, 0], plane: 'XY', distance: 5 } }]); close(g.volumeMm3, 80 * Math.PI);
    for (const angle of [360, 180]) {
      g = evaluate([{ id: 'turned', kind: 'revolve', params: { points: [[2, 0], [4, 0], [4, 5], [2, 5]], origin: [10, 20, 30], angleDegrees: angle } }]);
      close(g.volumeMm3, 60 * Math.PI * angle / 360); close(g.bounds.min[2], 30); close(g.bounds.max[2], 35);
    }
    g = evaluate([box, { id: 'holes', kind: 'drill_holes', params: { target: 'base', axis: 'Z', diameter: 2, centers: [[2, 2, 999], [8, 18, 0]] } }]); close(g.volumeMm3, 1000 - 10 * Math.PI);
    for (const axis of ['X', 'Y'] as const) {
      g = evaluate([box, { id: 'holes', kind: 'drill_holes', params: { target: 'base', axis, diameter: 2, centers: [[5, 10, 2.5]] } }]); close(g.volumeMm3, 1000 - (axis === 'X' ? 10 : 20) * Math.PI);
    }
    const badHole: Feature = { id: 'bad_hole', kind: 'drill_holes', params: { target: 'base', axis: 'Z', diameter: 2, centers: [[50, 50, 0]] } };
    assert.throws(() => evaluate([box, badHole]), /removes no material/);
    // Failed replay retains the last evaluated graph, including its real STEP export.
    const step = await engine.export('step', ['holes']); assert.ok(step.bytes.byteLength > 1000);
    assert.throws(() => evaluate([box, { id: 'bad', kind: 'extrude', params: { profile: { type: 'polygon', points: [[0, 0], [10, 10], [10, 0], [0, 10]] }, plane: 'XY', origin: [0, 0, 0], distance: 5 } }]), /valid|rebuild|solid/i);
  } finally { engine.dispose(); }
});

test('copies keep their source visible and deletion requires explicit transitive cascade', () => {
  const doc = { ...emptyDocument(), features: [box,
    { id: 'copy', kind: 'transform', params: { ...transform, copy: true } },
    { id: 'mirror', kind: 'mirror', params: { target: 'copy', plane: 'YZ', origin: [0, 0, 0], copy: false } },
  ] as Feature[] };
  assert.deepEqual(visibleFeatures(doc), ['base', 'mirror']);
  assert.throws(() => deletionIds(doc, ['base'], false), e => (e as {code: string}).code === 'FEATURE_HAS_DEPENDENTS');
  assert.deepEqual(deletionIds(doc, ['base'], true), ['base', 'copy', 'mirror']);
  assert.deepEqual(deletionIds(doc, ['mirror'], false), ['mirror']);
  assert.throws(() => deletionIds(doc, ['missing'], true), /does not exist/);
  assert.throws(() => parseCommand({ type: 'apply_edits', params: { documentId: doc.documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'x', kind: 'transform', params: { ...transform, rotationAxis: [0, 0, 0] } } }] } }), /nonzero/);
});
