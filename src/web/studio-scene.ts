import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { floorPatternSize, STUDIO_FLOORS, studioSettings } from '../shared/studio';
import type { StudioFloor } from '../shared/materials';
import type { Presentation } from '../shared/protocol';
import { floorPatternTextures, type ProceduralFloor } from './floor-patterns';
import { continuousConcrete, type FloorMaps } from './floor-texture';

/** Only three bundled HDRs. No remote requests, user paths, or unbounded texture cache. */
const sources = new Map<string, Promise<THREE.DataTexture>>();
export function loadStudioEnvironment(preset: 'studio' | 'dark_studio' | 'warehouse' | 'outdoor' = 'studio') {
  let pending = sources.get(preset);
  if (!pending) {
    pending = preset === 'dark_studio' ? Promise.resolve(darkStudioEnvironment()) : import('./assets/environments/embedded').then(({ environmentBytes }) => {
      const binary = atob(environmentBytes[preset]);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const parsed = new HDRLoader().parse(bytes.buffer);
      const texture = new THREE.DataTexture(parsed.data, parsed.width, parsed.height, THREE.RGBAFormat, parsed.type);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false; texture.flipY = true; texture.needsUpdate = true;
      return texture;
    }).catch(error => { sources.delete(preset); throw error; });
    sources.set(preset, pending);
  }
  return pending;
}

/** A dark neutral room; the physical softboxes supply its shaped reflections. */
function darkStudioEnvironment() {
  const data = new Uint16Array(4 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = THREE.DataUtils.toHalfFloat(0.035);
    data[i + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const texture = new THREE.DataTexture(data, 4, 2, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

/** A vertical sky gradient: horizon color at and below the horizon, top color overhead. Both renderers read it. */
export function gradientBackground(top: string, horizon: string): THREE.DataTexture {
  const width = 4, height = 64, data = new Uint16Array(width * height * 4);
  const a = new THREE.Color(horizon), b = new THREE.Color(top), c = new THREE.Color();
  for (let y = 0; y < height; y++) {
    const elevation = ((y + 0.5) / height - 0.5) * Math.PI, t = Math.max(0, Math.sin(elevation)) ** 0.7;
    c.copy(a).lerp(b, t);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(c.r); data[i + 1] = THREE.DataUtils.toHalfFloat(c.g); data[i + 2] = THREE.DataUtils.toHalfFloat(c.b); data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

/** Shared direct lighting, in world coordinates. Orbiting the camera never moves it. */
export function addStudioLights(scene: THREE.Scene, bounds: THREE.Box3, settings: Presentation) {
  RectAreaLightUniformsLib.init();
  const s = studioSettings(settings), center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1);
  const azimuth = THREE.MathUtils.degToRad(s.lightRotation), elevation = THREE.MathUtils.degToRad(s.lightElevation);
  const direction = new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation));
  // Raster softboxes cannot cast shadows. This light supplies them in the preview only and takes its share
  // of the key softbox, so preview and final images receive about the same key light.
  const key = new THREE.DirectionalLight(s.lightColor, s.keyIntensity * 0.35);
  key.userData.previewLight = true;
  key.position.copy(center).addScaledVector(direction, radius * 4); key.target.position.copy(center);
  key.castShadow = s.shadows;
  // A low light casts a long shadow; the depth range must reach its end or the shadow is cut off in a straight line.
  Object.assign(key.shadow.camera, { left: -radius * 1.15, right: radius * 1.15, top: radius * 1.15, bottom: -radius * 1.15, near: radius, far: radius * (5 + 2 / Math.tan(Math.max(elevation, THREE.MathUtils.degToRad(5)))) });
  key.shadow.camera.updateProjectionMatrix(); key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0001; key.shadow.normalBias = radius * 0.00015; key.shadow.radius = 3;
  scene.add(key, key.target);
  if (s.preset === 'dramatic') {
    // Long softboxes describe curvature without filling every dark surface with a white reflection.
    const size = bounds.getSize(new THREE.Vector3());
    const along = new THREE.Vector3(size.x >= size.y ? 1 : 0, size.x >= size.y ? 0 : 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), azimuth);
    const across = new THREE.Vector3(-along.y, along.x, 0);
    const panel = (side: number, height: number, width: number, tall: number, strength: number) => {
      const light = new THREE.RectAreaLight(s.lightColor, strength, radius * width, radius * tall);
      light.position.copy(center).addScaledVector(across, side * radius);
      light.position.z += height * radius;
      light.up.set(0, 0, 1); light.lookAt(center); scene.add(light); return light;
    };
    const full = s.keyIntensity * 4;
    const primary = panel(-Math.cos(elevation) * 0.55, Math.sin(elevation) * 1.65, 1.9 * s.keySize, 0.65 * s.keySize, full * PREVIEW_KEY_SHARE);
    primary.userData.keySoftbox = { full, preview: full * PREVIEW_KEY_SHARE };
    key.position.copy(primary.position);
    panel(1.1, 0.65, 1.8, 0.16, s.keyIntensity * 4);
    panel(-1.2, 0.5, 1.7, 0.4, s.keyIntensity * 3 * s.fillIntensity);
    return key;
  }
  const box = (angle: number, e: number, width: number, tall: number, strength: number, color: string) => {
    const light = new THREE.RectAreaLight(color, strength, radius * width, radius * tall);
    const a = azimuth + angle;
    light.position.copy(center).addScaledVector(new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)), radius * 3);
    light.lookAt(center); scene.add(light);
    return light;
  };
  const full = s.keyIntensity * 6, softbox = box(0, elevation, 2.8 * s.keySize, 1.4 * s.keySize, full * PREVIEW_KEY_SHARE, s.lightColor);
  softbox.userData.keySoftbox = { full, preview: full * PREVIEW_KEY_SHARE };
  // Fill and rim stay above the floor when the key is lowered. Near the floor a glossy set mirrors them as hard shapes.
  box(Math.PI * 0.7, Math.max(elevation - 0.2, THREE.MathUtils.degToRad(25)), 2.5, 1, s.keyIntensity * 1.2 * s.fillIntensity, '#ffffff');
  box(-Math.PI * 0.7, Math.max(elevation, THREE.MathUtils.degToRad(35)), 0.7, 2.8, s.keyIntensity * 3.5, '#ffffff');
  return key;
}
/**
 * Irradiance from the key softbox is roughly intensity × area / distance² ≈ 2.6 × keyIntensity at the model;
 * the shadow light adds 0.35 × keyIntensity. The preview softbox gives up that share.
 */
