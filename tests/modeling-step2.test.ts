import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine } from '../src/cad/geometry';
import { emptyDocument, deletionIds, validateDocument, visibleFeatures } from '../src/cad/document';
import { applyEdits } from '../src/cad/edits';
import { xyFrame, bodySections, wingProfile } from '../src/cad/modeling-presets';
import { attachmentPlacement, placeFrame } from '../src/cad/frames';
import { featureSchema, commandInputSchema, parseCommand, type CadDocument, type Feature, type Frame, type Vector3 } from '../src/shared/protocol';
import { z } from 'zod';

const kernel = readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url)).then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }));
const close = (actual: number, expected: number, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const document = (features: Feature[]): CadDocument => ({ ...emptyDocument(), features });
const box = (id = 'base'): Feature => ({ id, kind: 'box', params: { origin: [0, 0, 0], size: [20, 30, 10] }, mounts: [{ name: 'top', frame: xyFrame([10, 15, 10]) }] });
const instance = (source: CadDocument, target: { featureId: string; name: string } | { frame: Frame }): Extract<Feature, { kind: 'instance' }> => ({ id: 'placed', kind: 'instance', params: { document: source.documentId, translation: [0, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0], attachment: { source: { featureId: 'base', name: 'top' }, target, mode: 'mate', offset: [0, 0, 0], twistDegrees: 0 } } });

test('step 2 schemas reject unbounded/ambiguous inputs and advertise all feature shapes', () => {
  const doc = document([]);
  const examples: Feature[] = [
    { id: 'loft', kind: 'loft', params: { sections: bodySections(), ruled: false } },
    { id: 'sweep', kind: 'sweep', params: { profile: { type: 'circle', radius: 2 }, path: { frame: xyFrame(), start: [20, 0], segments: [{ type: 'arc', via: [Math.SQRT1_2 * 20, Math.SQRT1_2 * 20], to: [0, 20] }] } } },
    { id: 'shell', kind: 'shell', params: { target: 'base', thickness: 1, removeFaces: [{ point: [0, 0, 10], normal: [0, 0, 1], toleranceMm: 0.001, expectedCount: 1 }] } },
    { id: 'wing', kind: 'extrude', params: { profile: wingProfile(), origin: [0, 0, 0], plane: { xDirection: [1, 0, 0], normal: [0, 1, 1] }, distance: 5 } },
    instance(doc, { frame: xyFrame() }),
  ];
  for (const feature of examples) {
    const params = { documentId: doc.documentId, expectedRevision: 0, edits: [{ op: 'add', feature }] };
    parseCommand({ type: 'apply_edits', params });
    assert.ok(z.fromJSONSchema(commandInputSchema('apply_edits', feature.kind)).safeParse(params).success);
  }
  const loft = examples[0] as Extract<Feature, {kind:'loft'}>;
  assert.equal(featureSchema.safeParse({ ...loft, params: { ...loft.params, sections: [loft.params.sections[0]] } }).success, false);
  assert.equal(featureSchema.safeParse({ ...loft, params: { ...loft.params, sections: Array(13).fill(loft.params.sections[0]) } }).success, false);
  assert.equal(featureSchema.safeParse({ ...examples[3], params: { ...examples[3].params, plane: { normal: [0, 0, 1], xDirection: [0, 0, 1] } } }).success, false);
  assert.equal(featureSchema.safeParse({ ...box(), mounts: Array(33).fill({ name: 'x', frame: xyFrame() }) }).success, false);
  assert.equal(featureSchema.safeParse({ ...examples[4], params: { ...examples[4].params, translation: [1, 0, 0] } }).success, false);
});

test('arbitrary-plane curves, smooth/ruled loft, curved pipe and shell have exact analytic geometry', async t => {
  const oc = await kernel; setOC(oc); const engine = new GeometryEngine(oc); t.after(() => engine.dispose());
  const frame: Frame = { origin: [1, 2, 3], xDirection: [1, 0, 0], normal: [0, -1, 1] };
  const f: Feature = { id: 'plate', kind: 'extrude', params: { profile: { type: 'rectangle', width: 10, height: 4 }, origin: frame.origin, plane: { normal: frame.normal, xDirection: frame.xDirection }, distance: 6 } };
  let g = engine.evaluate(document([f])).geometry[0]; close(g.volumeMm3, 240);
  const corners = [-5, 5].flatMap(x => [-2, 2].flatMap(y => [0, 6].map(z => [1 + x, 2 + (y-z)*Math.SQRT1_2, 3 + (y+z)*Math.SQRT1_2])));
  for (let i = 0; i < 3; i++) { close(g.bounds.min[i], Math.min(...corners.map(v => v[i]))); close(g.bounds.max[i], Math.max(...corners.map(v => v[i]))); }
  const loft: Feature = { id: 'loft', kind: 'loft', params: { ruled: false, sections: [0, 10, 20].map(z => ({ frame: xyFrame([0, 0, z]), profile: { type: 'circle', radius: 5 } })) } };
  g = engine.evaluate(document([loft])).geometry[0]; close(g.volumeMm3, Math.PI * 25 * 20, 0.002); close(g.bounds.size[2], 20, 0.00001);
  const cone: Feature = { ...loft, params: { ruled: true, sections: [{ frame: xyFrame(), profile: { type: 'circle', radius: 5 } }, { frame: xyFrame([0, 0, 20]), profile: { type: 'circle', radius: 10 } }] } };
  close(engine.evaluate(document([cone])).geometry[0].volumeMm3, Math.PI * 20 / 3 * (25 + 50 + 100), 0.002);
  const pipe: Feature = { id: 'pipe', kind: 'sweep', params: { profile: { type: 'circle', radius: 2 }, path: { frame: xyFrame(), start: [20, 0], segments: [{ type: 'arc', via: [20 * Math.SQRT1_2, 20 * Math.SQRT1_2], to: [0, 20] }] } } };
  g = engine.evaluate(document([pipe])).geometry[0]; close(g.volumeMm3, Math.PI * 4 * (Math.PI * 20 / 2), 0.002);
  [0,0,-2].forEach((v,i)=>close(g.bounds.min[i],v,0.00001)); [22,22,2].forEach((v,i)=>close(g.bounds.max[i],v,0.00001));
  const shell: Feature = { id: 'cup', kind: 'shell', params: { target: 'base', thickness: 1, removeFaces: [{ point: [0, 0, 10], normal: [0, 0, 1], toleranceMm: 0.001, expectedCount: 1 }] } };
  const doc = document([box(), shell]);
  g = engine.evaluate(doc).geometry[1]; close(g.volumeMm3, 20*30*10 - 18*28*9); assert.deepEqual(g.bounds.size, [20,30,10]);
  assert.throws(() => engine.evaluate(document([box(), { ...shell, params: { ...shell.params, removeFaces: [{ ...shell.params.removeFaces[0], expectedCount: 2 }] } } as Feature])), /matched 1.*expected 2/);
  assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt, []);
  // Exact curves survive STEP serialization; no tessellation or segmented extrusion is authoritative.
  const wingDoc = document([{ id:'wing',kind:'extrude',params:{profile:wingProfile(),plane:'XY',origin:[0,0,0],distance:8} }]);
  const ev = engine.evaluate(wingDoc); assert.equal(ev.geometry[0].valid, true); assert.ok(ev.geometry[0].faceCount! <= 5);
  const step = new TextDecoder().decode((await engine.export('step', ['wing'], wingDoc)).bytes);
  assert.match(step, /B_SPLINE_CURVE|BEZIER_CURVE/); assert.doesNotMatch(step, /FACETED_BREP/);
  assert.equal(engine.evaluate(document([{ id:'body',kind:'loft',params:{sections:bodySections(),ruled:false} }])).geometry[0].valid,true);
});

