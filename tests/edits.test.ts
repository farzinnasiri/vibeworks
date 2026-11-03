import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from '../src/cad/edits';
import { demoFeatures } from '../src/cad/demo';
import { emptyDocument } from '../src/cad/document';
import { AGENT_TOOLS, changesDocument, commandInfo, commandSchemas, parseCommand, type Feature } from '../src/shared/protocol';
import { runCli } from '../src/bridge/cli';

// Plain, unbound features: parameters have their own tests.
const plate = (): Feature[] => demoFeatures().map(({ bindings: _bindings, ...feature }) => feature as Feature);

test('HTTP and agent adapters accept the same eight commands', () => {
  assert.deepEqual(Object.keys(commandSchemas).sort(), [...AGENT_TOOLS].sort());
  for (const type of ['create_box', 'create_rod', 'create_cylinder', 'extrude', 'revolve',
    'subtract', 'union', 'intersect', 'fillet', 'chamfer', 'transform', 'mirror',
    'drill_holes', 'pattern', 'text', 'delete_features', 'update_feature']) {
    assert.throws(() => parseCommand({ type, params: {} }), type);
  }
});

test('applyEdits is pure, atomic and reports created/updated/deleted', () => {
  const doc = emptyDocument();
  const built = applyEdits(doc, plate().map(feature => ({ op: 'add', feature })));
  assert.equal(doc.features.length, 0, 'source document untouched');
  assert.deepEqual(built.created, plate().map(f => f.id));
  const box = built.document.features[0] as Extract<Feature, { kind: 'box' }>;
  const changed = applyEdits(built.document, [
    { op: 'update', feature: { ...box, params: { ...box.params, size: [100, 60, 8] } } },
    { op: 'delete', featureIds: ['finished_plate'], cascade: false },
  ]);
  assert.deepEqual(changed.updated, ['plate']);
  assert.deepEqual(changed.deleted, ['finished_plate']);
  // Adding then deleting in one batch is neither created nor deleted.
  const net = applyEdits(built.document, [{ op: 'add', feature: { id: 'tmp', kind: 'box', params: { origin: [0, 0, 0], size: [1, 1, 1] } } }, { op: 'delete', featureIds: ['tmp'], cascade: false }]);
  assert.deepEqual([net.created, net.deleted], [[], []]);
  assert.throws(() => applyEdits(built.document, [{ op: 'add', feature: box }]), /already exists/);
  assert.throws(() => applyEdits(built.document, [{ op: 'delete', featureIds: ['plate'], cascade: false }]), /depend/);
  // A forward reference is caught when the whole graph is validated, naming no partial result.
  assert.throws(() => applyEdits(doc, [{ op: 'add', feature: plate()[1] }]), /No edit was applied/);
});

test('one command catalog describes every tool and decides which outcomes can be unknown', () => {
  assert.deepEqual(Object.keys(commandInfo).sort(), Object.keys(commandSchemas).sort());
  const context = { documentId: emptyDocument().documentId, expectedRevision: 0 };
  const edit = { op: 'delete', featureIds: ['x'], cascade: true };
  assert.equal(changesDocument(parseCommand({ type: 'apply_edits', params: { ...context, edits: [edit] } })), true);
  assert.equal(changesDocument(parseCommand({ type: 'apply_edits', params: { ...context, edits: [edit], dryRun: true } })), false);
  assert.equal(changesDocument(parseCommand({ type: 'document_action', params: { ...context, action: 'save' } })), true);
  assert.equal(changesDocument(parseCommand({ type: 'render_views', params: {} })), false);
});

test('CLI lists tools, fills context with --latest and reports usage errors with exit codes', async () => {
  const lines: string[] = [];
  const print = (text: string) => { lines.push(text); };
  assert.equal(await runCli(['tools'], async () => { throw new Error('no call'); }, print), 0);
  assert.equal(lines.join('\n').split('\n').length, AGENT_TOOLS.length);
  lines.length = 0;
  assert.equal(await runCli(['help', 'apply_edits'], async () => { throw new Error('no call'); }, print), 0);
  assert.match(lines[0], /set_parameter/); assert.match(lines[0], /requires documentId and expectedRevision/);
  lines.length = 0;
  assert.equal(await runCli(['schema', 'apply_edits'], async () => { throw new Error('no call'); }, print), 0);
  assert.match(JSON.parse(lines[0]).description, /circular/);
  assert.equal(await runCli(['create_box', '{}'], async () => { throw new Error('no call'); }, print), 2, 'Removed single-feature commands are rejected.');
  const doc = emptyDocument();
  const seen: unknown[] = [];
  const forward = async (command: { type: string; params: unknown }) => {
    seen.push(command);
    return command.type === 'inspect_model'
      ? { operation: 'inspect_model' as const, status: 'success' as const, documentId: doc.documentId, revision: 7, created: [], updated: [], warnings: [] }
      : { operation: 'select_features' as const, status: 'success' as const, documentId: doc.documentId, revision: 7, created: [], updated: [], warnings: [] };
  };
  lines.length = 0;
  assert.equal(await runCli(['select_features', '{"featureIds":[]}', '--latest'], forward, print), 0);
  assert.deepEqual((seen[1] as { params: unknown }).params, { documentId: doc.documentId, expectedRevision: 7, featureIds: [] });
  lines.length = 0;
  assert.equal(await runCli(['select_features', '{"featureIds":[]}'], forward, print), 2);
  assert.match(lines.join('\n'), /--latest/);
  assert.equal(await runCli(['nonsense'], forward, print), 2);
});

test('a new feature on a shape another feature already consumed warns that the model forks', () => {
  const built = applyEdits(emptyDocument(), plate().map(feature => ({ op: 'add', feature })));
  assert.deepEqual(built.warnings, []);
  // finished_plate is the visible result; filleting the plain box again would leave two overlapping results.
  const forked = applyEdits(built.document, [{ op: 'add', feature: { id: 'again', kind: 'fillet', params: { target: 'plate', radius: 1, edges: 'all' } } }]);
  assert.equal(forked.warnings.length, 1);
  assert.match(forked.warnings[0], /'again' builds on 'plate', which '.+' already uses/);
  // Building on the visible result, or making a linked copy, does not fork.
  assert.deepEqual(applyEdits(built.document, [{ op: 'add', feature: { id: 'round', kind: 'fillet', params: { target: 'finished_plate', radius: 1, edges: 'all' } } }]).warnings, []);
  assert.deepEqual(applyEdits(built.document, [{ op: 'add', feature: { id: 'copy', kind: 'transform', params: { target: 'finished_plate', translation: [0, 0, 20], rotationAxis: [0, 0, 1], angleDegrees: 0, origin: [0, 0, 0], scale: 1, copy: true } } }]).warnings, []);
});

test('apply_edits carries appearance beside params, as the creation forms send it', () => {
  const doc = emptyDocument();
  const command = parseCommand({ type: 'apply_edits', params: { documentId: doc.documentId, expectedRevision: 0, edits: [{ op: 'add', feature: { id: 'b', appearance: { material: 'aluminum' }, kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] } } }] } });
  assert.equal(command.type, 'apply_edits');
  assert.deepEqual(command.params.edits, [{ op: 'add', feature: { id: 'b', kind: 'box', params: { origin: [0, 0, 0], size: [10, 10, 10] }, appearance: { material: 'aluminum' } } }]);
  assert.equal(applyEdits(doc, command.params.edits).document.features[0].appearance?.material, 'aluminum');
});
