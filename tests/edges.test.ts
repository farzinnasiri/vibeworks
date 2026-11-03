import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { deletionIds, emptyDocument, validateDocument } from '../src/cad/document';
import type { CadDocument, Feature } from '../src/shared/protocol';

test('edge queries select edges by direction, plane, nearby points and length, re-resolved exactly', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const box: Feature = { id: 'b', kind: 'box', params: { origin: [0, 0, 0], size: [40, 20, 10] } };
  const volume = (edges: Extract<Feature, { kind: 'chamfer' }>['params']['edges']) => {
    const doc: CadDocument = { ...emptyDocument(), features: [box, { id: 'c', kind: 'chamfer', params: { target: 'b', distance: 1, edges } }] };
    return engine.evaluate(doc).geometry.find(g => g.featureId === 'c')!.volumeMm3;
  };
  // An equal chamfer d removes d²/2 per unit length of a straight edge (corners add small extra terms).
  const full = 40 * 20 * 10;
  try {
    const one = full - volume({ near: [[20, 0, 10]] });                 // the front top edge, 40 long
    assert.ok(Math.abs(one - 0.5 * 40) < 1e-6, String(one));
    const topFace = full - volume({ on: { axis: 'Z', value: 10 } });   // all four top edges: 2·40 + 2·20 = 120 long
    assert.ok(topFace > 0.5 * 120 - 2 && topFace < 0.5 * 120, String(topFace));
    const alongX = full - volume({ parallel: 'X' });                     // four 40 mm edges
    assert.ok(Math.abs(alongX - 0.5 * 160) < 1e-6, String(alongX));          // parallel edges never meet: exact
    const longOnes = full - volume({ minLengthMm: 30 });                 // the same four 40 mm edges
    assert.ok(Math.abs(longOnes - alongX) < 1e-6);
    const combined = full - volume({ parallel: 'X', on: { axis: 'Z', value: 0 } });  // the two bottom X edges
    assert.ok(Math.abs(combined - 0.5 * 80) < 1e-6, String(combined));
    assert.throws(() => volume({ near: [[500, 500, 500]] }), /No queried edges found on 'b'/);
  } finally { engine.dispose(); }
});

test('a failed blend tries each edge alone and says which to leave out', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  // Rounded corners leave tangent vertical seams; filleting every vertical edge again cannot blend them.
  const doc: CadDocument = { ...emptyDocument(), features: [
    { id: 'p', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 5] } },
    { id: 'r', kind: 'fillet', params: { target: 'p', radius: 3, edges: 'vertical' } },
    { id: 'again', kind: 'fillet', params: { target: 'r', radius: 1, edges: 'vertical' } },
  ] };
  try {
    assert.throws(() => engine.evaluate(doc), (error: Error) => {
      if (/blends even alone/.test(error.message)) { assert.match(error.message, /Leave them out of the selection/); assert.equal((error as any).details.edges.length, 8); return true; }
      // If this kernel build can blend them after all, the case no longer exercises the hint.
      throw error;
    });
  } catch (error) {
    if (error instanceof assert.AssertionError && /Missing expected exception/.test(error.message)) return;
    throw error;
  } finally { engine.dispose(); }
});

test('a seam query blends exactly where two united inputs meet, and follows them on rebuild', async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }); setOC(oc);
  const engine = new GeometryEngine(oc);
  const features = (radius: number, between: [string, string] = ['plate', 'boss']): Feature[] => [
    { id: 'plate', kind: 'box', params: { origin: [-20, -20, 0], size: [40, 40, 4] } },
    { id: 'boss', kind: 'cylinder', params: { origin: [0, 0, 2], radius, height: 20 } },
    { id: 'stray', kind: 'box', params: { origin: [100, 100, 100], size: [1, 1, 1] } },
    { id: 'body', kind: 'union', params: { target: 'plate', tools: ['boss'] } },
    { id: 'root', kind: 'fillet', params: { target: 'body', radius: 2, edges: { between } } },
  ];
  // Pappus: a concave ring blend of radius r around a boss of radius R adds 2π(R + d)·r²(1 − π/4),
  // with the section centroid d = r(10 − 3π)/(12 − 3π) from the boss wall.
  const added = (R: number, r = 2) => 2 * Math.PI * (R + r * (10 - 3 * Math.PI) / (12 - 3 * Math.PI)) * r * r * (1 - Math.PI / 4);
  try {
    for (const R of [5, 7]) {
      const evaluation = engine.evaluate({ ...emptyDocument(), features: features(R) });
      const volume = (id: string) => evaluation.geometry.find(g => g.featureId === id)!.volumeMm3;
      assert.ok(Math.abs(volume('root') - volume('body') - added(R)) < 0.01, `${R}: ${volume('root') - volume('body')} vs ${added(R)}`);
      // The seam inputs stay construction; only the blend is a visible result besides the unrelated box.
      assert.deepEqual(evaluation.visibleFeatureIds.sort(), ['root', 'stray']);
    }
    assert.throws(() => engine.evaluate({ ...emptyDocument(), features: features(5, ['plate', 'stray']) }),
      (error: Error & { code?: string }) => error.code === 'EMPTY_EDGE_SELECTION' && /surfaces of both 'plate' and 'stray'/.test(error.message));
    assert.throws(() => validateDocument({ ...emptyDocument(), features: [...features(5).slice(0, 4), { id: 'root', kind: 'fillet', params: { target: 'body', radius: 2, edges: { between: ['body', 'boss'] } } }] }), /not the target/);
    const doc = { ...emptyDocument(), features: features(5) };
    assert.deepEqual(deletionIds(doc, ['boss'], true), ['boss', 'body', 'root']);
  } finally { engine.dispose(); }
});
