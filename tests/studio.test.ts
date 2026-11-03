import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { appearanceSchema, presentationSchema } from '../src/shared/protocol';
import { STUDIO_FLOOR_IDS } from '../src/shared/materials';
import { DEFAULT_IMAGE_OUTPUT, floorPatternSize, imageFrame, imagePixels, imageQuality, resolveSurface, STUDIO_FLOORS, studioSettings } from '../src/shared/studio';
import { createStudioModelScene, disposeScene, applyMaterialLooks, partMaterial } from '../src/web/scene';
import { addStudioFloor, addStudioLights, gradientBackground, studioPreviewLights } from '../src/web/studio-scene';
import { detailGeometry, DETAIL_REPEAT_MM } from '../src/web/material-detail';
import { floorPattern } from '../src/web/floor-patterns';
import { liftGraphicForTracing, studioUnitMm, TRACER_RAY_OFFSET } from '../src/web/surface-graphics';
import { buildStudioAssets, composeStudioScene, releaseStudioScene } from '../src/web/studio-compose';
import { dispatchDelay } from '../src/web/studio-render';

const carbon = { material: 'carbon_fiber' as const, color: '#272a2d', finish: 'matte' as const, detail: 'carbon' as const };
const triangle = (featureId: string, appearance?: object) => ({ featureId, vertices: [0,0,0, 10,0,0, 0,10,0], normals: [0,0,1, 0,0,1, 0,0,1], triangles: [0,1,2], lines: [], appearance });
const meshMaterial = (scene: THREE.Scene, featureId: string) => (scene.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.userData.featureId === featureId)!).material as THREE.MeshPhysicalMaterial;

test('Studio renders embedded assembly appearances instead of the unstyled contact-sheet palette', () => {
  const evaluation = { geometry: [], visibleFeatureIds: ['body'], meshes: [triangle('body', carbon)] };
  const before = JSON.stringify(evaluation), scene = createStudioModelScene(evaluation);
  const material = meshMaterial(scene, 'body');
  assert.equal(material.color.getHexString(), '272a2d');
  assert.equal(material.roughness, 0.85); assert.equal(material.clearcoat, 1, 'finish changes the substrate roughness independently of its resin');
  assert.ok(material.normalMap); assert.ok(material.roughnessMap);
  assert.equal(material.bumpMap, null, 'standard normal maps also reach the refined renderer and GLB');
  assert.equal(JSON.stringify(evaluation), before, 'staging must not recolor or modify the model');
  disposeScene(scene);
});

test('material looks change finish, coating and detail independently, per material, and keep authored color', () => {
  const evaluation = { geometry: [], visibleFeatureIds: ['body', 'plain', 'tire', 'bare'], meshes: [
    triangle('body', carbon), triangle('plain', { ...carbon, detail: 'plain' }), triangle('tire', { material: 'tpu', finish: 'matte' }), triangle('bare'),
  ] };
  const scene = createStudioModelScene(evaluation);
  const tireBefore = meshMaterial(scene, 'tire').roughnessMap;
  applyMaterialLooks(scene, { materials: { carbon_fiber: { coat: 'clear' } } });
  const body = meshMaterial(scene, 'body'), plain = meshMaterial(scene, 'plain');
  assert.equal(body.clearcoat, 1); assert.equal(body.roughness, 0.85, 'a coat does not change the base finish');
  assert.equal(body.color.getHexString(), '272a2d');
  assert.equal(plain.clearcoat, 1); assert.equal(plain.normalMap, null, 'a coat does not add weave to plain carbon');
  assert.equal(meshMaterial(scene, 'tire').roughnessMap, tireBefore, 'other materials are untouched');
  applyMaterialLooks(scene, { materials: { carbon_fiber: { detail: 'carbon', detailScale: 2 }, tpu: { finish: 'satin' } } });
  assert.ok(plain.normalMap, 'detail is a separate choice');
  assert.equal((plain.normalMap as THREE.Texture | null)?.repeat.x, 0.5, 'a larger pattern repeats less often');
  assert.equal(meshMaterial(scene, 'tire').roughness, 0.45);
  disposeScene(scene);
  // Legacy coated carbon reads as a carbon look; explicit looks win.
  assert.deepEqual(studioSettings({ carbonFinish: 'coated' }).materials.carbon_fiber, { coat: 'clear', detail: 'carbon' });
  assert.deepEqual(studioSettings({ carbonFinish: 'coated', materials: { carbon_fiber: { finish: 'gloss' } } }).materials.carbon_fiber, { finish: 'gloss' });
  const unchanged = resolveSurface({ materialKey: 'steel', finish: 'satin', detail: 'plain' }, {});
  assert.equal(unchanged.changed, false); assert.equal(unchanged.roughness, undefined); assert.equal(unchanged.clearcoat, undefined);
});

