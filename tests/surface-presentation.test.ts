import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { graphicGeometry } from '../src/web/surface-graphics';
import { emptyDocument } from '../src/cad/document';
import { parseCommand, surfaceGraphicSchema, type SurfaceGraphic } from '../src/shared/protocol';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { CommandAuthority } from '../src/bridge/authority';

const graphic: SurfaceGraphic = { id:'mark', anchor:[0.5,0.5,1], normal:[0,0,1], xDirection:[1,0,0], width:12, height:8, depth:2, rotation:0, maxAngle:60,
  content:{type:'text',text:'VIBE',font:'sans',weight:'bold',align:'center',spacing:0.05,color:'#ffffff'} };

test('surface projection clips to the selected panel and depth, rejects back faces, and follows rigid instance placement', () => {
  const mesh = {featureId:'body',vertices:[-10,-10,0,10,-10,0,10,10,0,-10,10,0,-10,-10,-1,10,-10,-1,10,10,-1,-10,10,-1], normals:[0,0,1,0,0,1,0,0,1,0,0,1,0,0,-1,0,0,-1,0,0,-1,0,0,-1],triangles:[0,1,2,0,2,3,4,6,5,4,7,6],lines:[]};
  const local = graphicGeometry(mesh,graphic);
  local.computeBoundingBox();
  assert.ok(local.getAttribute('position').count > 0);
  assert.equal(local.boundingBox!.min.z,0);assert.equal(local.boundingBox!.max.z,0);
  assert.ok(Math.abs(local.boundingBox!.max.x-6)<1e-6);assert.ok(Math.abs(local.boundingBox!.max.y-4)<1e-6);
  const transform = new Matrix4().makeRotationY(Math.PI/2).setPosition(30,40,50);
  const placed = graphicGeometry({...mesh,transform:transform.toArray()},graphic);
  const p = placed.getAttribute('position'), q = local.getAttribute('position');
  for(let i=0;i<p.count;i++) assert.ok(new Vector3().fromBufferAttribute(p,i).distanceTo(new Vector3().fromBufferAttribute(q,i).applyMatrix4(transform))<1e-5);
  const reverse = graphicGeometry(mesh,{...graphic,normal:[0,0,-1],depth:0.1});
  assert.equal(reverse.getAttribute('position').count,0,'backside is outside the bounded projector');
  local.dispose();placed.dispose();reverse.dispose();
});

