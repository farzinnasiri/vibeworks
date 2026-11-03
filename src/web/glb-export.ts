import * as THREE from 'three';
import { addSurfaceGraphics } from './surface-graphics';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { MeshExporter } from '../cad/runtime';
import { effectiveAppearance } from '../cad/document';
import { partMaterial, displayBuffers, placeDisplay } from './scene';

/**
 * Binary glTF of the display meshes with each part's material and name: for presentation, AR and
 * renderers, not manufacturing (use STEP). glTF is metres and Y-up, so the model is scaled and turned.
 */
export const exportGlb: MeshExporter = async (evaluation, document, featureIds) => {
  const root = new THREE.Group();
  root.name = document.name ?? 'Vibeworks part';
  root.userData = { documentId: document.documentId, revision: document.revision, authoredUnits: 'mm', exportedUnits: 'm', authority: 'node', sources: evaluation.references ?? [] };
  root.scale.setScalar(0.001);
  root.rotation.x = -Math.PI / 2;
  const buffers=new Map<number[], {solid:THREE.BufferGeometry;edges:THREE.BufferGeometry}>();
  const exportTextures = new Map<THREE.DataTexture, THREE.CanvasTexture>();
  for (const data of evaluation.meshes.filter(mesh => featureIds.includes(mesh.featureId))) {
    const geometry=displayBuffers(data,buffers).solid;
    // glTF readers can reconstruct tangents from the seam-safe UVs and normals. Omitting this
    // redundant array keeps large assemblies within the existing bounded export transport.
    geometry.deleteAttribute('tangent');
    const material = partMaterial(data.appearance ?? effectiveAppearance(document, data.featureId)) ?? new THREE.MeshPhysicalMaterial({ color: 0xc4cbd1, roughness: 0.5, metalness: 0.2 });
    // The exporter combines roughness and metalness using Canvas2D.drawImage,
    // which cannot read a DataTexture's raw pixel object.
    for (const slot of ['map', 'roughnessMap', 'normalMap', 'anisotropyMap', 'clearcoatNormalMap'] as const) {
      const source = material[slot];
      if (!(source instanceof THREE.DataTexture)) continue;
      let texture = exportTextures.get(source);
      if (!texture) {
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = source.image.width; canvas.height = source.image.height;
        if (!source.image.data) throw new Error('Material detail texture has no pixels.');
        const pixels = Uint8ClampedArray.from(source.image.data, Number);
        canvas.getContext('2d')!.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
        texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = source.wrapS; texture.wrapT = source.wrapT;
        texture.flipY = source.flipY; texture.colorSpace = source.colorSpace;
        exportTextures.set(source, texture);
      }
      material[slot] = texture;
    }
    const mesh = new THREE.Mesh(geometry, material);
    placeDisplay(mesh,data);
    mesh.name = document.features.find(f => f.id === data.featureId)?.label ?? data.featureId;
    root.add(mesh);
  }
  try {
  await addSurfaceGraphics(root, evaluation.meshes.filter(mesh => featureIds.includes(mesh.featureId)));
  const result = await new GLTFExporter().parseAsync(root, { binary: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('GLB export did not produce binary data.');
  return { bytes: result, mimeType: 'model/gltf-binary' };
  } finally {
  for (const texture of exportTextures.values()) texture.dispose();
  for(const asset of buffers.values())asset.edges.dispose();
  root.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
  }
};
