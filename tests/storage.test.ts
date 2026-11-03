import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/bridge/sqlite-store';
import { startBridge } from '../src/bridge/server';
import { CONTRACT_FINGERPRINT } from '../src/bridge/fingerprint';
import { emptyDocument } from '../src/cad/document';
import { emptyHistory } from '../src/cad/store';
import { LEGACY_PROJECT_ID, storageResponseSchema, commandSchemas, commandInputSchema } from '../src/shared/protocol';
import { z } from 'zod';

const doc = () => ({ ...emptyDocument(), name: 'New part', projectId: LEGACY_PROJECT_ID });
async function database(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeworks-step1-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir,'workspace.db');
}

test('SQLite persists documents, creation identity, exact appearance, bounded undo and append-only revisions across reopen', async t => {
  const path = await database(t), a = new SqliteStore(path), d = doc();
  d.creation = { requestId: d.documentId, action: 'create', name: d.name };
  assert.equal(await a.put(d, null), 1);
  const edited = { ...d, revision: 1, features: [{ id: 'body', kind: 'box' as const, params: { origin: [0,0,0] as [number,number,number], size: [10,20,5] as [number,number,number] }, appearance: { material: 'steel' as const } }] };
  assert.equal(await a.put(edited,1,{ undo:[d],redo:[] }),2); a.close();
  const b = new SqliteStore(path); t.after(() => b.close());
  const record = (await b.read(d.documentId))!;
  assert.deepEqual(record.document, edited); assert.deepEqual(record.history.undo,[d]); assert.equal(record.version,2);
  assert.equal((await b.operation({action:'history',documentId:d.documentId})).revisions!.length,2);
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  assert.throws(() => raw.prepare('DELETE FROM revisions WHERE document_id=?').run(d.documentId), /append-only/);
  assert.throws(() => raw.prepare('UPDATE revisions SET revision=0 WHERE document_id=?').run(d.documentId), /append-only/);
});

