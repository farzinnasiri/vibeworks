// SDK acceptance against a real browser. This is verification, not an agent reasoning loop.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AGENT_TOOLS, type CadDocument, type CadResult, type CommandName } from '../src/shared/protocol';
import { ARTIFACTS_DIR, PROJECT_ROOT } from '../src/bridge/connection';

if (!process.argv.includes('--reset')) throw new Error('Usage: pnpm run demo:mechanical --reset. Backs up and replaces the connected test document.');
await mkdir(ARTIFACTS_DIR, { recursive: true });
const directory = await mkdtemp(join(ARTIFACTS_DIR, 'mechanical-'));
const client = new Client({ name: 'mechanical-browser-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../src/bridge/mcp.ts', import.meta.url))], cwd: PROJECT_ROOT, maxBufferSize: 64 * 1024 * 1024 });
let doc!: CadDocument;
const transcript: unknown[] = [];
let failure: string | undefined;
async function call(name: CommandName, args: Record<string, unknown>, fail = false) {
  const raw = await client.callTool({ name, arguments: args }, { timeout: 70_000 });
  const result = raw.structuredContent as CadResult;
  assert.ok(result, `${name} must return structured content`);
  const image = raw.content.find(c => c.type === 'image');
  if (image?.type === 'image') await writeFile(join(directory, 'views.png'), Buffer.from(image.data, 'base64'));
  transcript.push({ name, args, result, image: !!image });
  assert.equal(result.status, fail ? 'error' : 'success', `${name}: ${result.error?.message}`);
  assert.ok(!result.error?.outcomeUnknown, 'Uncertain transport outcome, stop and inspect.');
  if (result.document) doc = result.document;
  // Edits answer with compact receipts; like an agent, fetch the full document when the revision moved.
  else if (!fail && name !== 'inspect_model' && result.revision !== undefined && result.revision !== doc?.revision) await call('inspect_model', {});
  return result;
}
const ctx = () => ({ documentId: doc.documentId, expectedRevision: doc.revision });
const edit = (name: CommandName, args: Record<string, unknown>, fail = false) => call(name, { ...ctx(), ...args }, fail);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);
try {
  await client.connect(transport);
  const enrollment = await client.callTool({name:"agent_session",arguments:{action:"join",client:"mechanical-demo"}});
  assert.ok(!enrollment.isError, JSON.stringify(enrollment.structuredContent));
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), [...AGENT_TOOLS].sort());
  await call('inspect_model', {});
  await writeFile(join(directory, 'before.json'), JSON.stringify(doc, null, 2));
  await edit('document_action', { action: 'reset' });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'foot', kind: 'extrude', params: { profile: { type: 'rectangle', width: 80, height: 50 }, plane: 'XY', origin: [0, 0, 0], distance: 5 } } }] });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'upright', kind: 'box', params: { origin: [-40, 20, 5], size: [80, 5, 35] } } }] });
  await edit('select_features', { featureIds: ['foot', 'upright'] }); await call('inspect_model', {}); assert.deepEqual(doc.selectedFeatureIds, ['foot', 'upright']);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'bracket', kind: 'union', params: { target: 'foot', tools: ['upright'] } } }] });
  let r = await call('inspect_model', {}); close(r.geometry![0].volumeMm3, 34000);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'base_holes', kind: 'drill_holes', params: { target: 'bracket', diameter: 6, axis: 'Z', centers: [[-25, -10, 0], [25, -10, 0]] } } }] });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'mount', kind: 'drill_holes', params: { target: 'base_holes', diameter: 6, axis: 'Y', centers: [[-25, 0, 25], [25, 0, 25]] } } }] });
  r = await call('inspect_model', {}); close(r.geometry![0].volumeMm3, 34000 - 180 * Math.PI);
  const good = structuredClone(doc);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'miss', kind: 'drill_holes', params: { target: 'mount', diameter: 6, axis: 'Z', centers: [[999, 999, 0]] } } }] }, true);
  await call('inspect_model', {}); assert.deepEqual(doc, good);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'placed', kind: 'transform', params: { target: 'mount', translation: [10, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 90, origin: [0, 0, 0], scale: 1, copy: false } } }] });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'copy', kind: 'transform', params: { target: 'placed', translation: [100, 0, 0], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0], scale: 0.5, copy: true } } }] });
  r = await call('inspect_model', {}); assert.deepEqual(r.visibleFeatureIds, ['placed', 'copy']);
  close(r.geometry!.find(g => g.featureId === 'copy')!.volumeMm3, (34000 - 180 * Math.PI) / 8);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'mirrored', kind: 'mirror', params: { target: 'copy', plane: 'YZ', origin: [0, 0, 0], copy: true } } }] });
  await edit('apply_edits', { edits: [{ op: 'delete', featureIds: ['copy'], cascade: false }] }, true);
  r = await edit('apply_edits', { edits: [{ op: 'delete', featureIds: ['copy'], cascade: true }] }); assert.deepEqual(r.deleted, ['copy', 'mirrored']);
  await edit('document_action', { action: 'undo' }); assert.ok(doc.features.some(f => f.id === 'mirrored'));
  await edit('document_action', { action: 'redo' }); assert.ok(!doc.features.some(f => f.id === 'copy'));
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'shaft', kind: 'revolve', params: { points: [[0, 0], [10, 0], [10, 5], [5, 5], [5, 30], [0, 30]], origin: [75, 0, 0], angleDegrees: 360 } } }] });
  r = await call('inspect_model', { featureId: 'shaft' }); close(r.geometry![0].volumeMm3, Math.PI * (100 * 5 + 25 * 25));
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'shaft_bevel', kind: 'chamfer', params: { target: 'shaft', distance: 0.5, edges: 'all' } } }] });
  // Exercise intersection and difference on known overlapping solids, then remove them.
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'a', kind: 'box', params: { origin: [200, 0, 0], size: [10, 10, 10] } } }] });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'b', kind: 'box', params: { origin: [205, 0, 0], size: [10, 10, 10] } } }] });
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'common', kind: 'intersect', params: { target: 'a', tools: ['b'] } } }] });
  r = await call('inspect_model', { featureId: 'common' }); close(r.geometry![0].volumeMm3, 500);
  await edit('apply_edits', { edits: [{ op: 'add', feature: { id: 'cut', kind: 'subtract', params: { target: 'a', tools: ['b'] } } }] });
  r = await call('inspect_model', { featureId: 'cut' }); close(r.geometry![0].volumeMm3, 500);
  await edit('apply_edits', { edits: [{ op: 'delete', featureIds: ['a', 'b'], cascade: true }] });
  await edit('select_features', { featureIds: ['placed', 'shaft_bevel'] });
  const rendered = await call('render_views', { views: ['isometric', 'front', 'right', 'top'], tileSize: 512 });
  assert.ok(rendered.image); assert.equal(rendered.image.base64, undefined);
  for (const format of ['step', 'stl', 'json']) await call('export_model', { format, filename: `mechanical-${format}` });
  await writeFile(join(directory, 'final-document.json'), JSON.stringify(doc, null, 2));
  console.log(`Passed ${transcript.length} real-browser MCP calls across ${AGENT_TOOLS.length} agent tools.`);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; console.error(failure); }
finally {
  await client.close();
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', failure, transcript }, null, 2));
  console.log(`Evidence: ${directory}/evidence.json`);
}
