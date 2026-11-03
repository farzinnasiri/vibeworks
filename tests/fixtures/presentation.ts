import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CommandAuthority } from '../../src/bridge/authority';
import { parseCommand, type CadDocument, type CadResult, type Feature, type Vector3 } from '../../src/shared/protocol';
export const ok = (r: CadResult) => { assert.equal(r.status, 'success', JSON.stringify(r)); return r; };
export const instance = (id: string, document: string, translation: Vector3 = [0,0,0], featureId?: string): Feature => ({ id, kind: 'instance', params: { document, translation, rotationAxis: [0,0,1], angleDegrees: 0, origin: [0,0,0], ...(featureId ? { featureId } : {}) } });
export async function presentationFixture(authority: CommandAuthority) {
  const run = async (value: unknown) => ok((await authority.execute(parseCommand(value))).result);
  const create = async (name: string, kind: 'part' | 'assembly') => { const created = await run({ type: 'documents', params: { action: 'create', name, kind, requestId: randomUUID() } }); return (await run({ type: 'inspect_model', params: { documentId: created.documentId } })).document!; };
  const build = async (document: CadDocument, features: Feature[]) => (await run({ type: 'apply_edits', params: { documentId: document.documentId, expectedRevision: 0, analyze: false, edits: features.map(feature => ({ op: 'add', feature })) } })).document!;
  const part = await build(await create('Machined plate', 'part'), [
    { id: 'stock', label: 'Plate stock', kind: 'box', params: { origin: [0,0,0], size: [20,10,4] }, appearance: { material: 'aluminum', color: '#9caeb8' }, mounts: [{ name: 'top', frame: { origin: [0,0,4], normal: [0,0,1], xDirection: [1,0,0] } }] },
    { id: 'cutter', label: 'Hole cutter', kind: 'cylinder', params: { origin: [5,5,0], radius: 2, height: 4 } },
    { id: 'cut', label: 'Cut the hole', kind: 'subtract', params: { target: 'stock', tools: ['cutter'] } },
    { id: 'finished', label: 'Offset plate', kind: 'transform', params: { target: 'cut', translation: [3,0,0], rotationAxis: [0,0,1], angleDegrees: 0, origin: [0,0,0], scale: 1, copy: false } },
    { id: 'unrelated', label: 'Unrelated result', kind: 'box', params: { origin: [100,0,0], size: [10,10,10] } },
  ]);
  const subInstance = instance('inner', part.documentId, [0,30,0], 'finished');
  if (subInstance.kind === 'instance') subInstance.params.angleDegrees = 90;
  subInstance.appearance = { color: '#426d97' };
  const sub = await build(await create('Nested carrier', 'assembly'), [subInstance]);
  const nested = instance('nested', sub.documentId, [60,20,10]);
  if (nested.kind === 'instance') nested.params.angleDegrees = 90;
  const mounted = instance('mounted', part.documentId, [0,0,0], 'finished');
  if (mounted.kind === 'instance') mounted.params.attachment = {
    source: { featureId: 'finished', name: 'top' }, target: { frame: { origin: [50,-20,8], normal: [0,0,1], xDirection: [0,1,0] } }, mode: 'mate', offset: [3,4,5], twistDegrees: 90,
  };
  mounted.appearance = { color: '#c47b43' };
  const assembly = await build(await create('Presentation assembly', 'assembly'), [instance('first', part.documentId, [0,0,0], 'finished'), instance('second', part.documentId, [30,0,0], 'finished'), nested, mounted]);
  return { part, sub, assembly, run };
}
