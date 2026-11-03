import * as THREE from 'three';

/** Edit-mode defaults. Geometry and authored material properties stay unchanged. */
export const DEFAULT_WORKBENCH_EDGES = false;
export const WORKBENCH_PIXEL_BUDGET = 4_200_000;

export function workbenchPixelRatio(width: number, height: number, density: number) {
  return Math.min(Math.max(1, density), 2, Math.sqrt(WORKBENCH_PIXEL_BUDGET / (Math.max(1, width) * Math.max(1, height))));
}

/** One fixed key casts shadows. Camera-only changes reuse its map. No fullscreen postprocessing. */
export function addWorkbenchLights(scene: THREE.Scene, bounds: THREE.Box3) {
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1);
  const ambient = new THREE.HemisphereLight(0xffffff, 0x7b8994, 0.55);
  ambient.position.set(0, 0, 1); scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.copy(center).addScaledVector(new THREE.Vector3(-1.3, -2.1, 3).normalize(), radius * 3);
  key.target.position.copy(center); key.castShadow = true; key.userData.workbenchKey = true;
  const shadow = key.shadow;
  Object.assign(shadow.camera, { left: -radius * 1.05, right: radius * 1.05, top: radius * 1.05, bottom: -radius * 1.05, near: radius, far: radius * 5 });
  shadow.camera.updateProjectionMatrix(); shadow.mapSize.set(1024, 1024);
  shadow.bias = -0.00015; shadow.normalBias = radius * 0.0005; shadow.radius = 1.5;
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.copy(center).addScaledVector(new THREE.Vector3(1.5, 1, 0.8).normalize(), radius * 3);
  fill.target.position.copy(center);
  // A soft light from the viewer keeps faces turned toward the camera readable, including dark authored
  // materials against the dark interface theme. Display only: no shadow, no material change, not used by Studio.
  const head = new THREE.DirectionalLight(0xffffff, 0.55);
  head.position.copy(center).add(new THREE.Vector3(1, -1, 1).normalize().multiplyScalar(radius * 3));
  head.target.position.copy(center); head.userData.workbenchHeadlight = true;
  scene.userData.headlight = head;
  scene.add(key, key.target, fill, fill.target, head, head.target);
  scene.environmentIntensity = 0.5;
  scene.environmentRotation.set(Math.PI / 2, 0, 0, 'ZXY');
  return key;
}

/** Point the workbench headlight along the current view. Cheap enough for every drawn frame. */
export function aimHeadlight(scene: THREE.Scene, camera: THREE.Camera, target: THREE.Vector3) {
  const head = scene.userData.headlight as THREE.DirectionalLight | undefined;
  if (!head) return;
  head.target.position.copy(target);
  head.position.copy(target).add(camera.position.clone().sub(target).normalize().multiplyScalar(Math.max(head.position.distanceTo(head.target.position), 1)));
  head.updateMatrixWorld(); head.target.updateMatrixWorld();
}

/** Linear luminance below which an authored surface is treated as dark for edge separation. */
export const DARK_SURFACE_LUMINANCE = 0.06;
export const isDarkSurface = (color: THREE.Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b < DARK_SURFACE_LUMINANCE;
