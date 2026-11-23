import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument,validateDocument } from '../src/cad/document';
import { NodeGeometryWorker } from '../src/cad/node-worker';
import type { CadDocument, DisplayMesh } from '../src/shared/protocol';

function radialChordError(mesh:DisplayMesh,radius:number){
  let max=0;
  for(let i=0;i<mesh.triangles.length;i+=3)for(const [a,b] of [[0,1],[1,2],[2,0]]){
    const x=mesh.triangles[i+a]*3,y=mesh.triangles[i+b]*3;
    if(Math.abs(mesh.normals[x+2])>.001||Math.abs(mesh.normals[y+2])>.001)continue;
    const r=Math.hypot((mesh.vertices[x]+mesh.vertices[y])/2,(mesh.vertices[x+1]+mesh.vertices[y+1])/2);
    max=Math.max(max,radius-r);
  }
  return max;
}

test('final video meshes reduce curved-surface chord error without changing the exact solid or viewport profile',async()=>{
  const document=validateDocument({...emptyDocument(),features:[{id:'reflector',kind:'cylinder',params:{origin:[0,0,0],radius:20,height:45}}]} as CadDocument);
  const ordinary=new NodeGeometryWorker(),final=new NodeGeometryWorker();
  try{
    const a=await ordinary.evaluate(document),b=await final.evaluate(document,undefined,undefined,[],undefined,undefined,true,{renderMesh:true});
    const errorA=radialChordError(a.meshes[0],20),errorB=radialChordError(b.meshes[0],20);
    assert.ok(errorA>0&&errorB<errorA/5,`ordinary ${errorA} mm, final ${errorB} mm`);
    assert.ok(b.meshes[0].triangles.length>a.meshes[0].triangles.length*2);
    assert.deepEqual(a.geometry,b.geometry,'exact measurements and validity remain identical');
    assert.equal(a.stats!.display!.toleranceMm,.05);assert.equal(b.stats!.display!.toleranceMm,.005);
    assert.equal(a.stats!.display!.angularTolerance,.15);assert.equal(b.stats!.display!.angularTolerance,.035);
    console.log(JSON.stringify({ordinaryTriangles:a.meshes[0].triangles.length/3,finalTriangles:b.meshes[0].triangles.length/3,ordinaryErrorMm:errorA,finalErrorMm:errorB}));
  }finally{await ordinary.close();await final.close();}
});
