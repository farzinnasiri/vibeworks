import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorkbenchScene, disposeScene, fitCamera } from '../src/web/scene';
import type { Bounds } from '../src/shared/protocol';
import { onDemandFrame } from '../src/web/presentation';
import { workbenchPixelRatio, WORKBENCH_PIXEL_BUDGET } from '../src/web/workbench';

test('edit-mode lighting fits one bounded shadow map and preserves transparent/ghost feedback', () => {
  const data = (featureId: string, appearance?: object) => ({ featureId, appearance, vertices: [0,0,0, 20,0,0, 0,20,0], normals: [0,0,1, 0,0,1, 0,0,1], triangles: [0,1,2], lines: [0,0,0,20,0,0] });
  const bounds = { min: [0,0,0], max: [20,20,10], size: [20,20,10] };
  const evaluation = { visibleFeatureIds: ['body','glass'], meshes: [data('body'),data('glass',{material:'glass'}),data('old')], geometry: ['body','glass'].map(featureId => ({featureId,bounds})) } as Parameters<typeof createWorkbenchScene>[0];
  const {scene,parts} = createWorkbenchScene(evaluation, [], ['old']);
  const lights = scene.children.filter((o): o is THREE.DirectionalLight => o instanceof THREE.DirectionalLight && o.castShadow);
  assert.equal(lights.length,1); assert.deepEqual(lights[0].shadow.mapSize.toArray(),[1024,1024]);
  scene.updateMatrixWorld(true); lights[0].shadow.updateMatrices(lights[0]);
  const frustum = lights[0].shadow.getFrustum();
  for (const x of [0,20]) for(const y of [0,20]) for(const z of [0,10]) assert.ok(frustum.containsPoint(new THREE.Vector3(x,y,z)));
  assert.ok(parts[0].mesh.castShadow && parts[0].mesh.receiveShadow);
  assert.equal(parts[1].mesh.castShadow,false); assert.equal(parts[2].mesh.castShadow,false);
  const glass = parts[1].mesh.material as THREE.MeshPhysicalMaterial;
  assert.equal(glass.transmission,0); assert.equal(glass.opacity,0.32); assert.ok(glass.transparent && !glass.depthWrite);
  assert.deepEqual(evaluation.meshes[1].appearance,{material:'glass'},'editor styling does not mutate the model appearance');
  assert.ok((parts[0].mesh.material as THREE.Material).clipShadows);
  assert.equal(parts[0].outline.visible,false); assert.equal(parts[2].outline.visible,true);
  disposeScene(scene);
  const empty = createWorkbenchScene({ visibleFeatureIds: [], geometry: [], meshes: [] }, [], []).scene;
  assert.equal(empty.children.some(o => o instanceof THREE.Light && o.castShadow),false,'empty documents do not allocate a shadow map');
  disposeScene(empty);
});

test('drawing-buffer pixels remain bounded at high DPR and large desktop sizes', () => {
  for (const [w,h,dpr] of [[390,844,3],[1280,800,2],[1920,1080,2],[3840,2160,2],[7680,4320,2]]) {
    const ratio=workbenchPixelRatio(w,h,dpr);
    assert.ok(Math.floor(w*ratio)*Math.floor(h*ratio)<=WORKBENCH_PIXEL_BUDGET);
    assert.ok(ratio<=2);
  }
  assert.equal(workbenchPixelRatio(390,844,2),2);
});

test('split-pane fitting keeps the camera direction and contains the model at narrow and wide aspects', () => {
  const camera = new THREE.OrthographicCamera(); camera.up.set(0, 0, 1);
  const direction = new THREE.Vector3(3, -4, 2).normalize();
  const bounds: Bounds = { min: [-40, -12, 0], max: [40, 12, 18], size: [80, 24, 18] };
  for (const aspect of [.4, 1, 3]) {
    const target = fitCamera(camera, bounds, direction, aspect);
    assert.ok(camera.position.clone().sub(target).normalize().distanceTo(direction) < 1e-10);
    camera.updateMatrixWorld(true);
    for (const x of [-40, 40]) for (const y of [-12, 12]) for (const z of [0, 18]) {
      const point = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(point.x) < .83 && Math.abs(point.y) < .83, 'The complete silhouette must stay in frame');
    }
  }
});

test('redraw requests coalesce, can schedule a later frame and cancel cleanly', () => {
  let next=0, draws=0; const pending=new Map<number,FrameRequestCallback>();
  const frame=onDemandFrame(()=>draws++,fn=>{pending.set(++next,fn);return next},id=>{pending.delete(id)});
  for(let i=0;i<20;i++)frame.request(); assert.equal(pending.size,1);
  pending.get(1)!(0); pending.delete(1); assert.equal(draws,1);
  frame.request(); frame.request(); assert.equal(pending.size,1);
  frame.cancel(); assert.equal(pending.size,0); assert.equal(draws,1);
  frame.request(); pending.get(3)!(1); assert.equal(draws,2);
});
