import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import type { Presentation } from '../shared/protocol';
import { NEUTRAL_COLOR } from '../shared/materials';
import { studioSettings } from '../shared/studio';
import { displayBuffers, modelBounds, partMaterial, placeDisplay, stageStudio } from './scene';
import { applyFloorTextures, loadFloorTextures, loadStudioEnvironment, prepareSweepTextures, studioPreviewLights } from './studio-scene';
import { addSurfaceGraphics, liftGraphicForTracing, studioUnitMm } from './surface-graphics';

/** Model geometry and printed graphics, prepared once per model and shared by every composed scene. */
export interface StudioAssets {
  parts: { data: Evaluation['meshes'][number]; geometry: THREE.BufferGeometry }[];
  graphics: { featureId: string; graphicId: string; geometry: THREE.BufferGeometry; texture: THREE.Texture | null; owner: THREE.Material }[];
  /** Model bounds and center in millimetres; scene unit in millimetres. */
  bounds: THREE.Box3; center: THREE.Vector3; radius: number; unit: number;
  /** Flat xyz silhouette sample in scene units, for framing. */
  points: number[];
}

export async function buildStudioAssets(evaluation: Evaluation, active: () => boolean = () => true): Promise<StudioAssets | undefined> {
  const visible = evaluation.meshes.filter(m => evaluation.visibleFeatureIds.includes(m.featureId));
  const raw = modelBounds(evaluation);
  const bounds = new THREE.Box3(new THREE.Vector3(...raw.min), new THREE.Vector3(...raw.max));
  const center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
  const unit = studioUnitMm(radius);
  const cache = new Map<number[], { solid: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  const parts = visible.map(data => ({ data, geometry: displayBuffers(data, cache).solid }));
  for (const asset of cache.values()) asset.edges.dispose();
  const holder = new THREE.Group(), graphics: StudioAssets['graphics'] = [];
  const release = () => { for (const part of new Set(parts.map(p => p.geometry))) part.dispose(); for (const g of graphics) { g.geometry.dispose(); g.owner.dispose(); } };
  try { await addSurfaceGraphics(holder, visible, active); }
  catch (error) { holder.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }); release(); throw error; }
  for (const mesh of holder.children) if (mesh instanceof THREE.Mesh) {
    // Graphics sit far enough above their surface that the path tracer cannot skip both together.
    liftGraphicForTracing(mesh.geometry, center, unit);
    const owner = mesh.material as THREE.MeshStandardMaterial;
    graphics.push({ featureId: mesh.userData.featureId, graphicId: mesh.userData.graphicId, geometry: mesh.geometry, texture: owner.map, owner });
  }
  if (!active()) { release(); return undefined; }
  const points: number[] = [], total = parts.reduce((sum, p) => sum + p.data.vertices.length, 0);
  const stride = Math.max(1, Math.ceil(total / 180000)) * 3, point = new THREE.Vector3();
  for (const { data } of parts) {
    const matrix = data.transform ? new THREE.Matrix4().fromArray(data.transform) : undefined;
    for (let i = 0; i < data.vertices.length; i += stride) {
      point.fromArray(data.vertices, i); if (matrix) point.applyMatrix4(matrix);
      point.sub(center).divideScalar(unit); points.push(point.x, point.y, point.z);
    }
  }
  return { parts, graphics, bounds, center, radius, unit, points };
}

export function disposeStudioAssets(assets: StudioAssets) {
  for (const geometry of new Set(assets.parts.map(p => p.geometry))) geometry.dispose();
  for (const g of assets.graphics) { g.geometry.dispose(); g.owner.dispose(); }
}

/** Environment and floor images for the settings. Cached by the loaders. */
export async function loadStudioLook(settings: Presentation, radius: number) {
  const s = studioSettings(settings);
  const [environment, floor] = await Promise.all([loadStudioEnvironment(s.environmentPreset), loadFloorTextures(s.floor)]);
  return { environment, floor: prepareSweepTextures(floor, settings, Math.max(radius, 1)) };
}

/**
 * A complete Studio scene in scene units centered on the model. 'preview' is the raster form with the
 * shadow light; 'trace' is what the path tracer sees. Neither changes the shared assets.
 */
export function composeStudioScene(assets: StudioAssets, settings: Presentation, look: Awaited<ReturnType<typeof loadStudioLook>>, mode: 'preview' | 'trace'): THREE.Scene {
  const staging = new THREE.Scene();
  for (const { data, geometry } of assets.parts) {
    const material = partMaterial(data.appearance) ?? partMaterial({ color: NEUTRAL_COLOR, finish: 'satin' })!;
    const mesh = new THREE.Mesh(geometry, material);
    placeDisplay(mesh, data); mesh.userData.featureId = data.featureId; staging.add(mesh);
  }
  for (const graphic of assets.graphics) {
    // Raster blends soft ink edges; the tracer needs a binary alpha test.
    const material = new THREE.MeshStandardMaterial({ map: graphic.texture, roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      ...(mode === 'trace' ? { alphaTest: 0.1, transparent: false } : { transparent: true, depthWrite: false }) });
    const mesh = new THREE.Mesh(graphic.geometry, material);
    mesh.userData = { featureId: graphic.featureId, graphicId: graphic.graphicId }; mesh.renderOrder = 3; mesh.raycast = () => {};
    staging.add(mesh);
  }
  stageStudio(staging, undefined, assets.bounds, settings, look.environment);
  applyFloorTextures(staging, look.floor, settings);
  if (mode === 'trace') studioPreviewLights(staging, false);
  // Move everything into one centered, unit-scaled group. Lights and shadow cameras carry sizes that do not scale.
  const scene = new THREE.Scene(), group = new THREE.Group(), scale = 1 / assets.unit;
  scene.background = staging.background; scene.environment = staging.environment; scene.environmentIntensity = staging.environmentIntensity;
  scene.environmentRotation.copy(staging.environmentRotation); scene.backgroundRotation.copy(staging.backgroundRotation);
  scene.userData.ownedTextures = staging.userData.ownedTextures;
  for (const object of [...staging.children]) group.add(object);
  group.scale.setScalar(scale); group.position.copy(assets.center).multiplyScalar(-scale); scene.add(group);
  group.traverse(object => {
    if (object instanceof THREE.RectAreaLight) { object.width *= scale; object.height *= scale; }
    if (object instanceof THREE.DirectionalLight) {
      const c = object.shadow.camera; c.left *= scale; c.right *= scale; c.top *= scale; c.bottom *= scale; c.near *= scale; c.far *= scale; c.updateProjectionMatrix();
      object.shadow.normalBias *= scale;
    }
    if (object instanceof THREE.Mesh && (object.material as THREE.MeshPhysicalMaterial).thickness) (object.material as THREE.MeshPhysicalMaterial).thickness *= scale;
  });
  scene.updateMatrixWorld(true);
  return scene;
}

/** Release what a composed scene owns: materials, the floor and its textures, shadow maps. Shared assets stay. */
export function releaseStudioScene(scene: THREE.Scene) {
  for (const texture of scene.userData.ownedTextures ?? []) texture.dispose();
  scene.traverse(object => {
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
    for (const texture of object !== scene ? object.userData.ownedTextures ?? [] : []) texture.dispose();
    if (object instanceof THREE.Mesh) {
      if (object.userData.studioFloor || object.userData.studioBackdrop) object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  });
  scene.clear();
}
