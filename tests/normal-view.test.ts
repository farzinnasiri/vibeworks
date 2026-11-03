import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { normalToSurface } from '../src/web/normal-view';
import { VIEW_DIRECTIONS, viewNameSchema } from '../src/shared/protocol';
import { shotLabel } from '../src/web/shots';

test('all named views validate and eight isometric corners cover every octant', () => {
  const corners = Object.entries(VIEW_DIRECTIONS).filter(([name]) => name.startsWith('isometric'));
  assert.equal(corners.length, 8);
  assert.equal(new Set(corners.map(([, d]) => d.map(Math.sign).join(','))).size, 8);
  for (const [name] of Object.entries(VIEW_DIRECTIONS)) {
    const view = viewNameSchema.parse(name);
    assert.ok(!shotLabel({ view }, 0).includes('undefined'));
  }
  for (const [name, count] of [['isometric', 1], ['dimetric', 2], ['trimetric', 3]] as const) {
    const n = new THREE.Vector3(...VIEW_DIRECTIONS[name]).normalize();
    const lengths = n.toArray().map(c => Math.sqrt(1 - c * c).toFixed(6));
    assert.equal(new Set(lengths).size, count);
  }
});

test('Normal To follows transformed surface normals, keeps distance, then flips', () => {
  const object = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  object.rotation.set(.2, .4, .6); object.scale.set(2, 3, 4); object.updateMatrixWorld();
  const camera = new THREE.OrthographicCamera(); camera.position.set(10, -20, 15);
  const target = new THREE.Vector3();
  const normal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(object.matrixWorld)).normalize();
  const hit: THREE.Intersection = { distance: 1, object, face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: new THREE.Vector3(0, 0, 1) }, point: new THREE.Vector3(1, 2, 3) };
  const distance = camera.position.distanceTo(target);
  assert.equal(normalToSurface(camera, target, hit), true);
  const direction = camera.position.clone().sub(target).normalize();
  assert.ok(Math.abs(direction.dot(normal)) > .99999);
  assert.ok(Math.abs(camera.position.distanceTo(target) - distance) < 1e-8);
  assert.deepEqual(target.toArray(), [1, 2, 3]);
  normalToSurface(camera, target, hit);
  assert.ok(camera.position.clone().sub(target).normalize().dot(direction) < -.99999);
});
