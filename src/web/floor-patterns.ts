import * as THREE from 'three';
import type { StudioFloor } from '../shared/materials';

/** One tileable repeat of a generated floor. Albedo multiplies the floor color; roughness multiplies its roughness. */
export interface FloorPattern { albedo: Float32Array; roughness: Float32Array; height?: Float32Array; normalStrength?: number }
export type ProceduralFloor = Extract<StudioFloor, 'grid' | 'checker' | 'wood' | 'plate' | 'epoxy' | 'asphalt'>;
export const PATTERN_SIZE = 256;

const hash = (x: number, y: number, seed: number) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
/** Smooth value noise that wraps every `period` cells, so the repeat has no seam. */
function noise(x: number, y: number, period: number, seed: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number, period: number, seed: number) =>
  0.55 * noise(x, y, period, seed) + 0.3 * noise(x * 2, y * 2, period * 2, seed + 1) + 0.15 * noise(x * 4, y * 4, period * 4, seed + 2);

export function floorPattern(kind: ProceduralFloor, size = PATTERN_SIZE): FloorPattern {
  const n = size * size, albedo = new Float32Array(n).fill(1), roughness = new Float32Array(n).fill(1);
  let height: Float32Array | undefined, normalStrength = 0;
  const each = (fn: (x: number, y: number, i: number) => void) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) fn(x, y, y * size + x); };
  if (kind === 'grid') {
    // One cell per repeat with a fine line on two edges, so repeats draw a continuous grid.
    const line = Math.max(1, Math.round(size * 0.012));
    each((x, y, i) => { if (x < line || y < line) { albedo[i] = 0.42; roughness[i] = 0.8; } });
  } else if (kind === 'checker') {
    each((x, y, i) => { albedo[i] = ((x < size / 2) !== (y < size / 2)) ? 0.58 : 1; });
  } else if (kind === 'wood') {
    // Four planks per repeat, staggered end joints, grain along each plank.
    height = new Float32Array(n).fill(1); normalStrength = 2.5;
    const planks = 4, width = size / planks;
    each((x, y, i) => {
      const plank = Math.floor(x / width), joint = Math.floor(hash(plank, 0, 7) * size);
      const piece = plank * 2 + ((y - joint + size) % size < size / 2 ? 0 : 1);
      const tone = 0.82 + 0.22 * hash(piece, 3, 11);
      const grain = 0.88 + 0.12 * Math.sin((x % width) * 0.55 + 7 * noise(x / 16, y / 48, size / 16, piece + 20) + 3 * hash(piece, 1, 5));
      const edge = Math.min(x % width, width - 1 - (x % width)) < 1 || Math.abs(((y - joint + size) % (size / 2))) < 1;
      albedo[i] = edge ? 0.45 : Math.min(1, tone * grain);
      roughness[i] = edge ? 1 : 0.82 + 0.18 * noise(x / 8, y / 32, size / 8, piece);
      height![i] = edge ? 0 : 1 - 0.04 * grain;
    });
  } else if (kind === 'plate') {
    // Diamond tread plate: raised lugs alternating ±45° in a 2 × 2 grid.
    height = new Float32Array(n); normalStrength = 4;
    const cell = size / 2;
    each((x, y, i) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), px = (x % cell) / cell - 0.5, py = (y % cell) / cell - 0.5;
      const angle = (cx + cy) % 2 ? Math.PI / 4 : -Math.PI / 4;
      const along = px * Math.cos(angle) + py * Math.sin(angle), across = -px * Math.sin(angle) + py * Math.cos(angle);
      const r = (along / 0.34) ** 2 + (across / 0.075) ** 2;
      const lug = r < 1 ? Math.sqrt(1 - r) : 0;
      height![i] = lug;
      albedo[i] = 0.84 + 0.1 * noise(x / 6, y / 6, size / 6, 3) + 0.06 * lug;
      roughness[i] = 1 - 0.35 * lug - 0.1 * noise(x / 12, y / 12, size / 12, 4);
    });
  } else if (kind === 'epoxy') {
    // Smooth coat with sparse color flakes.
    each((x, y, i) => {
      const flake = hash(x >> 1, y >> 1, 9);
      albedo[i] = flake > 0.94 ? 0.62 : flake < 0.05 ? 1 : 0.86 + 0.04 * noise(x / 32, y / 32, size / 32, 2);
      roughness[i] = 0.9 + 0.1 * noise(x / 16, y / 16, size / 16, 5);
    });
  } else {
    // Asphalt: fine aggregate in a dark binder.
    height = new Float32Array(n); normalStrength = 3;
    each((x, y, i) => {
      const grit = fbm(x / 4, y / 4, size / 4, 13), stone = hash(x >> 1, y >> 1, 17);
      albedo[i] = Math.min(1, 0.68 + 0.3 * grit + (stone > 0.97 ? 0.25 : 0));
      roughness[i] = 0.88 + 0.12 * grit;
      height![i] = grit + (stone > 0.97 ? 0.4 : 0);
    });
  }
  return { albedo, roughness, height, normalStrength };
}

function texture(data: Uint8Array, size: number, srgb = false) {
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}

/** Texture maps for a generated floor. Cached by the caller; the caller clones before changing repeat. */
export function floorPatternTextures(kind: ProceduralFloor, size = PATTERN_SIZE) {
  const pattern = floorPattern(kind, size), n = size * size;
  const map = new Uint8Array(n * 4), rough = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    map[i * 4] = map[i * 4 + 1] = map[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, pattern.albedo[i]))); map[i * 4 + 3] = 255;
    rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, pattern.roughness[i]))); rough[i * 4 + 3] = 255;
  }
  let normalMap: THREE.DataTexture | undefined;
  if (pattern.height) {
    const h = pattern.height, normal = new Uint8Array(n * 4), at = (x: number, y: number) => h[((y + size) % size) * size + (x + size) % size];
    const v = new THREE.Vector3();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      v.set(-(at(x + 1, y) - at(x - 1, y)) * pattern.normalStrength!, -(at(x, y + 1) - at(x, y - 1)) * pattern.normalStrength!, 1).normalize();
      const i = (y * size + x) * 4;
      normal[i] = Math.round((v.x * 0.5 + 0.5) * 255); normal[i + 1] = Math.round((v.y * 0.5 + 0.5) * 255); normal[i + 2] = Math.round((v.z * 0.5 + 0.5) * 255); normal[i + 3] = 255;
    }
    normalMap = texture(normal, size);
  }
  return { map: texture(map, size, true), roughnessMap: texture(rough, size), normalMap };
}
