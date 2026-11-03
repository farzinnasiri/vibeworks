import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { shotCamera, scaleBarLength, shotLabel } from '../src/web/shots';
import { commandSchemas } from '../src/shared/protocol';

// A 100 x 40 x 20 mm block from the origin, as framed points (its corners).
const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].flatMap(z => [x * 100, y * 40, z * 20])));
const scene = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 40, 20));

test('orthographic shots fit their frame and report exact scale and camera', () => {
  const front = shotCamera({ view: 'front' }, 0, corners, scene, 2, 200);
  // Seen from -Y the block is 100 wide and 20 high; a 2:1 tile is width-bound: 100 / 2 · 1.06 half height.
  assert.equal(front.tile.label, 'FRONT · from −Y');
  assert.deepEqual(front.tile.target, [50, 20, 10]);
  assert.ok(Math.abs(front.tile.heightMm - 53) < 1e-6 && Math.abs(front.tile.widthMm - 106) < 1e-6, JSON.stringify(front.tile));
  assert.ok(Math.abs(front.tile.mmPerPixel - 53 / 200) < 1e-9);
  assert.ok(front.tile.eye[1] < 0 && front.tile.eye[0] === 50 && front.tile.eye[2] === 10);
  // The whole block stays between near and far.
  const camera = front.camera as THREE.OrthographicCamera, depth = -front.tile.eye[1];
  assert.ok(camera.near < depth - 40 && camera.far > depth + 40);
  const detail = shotCamera({ from: [0, 0, 1], frame: { center: [10, 10, 20], radiusMm: 5 } }, 1, [], scene, 1, 100);
  assert.deepEqual(detail.tile.up, [0, 1, 0]);
  assert.ok(Math.abs(detail.tile.heightMm - 10.6) < 1e-9 && detail.tile.eye[2] > 20);
  assert.throws(() => shotCamera({ from: [0, 0, 1], up: [0, 0, 2] }, 0, corners, scene, 1, 100), /parallel/);
});

test('perspective shots stand back far enough to keep the frame in view', () => {
  const shot = shotCamera({ view: 'isometric', projection: 'perspective', fovDegrees: 30 }, 0, corners, scene, 1, 300);
  const camera = shot.camera as THREE.PerspectiveCamera;
  camera.updateMatrixWorld();
  for (let i = 0; i < corners.length; i += 3) {
    const p = new THREE.Vector3(corners[i], corners[i + 1], corners[i + 2]).project(camera);
    assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1, JSON.stringify(p));
  }
  assert.equal(shot.tile.fovDegrees, 30);
  assert.ok(Math.abs(shot.tile.mmPerPixel / (shot.tile.heightMm / 300) - 1) < 1e-5);
});

test('shot requests are validated before rendering', () => {
  const parse = (params: unknown) => commandSchemas.render_views.safeParse(params).success;
  assert.ok(parse({ shots: [{ from: [1, 1, 0], frame: { featureIds: ['a'] }, hide: ['b'], section: { axis: 'Z', offset: 3 } }] }));
  assert.ok(!parse({ views: ['top'], shots: [{ view: 'top' }] }));
  assert.ok(!parse({ shots: [{ view: 'top', from: [0, 0, 1] }] }));
  assert.ok(parse({ shots: [{ fovDegrees: 40 }] }));
  assert.ok(!parse({ shots: [{ projection:'orthographic', fovDegrees:40 }] }));
  const shorthand=commandSchemas.render_views.parse({shots:[{view:'perspective',from:[1,-2,1],fovDegrees:35}]}).shots![0];
  assert.deepEqual(shorthand,{from:[1,-2,1],projection:'perspective',fovDegrees:35});
  assert.deepEqual(commandSchemas.render_views.parse({shots:[{view:'perspective'}]}).shots![0],{view:'isometric',projection:'perspective'});
  assert.ok(!parse({ shots: Array.from({ length: 13 }, () => ({ view: 'top' })) }));
  assert.ok(!parse({ shots: [{ frame: { min: [1, 0, 0], max: [0, 1, 1] } }] }));
  assert.equal(shotLabel({ from: [1, -1, 0.25] }, 2), 'SHOT 3 · from [1, -1, 0.25]');
  // A section shot without a direction looks at the cut face from the removed side.
  const cut = shotCamera({ section: { axis: 'Y', offset: 20 } }, 0, corners, scene, 1, 100);
  assert.ok(cut.tile.eye[1] > 40 && cut.tile.eye[0] === 50 && cut.tile.label.startsWith('SECTION Y ≤ 20'));
  assert.ok(shotCamera({ section: { axis: 'Z', offset: 5, flip: true } }, 0, corners, scene, 1, 100).tile.eye[2] < 0);
  assert.deepEqual([0.7, 3, 14, 230].map(scaleBarLength), [0.5, 2, 10, 200]);
});
