import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { attachmentPlacement } from '../src/cad/frames';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument } from '../src/cad/document';
import type { CadDocument, Feature, Vector3 } from '../src/shared/protocol';
import { add, expectedPlacement, placementCases, scale, turn, unit, cross } from './fixtures/mount-placement';

const close = (actual: Vector3, expected: Vector3, tolerance = 1e-6) => expected.forEach((n, i) =>
  assert.ok(Math.abs(actual[i] - n) < tolerance, `${actual} != ${expected}`));

test('positive target-normal twist then mate about the twisted local U has independently derived landmarks', () => {
  for (const c of placementCases()) {
    const expected = expectedPlacement(c);
    const p = attachmentPlacement(c.source, c.target, { source: { featureId: 'box', name: 'top' }, target: { frame: c.target }, mode: c.mode, offset: c.offset, twistDegrees: c.twistDegrees });
    const actual = (point: Vector3) => add(turn(point, p.rotationAxis, p.angleDegrees), p.translation);
    const su = unit(c.source.xDirection), sn = unit(c.source.normal), sv = cross(sn, su);
    const landmarks = [c.source.origin, add(c.source.origin, su), add(c.source.origin, sv), add(c.source.origin, sn), [20,0,4] as Vector3];
    for (const point of landmarks) close(actual(point), expected.point(point));
    close(actual(c.source.origin), expected.landing);
    if (c.name === 'review-box-mate-90') {
      close(expected.u, [-1,0,0]); close(expected.v, [0,1,0]); close(expected.n, [0,0,-1]);
      close(actual([20,0,4]), [26,-17,13]);
      close(expected.min, [26,-17,13]); close(expected.max, [46,-7,17]);
    }
    if (c.name === 'review-box-mate--90') {
      close(expected.min, [46,-27,13]); close(expected.max, [66,-17,17]);
    }
    // Offset is always measured in the original target axes, irrespective of twist/mate.
    assert.ok(Math.abs(Math.hypot(...add(expected.landing, scale(c.target.origin, -1))) - Math.sqrt(50)) < 1e-9);
  }
});

test('exact OCCT placements match all box corners and resolved mount axes for align/mate and signed twists', async t => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} });
  setOC(oc); const engine = new GeometryEngine(oc); t.after(() => engine.dispose());
  for (const c of placementCases()) {
    const source: CadDocument = { ...emptyDocument(), features: [{ id: 'box', kind: 'box',
      params: { origin: [0,0,0], size: [20,10,4] }, mounts: [{ name: 'top', frame: c.source }] }] };
    const feature: Feature = { id: 'placed', kind: 'instance', params: {
      document: source.documentId, origin: [0,0,0], translation: [0,0,0], rotationAxis: [0,0,1], angleDegrees: 0,
      attachment: { source: { featureId: 'box', name: 'top' }, target: { frame: c.target }, mode: c.mode, twistDegrees: c.twistDegrees, offset: c.offset },
    } };
    const g = engine.evaluate({ ...emptyDocument(), features: [feature] }, [source]).geometry[0];
    const expected = expectedPlacement(c);
    assert.equal(g.valid, true, c.name); assert.ok(Math.abs(g.volumeMm3 - 800) < 1e-6);
    close(g.bounds.min, expected.min); close(g.bounds.max, expected.max);
    const mount = g.mounts!.find(m => m.name === 'box/top')!.frame;
    close(mount.origin, expected.landing); close(mount.xDirection, expected.u); close(mount.normal, expected.n);
  }
});
