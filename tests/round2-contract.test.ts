import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commandInputSchema, commandSchemas, FEATURE_KINDS, parseCommand, uncertainOutcome, type CadCommand, type CadResult, type Feature } from '../src/shared/protocol';
import { runCli } from '../src/bridge/cli';
import { contactSheetLayout } from '../src/web/contact-sheet';
import { toolFeature } from '../src/web/modeling';
import { emptyDocument } from '../src/cad/document';

const documentId = randomUUID();
const feature: Feature = { id: 'body', kind: 'box', params: { origin: [0, 0, 0], size: [10, 20, 5] } };
const params = { documentId, expectedRevision: 0, edits: [{ op: 'add', feature }] };
const notForwarded = async (): Promise<CadResult> => { throw new Error('Unexpected forwarding'); };

test('edit help stays small; full and per-kind schemas share valid local definitions', async () => {
  const output: string[] = [];
  assert.equal(await runCli(['help', 'apply_edits'], notForwarded, text => output.push(text)), 0);
  assert.ok(Buffer.byteLength(output[0]) < 8000);
  for (const kind of FEATURE_KINDS) assert.ok(output[0].includes(kind));
  // Surface appearance targets and signatures add schema fields. The 21-kind shaping catalog stays below 44 KiB; per-kind schemas remain the small path.
  assert.ok(Buffer.byteLength(JSON.stringify(commandInputSchema('apply_edits'))) < 45056);
  const full = z.fromJSONSchema(commandInputSchema('apply_edits'));
  const box = z.fromJSONSchema(commandInputSchema('apply_edits', 'box'));
  assert.equal(full.safeParse(params).success, true);
  assert.equal(box.safeParse(params).success, true);
  const presentation = { ...params, edits: [{ op: 'set_presentation', presentation: { preset: 'soft' } }] };
  assert.equal(full.safeParse(presentation).success, true);
  assert.equal(box.safeParse(presentation).success, true);
  const cylinder = { ...params, edits: [{ op: 'add', feature: { id: 'pin', kind: 'cylinder', params: { origin: [0, 0, 0], radius: 1, height: 5 } } }] };
  assert.equal(full.safeParse(cylinder).success, true);
  assert.equal(box.safeParse(cylinder).success, false);
  for (const input of [
    { ...params, extra: true },
    { ...params, edits: [{ op: 'add', feature: { ...feature, params: { origin: [0, 0, 0], size: [-1, 20, 5] } } }] },
    { ...params, edits: [{ op: 'add', feature: { ...feature, extra: true } }] },
  ]) {
    assert.equal(full.safeParse(input).success, false);
    assert.equal(commandSchemas.apply_edits.safeParse(input).success, false);
  }
  const document = { ...emptyDocument(), features: [feature, { ...feature, id: 'other' }], selectedFeatureIds: ['body', 'other'] };
  for (const kind of FEATURE_KINDS) {
    const inputFeature = toolFeature(kind === 'transform' ? 'move' : kind, document, [])!;
    if (inputFeature.kind === 'instance') inputFeature.params.document = documentId;
    const input = { ...params, edits: [{ op: 'add', feature: inputFeature }, { op: 'update', feature: inputFeature }] };
    assert.equal(commandSchemas.apply_edits.safeParse(input).success, true, kind);
    assert.equal(full.safeParse(input).success, true, kind);
    assert.equal(z.fromJSONSchema(commandInputSchema('apply_edits', kind)).safeParse(input).success, true, kind);
    const invalid = { ...params, edits: [{ op: 'add', feature: { ...inputFeature, params: { ...inputFeature.params, ignoredField: 1 } } }] };
    assert.equal(full.safeParse(invalid).success, false, kind);
  }
  output.length = 0;
  assert.equal(await runCli(['schema', 'apply_edits', '--kind', 'box'], notForwarded, text => output.push(text)), 0);
  assert.equal(z.fromJSONSchema(JSON.parse(output[0])).safeParse(params).success, true);
});

test('documents action requirements agree between parser, advertised schema and help; invalid fields never forward', async () => {
  const advertised = z.fromJSONSchema(commandInputSchema('documents'));
  const valid = [
    { action: 'list' }, { action: 'list', name: 'Part' }, { action: 'list', requestId: randomUUID() },
    { action: 'create', kind: 'assembly', requestId: randomUUID() }, { action: 'duplicate', documentId },
    { action: 'rename', documentId, name: 'Renamed', expectedStorageVersion: 1 }, { action: 'delete', documentId, expectedRevision: 0 }, { action: 'open', documentId },
  ];
  const invalid = [
    { action: 'create', documentId }, { action: 'create', expectedRevision: 0 }, { action: 'list', documentId },
    { action: 'duplicate' }, { action: 'duplicate', documentId, kind: 'part' }, { action: 'rename', documentId },
    { action: 'rename', documentId, name: 'A', expectedRevision: 0 }, { action: 'delete', documentId },
    { action: 'open', documentId, name: 'Ignored' },
  ];
  for (const input of valid) {
    assert.equal(commandSchemas.documents.safeParse(input).success, true, JSON.stringify(input));
    assert.equal(advertised.safeParse(input).success, true, JSON.stringify(input));
  }
  for (const input of invalid) {
    assert.equal(commandSchemas.documents.safeParse(input).success, false, JSON.stringify(input));
    assert.equal(advertised.safeParse(input).success, false, JSON.stringify(input));
    assert.equal(await runCli(['documents', JSON.stringify(input)], notForwarded, () => {}), 2);
  }
  const output: string[] = [];
  await runCli(['help', 'documents', 'create'], notForwarded, text => output.push(text));
  assert.match(output[0].split('\n')[1], /no document context/);
  output.length = 0;
  await runCli(['help', 'documents', 'delete'], notForwarded, text => output.push(text));
  assert.match(output[0].split('\n')[1], /documentId and expectedRevision/);
});

