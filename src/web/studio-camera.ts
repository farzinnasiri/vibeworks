import * as THREE from 'three';
import { imageFrame } from '../shared/studio';
import { shotCamera } from './shots';

/** Fit the actual silhouette while retaining the full live viewport around the image frame. */
export function fitStudioCamera(projection: 'perspective' | 'orthographic', direction: [number, number, number], points: ArrayLike<number>, bounds: THREE.Box3,
  viewport: { width: number; height: number }, image: { width: number; height: number }, focalLengthMm?: number) {
  const frame = imageFrame(viewport, image);
  const heightRatio = frame.height / viewport.height;
  const liveFov = focalLengthMm ? studioLensFov(focalLengthMm, viewport, image) : 35;
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(liveFov) / 2) * heightRatio));
  const shot = shotCamera({ from: direction, projection, fovDegrees: projection === 'perspective' ? fov : undefined }, 0, points, bounds, frame.width / frame.height, frame.height);
  if (shot.camera instanceof THREE.PerspectiveCamera) {
    shot.camera.fov = liveFov; shot.camera.aspect = viewport.width / viewport.height;
  } else {
    const half = shot.camera.top / heightRatio;
    shot.camera.top = half; shot.camera.bottom = -half;
    shot.camera.right = half * viewport.width / viewport.height; shot.camera.left = -shot.camera.right;
  }
  // shotCamera supplies an image-plane up vector. OrbitControls keeps a fixed Z-up orbit axis;
  // copying that tilted vector into its camera rolls the floor on the next orbit.
  shot.camera.up.set(0, 0, 1);
  shot.camera.updateProjectionMatrix(); return shot;
}

/** A 35 mm film gate fitted to the output, including the crop inside the live viewport. */
export function studioLensFov(focalLengthMm: number, viewport: { width: number; height: number }, image: { width: number; height: number }) {
  const filmHeight = 35 / Math.max(image.width / image.height, 1);
  const ratio = imageFrame(viewport, image).height / viewport.height;
  return THREE.MathUtils.radToDeg(2 * Math.atan(filmHeight / (2 * focalLengthMm * ratio)));
}

/** Change perspective compression while preserving the subject's size at the orbit target. */
export function changeStudioLens(camera: THREE.PerspectiveCamera, target: THREE.Vector3, fov: number) {
  const offset = camera.position.clone().sub(target);
  const distance = offset.length() * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  camera.position.copy(target).add(offset.normalize().multiplyScalar(distance));
  camera.fov = fov; camera.lookAt(target); camera.updateProjectionMatrix();
}

/** Resize the window around the current view instead of replacing a deliberate close-up with Fit. */
export function resizeStudioCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  before: { width: number; height: number }, after: { width: number; height: number }, image?: { width: number; height: number }) {
  // A fixed output frame must retain its composition as the surrounding viewport changes shape.
  const ratio = image ? (imageFrame(before, image).height / before.height) / (imageFrame(after, image).height / after.height) : undefined;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = after.width / after.height;
    if (ratio) camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * ratio));
  }
  else if (ratio) {
    camera.top *= ratio; camera.bottom *= ratio;
    const halfWidth = (camera.top - camera.bottom) / 2 * after.width / after.height;
    camera.left = -halfWidth; camera.right = halfWidth;
  }
  else {
    camera.left *= after.width / before.width; camera.right *= after.width / before.width;
    camera.top *= after.height / before.height; camera.bottom *= after.height / before.height;
  }
  camera.updateProjectionMatrix();
}

/** Match the size of the focus plane when changing projection, preserving the target and direction. */
export function matchStudioProjection(current: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  next: THREE.PerspectiveCamera | THREE.OrthographicCamera, target: THREE.Vector3, aspect: number) {
  const offset = current.position.clone().sub(target);
  const height = current instanceof THREE.PerspectiveCamera
    ? 2 * offset.length() * Math.tan(THREE.MathUtils.degToRad(current.fov) / 2) / current.zoom
    : (current.top - current.bottom) / current.zoom;
  next.up.set(0, 0, 1); next.zoom = 1;
  if (next instanceof THREE.PerspectiveCamera) {
    next.aspect = aspect;
    const distance = height / (2 * Math.tan(THREE.MathUtils.degToRad(next.fov) / 2));
    next.position.copy(target).add(offset.normalize().multiplyScalar(distance));
  } else {
    next.top = height / 2; next.bottom = -next.top;
    next.right = next.top * aspect; next.left = -next.right;
    next.position.copy(current.position);
  }
  next.lookAt(target); next.updateProjectionMatrix();
}
