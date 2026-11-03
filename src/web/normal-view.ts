import * as THREE from 'three';

/** Display tessellation supplies a local surface direction, never an exact CAD face reference. */
export function normalToSurface(camera: THREE.Camera, target: THREE.Vector3, hit: THREE.Intersection) {
  if (!hit.face) return false;
  const normal = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  const offset = camera.position.clone().sub(target), direction = offset.clone().normalize();
  if (normal.dot(direction) < 0) normal.negate();
  // Choosing the same facing surface again shows its opposite side.
  if (normal.dot(direction) > 0.9999) normal.negate();
  target.copy(hit.point); camera.position.copy(target).addScaledVector(normal, offset.length());
  camera.up.set(0, 0, 1);
  camera.lookAt(target); return true;
}