const PREVIEW_KEY_SHARE = 1 - 0.35 / 2.6;

/** Lights start in raster form. Path tracing computes shadows itself: call with false before tracing. */
export function studioPreviewLights(scene: THREE.Scene, enabled: boolean) {
  scene.traverse(object => {
    if (object.userData.previewLight) object.visible = enabled;
    const share = object.userData.keySoftbox;
    if (share && object instanceof THREE.RectAreaLight) object.intensity = enabled ? share.preview : share.full;
  });
}

const floorSources = new Map<string, Promise<FloorMaps>>();
const floorAverages = new WeakMap<THREE.Texture, THREE.Color>();
/** Only the bounded floor maps enter this cache. Average in linear light, matching texture sampling. */
function averageFloorMap(texture: THREE.Texture) {
  let mean = floorAverages.get(texture); if (mean) return mean;
  let { data, width, height } = texture.image as { data?: Uint8Array; width: number; height: number };
  if (!data) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(texture.image as CanvasImageSource, 0, 0, 32, 32);
    data = new Uint8Array(ctx.getImageData(0, 0, 32, 32).data); width = height = 32;
  }
  mean = new THREE.Color(0, 0, 0); const color = new THREE.Color(); let count = 0;
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 32))) for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 32))) {
    const i = (y * width + x) * 4; color.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    if (texture.colorSpace === THREE.SRGBColorSpace) color.convertSRGBToLinear();
    mean.add(color); count++;
  }
  mean.multiplyScalar(1 / count); floorAverages.set(texture, mean); return mean;
}

/** A bounded, ordinary texture atlas lets both renderers fade detail around the physical bend.
 * The central floor keeps its pattern phase; the start of the distant bend fades to a plain wall.
 * No custom material shader is needed by either renderer.
 */