test('two SQLite connections serialize conditional writes, including same-revision rename and stale deletion; failures emit no history/feed', async t => {
  const path = await database(t), a = new SqliteStore(path), b = new SqliteStore(path); t.after(() => { a.close(); b.close(); });
  const d = doc(); await a.put(d,null);
  const before = (await b.read(d.documentId))!;
  const results = await Promise.allSettled([a.put({...d,name:'A'},1),b.put({...d,name:'B'},1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
  const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejection.reason.code,'STORAGE_CONFLICT');
  await assert.rejects(b.remove(d.documentId,before.version), {code:'STORAGE_CONFLICT'});
  const now = (await a.read(d.documentId))!;
  assert.equal(now.document.revision,0); assert.equal(now.version,2);
  assert.equal((await a.operation({action:'history',documentId:d.documentId})).revisions!.length,2);
  assert.equal((await a.operation({action:'changes',after:0})).changes!.length,2);
  await a.put(doc(),null);
  await a.remove(d.documentId,2);
  await assert.rejects(b.put(d,null),{code:'DOCUMENT_DELETED'});
});

test('projects own documents and a conditional main assembly; instance references and source versions remain transactional', async t => {
  const path = await database(t), a = new SqliteStore(path); t.after(() => a.close());
  const projectId = randomUUID();
  await a.operation({ action:'project', project:{projectId,name:'F1',version:1},expectedVersion:null });
  const part = {...doc(),projectId}; await a.put(part,null);
  const assembly = {...doc(),projectId,kind:'assembly' as const,features:[{ id:'part',kind:'instance' as const,params:{document:part.documentId,translation:[0,0,0] as [number,number,number],rotationAxis:[0,0,1] as [number,number,number],angleDegrees:0,origin:[0,0,0] as [number,number,number]} }]};
  await a.put(assembly,null);
  await a.operation({action:'project',project:{projectId,name:'F1',version:1,mainAssemblyId:assembly.documentId},expectedVersion:1});
  await assert.rejects(a.operation({action:'project',project:{projectId,name:'stale',version:1},expectedVersion:1}),{code:'STORAGE_CONFLICT'});
  await assert.rejects(a.remove(part.documentId,1),{code:'DOCUMENT_IN_USE'});
  await assert.rejects(a.remove(assembly.documentId,1),{code:'MAIN_ASSEMBLY_IN_USE'});
  await assert.rejects(a.put({...assembly,projectId:LEGACY_PROJECT_ID},1),{code:'MAIN_ASSEMBLY_IN_USE'});
  await a.put({...part,name:'Changed source'},1);
  await assert.rejects(a.put({...assembly,revision:1},1,emptyHistory(),{[part.documentId]:1}),{code:'STORAGE_CONFLICT'});
  assert.equal((await a.read(assembly.documentId))!.version,1);
  const listed = await a.operation({action:'list',projectId}); assert.equal(listed.documents!.length,2);
  assert.equal(listed.documents![0].storageVersion! > 0,true);
  await assert.rejects(a.operation({action:'remove_project',projectId,expectedVersion:2}),{code:'PROJECT_IN_USE'});
});

test('durable change feed paginates, resumes after bridge restart and bounds revision listings without pruning audit data', async t => {
  const path = await database(t), a = new SqliteStore(path), d = doc(); let version = await a.put(d,null);
  for (let i=0;i<505;i++) version = await a.put({...d,name:`Name ${i}`},version);
  const first = await a.operation({action:'changes',after:0}); assert.equal(first.changes!.length,500); assert.equal(first.cursor,500); a.close();
  const b = new SqliteStore(path); t.after(() => b.close());
  const second = await b.operation({action:'changes',after:first.cursor!}); assert.equal(second.changes!.length,6); assert.equal(second.cursor,506);
  assert.equal((await b.operation({action:'changes',after:second.cursor!})).changes!.length,0);
  assert.equal((await b.operation({action:'history',documentId:d.documentId})).revisions!.length,40);
  assert.equal((await b.operation({action:'changes',after:1000})).cursor,506);
});

test('storage HTTP works without a geometry browser and enforces authentication, origins, fingerprint and request identity', async t => {
  const path = await database(t), connectionFile = join(path+'-connection.json');
  const bridge = await startBridge({port:0,databasePath:path,connectionFile,log:()=>{}}); t.after(() => bridge.close());
  const call = async (operation: unknown, headers: Record<string,string> = {}) => fetch(bridge.connection.httpUrl+'/storage',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${bridge.connection.token}`,'X-Vibeworks-Fingerprint':CONTRACT_FINGERPRINT,...headers},body:JSON.stringify({requestId:randomUUID(),operation})});
  assert.equal((await call({action:'projects'},{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await call({action:'projects'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await call({action:'projects'},{'X-Vibeworks-Fingerprint':'wrong'})).status,409);
  await bridge.ready();
  const d=doc();assert.equal((await call({action:'write',document:d,expectedVersion:null,history:emptyHistory()})).status,403);
  const listed=storageResponseSchema.parse(await(await call({action:'list'})).json());assert.ok(listed.documents!.length>=1);
  const state=storageResponseSchema.parse(await(await call({action:'read',documentId:listed.documents![0].documentId})).json());assert.equal(state.record!.version,1);
  assert.equal(JSON.parse(await readFile(connectionFile,'utf8')).pid,process.pid);
  const health=await(await fetch(bridge.connection.httpUrl+'/health')).json();assert.equal(health.browserConnected,false);assert.equal(health.diagnosis.kernel.phase,'ready');
});

test('project operations share the common parser and advertised action schema', () => {
  const projectId=randomUUID(), documentId=randomUUID(), advertised=z.fromJSONSchema(commandInputSchema('documents'));
  const inputs=[{action:'create_project',projectId,name:'F1'},{action:'rename_project',projectId,name:'F2',expectedStorageVersion:1},{action:'move',documentId,projectId,expectedStorageVersion:1},{action:'set_main_assembly',projectId,documentId,expectedStorageVersion:1},{action:'history',documentId}];
  for (const input of inputs) { assert.equal(commandSchemas.documents.safeParse(input).success,true); assert.equal(advertised.safeParse(input).success,true); }
  assert.equal(commandSchemas.documents.safeParse({action:'rename',documentId,name:'stale'}).success,false);
  assert.equal(Object.keys(commandSchemas).length,13);
});

test('a failure inside the SQLite transaction rolls back the document, undo data, audit and change feed together', async t => {
  const path = await database(t), store = new SqliteStore(path), raw = new DatabaseSync(path); t.after(() => {raw.close();store.close();});
  const d = doc(); await store.put(d,null);
  raw.exec("CREATE TRIGGER controlled_failure BEFORE INSERT ON revisions WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'controlled audit failure'); END;");
  await assert.rejects(store.put({...d,name:'Must roll back'},1,{undo:[d],redo:[]}),/controlled audit failure/);
  assert.equal((await store.read(d.documentId))!.document.name,d.name); assert.equal((await store.read(d.documentId))!.version,1);
  assert.deepEqual((await store.read(d.documentId))!.history,emptyHistory());
  assert.equal((await store.operation({action:'changes',after:0})).changes!.length,1);
  assert.equal((await store.operation({action:'history',documentId:d.documentId})).revisions!.length,1);
  raw.exec('DROP TRIGGER controlled_failure'); assert.equal(await store.put({...d,name:'Now saved'},1),2);
});

test('populated project removal is atomic, checks the reviewed contents and rejects external references', async t => {
  const store = new SqliteStore(await database(t)); t.after(() => store.close());
  const projectId = randomUUID();
  await store.operation({ action: 'project', project: { projectId, name: 'Disposable', version: 1 }, expectedVersion: null });
  const part = { ...doc(), projectId }; await store.put(part, null);
  const outside = { ...doc(), features: [{ id: 'source', kind: 'instance' as const, params: { document: part.documentId, translation: [0,0,0] as [number,number,number], rotationAxis: [0,0,1] as [number,number,number], angleDegrees: 0, origin: [0,0,0] as [number,number,number] } }] };
  await store.put(outside, null);
  const remove = { action: 'remove_project' as const, projectId, expectedVersion: 1, documentVersions: { [part.documentId]: 1 } };
  await assert.rejects(store.operation(remove), { code: 'DOCUMENT_IN_USE' });
  assert.ok(await store.read(part.documentId));
  await store.remove(outside.documentId, 1);
  await store.put({ ...part, name: 'Changed after preview' }, 1);
  await assert.rejects(store.operation(remove), { code: 'STORAGE_CONFLICT' });
  assert.ok(await store.read(part.documentId));
  await store.operation({ ...remove, documentVersions: { [part.documentId]: 2 } });
  assert.equal(await store.read(part.documentId), undefined);
  assert.equal((await store.operation({ action: 'projects' })).projects!.some(project => project.projectId === projectId), false);
});
