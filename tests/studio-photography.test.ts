import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { presentationSchema } from '../src/shared/protocol';
import { addStudioFloor, addStudioLights, applyFloorTextures, studioPreviewLights } from '../src/web/studio-scene';
import { changeStudioLens, studioLensFov } from '../src/web/studio-camera';
import { partMaterial } from '../src/web/scene';

test('the floor finish continues through the seamless bend without a material boundary', () => {
  const scene = new THREE.Scene();
  const floor = addStudioFloor(scene, new THREE.Box3(new THREE.Vector3(-100, -30, 0), new THREE.Vector3(100, 30, 80)), { backdrop: 'sweep', floor: 'gloss' })!;
  const surfaces = scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  const flatIndex = floor.geometry.index!.getX(0);
  const curved = surfaces.find(o => {
    const n = o.geometry.getAttribute('normal'), index = o.geometry.index!;
    return Array.from(index.array).some(i => n.getZ(i) < 0.5);
  })!;
  assert.equal(curved.material, floor.material, 'the glossy floor and bend must share their texture and full reflection response');
  assert.equal(floor.geometry.getAttribute('normal').getZ(flatIndex), 1);
  for (const mesh of surfaces) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
});

test('a seamless set has continuous upward/inward normals, finite texture coordinates and no degenerate faces', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-100, -30, 0), new THREE.Vector3(100, 30, 80));
  const scene = new THREE.Scene(), floor = addStudioFloor(scene, bounds, { backdrop: 'sweep' })!;
  const geometry = floor.geometry, p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)));
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-6);
    assert.ok(n.getZ(i) >= 0 && p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i) <= 1e-3);
  }
  for (let i = 0; i < geometry.index!.count; i += 3) {
    a.fromBufferAttribute(p, geometry.index!.getX(i)); b.fromBufferAttribute(p, geometry.index!.getX(i + 1)); c.fromBufferAttribute(p, geometry.index!.getX(i + 2));
    assert.ok(b.sub(a).cross(c.sub(a)).lengthSq() > 1e-8);
  }
  const map = new THREE.DataTexture(new Uint8Array([128,128,128,255]), 1, 1); map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.DataTexture(new Uint8Array([128,128,128,255]), 1, 1);
  applyFloorTextures(scene, { map, roughnessMap, sweep: true }, { backdrop: 'sweep' });
  const color = geometry.getAttribute('color'), material = floor.material as THREE.MeshPhysicalMaterial;
  assert.ok(Math.abs(color.getX(0) - new THREE.Color('#8f9396').r) < 1e-6, 'the flat floor retains its color before texture sampling');
  assert.equal(material.map?.source, map.source, 'the same texture covers the floor and bend');
  assert.equal(material.roughnessMap?.source, roughnessMap.source);
  assert.equal(material.roughness, .85, 'roughness sampling stays continuous through the bend');
  assert.ok(Math.abs(color.getX(color.count - 1) * new THREE.Color(128/255,128/255,128/255).convertSRGBToLinear().r - new THREE.Color('#9a9d9f').r) < 1e-6);
  // Every triangle touching the flat floor samples the same color on both sides of the join.
  for (let i = 0; i < p.count; i++) if (p.getZ(i) === 0) assert.ok(Math.abs(color.getX(i) - color.getX(0)) < 1e-7);
  for (let i = 0; i < geometry.index!.count; i += 3) {
    const [a,b,c] = [0,1,2].map(j => geometry.index!.getX(i+j));
    const area = (uv.getX(b)-uv.getX(a))*(uv.getY(c)-uv.getY(a)) - (uv.getY(b)-uv.getY(a))*(uv.getX(c)-uv.getX(a));
    assert.ok(Math.abs(area) > 1e-10, 'normal-map derivatives remain finite on the vertical wall');
  }
  map.dispose(); roughnessMap.dispose();
  for (const texture of floor.userData.ownedTextures ?? []) texture.dispose();
  geometry.dispose(); (floor.material as THREE.Material).dispose();
});

test('softbox size and fill can be varied independently in a world-fixed rig', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-100, -30, 0), new THREE.Vector3(100, 30, 80));
  const panels = (keySize: number, fillIntensity: number) => {
    const scene = new THREE.Scene(); addStudioLights(scene, bounds, { preset: 'dramatic', keySize, fillIntensity }); studioPreviewLights(scene, false);
    return scene.children.filter((o): o is THREE.RectAreaLight => o instanceof THREE.RectAreaLight);
  };
  const base = panels(1, 1), wide = panels(2, 1), dark = panels(1, 0);
  assert.equal(wide[0].width, base[0].width * 2); assert.equal(wide[0].height, base[0].height * 2);
  assert.equal(wide[1].intensity, base[1].intensity); assert.equal(wide[2].intensity, base[2].intensity);
  assert.equal(dark[2].intensity, 0); assert.equal(dark[0].intensity, base[0].intensity); assert.equal(dark[1].intensity, base[1].intensity);
  assert.ok(base[0].position.distanceTo(bounds.getCenter(new THREE.Vector3())) < bounds.getBoundingSphere(new THREE.Sphere()).radius * 2);
  assert.ok(presentationSchema.safeParse({ keySize: 0.25, fillIntensity: 0, backdrop: 'sweep', environmentPreset: 'dark_studio', floor: 'polished_concrete' }).success);
  assert.equal(presentationSchema.safeParse({ keySize: 0 }).success, false);
  const metal = partMaterial({ material: 'chrome', finish: 'mirror' })!;
  assert.equal(metal.clearcoat, 0, 'polishing a metal does not add a lacquer'); metal.dispose();
});

test('lens changes preserve focus-plane framing and account for the actual output crop', () => {
  const viewport = { width: 1200, height: 900 }, image = { width: 1920, height: 1080 };
  const short = studioLensFov(50, viewport, image), long = studioLensFov(135, viewport, image);
  const camera = new THREE.PerspectiveCamera(short, viewport.width / viewport.height, .01, 1000), target = new THREE.Vector3(1, 2, 3);
  camera.position.set(2, -8, 6); camera.up.set(0, 0, 1); camera.lookAt(target);
  const direction = camera.position.clone().sub(target).normalize();
  const before = 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(short) / 2);
  changeStudioLens(camera, target, long);
  const after = 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(long) / 2);
  assert.ok(Math.abs(before - after) < 1e-9); assert.ok(direction.distanceTo(camera.position.clone().sub(target).normalize()) < 1e-10);
  const outputFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(long) / 2) * (1200 * 1080 / 1920) / 900);
  assert.ok(Math.abs(outputFov - 2 * Math.atan((35 / (1920 / 1080)) / (2 * 135))) < 1e-10);
});