test('detail coordinates never interpolate across a projection seam, and tangents are finite and orthogonal', () => {
  // A tire-like torus: its normals sweep through every dominant axis.
  const geometry = new THREE.TorusGeometry(300, 110, 48, 96);
  const vertices = Array.from(geometry.getAttribute('position').array as Float32Array), normals = Array.from(geometry.getAttribute('normal').array as Float32Array), triangles = Array.from(geometry.index!.array);
  const detail = detailGeometry(vertices, normals, triangles);
  assert.equal(detail.index.length, triangles.length);
  let worst = 0;
  for (let t = 0; t < detail.index.length; t += 3) {
    const ids = [detail.index[t], detail.index[t + 1], detail.index[t + 2]];
    // Same positions as the worker's triangle.
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) assert.equal(detail.position[ids[k] * 3 + c], Math.fround(vertices[triangles[t + k] * 3 + c]));
    // Span of the triangle in detail coordinates against its size in millimetres.
    const span = Math.max(...[0, 1].map(axis => Math.max(...ids.map(i => detail.uv[i * 2 + axis])) - Math.min(...ids.map(i => detail.uv[i * 2 + axis]))));
    const edge = Math.max(...[[0, 1], [1, 2], [2, 0]].map(([a, b]) => Math.hypot(...[0, 1, 2].map(c => detail.position[ids[a] * 3 + c] - detail.position[ids[b] * 3 + c]))));
    worst = Math.max(worst, span * DETAIL_REPEAT_MM / edge);
  }
  assert.ok(worst <= 1.0001, `detail coordinates stretch at most like the surface itself (worst ${worst.toFixed(2)})`);
  for (let i = 0; i < detail.tangent.length / 4; i++) {
    const t = [0, 1, 2].map(k => detail.tangent[i * 4 + k]), n = [0, 1, 2].map(k => detail.normal[i * 3 + k]);
    assert.ok(t.every(Number.isFinite)); assert.ok(Math.abs(Math.hypot(...t) - 1) < 1e-5);
    assert.ok(Math.abs(t[0] * n[0] + t[1] * n[1] + t[2] * n[2]) < 1e-4); assert.ok(Math.abs(detail.tangent[i * 4 + 3]) === 1);
  }
  assert.ok(detail.position.length / 3 < vertices.length / 3 * 1.6, 'only seam triangles add vertices');
  geometry.dispose();
});

test('graphics clear the path tracer surface step at every vertex, proportionately to model size', () => {
  for (const radius of [40, 2700]) {
    const unit = studioUnitMm(radius), center = new THREE.Vector3(10, -20, 30);
    const geometry = new THREE.BufferGeometry();
    const points = [[center.x + radius, center.y, center.z], [center.x, center.y, center.z], [center.x - radius * 0.7, center.y + radius * 0.7, center.z]];
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1], 3));
    liftGraphicForTracing(geometry, center, unit);
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < points.length; i++) {
      const lift = positions.getZ(i) - points[i][2];
      const extent = Math.max(...points[i].map((v, k) => Math.abs(v - center.getComponent(k)))) / unit;
      const step = (extent + 1) * TRACER_RAY_OFFSET * unit;
      assert.ok(lift > step * 1.5, `lift ${lift} mm exceeds the tracer step ${step} mm`);
      assert.ok(lift < radius * 0.002, 'and stays imperceptible beside the model');
    }
  }
});