let sweepTextures: { source: FloorMaps; radius: number; span: number; maps: FloorMaps } | undefined;
export function prepareSweepTextures(maps: FloorMaps | undefined, settings: Presentation, radius: number): FloorMaps | undefined {
  if (!maps || studioSettings(settings).backdrop !== 'sweep') return maps;
  const size = 2048, span = (floorPatternSize(settings, radius) ?? radius * 200) * (maps.repeatSpan ?? 1);
  if (sweepTextures?.source === maps && sweepTextures.radius === radius && sweepTextures.span === span) return sweepTextures.maps;
  const period = size * span / (radius * 16), phase = (radius * 100 / span) % 1;
  const bake = (source: THREE.Texture, normal = false) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const tile = document.createElement('canvas'), img = source.image as { width: number; height: number; data?: Uint8Array };
    tile.width = img.width; tile.height = img.height;
    const tileCtx = tile.getContext('2d')!;
    if (img.data) tileCtx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    else tileCtx.drawImage(img as CanvasImageSource, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat')!;
    // Canvas rows point down; world Y and texture V point up. Respect the source upload orientation.
    const sy = source.flipY ? 1 : -1;
    pattern.setTransform(new DOMMatrix([period / tile.width, 0, 0, sy * period / tile.height, size / 2 - phase * period, size / 2 + phase * period]));
    ctx.fillStyle = pattern; ctx.fillRect(0, 0, size, size);
    const mean = normal ? new THREE.Color(128 / 255, 128 / 255, 1) : averageFloorMap(source).clone();
    if (source.colorSpace === THREE.SRGBColorSpace) mean.convertLinearToSRGB();
    const rgb = [mean.r, mean.g, mean.b].map(v => Math.round(v * 255));
    const fade = ctx.createRadialGradient(size / 2, size / 2, size * 6 / 16, size / 2, size / 2, size * 7 / 16);
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      fade.addColorStop(t, `rgba(${rgb.join(',')},${t * t * (3 - 2 * t)})`);
    }
    ctx.fillStyle = fade; ctx.fillRect(0, 0, size, size);
    tile.width = tile.height = 0;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = source.colorSpace; texture.anisotropy = 4;
    return texture;
  };
  const result = { map: bake(maps.map), roughnessMap: bake(maps.roughnessMap), ...(maps.normalMap ? { normalMap: bake(maps.normalMap, true) } : {}), sweep: true };
  // One reusable bake, independent of lighting/color controls. Scenes own clones, so eviction is safe.
  if (sweepTextures) for (const texture of [sweepTextures.maps.map, sweepTextures.maps.roughnessMap, sweepTextures.maps.normalMap]) texture?.dispose();
  sweepTextures = { source: maps, radius, span, maps: result };
  return result;
}

function shadeStudioBackdrop(scene: THREE.Scene, settings: Presentation, maps?: FloorMaps) {
  const s = studioSettings(settings), base = new THREE.Color(s.floorColor), top = new THREE.Color(s.background);
  // Keep the selected upper color on average while carrying the actual floor texture through the bend.
  // Matching only the texture's mean at a separate wall loses its local color and reflection response.
  if (maps) {
    const mean = averageFloorMap(maps.map);
    top.r /= Math.max(mean.r, 0.02); top.g /= Math.max(mean.g, 0.02); top.b /= Math.max(mean.b, 0.02);
  }
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.userData.studioBackdrop) return;
    const positions = object.geometry.getAttribute('position'), colors = new Float32Array(positions.count * 3), color = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const t = Math.min(1, Math.max(0, positions.getZ(i) / (2 * object.userData.modelRadius)));
      color.copy(base).lerp(top, t * t * (3 - 2 * t)); color.toArray(colors, i * 3);
    }
    object.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
}
/** Bundled photographs for concrete and tiles, generated patterns for the rest, nothing for plain floors. */
export function loadFloorTextures(floor: StudioFloor = 'matte'): Promise<FloorMaps | undefined> {
  if (floor === 'polished_concrete') return loadFloorTextures('concrete');
  const source = STUDIO_FLOORS[floor]?.source;
  if (!source) return Promise.resolve(undefined);
  let pending = floorSources.get(floor);
  if (!pending) {
    pending = source === 'procedural' ? Promise.resolve(floorPatternTextures(floor as ProceduralFloor))
      : import('./assets/floors/embedded').then(async ({ floorImages }) => {
        const loader = new THREE.TextureLoader(), images = floorImages[floor as 'concrete' | 'tiles'];
        const [map, roughnessMap, normalMap] = await Promise.all([loader.loadAsync(images.map), loader.loadAsync(images.roughnessMap), loader.loadAsync(images.normalMap)]);
        map.colorSpace = THREE.SRGBColorSpace;
        const maps = { map, roughnessMap, normalMap };
        return floor === 'concrete' ? continuousConcrete(maps) : maps;
      });
    pending = pending.catch(error => { floorSources.delete(floor); throw error; });
    floorSources.set(floor, pending);
  }
  return pending;
}

