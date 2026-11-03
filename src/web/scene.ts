import { resolveLook } from '../shared/appearance-resolver';
import { showOutline } from './presentation';
import { addWorkbenchLights, DEFAULT_WORKBENCH_EDGES, isDarkSurface } from './workbench';
import { addStudioFloor, addStudioLights, gradientBackground } from './studio-scene';
import { studioSettings } from '../shared/studio';
import { configureMaterialDetail, detailGeometry, detailKind } from './material-detail';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Appearance, Presentation } from '../shared/protocol';
import { finishLook, materialById, NEUTRAL_COLOR } from '../shared/materials';

/** A physically based material for a part's appearance, or undefined to keep the neutral workbench look. */
export function partMaterial(appearance: Appearance | undefined): THREE.MeshPhysicalMaterial | undefined {
  const material = materialById(appearance?.visualMaterial ?? appearance?.material);
  if (!material && !appearance?.color && !appearance?.detail && !appearance?.coat && appearance?.roughness === undefined) return undefined;
  const look = resolveLook(appearance);
  const transmission = material?.transmission ?? 0;
  const kind = detailKind(appearance);
  const physical = new THREE.MeshPhysicalMaterial({
    color: look.color,
    metalness: look.metalness, roughness: look.roughness,
    clearcoat: look.clearcoat, clearcoatRoughness: 0.12,
    transmission, thickness: transmission ? 3 : 0, ior: 1.5,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  configureMaterialDetail(physical, kind, appearance?.detailScale ?? 1);
  physical.userData.materialId = material?.id;
  // What the model authored, so Studio looks can override and restore individual properties.
  physical.userData.appearance = appearance;
  physical.userData.surface = { materialKey: material?.id ?? 'unassigned', finish: appearance?.finish, detail: kind, detailScale:appearance?.detailScale, coat:appearance?.coat, roughness:appearance?.roughness };
  return physical;
}

/** Soft studio reflections so metals, gloss and glass read correctly. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  try {
    const target = pmrem.fromScene(room, 0.04), texture = target.texture;
    const dispose = () => { texture.removeEventListener('dispose', dispose); target.dispose(); };
    texture.addEventListener('dispose', dispose);
    return texture;
  } finally { room.dispose(); pmrem.dispose(); }
}
import { VIEW_DIRECTIONS, type Bounds, type ViewName } from '../shared/protocol';
import type { Evaluation } from '../cad/types';

const BACKGROUND = 0xeef1f2;
export function modelBounds(evaluation: Evaluation, ids = evaluation.visibleFeatureIds): Bounds {
  const records = evaluation.geometry.filter(g => ids.includes(g.featureId));
  if (!records.length) return { min: [-50, -30, 0], max: [50, 30, 5], size: [100, 60, 5] };
  const min = [0, 1, 2].map(i => Math.min(...records.map(g => g.bounds.min[i]))) as Bounds['min'];
  const max = [0, 1, 2].map(i => Math.max(...records.map(g => g.bounds.max[i]))) as Bounds['max'];
  return { min, max, size: max.map((v, i) => v - min[i]) as Bounds['size'] };
}

/** Distinct, print-safe part colors for multi-part renders; repeats after twelve parts. */
export const PART_COLORS = [0x8da7b2, 0xd08c60, 0x7fa36b, 0xb58db6, 0xd2b55b, 0x6f8fc9, 0xc9727a, 0x5fa6a0, 0xa38a6d, 0x9aa05a, 0x8b7fc4, 0xc48aa4];

/** A single GPU buffer pair per shared asset, with separate rigidly placed scene objects. */
export function displayBuffers(data: Evaluation['meshes'][number], cache: Map<number[], {solid: THREE.BufferGeometry; edges: THREE.BufferGeometry}>) {
  let buffers = cache.get(data.vertices);
  if (!buffers) {
    const solid = new THREE.BufferGeometry();
    // Same positions and normals as the worker mesh; seam triangles get their own vertices for detail mapping.
    const detail = detailGeometry(data.vertices, data.normals, data.triangles);
    solid.setAttribute('position', new THREE.BufferAttribute(detail.position, 3));
    solid.setAttribute('normal', new THREE.BufferAttribute(detail.normal, 3)); solid.setIndex(new THREE.BufferAttribute(detail.index, 1));
    solid.setAttribute('uv', new THREE.BufferAttribute(detail.uv, 2));
    solid.setAttribute('tangent', new THREE.BufferAttribute(detail.tangent, 4));
    const edges = new THREE.BufferGeometry(); edges.setAttribute('position',new THREE.Float32BufferAttribute(data.lines,3));
    buffers={solid,edges}; cache.set(data.vertices,buffers);
  }
  return buffers;
}
export function placeDisplay(object: THREE.Object3D, data: Evaluation['meshes'][number]) {
  if (data.transform) object.applyMatrix4(new THREE.Matrix4().fromArray(data.transform));
}

export function createModelScene(evaluation: Evaluation, selected: string[] = [], ids = evaluation.visibleFeatureIds, colors?: Map<string, number>, appearances?: Map<string, Appearance | undefined>): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const ambient = new THREE.HemisphereLight(0xffffff, 0x697985, 2.2);
  ambient.position.set(0, 0, 1); scene.add(ambient);
  for (const [position, intensity] of [[[1, -2, 3], 3.1], [[-2, 1, 1], 1.2]] as const) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(position[0], position[1], position[2]); scene.add(light);
  }
  const buffers = new Map<number[], {solid: THREE.BufferGeometry; edges: THREE.BufferGeometry}>();
  for (const data of evaluation.meshes.filter(mesh => ids.includes(mesh.featureId))) {
    const asset = displayBuffers(data,buffers); const geometry=asset.solid;
    const material = (appearances && partMaterial(data.appearance ?? appearances.get(data.featureId))) || new THREE.MeshStandardMaterial({ color: colors?.get(data.featureId) ?? (selected.includes(data.featureId) ? 0x4b91ab : 0x8da7b2), roughness: 0.6, metalness: 0.18, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const mesh = new THREE.Mesh(geometry, material);
    placeDisplay(mesh,data);
    mesh.userData.featureId = data.featureId; scene.add(mesh);
    const edges = asset.edges;
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x293b44, transparent: true, opacity: 0.8 }));
    placeDisplay(outline,data);
    outline.userData.featureId = data.featureId; scene.add(outline);
  }
  return scene;
}