test('studio softboxes stay in world space, floors follow model bounds, and preview lights can be excluded from tracing', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-100,-20,-50), new THREE.Vector3(300,80,100));
  const scene = new THREE.Scene(), settings = { lightColor: '#ffcc88', lightRotation: 30, lightElevation: 50, floorHeight: -2, floor: 'tiles' as const, backdrop: 'plane' as const };
  const key = addStudioLights(scene, bounds, settings), floor = addStudioFloor(scene, bounds, settings)!;
  const lights = scene.children.filter((o): o is THREE.RectAreaLight => o instanceof THREE.RectAreaLight);
  assert.equal(lights.length, 3); assert.equal(lights[0].color.getHexString(), 'ffcc88');
  assert.ok(lights[0].width > lights[0].height); assert.ok(lights[2].height > lights[2].width);
  const center = bounds.getCenter(new THREE.Vector3());
  assert.ok(key.target.position.distanceTo(center) < 1e-9); assert.ok(key.position.z > center.z);
  assert.ok(floor.position.z < -52 && floor.position.z > -53);
  assert.equal(floor.userData.featureId, undefined); assert.equal(floor.raycast(new THREE.Raycaster(), []), undefined);
  const preview = lights[0].intensity;
  studioPreviewLights(scene, false); assert.equal(key.visible, false); assert.ok(lights.every(l => l.visible));
  assert.ok(lights[0].intensity > preview, 'the traced key softbox takes back the shadow light share');
  studioPreviewLights(scene, true); assert.equal(key.visible, true); assert.equal(lights[0].intensity, preview);
  assert.equal(addStudioFloor(new THREE.Scene(), bounds, { floor: 'none' }), undefined);
  // Without a saved choice the set is seamless: an open floor shows a horizon behind the model.
  assert.equal(studioSettings({}).backdrop, 'sweep');
  disposeScene(scene);
});

test('floors offer studio, industrial and architectural types with real-world pattern sizes that shrink for small models', () => {
  assert.deepEqual(new Set(STUDIO_FLOOR_IDS.map(id => STUDIO_FLOORS[id].group)), new Set(['Studio', 'Industrial', 'Architectural']));
  assert.equal(floorPatternSize({ floor: 'wood' }, 2700), 800);
  assert.ok(floorPatternSize({ floor: 'wood' }, 60)! < 100);
  assert.equal(floorPatternSize({ floor: 'wood', floorScale: 250 }, 60), 250);
  assert.equal(floorPatternSize({ floor: 'matte' }, 2700), undefined);
  for (const kind of ['grid', 'checker', 'wood', 'plate', 'epoxy', 'asphalt'] as const) {
    const pattern = floorPattern(kind, 64);
    for (const values of [pattern.albedo, pattern.roughness]) assert.ok(values.every(v => Number.isFinite(v) && v >= 0 && v <= 1.0001), kind);
    assert.deepEqual(floorPattern(kind, 64).albedo, pattern.albedo, `${kind} is deterministic`);
  }
  assert.equal(studioSettings({ floor: 'plate' }).floorRoughness, STUDIO_FLOORS.plate.roughness, 'each floor type has its own defaults');
  const gradient = gradientBackground('#ffffff', '#000000');
  assert.equal(gradient.mapping, THREE.EquirectangularReflectionMapping); gradient.dispose();
});

test('composed Studio scenes share model assets, keep preview-only lighting out of tracing, and release only what they own', async () => {
  const evaluation = { geometry: [{ featureId: 'body', bounds: { min: [0, 0, 0], max: [10, 10, 0] } }], visibleFeatureIds: ['body'], meshes: [triangle('body', carbon)] } as never;
  const assets = (await buildStudioAssets(evaluation))!;
  const look = { environment: new THREE.DataTexture(), floor: undefined };
  const preview = composeStudioScene(assets, { floor: 'gloss' }, look, 'preview'), traced = composeStudioScene(assets, { floor: 'gloss' }, look, 'trace');
  const find = (scene: THREE.Scene, test: (o: THREE.Object3D) => boolean) => { let found: THREE.Object3D | undefined; scene.traverse(o => { if (!found && test(o)) found = o; }); return found; };
  assert.equal(find(preview, o => !!o.userData.previewLight)!.visible, true);
  assert.equal(find(traced, o => !!o.userData.previewLight)!.visible, false);
  const a = find(preview, o => o.userData.featureId === 'body') as THREE.Mesh, b = find(traced, o => o.userData.featureId === 'body') as THREE.Mesh;
  assert.equal(a.geometry, b.geometry, 'geometry is prepared once per model');
  assert.notEqual(a.material, b.material, 'materials belong to each scene');
  let disposed = false; a.geometry.addEventListener('dispose', () => { disposed = true; });
  releaseStudioScene(preview);
  assert.equal(disposed, false, 'releasing a scene keeps the shared model geometry');
  releaseStudioScene(traced);
});

