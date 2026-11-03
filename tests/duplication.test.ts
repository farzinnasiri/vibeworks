import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { CommandAuthority } from '../src/bridge/authority';
import { resultSchema } from '../src/bridge/validation';
import { receipt } from '../src/bridge/deliver';
import { emptyDocument } from '../src/cad/document';
import { MemoryStore, emptyHistory, type DocumentStore } from '../src/cad/store';
import { LEGACY_PROJECT_ID, commandInputSchema, parseCommand, withCreationRequestId, uncertainOutcome, type CadDocument, type CadResult, type StorageOperation } from '../src/shared/protocol';

const box = (size = 10): CadDocument['features'][number] => ({ id: 'body', kind: 'box', params: { origin: [0,0,0], size: [size,10,10] }, appearance: { material: 'steel', color: '#123456' } });
const instance = (id: string, document: string): CadDocument['features'][number] => ({ id, kind: 'instance', params: { document, translation: [0,0,0], rotationAxis: [0,0,1], angleDegrees: 0, origin: [0,0,0] } });
const success = (result: CadResult) => { assert.equal(result.status, 'success', JSON.stringify(result.error)); return result; };
async function fixture(store: DocumentStore) {
  const projectId = crypto.randomUUID();
  await store.operation({ action: 'project', project: { projectId, name: 'F1', version: 1 }, expectedVersion: null });
  const part: CadDocument = { ...emptyDocument(), projectId, name: 'Body', revision: 7, features: [box()], presentation: { exposure: 1.3, materials: { steel: { finish: 'gloss' } } } };
  part.creation = { requestId: part.documentId, action: 'create', name: part.name };
  await store.put(part, null);
  await store.put(part, 1, { undo: [{ ...part, revision: 6 }], redo: [] });
  const outside: CadDocument = { ...emptyDocument(), projectId: LEGACY_PROJECT_ID, name: 'Shared hardware', features: [box(2)] };
  await store.put(outside, null);
  const sub: CadDocument = { ...emptyDocument(), projectId, kind: 'assembly', name: 'Subassembly', features: [instance('part', part.documentId)] };
  await store.put(sub, null);
  const root: CadDocument = { ...emptyDocument(), projectId, kind: 'assembly', name: 'Main', features: [instance('sub', sub.documentId), instance('outside', outside.documentId)] };
  await store.put(root, null);
  await store.operation({ action: 'project', project: { projectId, name: 'F1', mainAssemblyId: root.documentId, version: 1 }, expectedVersion: 1 });
  const op: Extract<StorageOperation, { action: 'duplicate_project' }> = { action: 'duplicate_project', projectId, requestId: crypto.randomUUID(), expectedVersion: 2,
    documentVersions: { [part.documentId]: 2, [sub.documentId]: 1, [root.documentId]: 1 } };
  return { projectId, part, sub, root, outside, op };
}

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: project copies remap nested sources and main assembly, retain outside references, and own their bodies/history`, async t => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    if (store instanceof SqliteStore) t.after(() => store.close());
    const { part, sub, root, outside, op } = await fixture(store);
    const originals = await Promise.all([part, sub, root, outside].map(d => store.read(d.documentId)));
    const before = (await store.operation({ action: 'changes', after: 0 })).cursor!;
    const result = await store.operation(op), copy = result.duplication!;
    assert.equal(copy.projectId, op.requestId); assert.equal(copy.sourceProjectId, op.projectId);
    assert.deepEqual(copy.externalDocumentIds, [outside.documentId]);
    assert.equal(Object.keys(copy.documentIds).length, 3);
    const newProject = (await store.operation({ action: 'projects' })).projects!.find(p => p.projectId === copy.projectId)!;
    assert.equal(newProject.name, 'F1 copy'); assert.equal(newProject.version, 1);
    assert.equal(newProject.mainAssemblyId, copy.documentIds[root.documentId]);
    for (const source of [part, sub, root]) {
      const record = (await store.read(copy.documentIds[source.documentId]))!;
      assert.equal(record.document.revision, 0); assert.equal(record.version, 1);
      assert.equal(record.document.projectId, copy.projectId); assert.equal(record.document.name, source.name);
      assert.equal(record.document.creation, undefined); assert.deepEqual(record.document.selectedFeatureIds, []);
      assert.deepEqual(record.history, emptyHistory());
      const expectedFeatures = structuredClone(source.features);
      for (const f of expectedFeatures) if (f.kind === 'instance') f.params.document = copy.documentIds[f.params.document] ?? f.params.document;
      assert.deepEqual(record.document.features, expectedFeatures);
      assert.deepEqual(record.document.presentation, source.presentation);
    }
    const newPartId = copy.documentIds[part.documentId], newPart = (await store.read(newPartId))!;
    newPart.document.features[0].appearance!.color = '#abcdef';
    await store.put({ ...newPart.document, revision: 1 }, 1);
    assert.deepEqual(await Promise.all([part, sub, root, outside].map(d => store.read(d.documentId))), originals);
    const replay = await store.operation({ ...op, documentVersions: Object.fromEntries(Object.entries(op.documentVersions).reverse()) });
    assert.equal(replay.replayed, true); assert.deepEqual(replay.duplication, copy);
    assert.equal((await store.operation({ action: 'changes', after: before })).changes!.length, 5, 'one project, three documents and one deliberate edit; replay writes nothing');
    await assert.rejects(store.operation({ ...op, name: 'Changed arguments' }), { code: 'REQUEST_ID_CONFLICT' });
  });

  test(`${adapter}: stale project version, edits, additions, removals and moves reject without partial copies`, async t => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    if (store instanceof SqliteStore) t.after(() => store.close());
    const { part, op } = await fixture(store);
    const beforeProjects = (await store.operation({ action: 'projects' })).projects;
    const beforeCursor = (await store.operation({ action: 'changes', after: 0 })).cursor;
    for (const change of [
      { expectedVersion: 1 },
      { documentVersions: { ...op.documentVersions, [part.documentId]: 1 } },
      { documentVersions: { ...op.documentVersions, [crypto.randomUUID()]: 1 } },
      { documentVersions: {} },
    ]) await assert.rejects(store.operation({ ...op, ...change }), { code: 'STORAGE_CONFLICT' });
    assert.deepEqual((await store.operation({ action: 'projects' })).projects, beforeProjects);
    assert.equal((await store.operation({ action: 'changes', after: 0 })).cursor, beforeCursor);
    const added = { ...emptyDocument(), projectId: op.projectId }; await store.put(added, null);
    await assert.rejects(store.operation(op), { code: 'STORAGE_CONFLICT' });
    await store.put({ ...added, projectId: LEGACY_PROJECT_ID }, 1);
    await store.put({ ...part, projectId: LEGACY_PROJECT_ID }, 2);
    await assert.rejects(store.operation(op), { code: 'STORAGE_CONFLICT' });
  });
}

test('SQLite audit failure rolls back all copied documents, project, feed and receipt; restart recovers identical request once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vibeworks-duplicate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.db'), store = new SqliteStore(path), raw = new DatabaseSync(path);
  const { op } = await fixture(store);
  const before = (await store.operation({ action: 'changes', after: 0 })).cursor;
  raw.exec(`CREATE TRIGGER fail_duplicate BEFORE INSERT ON revisions WHEN json_extract(NEW.body,'$.name')='Main' AND NEW.revision=0 BEGIN SELECT RAISE(ABORT,'controlled copy failure'); END;`);
  await assert.rejects(store.operation(op), /controlled copy failure/);
  assert.equal((await store.operation({ action: 'changes', after: 0 })).cursor, before);
  assert.equal((await store.operation({ action: 'projects' })).projects!.some(p => p.projectId === op.requestId), false);
  assert.equal((await store.list()).length, 4);
  raw.exec('DROP TRIGGER fail_duplicate'); raw.close();
  const first = await store.operation(op); store.close();
  const reopened = new SqliteStore(path); t.after(() => reopened.close());
  const recovered = await reopened.operation(op);
  assert.equal(recovered.replayed, true); assert.deepEqual(recovered.duplication, first.duplication);
  const contents = (await reopened.list()).filter(d => d.projectId === op.requestId);
  await reopened.operation({ action: 'remove_project', projectId: op.requestId, expectedVersion: 1,
    documentVersions: Object.fromEntries(contents.map(d => [d.documentId, d.storageVersion!])) });
  await assert.rejects(reopened.operation(op), { code: 'PROJECT_DELETED' });
});

test('duplicate commands share strict advertised schemas, request identity and project-specific uncertain-outcome recovery', () => {
  const projectId = crypto.randomUUID(), requestId = crypto.randomUUID();
  const params = { action: 'duplicate_project', projectId, requestId, expectedStorageVersion: 1, documentVersions: {} };
  const command = parseCommand({ type: 'documents', params });
  assert.equal(z.fromJSONSchema(commandInputSchema('documents')).safeParse(params).success, true);
  assert.throws(() => parseCommand({ type: 'documents', params: { ...params, documentVersions: undefined } }));
  assert.throws(() => parseCommand({ type: 'documents', params: { ...params, documentId: crypto.randomUUID() } }));
  const identified = withCreationRequestId(command);
  assert.equal(identified.type === 'documents' && identified.params.requestId, requestId);
  const failure = uncertainOutcome(command, 'BRIDGE_TRANSPORT_ERROR', 'Reply lost.', requestId, true);
  assert.equal(failure.error!.outcomeUnknown, true); assert.match(failure.error!.recovery!.steps[0], new RegExp(requestId));
  assert.match(failure.error!.recovery!.steps[0], /projects/);
});

test('Node authority copies parts and assemblies through commands, checks source versions, and keeps original geometry and history independent', async t => {
  const store = new SqliteStore(':memory:');
  const { part, sub, root, op } = await fixture(store);
  const authority = new CommandAuthority(store, { workers: 1 });
  t.after(async () => { await authority.close(); store.close(); });
  await authority.ready(); assert.equal(authority.phase, 'ready');
  const execute = async (type: string, params: unknown) => (await authority.execute(parseCommand({ type, params }), undefined, false)).result;
  const command = parseCommand({ type: 'documents', params: { action: 'duplicate_project', projectId: op.projectId, requestId: op.requestId, expectedStorageVersion: op.expectedVersion, documentVersions: op.documentVersions, name: 'F1 blue' } });
  const actor = store.collaboration.command({ action: 'join', client: 'codex' });
  const context = store.collaboration.begin(op.requestId, actor.session.sessionId, command);
  const copied = success((await authority.execute(command, context, false)).result);
  store.collaboration.finish(op.requestId, copied);
  const activity = store.collaboration.query({ projectId: copied.duplication!.projectId }).operations[0];
  assert.deepEqual(new Set(activity.affectedDocumentIds), new Set(Object.values(copied.duplication!.documentIds)));
  assert.equal(activity.projectId, copied.duplication!.projectId); assert.equal(activity.documentId, undefined);
  resultSchema.parse(copied); assert.deepEqual(receipt(command, copied).duplication, copied.duplication);
  const newPartId = copied.duplication!.documentIds[part.documentId], newRootId = copied.duplication!.documentIds[root.documentId];
  const old = success(await execute('inspect_model', { documentId: part.documentId }));
  const initialCopy = success(await execute('inspect_model', { documentId: newPartId }));
  assert.deepEqual(initialCopy.geometry, old.geometry); assert.equal(initialCopy.history!.canUndo, false);
  const changed = success(await execute('apply_edits', { documentId: newPartId, expectedRevision: 0, analyze: false, edits: [{ op: 'update', feature: box(20) }] }));
  assert.equal(changed.revision, 1);
  assert.ok(Math.abs(success(await execute('inspect_model', { documentId: part.documentId })).geometry![0].volumeMm3 - 1000) < 1e-8);
  assert.ok(Math.abs(success(await execute('inspect_model', { documentId: newPartId })).geometry![0].volumeMm3 - 2000) < 1e-8);
  const rootCopy = success(await execute('inspect_model', { documentId: newRootId }));
  assert.equal(rootCopy.instances!.find(i => i.featureId === 'sub')!.documentId, copied.duplication!.documentIds[sub.documentId]);
  const requestId = crypto.randomUUID();
  const single = success(await execute('documents', { action: 'duplicate', documentId: root.documentId, requestId, expectedStorageVersion: 1 }));
  const singleBody = (await store.read(single.createdDocumentId!))!;
  assert.deepEqual(singleBody.document.features, root.features); assert.match(single.warnings.join(' '), /source references/);
  assert.equal(singleBody.history.undo.length, 0);
  const replay = success(await execute('documents', { action: 'duplicate', documentId: root.documentId, requestId, expectedStorageVersion: 1 }));
  assert.equal(replay.replayed, true); assert.equal(replay.createdDocumentId, single.createdDocumentId);
  assert.equal((await execute('documents', { action: 'duplicate', documentId: newPartId, expectedStorageVersion: 1 })).error!.code, 'STORAGE_CONFLICT');
  const source = (await store.read(part.documentId))!;
  await store.put({ ...source.document, name: 'x'.repeat(120) }, source.version);
  const partCopy = success(await execute('documents', { action: 'duplicate', documentId: part.documentId, expectedStorageVersion: 3 }));
  assert.equal((await store.read(partCopy.createdDocumentId!))!.document.name!.length, 120);

  // A second authority can win after the source read but before the new document's conditional write.
  const operation = store.operation.bind(store), raceId = crypto.randomUUID();
  t.mock.method(store, 'operation', async (op: StorageOperation) => {
    if (op.action === 'write' && op.document.documentId === raceId) {
      const winner = (await operation({ action: 'read', documentId: part.documentId })).record!;
      await operation({ action: 'write', document: { ...winner.document, name: 'Won during copy' }, expectedVersion: winner.version, history: winner.history });
    }
    return operation(op);
  });
  assert.equal((await execute('documents', { action: 'duplicate', documentId: part.documentId, expectedStorageVersion: 3, requestId: raceId })).error!.code, 'STORAGE_CONFLICT');
  assert.equal(await store.read(raceId), undefined);
  assert.equal((await store.read(part.documentId))!.document.name, 'Won during copy');
});


test('empty default project duplicates without inventing a document and a conflicting identity never overwrites a project', async () => {
  const store = new MemoryStore(), requestId = crypto.randomUUID();
  const op = { action: 'duplicate_project' as const, projectId: LEGACY_PROJECT_ID, requestId, expectedVersion: 1, documentVersions: {} };
  const copy = await store.operation(op);
  assert.deepEqual(copy.duplication!.documentIds, {}); assert.equal((await store.list()).length, 0);
  await assert.rejects(store.operation({ ...op, requestId: LEGACY_PROJECT_ID }), { code: 'REQUEST_ID_CONFLICT' });
});
