import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument } from '../src/cad/document';
import { NodeGeometryWorker } from '../src/cad/node-worker';
import { restylePart } from '../src/cad/appearance';
import type { CadDocument, SurfaceGraphic } from '../src/shared/protocol';

const graphic: SurfaceGraphic = { id: 'label', anchor: [0.5, 0.5, 1], normal: [0, 0, 1], xDirection: [1, 0, 0],
  width: 12, height: 8, depth: 2, rotation: 0, maxAngle: 60,
  content: { type: 'text', text: 'VIBE', font: 'sans', weight: 'bold', align: 'center', spacing: 0, color: '#ffffff' } };

test('derived results and instances expose inherited graphics and detail consistently before and after restyling', async t => {
  const worker = new NodeGeometryWorker();
  t.after(() => worker.close());
  const source: CadDocument = { ...emptyDocument(), features: [
    { id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [30, 20, 4] }, appearance: { material: 'aluminum', detail: 'brushed', graphics: [graphic] } },
    { id: 'rounded', kind: 'fillet', params: { target: 'body', radius: 1, edges: 'vertical' } },
  ] };
  const first = await worker.evaluate(source);
  const check = (appearance: typeof source.features[0]['appearance']) => {
    assert.equal(appearance?.detail, 'brushed');
    assert.deepEqual(appearance?.graphics, [graphic]);
  };
  check(first.geometry.find(g => g.featureId === 'rounded')?.appearance);
  check(first.meshes.find(g => g.featureId === 'rounded')?.appearance);
  const changed = structuredClone(source);
  changed.revision++;
  changed.features[1].appearance = { color: '#ff0000' };
  const fast = restylePart(changed, first, source.revision);
  const rebuilt = await worker.evaluate(changed);
  assert.deepEqual(fast.geometry.map(g => g.appearance), rebuilt.geometry.map(g => g.appearance));
  const assembly: CadDocument = { ...emptyDocument(), kind: 'assembly', features: [
    { id: 'placed', kind: 'instance', params: { document: source.documentId, translation: [40, 0, 0], rotationAxis: [0, 1, 0], angleDegrees: 90, origin: [0, 0, 0] } },
  ] };
  const placed = await worker.evaluate(assembly, undefined, undefined, [source]);
  check(placed.geometry[0].appearance);
  check(placed.meshes[0].appearance);
});