test('render pacing follows measured GPU completion and output framing matches the view', () => {
  assert.ok(dispatchDelay(20, { hidden: false, interacting: true }) > 0, 'camera motion yields GPU time to the preview');
  assert.equal(dispatchDelay(20, { hidden: false, interacting: false }), 0);
  assert.equal(dispatchDelay(20, { hidden: true, interacting: true }), 0);
  const frame = imageFrame({ width: 1200, height: 800 }, { width: 1920, height: 1080 });
  assert.equal(frame.width, 1200); assert.ok(Math.abs(frame.height - 675) < 1e-9); assert.ok(Math.abs(frame.y - 62.5) < 1e-9);
  const tall = imageFrame({ width: 1200, height: 800 }, { width: 1600, height: 2000 });
  assert.equal(tall.height, 800); assert.equal(tall.width, 640);
  assert.deepEqual(imagePixels({ size: 'viewport', quality: 'draft', denoise: true }, { width: 1000, height: 500 }, 2), { width: 2000, height: 1000 });
  assert.deepEqual(imagePixels({ size: 'viewport', quality: 'draft', denoise: true }, { width: 3000, height: 1500 }, 2), { width: 3840, height: 1920 });
  assert.deepEqual(imagePixels(DEFAULT_IMAGE_OUTPUT, { width: 2000, height: 1400 }, 2), { width: 1920, height: 1080 }, 'the default image cost is independent of Retina viewport size');
  assert.equal(imageQuality({ quality: 'standard', denoise: true }).samples, 64);
  assert.equal(imageQuality({ quality: 'standard', denoise: false }).samples, 160, 'turning off guided denoising restores the raw sample budget');
  assert.equal(imageQuality({ quality: 'high', denoise: true }).samples, 160);
  assert.equal(imageQuality({ quality: 'high', denoise: false }).samples, 512);
});

test('saved Studio controls retain legacy settings and reject unbounded or unsupported input', () => {
  const settings = presentationSchema.parse({ preset: 'soft', environment: 1.2, environmentPreset: 'warehouse', environmentRotation: 60, lightColor: '#ffc68a', lightElevation: 45, floor: 'tiles', floorScale: 800, floorHeight: -3, floorRoughness: 0.3, backgroundMode: 'environment', carbonFinish: 'coated' });
  assert.equal(studioSettings(settings).environment, 1.2);
  assert.equal(studioSettings(settings).floor, 'tiles');
  assert.equal(studioSettings({ preset: 'soft' }).environment, 1);
  presentationSchema.parse({ floor: 'wood', backgroundMode: 'gradient', backgroundTop: '#ffffff', materials: { carbon_fiber: { finish: 'gloss', coat: 'clear', detail: 'carbon', detailScale: 0.5 }, unassigned: { finish: 'satin' } } });
  for (const patch of [{ floor: 'remote-url' }, { floorScale: 0 }, { floorHeight: Infinity }, { lightColor: 'red' }, { environmentRotation: 181 }, { lightElevation: 90 }, { arbitraryScript: 'x' },
    { materials: { unobtainium: { finish: 'gloss' } } }, { materials: { steel: { detailScale: 10 } } }, { materials: { steel: { coat: 'chrome' } } }, { materials: { steel: { shader: 'x' } } }, { backgroundMode: 'image' }])
    assert.throws(() => presentationSchema.parse(patch), JSON.stringify(patch));
});

test('woven detail retains authored color and supplies directional and coating detail; plain clears it', () => {
  const evaluation={geometry:[],visibleFeatureIds:['body'],meshes:[triangle('body',carbon)]};
  const scene=createStudioModelScene(evaluation), material=meshMaterial(scene,'body');
  assert.equal(material.color.getHexString(),'272a2d');
  assert.ok(material.map);assert.equal(material.map.colorSpace,THREE.SRGBColorSpace);
  assert.ok(material.anisotropyMap);assert.equal(material.clearcoatNormalMap,null,'resin stays smooth over woven base normals');
  assert.ok(material.anisotropy>0);
  applyMaterialLooks(scene,{materials:{carbon_fiber:{detail:'plain'}}});
  for(const slot of ['map','normalMap','roughnessMap','anisotropyMap','clearcoatNormalMap'] as const)assert.equal(material[slot],null);
  assert.equal(material.anisotropy,0);assert.equal(material.color.getHexString(),'272a2d');
  disposeScene(scene);
});