export function applyFloorTextures(scene: THREE.Scene, maps: Awaited<ReturnType<typeof loadFloorTextures>>, settings: Presentation) {
  shadeStudioBackdrop(scene, settings, maps);
  if (!maps) return;
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.userData.studioFloor) return;
    const material = object.material as THREE.MeshPhysicalMaterial;
    const size = object.userData.floorSize as number;
    const repeat = maps.sweep ? 1 : size / ((floorPatternSize(settings, object.userData.modelRadius ?? size / 200) ?? size) * (maps.repeatSpan ?? 1));
    if (maps.sweep) sweepCoordinates(object);
    const owned: THREE.Texture[] = [];
    for (const slot of ['map', 'roughnessMap', 'normalMap'] as const) {
      const source = maps[slot]; if (!source) continue;
      const texture = source.clone(); texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat, repeat); texture.anisotropy = 4; texture.updateMatrix(); texture.needsUpdate = true;
      material[slot] = texture; owned.push(texture);
    }
    material.normalScale.setScalar(settings.floor === 'polished_concrete' ? 0.08 : 0.5); material.needsUpdate = true; object.userData.ownedTextures = [...object.userData.ownedTextures ?? [], ...owned];
  });
}

/** Sweep texture coordinates: a 16-radius square atlas centered on the model, finite on the vertical wall. */
function sweepCoordinates(mesh: THREE.Mesh) {
  const positions = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
  const radius = mesh.userData.modelRadius as number, span = radius * 16;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), r = Math.hypot(x, y);
    // Keep a finite UV derivative on the vertical wall. All of this outer atlas is already plain.
    const stretch = r ? 1 + Math.max(0, positions.getZ(i) - radius * 2) / r : 1;
    uv.setXY(i, x * stretch / span + 0.5, y * stretch / span + 0.5);
  }
  uv.needsUpdate = true;
}
/** Reflection kept on the seamless wall, as a fraction of the floor's. */
export const SWEEP_WALL_SPECULAR = 0;
let wallMask: THREE.DataTexture | undefined;
/**
 * The floor keeps its gloss; the bend and wall become matte paint. Without this the curve mirrors the lamps of
 * the surroundings and the softboxes as streaks. Red scales the clear coat, alpha the base reflection.
 */
function sweepWallMask() {
  if (wallMask) return wallMask;
  const size = 128, data = new Uint8Array(size * size * 4), from = 5.6 / 16, to = 7 / 16;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5), t = Math.min(1, Math.max(0, (r - from) / (to - from)));
    const value = Math.round(255 * (1 - (1 - SWEEP_WALL_SPECULAR) * t * t * (3 - 2 * t))), i = 4 * (y * size + x);
    data[i] = data[i + 1] = data[i + 2] = data[i + 3] = value;
  }
  wallMask = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  wallMask.magFilter = wallMask.minFilter = THREE.LinearFilter; wallMask.needsUpdate = true;
  return wallMask;
}