test('mount mapping, dependencies and cache identity use resolved frames, including nested sources', async t => {
  const oc = await kernel; setOC(oc); const engine = new GeometryEngine(oc); t.after(() => engine.dispose());
  const source = document([box()]); const placed = instance(source, { featureId: 'stand', name: 'top' });
  const stand = { ...box('stand'), params: { origin: [30, 0, 0], size: [20,30,10] }, mounts: [{ name:'top',frame:xyFrame([40,15,10]) }] } as Feature;
  const assembly = document([stand, placed]);
  let ev = engine.evaluate(assembly,[source]); const g=ev.geometry[1]; close(g.volumeMm3,6000); close(g.bounds.min[0],30); close(g.bounds.min[2],10); close(g.bounds.max[2],20);
  assert.deepEqual(visibleFeatures(assembly), ['stand','placed']); assert.throws(()=>deletionIds(assembly,['stand'],false), /depend/); assert.deepEqual(deletionIds(assembly,['stand'],true),['stand','placed']);
  assert.throws(()=>validateDocument(document([placed,stand])), /earlier/);
  assert.deepEqual(ev.geometry[1].mounts!.map(m=>m.name),['base/top']);
  assert.equal(engine.evaluate(assembly,[source]).stats!.cache.misses,0);
  const changed = structuredClone(source); changed.features[0].mounts![0].frame.origin[0]+=5; changed.revision++;
  ev=engine.evaluate(assembly,[changed]); assert.deepEqual(ev.stats!.referencedDocuments![0].rebuilt,[]); assert.deepEqual(ev.stats!.cache.rebuilt,['placed']); close(ev.geometry[1].bounds.min[0],25);
  changed.features[0].label='renamed'; changed.features[0].mounts!.push({name:'unused',frame:xyFrame()});
  assert.equal(engine.evaluate(assembly,[changed]).stats!.cache.misses,0);
  const missing=structuredClone(changed); missing.features[0].mounts=[]; assert.throws(()=>engine.evaluate(assembly,[missing]), /Mount 'top' is missing/);
  assert.equal(engine.evaluate(assembly,[changed]).stats!.cache.misses,0);
  const targetChanged=structuredClone(assembly);targetChanged.features[0].mounts![0].frame.origin[2]+=3;
  const targetMoved=engine.evaluate(targetChanged,[changed]);assert.deepEqual(targetMoved.stats!.cache.rebuilt,['placed']);close(targetMoved.geometry[1].bounds.min[2],13);
  targetChanged.features[0].mounts=[];assert.throws(()=>engine.evaluate(targetChanged,[changed]),/Mount 'top' is missing/);
  const nested=instance(assembly,{frame:xyFrame([0,0,50])}); nested.params.attachment!.source={featureId:'placed',name:'base/top'};
  ev=engine.evaluate(document([nested]),[source,assembly]); assert.ok(ev.geometry[0].mounts!.some(m=>m.name==='placed/base/top'));
  const a=placed.params.attachment!;
  for (const mode of ['align','mate'] as const) {
    const src:Frame={origin:[3,4,5],xDirection:[0,1,0],normal:[1,0,0]}, dst:Frame={origin:[20,30,40],xDirection:[0,0,1],normal:[0,-1,0]};
    const transformed=placeFrame(src,attachmentPlacement(src,dst,{...a,mode,offset:[2,3,4],twistDegrees:90}));
    [17,26,42].forEach((v,i)=>close(transformed.origin[i],v));
    dst.normal.forEach((v,i)=>close(transformed.normal[i],v*(mode==='align'?1:-1)));
    [-1,0,0].forEach((v,i)=>close(transformed.xDirection[i],v));
  }
});

