import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {studioFramePoints} from '../src/web/studio-output';
import {shotCamera} from '../src/web/shots';
import type {DisplayMesh} from '../src/shared/protocol';

test('large multi-part Studio shots bound silhouette samples globally and frame transformed detail geometry',()=>{
 const parts:DisplayMesh[]=Array.from({length:12},(_,part)=>({featureId:`part_${part}`,
  vertices:Array.from({length:90000},(_,i)=>i%3===0?part*10+(i%10):i%3===1?(i%7):i%5),normals:[],triangles:[],lines:[]}));
 const frame=studioFramePoints(parts,{});
 assert.ok(frame.length<=180000+parts.length*3);
 assert.ok(frame.length<parts.reduce((n,p)=>n+p.vertices.length,0));
 const bounds=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(120,10,5));
 const camera=shotCamera({projection:'perspective',from:[1,-1,0.5]},0,frame,bounds,16/9,1080).camera;
 assert.ok(camera.position.toArray().every(Number.isFinite));
 const translated={...parts[0],vertices:[0,0,0,1,2,3],transform:new THREE.Matrix4().makeTranslation(100,20,30).toArray()};
 assert.deepEqual(studioFramePoints([translated,parts[1]],{frame:{featureIds:['part_0']}}),[100,20,30,101,22,33]);
});