/** A physical floor. Path tracing supplies model reflections and contact shadows directly. */
export function addStudioFloor(scene: THREE.Scene, bounds: THREE.Box3, settings: Presentation) {
  const s = studioSettings(settings); if (s.floor === 'none') return;
  const type = STUDIO_FLOORS[s.floor];
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1), size = radius * 200;
  const material = new THREE.MeshPhysicalMaterial({ color: s.floorColor, roughness: s.floorRoughness, metalness: type.metalness ?? 0, clearcoat: type.clearcoat ?? 0, clearcoatRoughness: Math.max(0.08, s.floorRoughness * 0.5) });
  // The coat follows Floor roughness, so a rougher gloss floor no longer keeps mirror-sharp reflections.
  const floor = new THREE.Mesh(s.backdrop === 'sweep' ? studioSweep(radius, size) : new THREE.PlaneGeometry(size, size), material);
  floor.position.set(bounds.getCenter(new THREE.Vector3()).x, bounds.getCenter(new THREE.Vector3()).y, bounds.min.z + s.floorHeight - radius * 0.00001);
  floor.receiveShadow = true; floor.userData.studioFloor = true; floor.userData.modelRadius = radius; floor.userData.floorSize = size; floor.raycast = () => {};
  scene.add(floor);
  if (s.backdrop === 'sweep') {
    // One surface and one finish from floor to wall: texture, coat and normals cannot jump at the join.
    floor.userData.studioBackdrop = true; material.color.set('#ffffff'); material.vertexColors = true;
    sweepCoordinates(floor);
    const mask = sweepWallMask().clone(); mask.needsUpdate = true;
    material.specularIntensityMap = mask; material.clearcoatMap = mask; floor.userData.ownedTextures = [mask];
    shadeStudioBackdrop(scene, settings);
    // Light the sweep separately. Its source faces away from the subject, so the room stays dark in reflections.
    const size = bounds.getSize(new THREE.Vector3()), angle = THREE.MathUtils.degToRad(s.lightRotation);
    const along = new THREE.Vector3(size.x >= size.y ? 1 : 0, size.x >= size.y ? 0 : 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    const across = new THREE.Vector3(-along.y, along.x, 0), center = bounds.getCenter(new THREE.Vector3());
    const backdrop = new THREE.RectAreaLight('#ffffff', s.keyIntensity * 1.5, radius * 5, radius * 3);
    backdrop.position.copy(center).addScaledVector(across, radius * 5); backdrop.position.z = floor.position.z + radius * 2.5;
    backdrop.up.set(0, 0, 1);
    const target = center.clone().addScaledVector(across, radius * 8); target.z = floor.position.z + radius * 2.5;
    backdrop.lookAt(target); scene.add(backdrop);
  }
  return floor;
}

/** Circular cyclorama. The flat set joins a quarter-circle sweep with continuous normals and XY texture scale. */
export function studioSweep(radius: number, textureSize: number): THREE.BufferGeometry {
  const profile: [number, number, number, number][] = [[0, 0, 0, 1], [radius * 6, 0, 0, 1]];
  for (let i = 1; i <= 32; i++) {
    const t = i / 32 * Math.PI / 2;
    profile.push([radius * (6 + 2 * Math.sin(t)), radius * 2 * (1 - Math.cos(t)), -Math.sin(t), Math.cos(t)]);
  }
  profile.push([radius * 8, radius * 10, -1, 0]);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [], segments = 128;
  profile.forEach(([r, z, nr, nz], row) => {
    for (let j = 0; j <= segments; j++) {
      const angle = j / segments * Math.PI * 2, x = r * Math.cos(angle), y = r * Math.sin(angle);
      const uvRadius = row <= 1 ? r : radius * 6 + Math.atan2(-nr, nz) * radius * 2 + Math.max(0, z - radius * 2);
      positions.push(x, y, z); normals.push(nr * Math.cos(angle), nr * Math.sin(angle), nz); uvs.push(uvRadius * Math.cos(angle) / textureSize + 0.5, uvRadius * Math.sin(angle) / textureSize + 0.5);
      if (row && j) { const a = (row - 1) * (segments + 1) + j - 1, b = row * (segments + 1) + j - 1; indices.push(a, b, b + 1); if (row > 1) indices.push(a, b + 1, a + 1); }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); return geometry;
}