test('new numeric bindings rebuild geometry and reject invalid edits without cache damage', async t=>{
  const oc=await kernel; setOC(oc);const engine=new GeometryEngine(oc); t.after(()=>engine.dispose());
  const loft:Feature={id:'loft',kind:'loft',params:{sections:[0,20].map(z=>({frame:xyFrame([0,0,z]),profile:{type:'circle',radius:5}})),ruled:true},bindings:{'sections.1.frame.origin.2':'length'}};
  let doc={...document([loft]),parameters:[{name:'length',value:20}]};engine.evaluate(doc);
  doc=applyEdits(doc,[{op:'set_parameter',name:'length',value:30}]).document as typeof doc;
  close(engine.evaluate(doc).geometry[0].volumeMm3,750*Math.PI,0.002);
  const bad=applyEdits(doc,[{op:'set_parameter',name:'length',value:0}]).document;
  assert.throws(()=>engine.evaluate(bad));assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt,[]);
});

test('Bezier profiles have analytic area; failed shells/curves discard staged results; transform/mirror mounts stay right-handed',async t=>{
  const oc=await kernel;setOC(oc);const engine=new GeometryEngine(oc);t.after(()=>engine.dispose());
  const curve:Feature={id:'curved',kind:'extrude',params:{profile:{type:'path',start:[0,0],segments:[{type:'bezier',controls:[[5,10]],to:[10,0]}]},origin:[0,0,0],plane:'XY',distance:3}};
  const doc=document([curve]);const ev=engine.evaluate(doc);close(ev.geometry[0].volumeMm3,100,1e-6);
  assert.equal(ev.geometry[0].faceCount,4);
  const count=engine.cacheStats().entries;
  const shell:Feature={id:'bad',kind:'shell',params:{target:'base',thickness:40,removeFaces:[{point:[0,0,10],normal:[0,0,1],toleranceMm:0.001,expectedCount:1}]}};
  assert.throws(()=>engine.evaluate(document([box(),shell])));assert.equal(engine.cacheStats().entries,count);
  assert.throws(()=>engine.evaluate(document([{...curve,params:{...curve.params,profile:{type:'path',start:[0,0],segments:[{type:'arc',via:[5,0],to:[10,0]}]}}} as Feature])));
  assert.deepEqual(engine.evaluate(doc).stats!.cache.rebuilt,[]);
  const transformed:Feature={id:'moved',kind:'transform',params:{target:'base',translation:[1,2,3],rotationAxis:[0,1,0],angleDegrees:90,origin:[0,0,0],scale:2,copy:false}};
  const mirror:Feature={id:'reflected',kind:'mirror',params:{target:'moved',plane:'YZ',origin:[0,0,0],copy:false}};
  const mounted=engine.evaluate(document([box(),transformed,mirror]));
  const frame=mounted.geometry[1].mounts![0].frame;[21,32,-17].forEach((v,i)=>close(frame.origin[i],v));[1,0,0].forEach((v,i)=>close(frame.normal[i],v));
  const reflected=mounted.geometry[2].mounts![0].frame;close(reflected.origin[0],-21);close(reflected.normal[0],-1);close(Math.hypot(...reflected.xDirection),1);
});