test('graphics follow resized source parts and moved instances across clients, conflicts, undo and reload', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteStore } = await import('../src/bridge/sqlite-store');
  const { CommandAuthority } = await import('../src/bridge/authority');
  const { parseCommand } = await import('../src/shared/protocol');
  const { graphicGeometry } = await import('../src/web/surface-graphics');
  const directory = await mkdtemp(join(tmpdir(), 'vibeworks-graphics-'));
  const database = join(directory, 'workspace.db');
  const stores = [new SqliteStore(database), new SqliteStore(database)];
  const authorities = stores.map(store => new CommandAuthority(store, {workers: 1}));
  t.after(async () => { for (const authority of authorities) await authority.close(); for (const store of stores) store.close(); await rm(directory, {recursive: true, force: true}); });
  const source: CadDocument = {...emptyDocument(), features: [
    {id: 'body', kind: 'box', params: {origin: [0,0,0], size: [30,20,4]}, appearance: {material: 'aluminum', graphics: [graphic]}}]};
  const assembly: CadDocument = {...emptyDocument(), kind: 'assembly', features: [
    {id: 'placed', kind: 'instance', params: {document: source.documentId, translation: [40,0,0], rotationAxis: [0,1,0], angleDegrees: 90, origin: [0,0,0]}}]};
  await stores[0].put(source, null); await stores[0].put(assembly, null);
  await Promise.all(authorities.map(authority => authority.ready()));
  const run = async (client: number, value: unknown) => {
    const outcome = await authorities[client].execute(parseCommand(value));
    assert.equal(outcome.result.status, 'success', JSON.stringify(outcome.result.error));
    return outcome;
  };
  const inspect = () => run(1, {type:'inspect_model',params:{documentId:assembly.documentId}});
  const assertProjection = (outcome: Awaited<ReturnType<typeof inspect>>, x: number) => {
    const mesh = outcome.evaluation!.meshes[0];
    assert.deepEqual(mesh.appearance?.graphics, [graphic]);
    const projected = graphicGeometry(mesh, mesh.appearance!.graphics![0]);
    try {
      projected.computeBoundingBox();
      assert.ok(projected.getAttribute('position').count > 0);
      assert.ok(Math.abs(projected.boundingBox!.min.x - x) < 1e-4);
      assert.ok(Math.abs(projected.boundingBox!.max.x - x) < 1e-4);
    } finally { projected.dispose(); }
  };
  assertProjection(await inspect(), 44);
  await run(0, {type:'apply_edits',params:{documentId:source.documentId,expectedRevision:0,analyze:false,edits:[{op:'patch',id:'body',params:{size:[30,20,8]}}]}});
  assertProjection(await inspect(), 48);
  const conflict = await authorities[1].execute(parseCommand({type:'apply_edits',params:{documentId:source.documentId,expectedRevision:0,edits:[{op:'patch',id:'body',appearance:{graphics:[]}}]}}));
  assert.equal(conflict.result.status, 'error');
  assert.equal(conflict.result.error?.code, 'REVISION_CONFLICT');
  assertProjection(await inspect(), 48);
  await run(0, {type:'document_action',params:{action:'undo',documentId:source.documentId,expectedRevision:1,analyze:false}});
  assertProjection(await inspect(), 44);
  await run(0, {type:'document_action',params:{action:'redo',documentId:source.documentId,expectedRevision:2,analyze:false}});
  await run(1, {type:'apply_edits',params:{documentId:assembly.documentId,expectedRevision:0,analyze:false,edits:[{op:'patch',id:'placed',params:{translation:[80,0,0]}}]}});
  assertProjection(await inspect(), 88);
  const reopenedStore = new SqliteStore(database);
  stores.push(reopenedStore); authorities.push(new CommandAuthority(reopenedStore, {workers:1}));
  await authorities[2].ready();
  const reopened = await run(2, {type:'inspect_model',params:{documentId:assembly.documentId}});
  assertProjection(reopened, 88);
});

test('mesh-free health counts inherited styling per piece, including mixed and partially unstyled instances', async t => {
  const { modelHealth } = await import('../src/cad/health');
  const worker = new NodeGeometryWorker();
  t.after(() => worker.close());
  const source: CadDocument = {...emptyDocument(), features:[
    {id:'left',kind:'box',params:{origin:[0,0,0],size:[10,10,5]},appearance:{material:'aluminum'}},
    {id:'right',kind:'box',params:{origin:[10,0,0],size:[10,10,5]},appearance:{color:'#cc8844'}},
  ]};
  const carrier: CadDocument = {...emptyDocument(),kind:'assembly',features:[{id:'inner',kind:'instance',params:{document:source.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]};
  const root: CadDocument = {...emptyDocument(),kind:'assembly',features:[{id:'nested',kind:'instance',params:{document:carrier.documentId,translation:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0,origin:[0,0,0]}}]};
  const check = async (missing: number) => {
    const compact = await worker.evaluate(root,undefined,undefined,[source,carrier],undefined,undefined,undefined,{meshes:false});
    assert.equal(compact.meshes.length,0);
    assert.equal(modelHealth(root,compact,null).partsWithoutAppearance,missing);
    const displayed = await worker.evaluate(root,undefined,undefined,[source,carrier]);
    assert.equal(modelHealth(root,displayed,null).partsWithoutAppearance,missing);
  };
  await check(0);
  source.features[1].appearance = undefined; source.revision++;
  await check(1);
  carrier.features[0].appearance = {color:'#ffffff'}; carrier.revision++;
  await check(0);
});
