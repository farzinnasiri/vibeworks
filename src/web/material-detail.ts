import * as THREE from 'three';
import type { Appearance } from '../shared/protocol';
import { materialById, type SurfaceDetail } from '../shared/materials';

/** Source millimetres per detail-map repeat at scale 1. */
export const DETAIL_REPEAT_MM = 12;

export function detailKind(appearance?: Appearance): SurfaceDetail {
  return appearance?.detail ?? materialById(appearance?.visualMaterial ?? appearance?.material)?.detail ?? 'plain';
}

// Small hash noise, stable across hosts.
const hash = (x: number, y: number) => {
  let n = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967295;
};

/** Height in 0..1. Carbon is a 2x2 twill of four tows per repeat; rubber and brushing are fine grain. */
function detailHeight(kind: Exclude<SurfaceDetail, 'plain'>, x: number, y: number, size: number): number {
  if (kind === 'carbon') {
    const tow = size / 4, cx = Math.floor(x / tow), cy = Math.floor(y / tow);
    // Twill: the over/under pattern shifts one tow per row.
    const warp = ((cx + cy) & 3) < 2;
    const along = warp ? (y % tow) / tow : (x % tow) / tow, across = warp ? (x % tow) / tow : (y % tow) / tow;
    return 0.55 + 0.35 * Math.sin(across * Math.PI) - 0.12 * Math.abs(along - 0.5) + 0.04 * hash(x, y);
  }
  if (kind === 'brushed') return 0.5 + 0.18 * Math.sin(y * 2.9 + 3 * hash(0, y)) + 0.06 * hash(x >> 3, y);
  if (kind === 'wood') {
    const bend = 0.7 * Math.sin(y / size * Math.PI * 2) + 0.35 * Math.sin(y / size * Math.PI * 4 + x / size * Math.PI * 2);
    const grain = 0.5 + 0.5 * Math.sin(x / size * Math.PI * 12 + bend);
    return 0.35 + 0.4 * grain ** 3 + 0.03 * hash(x >> 1, y >> 4);
  }
  // Rubber: soft two-octave grain without directional structure.
  const coarse = hash(x >> 2, y >> 2), fine = hash(x, y);
  return 0.5 + 0.25 * (coarse - 0.5) + 0.1 * (fine - 0.5);
}

const heights = new Map<SurfaceDetail, Float32Array>();
const SIZE = 128;
function heightField(kind: Exclude<SurfaceDetail, 'plain'>) {
  let field = heights.get(kind);
  if (!field) {
    field = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) field[y * SIZE + x] = detailHeight(kind, x, y, SIZE);
    heights.set(kind, field);
  }
  return field;
}

function dataTexture(data: Uint8Array) {
  const texture = new THREE.DataTexture(data, SIZE, SIZE);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Shared base maps. Scaled variants are clones that share the pixels.
const roughness = new Map<SurfaceDetail, THREE.DataTexture>();
const normals = new Map<SurfaceDetail, THREE.DataTexture>();
const colors = new Map<SurfaceDetail, THREE.DataTexture>();
const directions = new Map<SurfaceDetail, THREE.DataTexture>();
const ROUGHNESS_SPREAD: Record<Exclude<SurfaceDetail, 'plain'>, [number, number]> = { carbon: [0.6, 1], rubber: [0.85, 1], brushed: [0.75, 1], wood: [0.8, 1] };
const NORMAL_STRENGTH: Record<Exclude<SurfaceDetail, 'plain'>, number> = { carbon: 1.6, rubber: 0.9, brushed: 0.5, wood: 0.35 };

/** Roughness multiplier in the green channel (three.js and the path tracer read G). */
export function detailRoughness(kind: SurfaceDetail): THREE.DataTexture | undefined {
  if (kind === 'plain') return;
  let texture = roughness.get(kind);
  if (!texture) {
    const field = heightField(kind), [low, high] = ROUGHNESS_SPREAD[kind], data = new Uint8Array(SIZE * SIZE * 4);
    for (let i = 0; i < field.length; i++) {
      const value = Math.round(255 * (low + (high - low) * Math.min(1, Math.max(0, field[i]))));
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value; data[i * 4 + 3] = 255;
    }
    texture = dataTexture(data); roughness.set(kind, texture);
  }
  return texture;
}

/** Tangent-space normals work in the fast and path-traced renderers, and in standard GLB. */
export function detailNormal(kind: SurfaceDetail): THREE.DataTexture | undefined {
  if (kind === 'plain') return;
  let texture = normals.get(kind);
  if (!texture) {
    const field = heightField(kind), strength = NORMAL_STRENGTH[kind], data = new Uint8Array(SIZE * SIZE * 4);
    const at = (x: number, y: number) => field[((y + SIZE) % SIZE) * SIZE + (x + SIZE) % SIZE];
    const v = new THREE.Vector3();
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      v.set(-(at(x + 1, y) - at(x - 1, y)) * strength, -(at(x, y + 1) - at(x, y - 1)) * strength, 1).normalize();
      const i = (y * SIZE + x) * 4;
      data[i] = Math.round((v.x * 0.5 + 0.5) * 255); data[i + 1] = Math.round((v.y * 0.5 + 0.5) * 255); data[i + 2] = Math.round((v.z * 0.5 + 0.5) * 255); data[i + 3] = 255;
    }
    texture = dataTexture(data); normals.set(kind, texture);
  }
  return texture;
}