test('read help and --latest never require or send expectedRevision', async () => {
  for (const name of ['inspect_model', 'analyze_model', 'render_views', 'export_model'] as const) {
    const output: string[] = [];
    await runCli(['help', name], notForwarded, text => output.push(text));
    assert.match(output[0].split('\n')[1], /optional documentId.*expectedRevision is not accepted/);
    const forwarded: CadCommand[] = [];
    await runCli([name, name === 'export_model' ? '{"format":"json"}' : '{}', '--latest'], async command => {
      forwarded.push(command);
      return { operation: command.type, status: 'success', documentId, revision: 7, created: [], updated: [], warnings: [] };
    }, () => {});
    assert.equal(forwarded.length, 2);
    assert.equal('expectedRevision' in forwarded[1].params, false);
    assert.equal('documentId' in forwarded[1].params && forwarded[1].params.documentId, documentId);
  }
});

test('uncertainty orders safe reconciliation before conditional human recovery and retains creation identity', () => {
  const requestId = randomUUID(), createdDocumentId = randomUUID();
  const command = parseCommand({ type: 'documents', params: { action: 'create', name: 'New part', requestId } });
  for (const reachable of [true, false]) {
    const result = uncertainOutcome(command, 'INVALID_RESPONSE', 'Result rejected.', requestId, reachable, undefined, createdDocumentId);
    assert.equal(result.requestId, requestId); assert.equal(result.createdDocumentId, createdDocumentId);
    assert.equal(result.error?.outcomeUnknown, true);
    assert.equal(result.error?.recovery?.first, reachable ? 'read' : 'human');
    if (reachable) {
      assert.equal(result.error?.requiresHuman, undefined);
      assert.match(result.error!.recovery!.steps[0], /documents.*requestId/);
      assert.ok(result.error!.recovery!.ifReadUnavailable?.steps.length);
    } else {
      assert.ok(result.error?.requiresHuman?.steps.length);
      assert.match(result.error!.recovery!.steps.at(-1)!, /documents.*requestId/);
    }
  }
});

test('contact sheet tiles cover only requested views, with four views in a 2 x 2 sheet', () => {
  for (let count = 1; count <= 7; count++) {
    const layout = contactSheetLayout(count, 384);
    assert.equal(layout.tiles.length, count);
    assert.equal(layout.tiles.reduce((area, tile) => area + tile.width * tile.height, 0), layout.width * layout.height);
    for (const [index, tile] of layout.tiles.entries()) {
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= layout.width && tile.y + tile.height <= layout.height);
      for (const other of layout.tiles.slice(index + 1)) assert.ok(tile.x + tile.width <= other.x || other.x + other.width <= tile.x || tile.y + tile.height <= other.y || other.y + other.height <= tile.y);
    }
    if (count === 4) { assert.equal(layout.width, 768); assert.equal(layout.height, 768); }
  }
});

test('compressed schemas preserve graphic property maps and keyed edit validation',()=>{
 const graphic={id:'mark',anchor:[0.5,0.5,1],normal:[0,0,1],xDirection:[1,0,0],width:5,height:3,depth:1,rotation:0,maxAngle:60,content:{type:'text',text:'VIBE',font:'sans',weight:'regular',spacing:0,align:'center',color:'#ffffff'}};
 const full=z.fromJSONSchema(commandInputSchema('apply_edits'));
 const input={...params,edits:[{op:'appearance',target:{feature:'body',select:{all:true}},graphics:{upsert:[graphic],remove:['old']}}]};
 assert.equal(full.safeParse(input).success,true);assert.equal(commandSchemas.apply_edits.safeParse(input).success,true);
 const invalid={...input,edits:[{...input.edits[0],graphics:{upsert:[{...graphic,content:{type:'image',dataUrl:'data:text/html;base64,PGgxPm5vPC9oMT4='}}]}}]};
 assert.equal(full.safeParse(invalid).success,false);assert.equal(commandSchemas.apply_edits.safeParse(invalid).success,false);
});