/** Material mode must opt in even when the worker embeds all source appearances in the meshes. */
export function createStudioModelScene(evaluation: Evaluation): THREE.Scene {
  return createModelScene(evaluation, [], evaluation.visibleFeatureIds, undefined, new Map());
}

export function disposeScene(scene: THREE.Scene, retained = new Set<THREE.BufferGeometry>()): void {
  scene.traverse(object => {
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight || object instanceof THREE.PointLight) object.shadow.dispose();
    for (const texture of object.userData.ownedTextures ?? []) texture.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      if (!retained.has(object.geometry)) object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    }
  });
  scene.clear();
}


/**
 * Frame bounds for a named view. With `points` (flat xyz, e.g. display-mesh vertices) the frame follows the
 * actual silhouette, which matters for sparse shapes whose bounding-box corners are empty space.
 */
export function fitCamera(camera: THREE.OrthographicCamera, bounds: Bounds, view: ViewName | THREE.Vector3, aspect: number, margin = 1.22, points?: ArrayLike<number>): THREE.Vector3 {
  const center = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(0.5);
  const direction = typeof view === 'string' ? new THREE.Vector3(...VIEW_DIRECTIONS[view]).normalize() : view.clone().normalize();
  if (typeof view === 'string') {
    camera.up.set(0, 0, 1);
    if (view === 'top') camera.up.set(0, 1, 0);
    if (view === 'bottom') camera.up.set(0, -1, 0);
  }
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  let horizontal = 0, vertical = 0;
  if (points && points.length >= 3) {
    let h0 = Infinity, h1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const offset = new THREE.Vector3();
    for (let i = 0; i + 2 < points.length; i += 3) {
      offset.set(points[i] - center.x, points[i + 1] - center.y, points[i + 2] - center.z);
      const h = offset.dot(right), v = offset.dot(up);
      h0 = Math.min(h0, h); h1 = Math.max(h1, h); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    // Recenter on the silhouette, then size to it.
    center.addScaledVector(right, (h0 + h1) / 2).addScaledVector(up, (v0 + v1) / 2);
    horizontal = (h1 - h0) / 2; vertical = (v1 - v0) / 2;
  } else {
    for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
      const offset = new THREE.Vector3(x, y, z).sub(center);
      horizontal = Math.max(horizontal, Math.abs(offset.dot(right)));
      vertical = Math.max(vertical, Math.abs(offset.dot(up)));
    }
  }
  const diagonal = Math.max(new THREE.Vector3(...bounds.size).length(), 0.1);
  const halfHeight = Math.max(vertical, horizontal / Math.max(aspect, 0.1), diagonal * 0.025) * margin;
  camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
  camera.top = halfHeight; camera.bottom = -halfHeight;
  camera.near = diagonal * 0.001; camera.far = diagonal * 20;
  camera.position.copy(center).addScaledVector(direction, diagonal * 4);
  camera.zoom = 1; camera.lookAt(center); camera.updateProjectionMatrix();
  return center;
}

