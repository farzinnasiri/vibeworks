import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AGENT_TOOLS, COMMAND_TIMEOUT_MS, documentSchema, type CadDocument, type CadResult, type CommandName } from '../src/shared/protocol.ts';
import { ARTIFACTS_DIR, PROJECT_ROOT } from '../src/bridge/connection.ts';
import { saveArtifact, type SavedArtifact } from '../src/bridge/artifacts.ts';
import { decodeBase64 } from '../src/bridge/validation.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run demo:mcp -- [--reset]\nRequires npm run dev and one real browser open at http://127.0.0.1:5173 with its kernel ready.\nWithout --reset, refuses an existing nonempty document. --reset backs up its JSON first.\nBuilds and checks the plate, edits thickness, exercises history/errors/JSON reload, saves PNG and exports.\nNo mock runtime or model-driven client session is launched.');
  process.exit(0);
}
if (args.some((arg) => arg !== '--reset')) throw new Error('Unknown argument. Use --help.');

await mkdir(ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
if ((await lstat(ARTIFACTS_DIR)).isSymbolicLink()) throw new Error('artifacts must not be a symlink.');
const evidenceDirectory = await mkdtemp(join(ARTIFACTS_DIR, 'mcp-demo-'));
const transcript: unknown[] = [];
const checks: Record<string, unknown> = {};
const artifacts: SavedArtifact[] = [];
const expectedVolumeMm3 = (100 * 60 - (4 - Math.PI) * 3 * 3 - 4 * Math.PI * 2.5 * 2.5) * 5;
const boundsToleranceMm = 1e-4;
const volumeToleranceMm3 = 1e-3;
const client = new Client({ name: 'vibeworks-real-browser-demo', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../src/bridge/mcp.ts', import.meta.url))],
  cwd: PROJECT_ROOT, maxBufferSize: 64 * 1024 * 1024,
});
let doc!: CadDocument;
let failure: string | undefined;

async function call(name: CommandName, params: Record<string, unknown>, expectError = false): Promise<{ result: CadResult; raw: CallToolResult }> {
  const raw = await client.callTool({ name, arguments: params }, { timeout: COMMAND_TIMEOUT_MS + 10_000 });
  const result = raw.structuredContent as CadResult | undefined;
  if (!result) throw new Error(`${name} returned no structured CAD result.`);
  transcript.push({ name, params, result, isError: raw.isError ?? false });
  assert.equal(raw.isError === true, expectError, `${name}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  assert.equal(result.status, expectError ? 'error' : 'success');
  if (result.error?.outcomeUnknown) throw new Error(`${name}: outcome unknown. Inspect the actual browser before another write. Demo stopped without retrying.`);
  if (!expectError && result.document) doc = documentSchema.parse(result.document);
  // Edits answer with compact receipts; like an agent, fetch the full document when the revision moved.
  else if (!expectError && name !== 'inspect_model' && result.revision !== undefined && result.revision !== doc?.revision) await call('inspect_model', {});
  return { result, raw };
}
const context = () => ({ documentId: doc.documentId, expectedRevision: doc.revision });
async function inspectPlate(thickness: number) {
  const { result } = await call('inspect_model', {});
  assert.deepEqual(result.visibleFeatureIds, ['finished_plate']);
  assert.equal(result.geometry?.length, 1, 'Exactly one visible output is expected.');
  const shape = result.geometry![0];
  assert.equal(shape.featureId, 'finished_plate'); assert.equal(shape.valid, true); assert.equal(shape.solidCount, 1); assert.ok(shape.validationMethod);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(shape.bounds.min[axis]) <= boundsToleranceMm, `Bounds min axis ${axis}`);
    assert.ok(Math.abs(shape.bounds.size[axis] - [100, 60, thickness][axis]) <= boundsToleranceMm, `Bounds size axis ${axis}`);
  }
  const expected = expectedVolumeMm3 * thickness / 5;
  assert.ok(Math.abs(shape.volumeMm3 - expected) <= volumeToleranceMm3, `Exact volume ${shape.volumeMm3} should be ${expected} ± ${volumeToleranceMm3}.`);
  return { documentId: doc.documentId, revision: doc.revision, geometry: shape };
}
async function assertUnchanged(before: CadDocument) {
  await call('inspect_model', {}); assert.deepEqual(doc, before, 'Failed edit must preserve the committed document and revision.');
  return inspectPlate(5);
}

try {
  await client.connect(transport);
  const enrollment = await client.callTool({name:"agent_session",arguments:{action:"join",client:"mcp-demo"}});
  assert.ok(!enrollment.isError, JSON.stringify(enrollment.structuredContent));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...AGENT_TOOLS].sort()); checks.tools = tools.map((tool) => tool.name);
  console.log(`Discovered all ${tools.length} MCP tools. Inspecting the connected real browser.`);
  await call('inspect_model', {});
  if (!doc) throw new Error('inspect_model did not return an editable document.');
  if (doc.features.length && !args.includes('--reset')) throw new Error(`Connected document ${doc.documentId} has ${doc.features.length} features. Refusing to replace it. Export/save it, then run with --reset if replacement is intended.`);
  if (args.includes('--reset')) {
    if (doc.features.length) artifacts.push(await saveArtifact(Buffer.from(JSON.stringify(doc, null, 2)), 'before-reset.json', 'application/json', evidenceDirectory));
    await call('document_action', { ...context(), action: 'reset' });
  }
  await call('apply_edits', { ...context(), edits: [{ op: 'add', feature: { id: 'plate', label: '100 x 60 x 5 mm plate', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 5] } } }] });
  await call('apply_edits', { ...context(), edits: [{ op: 'add', feature: { id: 'rounded_plate', kind: 'fillet', params: { target: 'plate', edges: 'vertical', radius: 3 } } }] });
  const holeCenters = [[10, 10], [90, 10], [10, 50], [90, 50]];
  for (const [index, [x, y]] of holeCenters.entries()) await call('apply_edits', { ...context(), edits: [{ op: 'add', feature: { id: `hole_${index + 1}`, kind: 'cylinder', params: { origin: [x, y, -1], radius: 2.5, height: 12 } } }] });
  await call('apply_edits', { ...context(), edits: [{ op: 'add', feature: { id: 'finished_plate', kind: 'subtract', params: { target: 'rounded_plate', tools: ['hole_1', 'hole_2', 'hole_3', 'hole_4'] } } }] });
  checks.plate = await inspectPlate(5); console.log('Exact bounds, solid validation and rounded-corner/hole volume passed.');

  const originalRevision = doc.revision;
  await call('apply_edits', { ...context(), edits: [{ op: 'update', feature: { id: 'plate', kind: 'box', label: '100 x 60 x 8 mm plate', params: { origin: [0, 0, 0], size: [100, 60, 8] } } }] });
  checks.thicknessUpdate = await inspectPlate(8); assert.ok(doc.revision > originalRevision);
  let previousRevision = doc.revision;
  await call('document_action', { ...context(), action: 'undo' }); checks.undo = await inspectPlate(5); assert.ok(doc.revision > previousRevision);
  previousRevision = doc.revision;
  await call('document_action', { ...context(), action: 'redo' }); checks.redo = await inspectPlate(8); assert.ok(doc.revision > previousRevision);
  await call('document_action', { ...context(), action: 'undo' }); await inspectPlate(5);
  const beforeFailures = structuredClone(doc);
  const stale = await call('apply_edits', { documentId: doc.documentId, expectedRevision: originalRevision, edits: [{ op: 'update', feature: doc.features.find((feature) => feature.id === 'plate') }] }, true);
  assert.match(stale.result.error!.code, /REVISION|STALE/); checks.staleRevision = stale.result.error; await assertUnchanged(beforeFailures);
  const wrongDocument = await call('document_action', { documentId: randomUUID(), expectedRevision: doc.revision, action: 'undo' }, true); checks.wrongDocument = wrongDocument.result.error; await assertUnchanged(beforeFailures);
  const invalid = await call('apply_edits', { ...context(), edits: [{ op: 'add', feature: { id: 'invalid_box', kind: 'box', params: { origin: [0, 0, 0], size: [-1, 60, 5] } } }] }, true); assert.equal(invalid.result.error!.code, 'INVALID_COMMAND'); checks.invalidInput = invalid.result.error; await assertUnchanged(beforeFailures);
  const oversized = await call('apply_edits', { ...context(), edits: [{ op: 'update', feature: { id: 'rounded_plate', kind: 'fillet', params: { target: 'plate', edges: 'vertical', radius: 1000 } } }] }, true); checks.oversizedFillet = oversized.result.error; await assertUnchanged(beforeFailures);

  const savedRevision = doc.revision;
  await call('document_action', { ...context(), action: 'save' }); assert.equal(doc.revision, savedRevision); checks.browserSave = { revisionUnchanged: true };
  const jsonExport = await call('export_model', { format: 'json', filename: 'mounting-plate.json' });
  const jsonArtifact = (jsonExport.raw.structuredContent as Record<string, any>).artifact as SavedArtifact; artifacts.push(jsonArtifact);
  const savedDocument = documentSchema.parse(JSON.parse(await readFile(jsonArtifact.path, 'utf8')));
  assert.deepEqual(savedDocument, doc);
  // This reset only affects the plate just created by this run. Load replays it.
  await call('document_action', { ...context(), action: 'reset' }); assert.equal(doc.features.length, 0);
  await call('document_action', { ...context(), action: 'load', document: savedDocument }); checks.jsonReload = await inspectPlate(5);
  assert.deepEqual(doc.features, savedDocument.features);
  checks.selection = { selectedFeatureIds: doc.selectedFeatureIds, note: 'Reported by inspection; manual selection and page-reload persistence are separate browser checks.' };

  const render = await call('render_views', { views: ['front', 'back', 'left', 'right', 'top', 'isometric'], tileSize: 512 });
  const image = render.raw.content.find((item) => item.type === 'image'); assert.ok(image && image.mimeType === 'image/png', 'render_views must deliver actual MCP image content.');
  artifacts.push(await saveArtifact(decodeBase64(image.data), 'mounting-plate-views.png', 'image/png', evidenceDirectory));
  checks.render = (render.raw.structuredContent as Record<string, unknown>).image;
  for (const format of ['step', 'stl'] as const) {
    const exported = await call('export_model', { format, featureId: 'finished_plate', filename: `mounting-plate.${format}` });
    const artifact = (exported.raw.structuredContent as Record<string, any>).artifact as SavedArtifact;
    assert.ok(artifact.byteLength > 0); assert.ok(exported.raw.content.some((item) => item.type === 'resource')); artifacts.push(artifact);
  }
  // The same plate as one atomic transaction: dry run first, then commit, then a single undo.
  const plateFeatures = structuredClone(doc.features);
  const dryRun = await call('apply_edits', { ...context(), edits: [{ op: 'update', feature: { id: 'plate', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 8] } } }], dryRun: true });
  assert.equal(dryRun.result.dryRun, true); assert.equal(dryRun.result.revision, doc.revision);
  // Receipts report the candidate's affected solids under `results`.
  const candidate = (dryRun.result as unknown as { results: { featureId: string; volumeMm3: number }[] }).results.find(r => r.featureId === 'finished_plate')!;
  assert.ok(Math.abs(candidate.volumeMm3 - expectedVolumeMm3 * 8 / 5) <= 0.01, 'Dry run reports the exact candidate volume (receipts round to 0.001 mm³).');
  await inspectPlate(5); checks.dryRun = { candidateVolumeMm3: candidate.volumeMm3, committedUnchanged: true };
  const beforeBatch = doc.revision;
  await call('apply_edits', { ...context(), edits: [{ op: 'delete', featureIds: plateFeatures.map(f => f.id), cascade: true }, ...plateFeatures.map(feature => ({ op: 'add', feature }))], select: ['finished_plate'] });
  assert.equal(doc.revision, beforeBatch + 1, 'A batch is one revision.'); await inspectPlate(5);
  const badBatch = await call('apply_edits', { ...context(), edits: [{ op: 'update', feature: { id: 'plate', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 8] } } }, { op: 'delete', featureIds: ['missing'], cascade: false }] }, true);
  assert.match(badBatch.result.error!.message, /Edit 2 of 2/); await inspectPlate(5); checks.atomicBatch = { revisionsUsed: 1, failingBatchError: badBatch.result.error };
  // Parameters: bind the plate thickness to a named value, change only the value, then undo.
  const plateFeature = doc.features.find(f => f.id === 'plate')!;
  await call('apply_edits', { ...context(), edits: [{ op: 'set_parameter', name: 'thickness', value: 8 }, { op: 'update', feature: { ...plateFeature, bindings: { 'size.2': 'thickness' } } }] });
  checks.parameters = await inspectPlate(8);
  const conflict = await call('apply_edits', { ...context(), edits: [{ op: 'update', feature: { ...doc.features.find(f => f.id === 'plate')!, params: { origin: [0, 0, 0], size: [100, 60, 6] } } }] }, true);
  assert.equal(conflict.result.error!.code, 'BINDING_CONFLICT'); await inspectPlate(8);
  await call('document_action', { ...context(), action: 'undo' }); await inspectPlate(5);
  const sectionRender = await call('render_views', { views: ['isometric', 'front'], tileSize: 384, section: { axis: 'X', offset: 10 } });
  const sectionImage = sectionRender.raw.content.find((item) => item.type === 'image'); assert.ok(sectionImage && sectionImage.mimeType === 'image/png');
  artifacts.push(await saveArtifact(decodeBase64(sectionImage.data), 'mounting-plate-section-x10.png', 'image/png', evidenceDirectory));
  checks.final = await inspectPlate(5);
  checks.evidenceLimits = { sdkProtocol: 'passed against real browser', geometry: 'browser-reported exact B-rep metrics checked against analytic values', imageVisualReview: 'not performed by this script', stepInteroperability: 'not tested by this script; parse exported STEP with a separate reader', pageReloadPersistence: 'not tested by this script', codexModelDriven: 'not run', claudeModelDriven: 'not run' };
  console.log('Thickness update, undo/redo, invalid/stale edits, JSON regeneration, PNG and STEP/STL delivery passed.');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`MCP demo failed: ${failure}`); process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  const report = { timestamp: new Date().toISOString(), status: failure ? 'failed' : 'passed', ...(failure ? { failure } : {}), expectedVolumeMm3, tolerances: { boundsMm: boundsToleranceMm, volumeMm3: volumeToleranceMm3 }, checks, artifacts, transcript };
  const saved = await saveArtifact(Buffer.from(JSON.stringify(report, null, 2)), 'evidence.json', 'application/json', evidenceDirectory);
  console.log(`Evidence: ${saved.path}`);
}
