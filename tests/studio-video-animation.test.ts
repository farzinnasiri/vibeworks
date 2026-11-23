import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { emptyDocument,validateDocument } from '../src/cad/document';
import { StudioConstructionCapture } from '../src/bridge/studio-capture';
import { animateStudioModel, constructionStep, explosionAmount, validateExplosion } from '../src/web/studio-video-animation';
import { studioVideoRecipeSchema, type CadDocument, type FrozenGraph } from '../src/shared/protocol';
import type { Evaluation } from '../src/cad/types';

test('construction streams real boolean prefixes through an assembly occurrence, preserving the captured definitions',async()=>{
  const source=validateDocument({...emptyDocument(),features:[
    {id:'block',kind:'box',params:{origin:[0,0,0],size:[10,10,10]}},
    {id:'tool',kind:'cylinder',params:{origin:[5,5,-1],radius:2,height:12}},
    {id:'bored',kind:'subtract',params:{target:'block',tools:['tool']}},
  ]} as CadDocument);
  const document=validateDocument({...emptyDocument(),features:[{id:'placed',kind:'instance',params:{document:source.documentId,
    translation:[20,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]} as CadDocument);
  const graph={document,documents:[source],snapshot:{snapshotId:randomUUID()}} as FrozenGraph;
  const before=JSON.stringify(graph),capture=new StudioConstructionCapture(graph,new Date(Date.now()+60000).toISOString(),new AbortController().signal);
  try{
    assert.equal(capture.steps,4);
    const first=JSON.parse(await capture.frame(1)),bored=JSON.parse(await capture.frame(3)),last=JSON.parse(await capture.frame(4));
    assert.ok(Math.abs(first.geometry[0].volumeMm3-1000)<.001);
    assert.ok(Math.abs(bored.geometry[0].volumeMm3-(1000-Math.PI*4*10))<.01,'a boolean must replace the actual solid, not merely hide the cutting tool');
    assert.ok(Math.abs(last.geometry[0].volumeMm3-bored.geometry[0].volumeMm3)<.001);
    assert.ok(last.geometry[0].bounds.min[0]>=20,'the source prefix keeps its occurrence placement');
    assert.equal(JSON.stringify(graph),before);
    await assert.rejects(capture.frame(5),/outside the captured build/);
  }finally{await capture.close();}
});

test('exploded transforms move parts and ink together, restore at the loop end, and do not accumulate or move the floor',()=>{
  const animation={kind:'exploded' as const,direction:'out_and_back' as const,offsets:[{featureId:'motor',offsetMm:[10,20,30] as [number,number,number]}]};
  const scene=new THREE.Scene(),model=new THREE.Group();model.scale.setScalar(.01);scene.add(model);
  for(const graphic of [false,true]){const object=new THREE.Object3D();object.userData={featureId:'motor',...(graphic?{graphicId:'label'}:{})};object.position.set(2,3,4);model.add(object);}
  const floor=new THREE.Object3D();floor.userData.studioFloor=true;model.add(floor);
  const positions=()=>model.children.slice(0,2).map(o=>o.position.toArray());
  animateStudioModel(scene,animation,.5);assert.deepEqual(positions(),[[12,23,34],[12,23,34]]);
  animateStudioModel(scene,animation,.5);assert.deepEqual(positions(),[[12,23,34],[12,23,34]],'offsets never accumulate');
  animateStudioModel(scene,animation,1);assert.deepEqual(positions(),[[2,3,4],[2,3,4]]);
  animateStudioModel(scene,{...animation,direction:'out'},1);assert.deepEqual(positions(),[[12,23,34],[12,23,34]]);
  animateStudioModel(scene,undefined,0);assert.deepEqual(positions(),[[2,3,4],[2,3,4]]);assert.deepEqual(floor.position.toArray(),[0,0,0]);
  assert.equal(explosionAmount({...animation,direction:'in'},0),1);
  const evaluation={meshes:[{featureId:'motor'}],visibleFeatureIds:['motor']} as Evaluation;
  validateExplosion(animation,evaluation);
  assert.throws(()=>validateExplosion({...animation,offsets:[...animation.offsets,...animation.offsets]},evaluation),/repeats motor/);
  assert.throws(()=>validateExplosion(animation,{...evaluation,visibleFeatureIds:[]}),/not visible/);
});

test('animation recipes retain display-only options, validate construction ranges and include both endpoints',()=>{
  const recipe=studioVideoRecipeSchema.parse({preset:{name:'turntable'},animation:{kind:'exploded',offsets:[{featureId:'motor',offsetMm:[0,0,20]}]}});
  assert.equal(recipe.animation!.kind,'exploded');
  assert.equal(constructionStep({kind:'construction'},10,0),1);assert.equal(constructionStep({kind:'construction'},10,1),10);
  assert.equal(constructionStep({kind:'construction',fromStep:3,toStep:7},10,1),7);
  assert.throws(()=>constructionStep({kind:'construction',fromStep:7,toStep:3},10,.5),/build order/);
  assert.throws(()=>constructionStep({kind:'construction',toStep:11},10,.5),/within/);
});