/** Display-only material looks from the scene settings. Authored color, metalness and transmission stay. */
export function applyMaterialLooks(scene: THREE.Object3D, settings: Presentation) {
  const looks = studioSettings(settings).materials;
  if (!Object.keys(looks).length) return;
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material) || object.userData.graphicId) return;
    const material = object.material;
    if (!(material instanceof THREE.MeshPhysicalMaterial) || !material.userData.surface) return;
    const look = resolveLook(material.userData.appearance, settings, 'studio');
    material.roughness = look.roughness;
    material.clearcoat = look.clearcoat; material.clearcoatRoughness = 0.12;
    configureMaterialDetail(material, look.detail, look.detailScale);
    material.needsUpdate = true;
  });
}

/** Shared product-shot staging for the live Studio and agent material renders. Without a renderer, only the scene changes. */
export function stageStudio(scene: THREE.Scene, renderer: THREE.WebGLRenderer | undefined, bounds: THREE.Box3, settings: Presentation = {}, environment?: THREE.Texture): THREE.Object3D[] {
  for (const light of scene.children.filter(object => object instanceof THREE.Light)) scene.remove(light);
  const s = studioSettings(settings);
  applyMaterialLooks(scene, settings);
  if (s.backgroundMode === 'gradient') {
    const gradient = gradientBackground(s.backgroundTop, s.background);
    scene.background = gradient; scene.userData.ownedTextures = [...scene.userData.ownedTextures ?? [], gradient];
  } else scene.background = s.backgroundMode === 'transparent' ? null : s.backgroundMode === 'environment' && environment ? environment : new THREE.Color(s.background);
  scene.environment = environment ?? (renderer ? studioEnvironment(renderer) : null);
  scene.environmentIntensity = s.environment;
  scene.environmentRotation.set(Math.PI / 2, 0, THREE.MathUtils.degToRad(s.environmentRotation), 'ZXY');
  scene.backgroundRotation.copy(scene.environmentRotation);
  if (renderer) configureStudioRenderer(renderer, settings);
  const key = addStudioLights(scene, bounds, settings);
  const floor = addStudioFloor(scene, bounds, settings);
  scene.traverse(object => { if (object instanceof THREE.Mesh && object.userData.featureId && !object.userData.graphicId) { object.castShadow = object.receiveShadow = s.shadows; Object.assign(object.material, { castShadow: s.shadows }); } });
  return floor ? [key, key.target, floor] : [key, key.target];
}

export function configureStudioRenderer(renderer: THREE.WebGLRenderer, settings: Presentation): void {
  const s = studioSettings(settings);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = s.exposure;
  renderer.shadowMap.enabled = s.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
}

/** Interactive viewport palette. Contact sheets keep createModelScene's fixed palette. */
export const WORKBENCH = {
  body: Number.parseInt(NEUTRAL_COLOR.slice(1), 16), edge: 0x1d2328,
  selectedBody: 0xe6d3c6, selectedEdge: 0xd9480f,
  hoverBody: 0xdde3e8, hoverEdge: 0x0b0f12,
  ghostBody: 0x8fa3b3, ghostEdge: 0x40505c,
  flaggedBody: 0xe7c7c2, flaggedEdge: 0xb42318,
  /** Light outlines that separate dark authored surfaces from the dark canvas. Never applied to the material. */
  darkSurfaceEdge: 0xa9b3ba, darkSurfaceHoverEdge: 0xe2e7ea,
};
export interface WorkbenchPart { featureId: string; mesh: THREE.Mesh; outline: THREE.LineSegments; ghost: boolean; /** Has its own material: highlight with emissive light, not by recoloring. */ styled: boolean; /** An opaque authored surface dark enough to need light edge separation. */ darkSurface: boolean }

