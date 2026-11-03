import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentSummary, Project } from '../src/shared/protocol';
import { projectCatalog, projectDocument, sortProjects } from '../src/web/projects';

const project = (projectId: string, name: string, mainAssemblyId?: string): Project => ({ projectId, name, version: 1, mainAssemblyId });
const document = (documentId: string, projectId: string, updatedAt: string, kind: 'part' | 'assembly' = 'part'): DocumentSummary => ({ documentId, projectId, updatedAt, kind, name: documentId, features: 1, revision: 1, active: false });

test('project opening prefers its own main assembly, otherwise the last updated document', () => {
  const main = document('main', 'a', '2026-10-20T10:00:00Z', 'assembly');
  const recent = document('recent', 'a', '2026-10-27T10:00:00Z');
  const foreign = document('foreign', 'b', '2026-10-28T10:00:00Z', 'assembly');
  const contents = [main, recent, foreign];
  assert.equal(projectDocument(project('a', 'A', 'main'), contents), main);
  assert.equal(projectDocument(project('a', 'A'), contents), recent);
  assert.equal(projectDocument(project('a', 'A', 'foreign'), contents), recent);
  assert.equal(projectDocument(project('empty', 'Empty'), contents), undefined);
  assert.deepEqual(contents, [main, recent, foreign], 'Opening and sorting must not mutate the runtime catalog');
});

test('recent projects use document updates; all sort orders handle empty projects and names', () => {
  const projects = [project('a', 'Beta'), project('b', 'Alpha'), project('c', 'Empty')];
  const docs = [document('a1', 'a', '2026-10-20T10:00:00Z'), document('a2', 'a', '2026-10-27T10:00:00Z', 'assembly'), document('b1', 'b', '2026-10-26T10:00:00Z')];
  const catalog = projectCatalog(projects, docs);
  assert.equal(catalog[0].updatedAt, docs[1].updatedAt);
  assert.equal(catalog[0].parts, 1); assert.equal(catalog[0].assemblies, 1);
  assert.equal(catalog[2].updatedAt, undefined);
  const ids = (order: Parameters<typeof sortProjects>[1]) => sortProjects(catalog, order).map(p => p.projectId);
  assert.deepEqual(ids('newest'), ['a', 'b', 'c']);
  assert.deepEqual(ids('oldest'), ['b', 'a', 'c']);
  assert.deepEqual(ids('az'), ['b', 'a', 'c']);
  assert.deepEqual(ids('za'), ['c', 'a', 'b']);
  assert.deepEqual(catalog.map(p => p.projectId), ['a', 'b', 'c']);
});