test('shell, sweep and attachment numeric bindings rebuild only their geometric dependents',async t=>{
 const oc=await kernel;setOC(oc);const engine=new GeometryEngine(oc);t.after(()=>engine.dispose());
 const shell:Feature={id:'cup',kind:'shell',params:{target:'base',thickness:1,removeFaces:[{point:[0,0,10],normal:[0,0,1],toleranceMm:0.001,expectedCount:1}]},bindings:{thickness:'wall'}};
 let doc:CadDocument={...document([box(),shell]),parameters:[{name:'wall',value:1}]};engine.evaluate(doc);
 doc=applyEdits(doc,[{op:'set_parameter',name:'wall',value:1.5}]).document;let ev=engine.evaluate(doc);close(ev.geometry[1].volumeMm3,2098.5);assert.deepEqual(ev.stats!.cache.rebuilt,['cup']);
 const pipe:Feature={id:'pipe',kind:'sweep',params:{profile:{type:'circle',radius:2},path:{frame:xyFrame(),start:[20,0],segments:[{type:'arc',via:[20*Math.SQRT1_2,20*Math.SQRT1_2],to:[0,20]}]}},bindings:{'profile.radius':'radius'}};
 doc={...document([pipe]),parameters:[{name:'radius',value:2}]};engine.evaluate(doc);doc=applyEdits(doc,[{op:'set_parameter',name:'radius',value:3}]).document;ev=engine.evaluate(doc);close(ev.geometry[0].volumeMm3,90*Math.PI*Math.PI,0.002);
 const source=document([box()]),attached=instance(source,{frame:xyFrame()});attached.bindings={'attachment.offset.2':'height'};
 doc={...document([attached]),parameters:[{name:'height',value:0}]};const before=engine.evaluate(doc,[source]);doc=applyEdits(doc,[{op:'set_parameter',name:'height',value:7}]).document;ev=engine.evaluate(doc,[source]);close(ev.geometry[0].bounds.min[2],before.geometry[0].bounds.min[2]+7);assert.deepEqual(ev.stats!.referencedDocuments![0].rebuilt,[]);assert.deepEqual(ev.stats!.cache.rebuilt,['placed']);
});