/** Display meshes from the worker, styled for interaction. Geometry stays exactly what the kernel tessellated. */
export function createWorkbenchScene(evaluation: Evaluation, selected: string[], ghosts: string[], appearances?: Map<string, Appearance | undefined>, showEdges = DEFAULT_WORKBENCH_EDGES, buffers = new Map<number[], {solid: THREE.BufferGeometry; edges: THREE.BufferGeometry}>()): { scene: THREE.Scene; parts: WorkbenchPart[] } {
  const scene = new THREE.Scene();
  const bounds = modelBounds(evaluation);
  const key = addWorkbenchLights(scene, new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max)));
  key.castShadow = evaluation.visibleFeatureIds.length > 0;
  const parts: WorkbenchPart[] = [];
  const shown = new Set([...evaluation.visibleFeatureIds, ...ghosts]);
  for (const data of evaluation.meshes.filter(mesh => shown.has(mesh.featureId))) {
    const ghost = !evaluation.visibleFeatureIds.includes(data.featureId);
    const isSelected = selected.includes(data.featureId);
    const asset=displayBuffers(data,buffers), geometry=asset.solid;
    const styled = ghost ? undefined : partMaterial(data.appearance ?? appearances?.get(data.featureId));
    const material = styled ?? new THREE.MeshStandardMaterial({
      color: ghost ? WORKBENCH.ghostBody : isSelected ? WORKBENCH.selectedBody : WORKBENCH.body,
      roughness: 0.52, metalness: 0.22, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: ghost, opacity: ghost ? 0.22 : 1, depthWrite: !ghost, side: ghost ? THREE.DoubleSide : THREE.FrontSide,
    });
    // The orthographic editor shows glass as tinted transparency. Physical refraction is for Studio:
    // it otherwise adds a second full-scene render and washes out against the editor's CSS background.
    if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
      material.transmission = 0; material.transparent = true; material.opacity = 0.32; material.depthWrite = false;
    }
    const mesh = new THREE.Mesh(geometry, material);
    // Transparent parts do not become opaque shadow blockers. Review/ghost geometry never casts.
    mesh.castShadow = !ghost && (!(material instanceof THREE.MeshPhysicalMaterial) || material.transmission === 0) && material.opacity === 1;
    mesh.receiveShadow = !ghost; material.clipShadows = true;
    placeDisplay(mesh,data);
    mesh.userData.display = data;
    mesh.userData.featureId = data.featureId; mesh.userData.ghost = ghost; mesh.renderOrder = ghost ? 2 : 0;
    scene.add(mesh);
    const edges = asset.edges;
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: isSelected ? WORKBENCH.selectedEdge : ghost ? WORKBENCH.ghostEdge : WORKBENCH.edge,
      transparent: true, opacity: isSelected ? 0.95 : ghost ? 0.75 : 0.4, depthTest: !ghost,
    }));
    outline.visible = showOutline(showEdges, isSelected, false, ghost, false, false);
    placeDisplay(outline,data);
    outline.userData.featureId = data.featureId; outline.renderOrder = ghost ? 3 : 1;
    scene.add(outline);
    parts.push({ featureId: data.featureId, mesh, outline, ghost, styled: !!styled, darkSurface: !!styled && !material.transparent && isDarkSurface(material.color) });
  }
  return { scene, parts };
}

/** XY ground grid sized to the model. Visual reference only. */
export function createGrid(bounds: Bounds, dark = false): THREE.Group {
  const group = new THREE.Group();
  const extent = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[1]), Math.abs(bounds.max[1]), 40);
  const step = extent > 600 ? 100 : extent > 150 ? 50 : 10;
  const half = Math.ceil(extent * 1.6 / (step * 5)) * step * 5;
  const minor: number[] = [], major: number[] = [];
  for (let v = -half; v <= half + 1e-9; v += step) {
    const target = Math.abs(v % (step * 5)) < 1e-9 ? major : minor;
    if (Math.abs(v) < 1e-9) continue;
    target.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
  }
  const lines = (positions: number[], color: number, opacity: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    line.renderOrder = -1; group.add(line);
  };
  lines(minor, dark ? 0x8c969f : 0x7d7a70, dark ? 0.06 : 0.1);
  lines(major, dark ? 0xa2aab2 : 0x6c695f, dark ? 0.14 : 0.22);
  lines([-half, 0, 0, half, 0, 0], 0xd23d2a, 0.55);
  lines([0, -half, 0, 0, half, 0], 0x2f8a4c, 0.55);
  group.userData.grid = true;
  return group;
}

/** X-ray overlay of the exact common solids. Never included in geometry exports or picking. */
export function addInterferenceVolumes(scene: THREE.Scene, evaluation: Evaluation, ids = evaluation.visibleFeatureIds, clippingPlanes?: THREE.Plane[]): void {
  const unintended = evaluation.analysis?.interferences.filter(i => !i.intendedBy) ?? [];
  for (const data of evaluation.analysis?.interferenceMeshes ?? []) {
    if ((!ids.includes(data.a) && !ids.includes(data.b)) || !unintended.some(i => (i.a === data.a && i.b === data.b) || (i.b === data.a && i.a === data.b))) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    geometry.setIndex(data.triangles);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: WORKBENCH.flaggedEdge, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false, side: THREE.DoubleSide, ...(clippingPlanes ? { clippingPlanes } : {}) }));
    mesh.userData.interference = [data.a, data.b];
    mesh.raycast = () => {};
    mesh.renderOrder = 5;
    scene.add(mesh);
  }
}