test('continuous floor patches vary between neighboring spans and keep normalized normals', async () => {
  const {continuousFloorPixels}=await import('../src/web/floor-texture');
  const size=32,color=new Uint8ClampedArray(size*size*4),normal=new Uint8ClampedArray(color.length);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4;color[i]=color[i+1]=color[i+2]=40+((x*x+7*y)%180);color[i+3]=255;
    normal[i]=128;normal[i+1]=128;normal[i+2]=255;normal[i+3]=255;
  }
  const source={data:color,width:size,height:size},n={data:normal,width:size,height:size};
  const a=await continuousFloorPixels(source,source,n,64,4),b=await continuousFloorPixels(source,source,n,64,4);
  assert.deepEqual(a.albedo,b.albedo,'the same scene produces the same floor');
  let differing=0;
  for(let y=0;y<64;y++)for(let x=0;x<48;x++)if(a.albedo[(y*64+x)*4]!==a.albedo[(y*64+x+16)*4])differing++;
  assert.ok(differing>64*48*.8,'adjacent source spans must not repeat the photograph');
  for(let i=0;i<a.normal.length;i+=4){
    const length=Math.hypot(...[0,1,2].map(k=>a.normal[i+k]/127.5-1));assert.ok(Math.abs(length-1)<.02);
    assert.equal(a.albedo[i],a.albedo[i+1]);assert.equal(a.albedo[i],a.albedo[i+2]);
  }
});

test('detail tangents follow the actual projected UV derivative on an oblique surface', () => {
  const n=[.4,.3,Math.sqrt(.75)];
  const data=detailGeometry([0,0,0,12,0,-12*n[0]/n[2],0,12,-12*n[1]/n[2]],[...n,...n,...n],[0,1,2]);
  const tangent=new THREE.Vector3(...data.tangent.slice(0,3));
  const derivative=new THREE.Vector3(12,0,-12*n[0]/n[2]).normalize();
  assert.ok(tangent.dot(derivative)>1-1e-6,'changing U at constant V follows the actual surface, without a sideways component');
});

test('Studio Fit keeps the whole silhouette inside fixed landscape and portrait export frames', async () => {
  const {fitStudioCamera}=await import('../src/web/studio-camera');
  const bounds=new THREE.Box3(new THREE.Vector3(-3,-1,-.5),new THREE.Vector3(3,1,.5));
  const points=[...[-3,3].flatMap(x=>[-1,1].flatMap(y=>[-.5,.5].flatMap(z=>[x,y,z])))];
  const viewport={width:1200,height:900};
  for(const projection of ['perspective','orthographic'] as const)for(const image of [{width:1920,height:1080},{width:1600,height:2000}]){
    const {camera}=fitStudioCamera(projection,[-1.4,-1.8,.95],points,bounds,viewport,image),frame=imageFrame(viewport,image);
    camera.setViewOffset(viewport.width,viewport.height,frame.x,frame.y,frame.width,frame.height);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    for(let i=0;i<points.length;i+=3){const p=new THREE.Vector3().fromArray(points,i).project(camera);assert.ok(Math.abs(p.x)<=1&&Math.abs(p.y)<=1,`${projection} ${image.width}×${image.height} clips ${p.toArray()}`);}
  }
});

test('orbiting after Studio Fit keeps the floor horizon level', async () => {
  const { fitStudioCamera } = await import('../src/web/studio-camera');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera);
  const bounds = new THREE.Box3(new THREE.Vector3(-3, -1, -0.5), new THREE.Vector3(3, 1, 0.5));
  const points = [-3, 3].flatMap(x => [-1, 1].flatMap(y => [-0.5, 0.5].flatMap(z => [x, y, z])));
  const fitted = fitStudioCamera('perspective', [-1.4, -1.8, 0.95], points, bounds,
    { width: 900, height: 850 }, { width: 1920, height: 1080 });
  camera.copy(fitted.camera as THREE.PerspectiveCamera);
  controls.target.fromArray(fitted.tile.target);
  controls.update();
  controls.rotateLeft(0.4);
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  assert.ok(Math.abs(right.z) < 1e-7, `Orbit introduced a tilted horizon: right.z=${right.z}`);
});