/** Neutral tow variation multiplies the authored color; it never paints the part another color. */
export function detailColor(kind: SurfaceDetail): THREE.DataTexture | undefined {
  if (kind !== 'carbon' && kind !== 'wood') return;
  let color = colors.get(kind);
  if (!color) {
    const data = new Uint8Array(SIZE * SIZE * 4), tow = SIZE / 4;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const warp = ((Math.floor(x / tow) + Math.floor(y / tow)) & 3) < 2;
      const across = (warp ? x : y) % tow / tow;
      const crown = Math.sin(across * Math.PI) ** 0.6;
      const strand = 0.5 + 0.5 * Math.cos(across * Math.PI * 20);
      const value = Math.round(255 * (kind === 'wood' ? 0.55 + 0.42 * detailHeight(kind, x, y, SIZE) : 0.6 + 0.27 * crown + 0.08 * strand));
      const i = (y * SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
    }
    color = dataTexture(data); color.colorSpace = THREE.SRGBColorSpace; colors.set(kind, color);
  }
  return color;
}

/** Woven tows reflect along alternating directions. Brushed surfaces have one direction. */
export function detailDirection(kind: SurfaceDetail): THREE.DataTexture | undefined {
  if (kind !== 'carbon' && kind !== 'brushed') return;
  let texture = directions.get(kind);
  if (!texture) {
    const data = new Uint8Array(SIZE * SIZE * 4), tow = SIZE / 4;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const warp = kind === 'brushed' || ((Math.floor(x / tow) + Math.floor(y / tow)) & 3) < 2;
      const i = (y * SIZE + x) * 4;
      data[i] = warp ? 128 : 255; data[i + 1] = warp ? 255 : 128;
      data[i + 2] = data[i + 3] = 255;
    }
    texture = dataTexture(data); directions.set(kind, texture);
  }
  return texture;
}

/** Shared PBR detail for preview, final images and GLB. A plain surface clears every detail channel. */
export function configureMaterialDetail(material: THREE.MeshPhysicalMaterial, kind: SurfaceDetail, scale = 1) {
  const map = (source: THREE.Texture | undefined, slot: DetailSlot) => source ? scaledDetail(source, kind, slot, scale) : null;
  material.map = map(detailColor(kind), 'color');
  material.normalMap = map(detailNormal(kind), 'normal');
  material.normalScale.setScalar(kind === 'carbon' ? 0.15 : kind === 'brushed' ? 0.2 : kind === 'rubber' ? 0.35 : kind === 'wood' ? 0.2 : 1);
  material.roughnessMap = map(detailRoughness(kind), 'roughness');
  material.anisotropyMap = map(detailDirection(kind), 'direction');
  material.anisotropy = kind === 'carbon' ? 0.3 : kind === 'brushed' ? 0.55 : 0;
  // Smooth resin reflects the softbox as one band. The weave belongs to the layer beneath it.
  material.clearcoatNormalMap = null;
}

/** Back-compatible names used by the material and export code. */
export const materialDetail = (appearance?: Appearance) => detailRoughness(detailKind(appearance));
export const materialNormal = (appearance?: Appearance) => detailNormal(detailKind(appearance));

const scaled = new Map<string, THREE.Texture>();
type DetailSlot = 'normal' | 'roughness' | 'color' | 'direction';
/** A detail map at a different pattern size. Clones share pixels and GPU uploads. Bounded by kinds × scales. */
export function scaledDetail(texture: THREE.Texture, kind: SurfaceDetail, slot: DetailSlot, scale: number): THREE.Texture {
  if (scale === 1) return texture;
  const key = `${kind}:${slot}:${scale.toFixed(3)}`;
  let clone = scaled.get(key);
  if (!clone) {
    if (scaled.size > 64) { for (const t of scaled.values()) t.dispose(); scaled.clear(); }
    clone = texture.clone(); clone.repeat.set(1 / scale, 1 / scale); clone.updateMatrix(); clone.needsUpdate = true;
    scaled.set(key, clone);
  }
  return clone;
}