test('graphic validation rejects unsafe/oversized images and degenerate frames before editing', () => {
  assert.throws(()=>surfaceGraphicSchema.parse({...graphic,xDirection:[0,0,1]}));
  const svg=(xml:string)=>({...graphic,content:{type:'image',dataUrl:'data:image/svg+xml;base64,'+Buffer.from(xml).toString('base64')}});
  assert.throws(()=>surfaceGraphicSchema.parse(svg('<svg width="999999" height="10"></svg>')));
  assert.throws(()=>surfaceGraphicSchema.parse(svg('<svg><script>alert(1)</script></svg>')));
  assert.throws(()=>surfaceGraphicSchema.parse(svg('<svg><use href="https://example.com/a.svg"/></svg>')));
  assert.doesNotThrow(()=>surfaceGraphicSchema.parse(svg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><path d="M0 0L100 50" stroke="red"/></svg>')));
});

test('paint fragments share the unpainted graphic projector and continuous texture coordinates',()=>{
 const fragment=(left:number,right:number)=>({featureId:'body',vertices:[left,-10,0,right,-10,0,right,10,0,left,10,0],normals:[0,0,1,0,0,1,0,0,1,0,0,1],triangles:[0,1,2,0,2,3],lines:[]});
 const whole=graphicGeometry(fragment(-10,10),graphic),left=graphicGeometry({...fragment(-10,0),graphicBounds:{min:[-10,-10,0],max:[10,10,0]}},graphic),right=graphicGeometry({...fragment(0,10),graphicBounds:{min:[-10,-10,0],max:[10,10,0]}},graphic);
 try{
  const area=(g:typeof whole)=>{const p=g.getAttribute('position');let sum=0;for(let i=0;i<p.count;i+=3){const a=new Vector3().fromBufferAttribute(p,i),b=new Vector3().fromBufferAttribute(p,i+1),c=new Vector3().fromBufferAttribute(p,i+2);sum+=b.sub(a).cross(c.sub(a)).length()/2;}return sum;};
  assert.ok(Math.abs(area(left)+area(right)-area(whole))<1e-6);left.computeBoundingBox();right.computeBoundingBox();assert.equal(left.boundingBox!.max.x,0);assert.equal(right.boundingBox!.min.x,0);
  for(const g of[left,right]){const p=g.getAttribute('position'),uv=g.getAttribute('uv');for(let i=0;i<p.count;i++)assert.ok(Math.abs(uv.getX(i)-(p.getX(i)/graphic.width+0.5))<1e-6,'texture must not restart at each paint boundary');}
 }finally{whole.dispose();left.dispose();right.dispose();}
});

test('saved presentation and graphics retain exact checks, undo, JSON and textured GLB output', async t => {
  const store = new SqliteStore(':memory:');
  const document = {...emptyDocument(), features:[{id:'body',kind:'box' as const,params:{origin:[0,0,0] as [number,number,number],size:[30,20,4] as [number,number,number]},appearance:{material:'aluminum' as const}}]};
  await store.put(document,null);
  const authority = new CommandAuthority(store,{workers:1});
  t.after(async()=>{await authority.close();store.close();});await authority.ready();
  const run=async(value:unknown)=>{const outcome=await authority.execute(parseCommand(value));assert.equal(outcome.result.status,'success',JSON.stringify(outcome.result.error));return outcome;};
  const before=await run({type:'inspect_model',params:{documentId:document.documentId}});
  const edited=await run({type:'apply_edits',params:{documentId:document.documentId,expectedRevision:0,edits:[
    {op:'appearance',target:{feature:'body',select:{all:true}},set:{material:'aluminum',detail:'brushed'},graphics:{upsert:[graphic]}},
    {op:'set_presentation',presentation:{preset:'soft',background:'#26313b',exposure:1.2,environmentPreset:'warehouse',environmentRotation:30,lightColor:'#ffddbb',lightElevation:45,floor:'tiles',floorScale:800,floorRoughness:0.3,floorHeight:-1,backgroundMode:'color'}},
  ]}});
  assert.equal(edited.result.timings!.geometryEvaluationMs,0);
  assert.equal(edited.result.timings!.analysisMs,0);
  assert.deepEqual(edited.result.geometry?.map(g=>g.volumeMm3),before.result.geometry?.map(g=>g.volumeMm3));
  const rendered=await run({type:'render_views',params:{documentId:document.documentId,appearance:'materials',views:['top'],tileSize:256}});
  assert.ok(rendered.result.image!.base64.length>1000);
  const glb=await run({type:'export_model',params:{documentId:document.documentId,format:'glb'}});
  const bytes=Buffer.from(glb.result.artifact!.base64,'base64');
  assert.equal(bytes.toString('ascii',0,4),'glTF');
  const json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)).trim());
  assert.ok(json.images.length>=1,'GLB embeds the printed graphic');assert.ok(json.materials.some((m:{normalTexture?:unknown})=>m.normalTexture),'GLB preserves the surface normal detail');
  assert.ok(json.nodes.some((node:{name?:string})=>node.name==='body/mark'));
  const backup=await run({type:'export_model',params:{documentId:document.documentId,format:'json',skipAnalysis:true}});
  const saved=JSON.parse(Buffer.from(backup.result.artifact!.base64,'base64').toString());
  assert.deepEqual(saved.features[0].appearance.graphics,[graphic]);assert.equal(saved.presentation.preset,'soft');assert.equal(saved.presentation.floor,'tiles');assert.equal(saved.presentation.environmentPreset,'warehouse');assert.equal(saved.presentation.lightColor,'#ffddbb');
  const undo=await run({type:'document_action',params:{action:'undo',documentId:document.documentId,expectedRevision:1}});
  assert.equal(undo.result.document!.presentation,undefined);assert.equal(undo.result.document!.features[0].appearance?.graphics,undefined);
  const redo=await run({type:'document_action',params:{action:'redo',documentId:document.documentId,expectedRevision:2}});
  assert.deepEqual(redo.result.document!.features[0].appearance?.graphics,[graphic]);
  assert.equal(redo.result.document!.presentation?.preset,'soft');
  const reset=await run({type:'document_action',params:{action:'reset',documentId:document.documentId,expectedRevision:3}});
  assert.equal(reset.result.document!.presentation,undefined);
  const loaded=await run({type:'document_action',params:{action:'load',documentId:document.documentId,expectedRevision:4,document:saved}});
  assert.equal(loaded.result.document!.presentation?.preset,'soft');
  assert.deepEqual(loaded.result.document!.features[0].appearance?.graphics,[graphic]);
  const plain=await run({type:'document_action',params:{action:'load',documentId:document.documentId,expectedRevision:5,document}});
  assert.equal(plain.result.document!.presentation,undefined);
});
