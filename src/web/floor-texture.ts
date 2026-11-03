import * as THREE from 'three';

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
export type FloorMaps = { map: THREE.Texture; roughnessMap: THREE.Texture; normalMap?: THREE.Texture; repeatSpan?: number; sweep?: boolean };
const hash = (x: number, y: number) => { let n = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263); n = Math.imul(n ^ n >>> 13, 1274126177); return (n ^ n >>> 16) >>> 0; };
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Bake offset and quarter-turned photograph patches together, keeping all PBR channels aligned.
 * Eight independent source spans fit in one bounded texture. Normal vectors rotate with each patch.
 * The result uses ordinary textures, identically in WebGL preview and the native path tracer.
 */
export async function continuousFloorPixels(color: Pixels, roughness: Pixels, normal: Pixels, size = 2048, cells = 8) {
  const albedo = new Uint8Array(size * size * 4), rough = new Uint8Array(albedo.length), normals = new Uint8Array(albedo.length);
  const patch = size / cells;
  const nodes = Array.from({ length: cells * cells }, (_, i) => {
    const h = hash(i % cells, Math.floor(i / cells));
    return { x: h % color.width, y: (h >>> 10) % color.height, turn: h >>> 24 & 3 };
  });
  const sample = (source: Pixels, x: number, y: number, channel: number) => {
    const u = ((Math.floor(x * source.width / color.width) % source.width) + source.width) % source.width;
    const v = ((Math.floor(y * source.height / color.height) % source.height) + source.height) % source.height;
    return source.data[(v * source.width + u) * 4 + channel];
  };
  for (let y = 0; y < size; y++) {
    const gy = y / patch, iy = Math.floor(gy), fy = smooth(gy - iy);
    for (let x = 0; x < size; x++) {
      const gx = x / patch, ix = Math.floor(gx), fx = smooth(gx - ix);
      let c = 0, r = 0, nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const n = nodes[((iy + j) % cells) * cells + (ix + i) % cells];
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
        const u = x / patch * color.width, v = y / patch * color.height;
        const su = (n.turn === 0 ? u : n.turn === 1 ? -v : n.turn === 2 ? -u : v) + n.x;
        const sv = (n.turn === 0 ? v : n.turn === 1 ? u : n.turn === 2 ? -v : -u) + n.y;
        // Floor color controls its tint. The photograph supplies restrained tonal variation.
        c += w * (0.2126 * sample(color, su, sv, 0) + 0.7152 * sample(color, su, sv, 1) + 0.0722 * sample(color, su, sv, 2));
        r += w * sample(roughness, su, sv, 1);
        const a = sample(normal, su, sv, 0) / 127.5 - 1, b = sample(normal, su, sv, 1) / 127.5 - 1;
        nx += w * (n.turn === 0 ? a : n.turn === 1 ? b : n.turn === 2 ? -a : -b);
        ny += w * (n.turn === 0 ? b : n.turn === 1 ? -a : n.turn === 2 ? -b : a);
        nz += w * (sample(normal, su, sv, 2) / 127.5 - 1);
      }
      const p = (y * size + x) * 4, value = Math.round(192 + (c - 150) * 0.35);
      albedo[p] = albedo[p + 1] = albedo[p + 2] = value; albedo[p + 3] = 255;
      rough[p] = rough[p + 1] = rough[p + 2] = Math.round(85 + r * 0.65); rough[p + 3] = 255;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[p] = Math.round(127.5 * (nx / length + 1)); normals[p + 1] = Math.round(127.5 * (ny / length + 1));
      normals[p + 2] = Math.round(127.5 * (nz / length + 1)); normals[p + 3] = 255;
    }
    // A floor change must not block orbiting while the one-time bake is prepared.
    if ((y & 15) === 15) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return { albedo, roughness: rough, normal: normals, size };
}

export async function continuousConcrete(maps: FloorMaps): Promise<FloorMaps> {
  if (!maps.normalMap) return maps;
  const pixels = (texture: THREE.Texture): Pixels => {
    const image = texture.image as HTMLImageElement, canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, 0, 0);
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
  };
  const baked = await continuousFloorPixels(pixels(maps.map), pixels(maps.roughnessMap), pixels(maps.normalMap));
  const texture = (data: Uint8Array, color = false) => {
    const t = new THREE.DataTexture(data, baked.size, baked.size); t.flipY = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true; return t;
  };
  for (const t of [maps.map, maps.roughnessMap, maps.normalMap]) t.dispose();
  return { map: texture(baked.albedo, true), roughnessMap: texture(baked.roughness), normalMap: texture(baked.normal), repeatSpan: 8 };
}