const AXES = [[1, 2], [0, 2], [0, 1]] as const;
/**
 * Box-projected detail coordinates with analytic tangents.
 *
 * Each vertex projects along its normal's dominant axis. A triangle whose vertices disagree gets its own
 * vertices projected along the face's dominant axis, so no triangle interpolates across a projection seam.
 * Positions and normals are copied unchanged; only the index differs from the worker's triangles.
 */
export function detailGeometry(vertices: ArrayLike<number>, normals: ArrayLike<number>, triangles: ArrayLike<number>) {
  const count = vertices.length / 3;
  const dominant = (x: number, y: number, z: number) => { const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z); return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2; };
  const vertexAxis = new Uint8Array(count);
  for (let i = 0; i < count; i++) vertexAxis[i] = dominant(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  // Extra vertices for seam triangles, shared between neighbors that use the same axis.
  const extra = new Map<number, number>(), sources: number[] = [], axes: number[] = [];
  const index = new Uint32Array(triangles.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    if (vertexAxis[a] === vertexAxis[b] && vertexAxis[b] === vertexAxis[c]) { index[t] = a; index[t + 1] = b; index[t + 2] = c; continue; }
    const e1 = [0, 1, 2].map(k => vertices[b * 3 + k] - vertices[a * 3 + k]), e2 = [0, 1, 2].map(k => vertices[c * 3 + k] - vertices[a * 3 + k]);
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    let axis = dominant(nx, ny, nz);
    if (nx === 0 && ny === 0 && nz === 0) axis = vertexAxis[a];
    for (let k = 0; k < 3; k++) {
      const v = triangles[t + k];
      if (vertexAxis[v] === axis) { index[t + k] = v; continue; }
      const key = v * 3 + axis;
      let id = extra.get(key);
      if (id === undefined) { id = count + sources.length; extra.set(key, id); sources.push(v); axes.push(axis); }
      index[t + k] = id;
    }
  }
  const total = count + sources.length;
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), uv = new Float32Array(total * 2), tangent = new Float32Array(total * 4);
  const n = new THREE.Vector3(), tan = new THREE.Vector3(), bit = new THREE.Vector3(), eu = new THREE.Vector3(), ev = new THREE.Vector3();
  for (let i = 0; i < total; i++) {
    const source = i < count ? i : sources[i - count], axis = i < count ? vertexAxis[i] : axes[i - count];
    for (let k = 0; k < 3; k++) { position[i * 3 + k] = vertices[source * 3 + k]; normal[i * 3 + k] = normals[source * 3 + k]; }
    const [u, w] = AXES[axis];
    uv[i * 2] = vertices[source * 3 + u] / DETAIL_REPEAT_MM; uv[i * 2 + 1] = vertices[source * 3 + w] / DETAIL_REPEAT_MM;
    // UV is a world-axis projection. Hold V constant and solve n·dp = 0 along the dropped axis.
    // Orthogonally projecting +U alone also moves V on an oblique surface and twists its shading frame.
    n.set(normals[source * 3], normals[source * 3 + 1], normals[source * 3 + 2]);
    if (n.lengthSq() < 1e-12) n.set(0, 0, 0).setComponent(axis, 1); else n.normalize();
    eu.set(0, 0, 0).setComponent(u, 1); ev.set(0, 0, 0).setComponent(w, 1);
    tan.copy(eu);
    if (Math.abs(n.getComponent(axis)) > 1e-6) tan.setComponent(axis, -n.getComponent(u) / n.getComponent(axis));
    else tan.addScaledVector(n, -n.dot(eu));
    if (tan.lengthSq() < 1e-8) {
      // The normal lies along U: use the world axis least aligned with it.
      const k = Math.abs(n.x) <= Math.abs(n.y) && Math.abs(n.x) <= Math.abs(n.z) ? 0 : Math.abs(n.y) <= Math.abs(n.z) ? 1 : 2;
      tan.set(0, 0, 0).setComponent(k, 1).addScaledVector(n, -n.getComponent(k));
    }
    tan.normalize();
    bit.crossVectors(n, tan);
    tangent[i * 4] = tan.x; tangent[i * 4 + 1] = tan.y; tangent[i * 4 + 2] = tan.z; tangent[i * 4 + 3] = bit.dot(ev) < 0 ? -1 : 1;
  }
  return { position, normal, uv, tangent, index };
}
