import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import type { DisplayMesh, SurfaceGraphic } from '../shared/protocol';
import { CadError } from '../cad/document';

/** Project in the source result's local coordinates, then carry the clipped graphic with its instance. */
export function graphicGeometry(data: DisplayMesh, graphic: SurfaceGraphic): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  geometry.computeBoundingBox();
  const bounds = data.graphicBounds ? new THREE.Box3(new THREE.Vector3(...data.graphicBounds.min),new THREE.Vector3(...data.graphicBounds.max)) : geometry.boundingBox!;
  const position = bounds.min.clone().add(bounds.getSize(new THREE.Vector3()).multiply(new THREE.Vector3(...graphic.anchor)));
  const normal = new THREE.Vector3(...graphic.normal).normalize();
  const x = new THREE.Vector3(...graphic.xDirection).normalize();
  x.addScaledVector(normal, -x.dot(normal)).normalize().applyAxisAngle(normal, THREE.MathUtils.degToRad(graphic.rotation));
  const y = new THREE.Vector3().crossVectors(normal, x);
  const orientation = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, normal));
  const indices: number[] = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cutoff = Math.cos(THREE.MathUtils.degToRad(graphic.maxAngle));
  for (let i = 0; i < data.triangles.length; i += 3) {
    const tri = data.triangles.slice(i, i + 3);
    a.fromArray(data.vertices, tri[0] * 3); b.fromArray(data.vertices, tri[1] * 3); c.fromArray(data.vertices, tri[2] * 3);
    const facing = b.sub(a).cross(c.sub(a)).normalize().dot(normal);
    if (facing >= cutoff) indices.push(...tri);
  }
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld();
  try {
    const clipped = new DecalGeometry(mesh, position, orientation, new THREE.Vector3(graphic.width, graphic.height, graphic.depth));
    if (data.transform) clipped.applyMatrix4(new THREE.Matrix4().fromArray(data.transform));
    return clipped;
  } finally { geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
}

const fonts = { sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: 'Courier New, monospace' };
async function graphicTexture(graphic: SurfaceGraphic): Promise<THREE.CanvasTexture> {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = Math.max(32, Math.min(1024, Math.round(1024 * graphic.height / graphic.width)));
  const ctx = canvas.getContext('2d')!;
  const content = graphic.content;
  if (content.type === 'text') {
    // Measure before fitting: long text scales down uniformly; spacing is in em units.
    const size = 200;
    ctx.font = `${content.weight === 'bold' ? 'bold' : 'normal'} ${size}px ${fonts[content.font]}`;
    const chars = Array.from(content.text), tracking = content.spacing * size;
    const widths = chars.map(char => ctx.measureText(char).width);
    const width = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
    const scale = Math.min((canvas.width - 32) / Math.max(width, 1), (canvas.height - 16) / size);
    ctx.translate(content.align === 'left' ? 16 : content.align === 'right' ? canvas.width - 16 - width * scale : (canvas.width - width * scale) / 2, canvas.height / 2);
    ctx.scale(scale, scale); ctx.textBaseline = 'middle'; ctx.fillStyle = content.color;
    let cursor = 0;
    chars.forEach((char, i) => { ctx.fillText(char, cursor, 0); cursor += widths[i] + tracking; });
  } else {
    if (!('dataUrl'in content)) throw new Error('Graphic asset bytes are unavailable in this display.');
    if (content.dataUrl.startsWith('data:image/svg+xml')) {
      const xml = atob(content.dataUrl.split(',')[1]);
      // Image context cannot execute scripts; reject external content and dynamic SVG as well.
      if (!/<svg[\s>]/i.test(xml) || /<!|<(?:script|foreignObject|image|use|animate|set|style)\b|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(/i.test(xml))
        throw new CadError('GRAPHIC_IMAGE', `Graphic '${graphic.id}' needs a self-contained static SVG without external content.`);
    }
    const image = new Image();
    image.src = content.dataUrl;
    try { await image.decode(); } catch { throw new CadError('GRAPHIC_IMAGE', `Graphic '${graphic.id}' could not be decoded. Replace it with a PNG or static SVG.`); }
    if (!image.width || !image.height || image.width > 2048 || image.height > 2048)
      throw new CadError('GRAPHIC_IMAGE', `Graphic '${graphic.id}' must be at most 2048 × 2048 pixels.`);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The caller owns/disposes added meshes. Late asynchronous image loads never enter a replaced scene. */
export async function addSurfaceGraphics(scene: THREE.Object3D, meshes: DisplayMesh[], active = () => true): Promise<void> {
  let count = 0, vertices = 0;
  for (const data of meshes) for (const graphic of data.appearance?.graphics ?? []) {
    if (!active()) return;
    if (++count > 128) throw new CadError('GRAPHIC_LIMIT', 'Show at most 128 printed graphics per output. Render a smaller selection.');
    const geometry = graphicGeometry(data, graphic);
    if (!geometry.getAttribute('position').count) { geometry.dispose(); continue; }
    vertices += geometry.getAttribute('position').count;
    if (vertices > 1_000_000) { geometry.dispose(); throw new CadError('GRAPHIC_LIMIT', 'Projected graphics exceed one million vertices. Reduce their size, depth or count.'); }
    let texture: THREE.Texture;
    try { texture = await graphicTexture(graphic); } catch (error) { geometry.dispose(); throw error; }
    if (!active()) { geometry.dispose(); texture.dispose(); return; }
    const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.45,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    material.addEventListener('dispose', () => texture.dispose());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { featureId: data.featureId, graphicId: graphic.id };
    mesh.name = `${data.featureId}/${graphic.id}`;
    mesh.renderOrder = 3; mesh.raycast = () => {};
    scene.add(mesh);
  }
}

/**
 * three-gpu-pathtracer 0.0.27 skips a discarded transparent texel by stepping the ray
 * (max(|x|,|y|,|z|) + 1) × RAY_OFFSET scene units past it. A graphic closer to its surface than that step
 * lets the ray skip the surface too, so the transparent part of a graphic shows what lies behind the part.
 * Re-check this constant when the tracer is upgraded.
 */
export const TRACER_RAY_OFFSET = 1e-4;
/** Slack for vertex normals tilted from the face normal on tessellated curves. */
const LIFT_MARGIN = 1.6;

/**
 * Raise graphic vertices along their normals by a margin over the tracer's step at that point.
 * Positions are millimetres; `center` and `unitMm` describe the traced scene's origin and unit.
 */
export function liftGraphicForTracing(geometry: THREE.BufferGeometry, center: THREE.Vector3, unitMm: number): void {
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const extent = Math.max(Math.abs(x - center.x), Math.abs(y - center.y), Math.abs(z - center.z)) / unitMm;
    const lift = LIFT_MARGIN * (extent + 1) * TRACER_RAY_OFFSET * unitMm;
    positions.setXYZ(i, x + normals.getX(i) * lift, y + normals.getY(i) * lift, z + normals.getZ(i) * lift);
  }
  positions.needsUpdate = true;
  geometry.computeBoundingSphere(); geometry.computeBoundingBox();
}

/** Studio traces in units of up to a metre, smaller for small models, so offsets stay proportionate. */
export const studioUnitMm = (modelRadiusMm: number) => Math.min(1000, Math.max(1, modelRadiusMm));