test('rubber is a distinct shared material with dry, nonmetallic grain in every presentation path', () => {
  const appearance = appearanceSchema.parse({ material: 'rubber' });
  const material = partMaterial(appearance)!;
  assert.equal(material.metalness, 0);
  assert.equal(material.clearcoat, 0);
  assert.ok(material.roughness >= 0.75);
  assert.ok(material.normalMap && material.roughnessMap);
  assert.equal(material.userData.surface.detail, 'rubber');
  assert.equal(resolveSurface({ materialKey: 'rubber' }, {}).detail, 'rubber');
  assert.equal(appearanceSchema.parse({ material: 'tpu' }).material, 'tpu', 'saved TPU remains a separate valid material');
  material.dispose();
});

test('Studio resize and projection changes preserve a close-up instead of fitting the whole model', async () => {
  const { matchStudioProjection, resizeStudioCamera } = await import('../src/web/studio-camera');
  const target = new THREE.Vector3(1.5, -0.3, 0.2);
  const perspective = new THREE.PerspectiveCamera(35, 1.5, 0.01, 100);
  perspective.up.set(0, 0, 1); perspective.position.copy(target).add(new THREE.Vector3(-2, -3, 1)); perspective.lookAt(target);
  const position = perspective.position.clone();
  resizeStudioCamera(perspective, { width: 900, height: 600 }, { width: 1200, height: 600 });
  assert.deepEqual(perspective.position.toArray(), position.toArray());
  assert.equal(perspective.aspect, 2);
  const sample = target.clone().add(new THREE.Vector3(0.2, 0, 0));
  perspective.updateMatrixWorld(true);
  const original = sample.clone().project(perspective);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  matchStudioProjection(perspective, ortho, target, 2);
  // Points on the focus plane keep the same visible scale; off-plane points retain projection differences.
  const height = 2 * perspective.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
  assert.ok(Math.abs((ortho.top - ortho.bottom) - height) < 1e-10);
  matchStudioProjection(ortho, perspective, target, 2);
  perspective.updateMatrixWorld(true);
  assert.ok(sample.clone().project(perspective).distanceTo(original) < 1e-10);
  assert.ok(perspective.position.distanceTo(position) < 1e-10);
  ortho.zoom = 4;
  const worldPerPixel = (ortho.top - ortho.bottom) / ortho.zoom / 600;
  resizeStudioCamera(ortho, { width: 1200, height: 600 }, { width: 1000, height: 800 });
  assert.equal(ortho.zoom, 4);
  assert.ok(Math.abs((ortho.top - ortho.bottom) / ortho.zoom / 800 - worldPerPixel) < 1e-10);
});

test('Studio separates trackpad pan/orbit from pinch and mouse-wheel zoom', async () => {
  const { studioWheelIntent } = await import('../src/web/studio-navigation');
  const scroll = { deltaX: 30, deltaY: 80, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false };
  assert.deepEqual(studioWheelIntent('trackpad', scroll, 600), { kind: 'pan', x: -30, y: -80 });
  assert.equal(studioWheelIntent('trackpad', { ...scroll, shiftKey: true }, 600).kind, 'orbit');
  assert.equal(studioWheelIntent('trackpad', { ...scroll, ctrlKey: true, shiftKey: true }, 600).kind, 'native', 'pinch outranks orbit');
  assert.equal(studioWheelIntent('mouse', scroll, 600).kind, 'native');
});

test('a fixed Studio image keeps its composition when its window becomes narrow', async () => {
  const { fitStudioCamera, resizeStudioCamera } = await import('../src/web/studio-camera');
  const bounds = new THREE.Box3(new THREE.Vector3(-3, -1, -0.5), new THREE.Vector3(3, 1, 0.5));
  const points = [-3, 3].flatMap(x => [-1, 1].flatMap(y => [-0.5, 0.5].flatMap(z => [x, y, z])));
  const before = { width: 1200, height: 900 }, after = { width: 390, height: 844 }, image = { width: 1920, height: 1080 };
  for (const projection of ['perspective', 'orthographic'] as const) {
    const { camera } = fitStudioCamera(projection, [-1.4, -1.8, 0.95], points, bounds, before, image);
    const project = (viewport: typeof before) => {
      const shot = camera.clone(), frame = imageFrame(viewport, image);
      shot.setViewOffset(viewport.width, viewport.height, frame.x, frame.y, frame.width, frame.height);
      shot.updateProjectionMatrix(); shot.updateMatrixWorld(true);
      return new THREE.Vector3(1, 0.5, 0).project(shot);
    };
    const original = project(before);
    resizeStudioCamera(camera, before, after, image);
    assert.ok(project(after).distanceTo(original) < 1e-8, `${projection} changed the exported image crop`);
  }
});
