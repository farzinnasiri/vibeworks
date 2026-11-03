import {guardWorkspace,restoreOperation,type OperationRecord} from './operations';
import { ENGINE_VERSION } from '../shared/protocol';
import { freezeGraph, snapshotManifest } from './snapshots';
import type { FrozenGraph, ProjectDuplication } from '../shared/protocol';
import { LEGACY_PROJECT_ID, type CadDocument, type DocumentSummary, type SavedHistory, type StoredDocument, type StorageOperation, type StorageResponse, type Project } from '../shared/protocol';
import { CadError, validateDocument } from './document';
import { assemblyGraph } from './assemblies';

export const DEFAULT_NAME = 'Untitled part';
export const emptyHistory = (): SavedHistory => ({ undo: [], redo: [] });
export function modelDocument(document: CadDocument): CadDocument {
  return { ...structuredClone(document), projectId: document.projectId ?? LEGACY_PROJECT_ID, selectedFeatureIds: [] };
}
export function summarize(document: CadDocument, updatedAt = new Date().toISOString(), storageVersion?: number): Omit<DocumentSummary, 'active'> {
  return { kind: document.features.some(f => f.kind === 'instance') ? 'assembly' : document.kind ?? 'part', documentId: document.documentId, name: document.name ?? DEFAULT_NAME, revision: document.revision, features: document.features.length, projectId: document.projectId ?? LEGACY_PROJECT_ID, updatedAt, ...(storageVersion ? { storageVersion } : {}) };
}
export function conflict(expected: number | null, actual?: number): void {
  if (expected !== (actual ?? null)) throw new CadError('STORAGE_CONFLICT', `Expected storage version ${expected}, current version is ${actual ?? 'absent'}. Read the document again before editing.`, { expectedVersion: expected, actualVersion: actual ?? null });
}
/** Validate a reviewed contents list and all incoming references before deleting anything. */
export function validateProjectRemoval(projectId: string, all: CadDocument[], versions: Record<string, number>, expected?: Record<string, number>): CadDocument[] {
  const contents = all.filter(document => document.projectId === projectId);
  if (!expected && contents.length) throw new CadError('PROJECT_IN_USE', 'Review project contents and supply documentVersions to delete a populated project.');
  expected ??= {};
  const ids = new Set(contents.map(document => document.documentId));
  if (ids.size !== Object.keys(expected).length || contents.some(document => expected[document.documentId] !== versions[document.documentId]))
    throw new CadError('STORAGE_CONFLICT', 'Project contents changed or were not confirmed. List documents and review their storage versions before deleting the project.');
  const references = all.filter(document => !ids.has(document.documentId)).flatMap(document => document.features
    .filter(feature => feature.kind === 'instance' && ids.has(feature.params.document))
    .map(feature => ({ documentId: document.documentId, featureId: feature.id })));
  if (references.length) throw new CadError('DOCUMENT_IN_USE', 'Documents outside this project reference its parts. Remove those references before deleting.', { references });
  return contents;
}

/** Build the complete candidate graph before either store publishes a project copy. */
export function prepareProjectDuplicate(
  op: Extract<StorageOperation, { action: 'duplicate_project' }>, projects: Project[],
  all: CadDocument[], versions: Record<string, number>,
): { project: Project; documents: CadDocument[]; duplication: ProjectDuplication } {
  const source = projects.find(p => p.projectId === op.projectId);
  if (!source) throw new CadError('PROJECT_NOT_FOUND', 'Source project does not exist.');
  conflict(op.expectedVersion, source.version);
  const contents = all.filter(d => (d.projectId ?? LEGACY_PROJECT_ID) === source.projectId);
  if (contents.length !== Object.keys(op.documentVersions).length || contents.some(d => op.documentVersions[d.documentId] !== versions[d.documentId]))
    throw new CadError('STORAGE_CONFLICT', 'Project contents changed. List documents and supply every current storageVersion before duplicating.');
  if (projects.some(p => p.projectId === op.requestId)) throw new CadError('REQUEST_ID_CONFLICT', 'The copy project identity is already in use.');
  const documentIds = Object.fromEntries(contents.map(d => [d.documentId, crypto.randomUUID()]));
  const external = new Set<string>();
  const documents = contents.map(source => {
    const copy = modelDocument(source);
    copy.documentId = documentIds[source.documentId]; copy.projectId = op.requestId; copy.revision = 0;
    delete copy.creation;
    for (const feature of copy.features) if (feature.kind === 'instance') {
      const mapped = documentIds[feature.params.document];
      if (mapped) feature.params.document = mapped;
      else external.add(feature.params.document);
    }
    return copy;
  });
  const project: Project = { projectId: op.requestId, name: op.name ?? copyName(source.name), version: 1,
    ...(source.mainAssemblyId ? { mainAssemblyId: documentIds[source.mainAssemblyId] } : {}) };
  const combined = [...all, ...documents];
  for (const copy of documents) validateStoredWrite(copy, combined, [...projects, project]);
  return { project, documents, duplication: { sourceProjectId: source.projectId, projectId: project.projectId, documentIds, externalDocumentIds: [...external].sort() } };
}
export function copyName(name: string): string { return `${name.slice(0, 115)} copy`; }
/** Sorted versions make request identity independent of object-key ordering. Context is delivery metadata. */
export function projectDuplicateIdentity(op: Extract<StorageOperation, { action: 'duplicate_project' }>): string {
  return JSON.stringify({ projectId: op.projectId, requestId: op.requestId, name: op.name,
    expectedVersion: op.expectedVersion, documentVersions: Object.entries(op.documentVersions).sort(([a], [b]) => a.localeCompare(b)) });
}

/** Validate shared relationships inside the same transaction as the conditional write. */
export function validateStoredWrite(document: CadDocument, all: CadDocument[], projects: Project[]): void {
  validateDocument(document);
  if (!projects.some(p => p.projectId === document.projectId)) throw new CadError('PROJECT_NOT_FOUND', 'The target project does not exist.');
  const docs = [...all.filter(d => d.documentId !== document.documentId), document];
  assemblyGraph(document, docs);
  // An update cannot introduce a cycle/depth error through an existing ancestor.
  const affected = new Set([document.documentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of docs) if (!affected.has(doc.documentId) && doc.features.some(f => f.kind === 'instance' && affected.has(f.params.document))) { affected.add(doc.documentId); changed = true; }
  }
  for (const doc of docs) if (affected.has(doc.documentId)) assemblyGraph(doc, docs);
  for (const p of projects) if (p.mainAssemblyId === document.documentId && (p.projectId !== document.projectId || !(document.kind === 'assembly' || document.features.some(f => f.kind === 'instance'))))
    throw new CadError('MAIN_ASSEMBLY_IN_USE', 'Clear or change the project main assembly before moving it or changing its kind.');
}
export function validateRemoval(id: string, docs: CadDocument[], projects: Project[]): void {
  if (docs.length <= 1) throw new CadError('LAST_DOCUMENT', 'Create another document before deleting the last one.');
  if (docs.some(d => d.features.some(f => f.kind === 'instance' && f.params.document === id))) throw new CadError('DOCUMENT_IN_USE', 'Remove referencing instances before deleting this document.');
  if (projects.some(p => p.mainAssemblyId === id)) throw new CadError('MAIN_ASSEMBLY_IN_USE', 'Choose another main assembly before deleting this document.');
}

/** Conditional model writes, durable history, summaries and a resumable workspace change feed. */
export abstract class DocumentStore {
  async storedOperation(id:string):Promise<import('./operations').OperationRecord|undefined>{return undefined;}
  async persistedSurfaceSelections():Promise<{documentId:string;value:unknown}[]>{return [];}
  private analysisState=new Map<string,import('../bridge/analysis-jobs').SavedJob>();
  private factState=new Map<string,import('./analysis-plan').DurablePair>();
  async analysisRecords():Promise<import('../bridge/analysis-jobs').SavedJob[]>{return structuredClone([...this.analysisState.values()]);}
  async saveAnalysis(id:string,value:import('../bridge/analysis-jobs').SavedJob){this.analysisState.set(id,structuredClone(value));while(this.analysisState.size>64){const oldest=[...this.analysisState].find(([,s])=>!['queued','running'].includes(s.job.state));if(!oldest)break;this.analysisState.delete(oldest[0]);}}
  async pairFacts():Promise<import('./analysis-plan').DurablePair[]>{return structuredClone([...this.factState.values()].slice(-32000));}
  async savePairFact(fact:import('./analysis-plan').DurablePair){this.factState.delete(fact.key);this.factState.set(fact.key,structuredClone(fact));while(this.factState.size>32000)this.factState.delete(this.factState.keys().next().value!);}
  abstract operation(operation: StorageOperation): Promise<Omit<StorageResponse, 'requestId' | 'fingerprint' | 'ok'>>;
  async list() { return (await this.operation({ action: 'list' })).documents!.map(({ active: _, ...summary }) => summary); }
  async read(documentId: string): Promise<StoredDocument | undefined> { return (await this.operation({ action: 'read', documentId })).record; }
  async get(documentId: string) { return (await this.read(documentId))?.document; }
  /** One stored body and its version, without undo history. Read-only. */
  async body(documentId: string): Promise<{ document: CadDocument; version: number } | undefined> {
    return (await this.operation({ action: 'body', documentId })).body;
  }
  /** Every stored document body, for reference scans. Read-only; SQLite serves parsed bodies from a version cache. */
  async bodies(): Promise<CadDocument[]> {
    const documents = await Promise.all((await this.list()).map(summary => this.get(summary.documentId)));
    return documents.filter((document): document is CadDocument => !!document);
  }
  async put(document: CadDocument, expectedVersion: number | null = null, history = emptyHistory(), references?: Record<string, number>) {
    return (await this.operation({ action: 'write', document: modelDocument(document), expectedVersion, history: { undo: history.undo.map(modelDocument), redo: history.redo.map(modelDocument) }, ...(references ? { references } : {}) })).version!;
  }
  async remove(documentId: string, expectedVersion: number) { await this.operation({ action: 'remove', documentId, expectedVersion }); }
  // These are client preferences; persistent implementations override them with tab-local storage.
  private preferences = new Map<string, string>();
  async getPreference(key: string) { return this.preferences.get(key); }
  async setPreference(key: string, value: string) { this.preferences.set(key, value); }
}

/** Test adapter with the same conditional semantics as SQLite. */
export class MemoryStore extends DocumentStore {
  override async storedOperation(id:string){return structuredClone(this.operationRecords.get(id));}
  private operationRecords=new Map<string,OperationRecord>();
  private duplications = new Map<string, { identity: string; duplication: ProjectDuplication }>();
  private snapshots = new Map<string,FrozenGraph>();
  private definitions = new Map<string,StoredDocument>();
  private documents = new Map<string, StoredDocument>();
  private projects: Project[] = [{ projectId: LEGACY_PROJECT_ID, name: 'My project', version: 1 }];
  private changes: NonNullable<StorageResponse['changes']> = [];
  private revisions = new Map<string, NonNullable<StorageResponse['revisions']>>();
  peek(id: string) { return structuredClone(this.documents.get(id)?.document); }
  async operation(op: StorageOperation) {
    const records = () => [...this.documents.values()].map(r => r.document);
    const event = (documentId: string | undefined, projectId: string | undefined, version: number, deleted = false) => this.changes.push({ sequence: this.changes.length + 1, documentId, projectId, version, deleted });
    switch (op.action) {
      case 'operation_request': {const record=this.operationRecords.get(op.requestId);return {batchReceipt:record?{...structuredClone(record.receipt),identity:record.identity}:undefined};}
      case 'operation_history': {
        const saved=this.operationRecords.get(op.operationId);if(!saved)throw new CadError('OPERATION_NOT_FOUND','Operation is not stored.');
        if(op.guards)guardWorkspace(op.guards,[...this.documents.values()]);
        const documents=restoreOperation(saved,op.direction,[...this.documents.values()]);
        const all=[...records().filter(d=>!documents.some(x=>x.documentId===d.documentId)),...documents];for(const d of documents)validateStoredWrite(d,all,this.projects);
        for(const document of documents){const prior=this.documents.get(document.documentId)!,version=prior.version+1,updatedAt=new Date().toISOString(),record={document,version,updatedAt,history:structuredClone((op.direction==='undo'?saved.before:saved.after).find(r=>r.document.documentId===document.documentId)!.history)};this.documents.set(document.documentId,record);this.definitions.set(document.documentId+':'+version,structuredClone(record));this.revisions.set(document.documentId,[...(this.revisions.get(document.documentId)??[]),{version,revision:document.revision,updatedAt}]);event(document.documentId,document.projectId,version);saved.versions[document.documentId]=version;}
        saved.state=op.direction==='undo'?'undone':'applied';return {batchReceipt:{...saved.receipt,retainedDocumentId:saved.createdIds[0],state:saved.state}};
      }
      case 'batch': {
        const prior=this.operationRecords.get(op.requestId);if(prior){if(prior.identity!==op.identity)throw new CadError('REQUEST_ID_CONFLICT','Extraction requestId has different arguments.');return {batchReceipt:structuredClone(prior.receipt),replayed:true};}
        guardWorkspace(op.guards,[...this.documents.values()]);
        for(const document of op.creates)if(this.documents.has(document.documentId)||this.revisions.has(document.documentId))throw new CadError('REQUEST_ID_CONFLICT','Created identity is already used.');
        const all=[...records().filter(d=>!op.writes.some(w=>w.document.documentId===d.documentId)),...op.creates,...op.writes.map(w=>w.document)];for(const d of[...op.creates,...op.writes.map(w=>w.document)])validateStoredWrite(d,all,this.projects);
        const before=op.writes.map(w=>structuredClone(this.documents.get(w.document.documentId)!));
        for(const write of [...op.creates.map(document=>({document,history:emptyHistory()})),...op.writes]){const document=modelDocument(write.document),version=(this.documents.get(document.documentId)?.version??0)+1,updatedAt=new Date().toISOString(),record={document,version,updatedAt,history:structuredClone(write.history)};this.documents.set(document.documentId,record);this.definitions.set(document.documentId+':'+version,structuredClone(record));this.revisions.set(document.documentId,[...(this.revisions.get(document.documentId)??[]),{version,revision:document.revision,updatedAt}]);event(document.documentId,document.projectId,version);}
        const after=[...op.creates,...op.writes.map(w=>w.document)].map(d=>structuredClone(this.documents.get(d.documentId)!));this.operationRecords.set(op.requestId,{identity:op.identity,receipt:structuredClone(op.receipt),before,after,versions:Object.fromEntries(after.map(r=>[r.document.documentId,r.version])),createdIds:op.creates.map(d=>d.documentId),state:'applied'});return {batchReceipt:op.receipt};
      }

      case 'duplicate_project': {
        const identity = projectDuplicateIdentity(op), prior = this.duplications.get(op.requestId);
        if (prior) {
          if (prior.identity !== identity) throw new CadError('REQUEST_ID_CONFLICT', 'This requestId belongs to different project duplication arguments.');
          if (!this.projects.some(p => p.projectId === op.requestId)) throw new CadError('PROJECT_DELETED', 'The copied project was deleted.');
          return { duplication: structuredClone(prior.duplication), replayed: true };
        }
        if (this.changes.some(c => !c.documentId && c.projectId === op.requestId)) throw new CadError('PROJECT_DELETED', 'This project identity was deleted.');
        const copy = prepareProjectDuplicate(op, this.projects, records(), Object.fromEntries([...this.documents].map(([id, r]) => [id, r.version])));
        // All checks happen above. Publish the prepared bodies/history/feed without awaits.
        this.projects.push(copy.project); event(undefined, copy.project.projectId, 1);
        for (const document of copy.documents) {
          const updatedAt = new Date().toISOString(), record = { document, history: emptyHistory(), version: 1, updatedAt };
          this.documents.set(document.documentId, record);
          this.definitions.set(document.documentId + ':1', structuredClone(record));
          this.revisions.set(document.documentId, [{ version: 1, revision: 0, updatedAt }]);
          event(document.documentId, copy.project.projectId, 1);
        }
        this.duplications.set(op.requestId, { identity, duplication: copy.duplication });
        return { duplication: structuredClone(copy.duplication) };
      }
      case 'snapshot': {
        if(op.snapshot?.id){const graph=this.snapshots.get(op.snapshot.id);if(!graph||graph.document.documentId!==op.documentId)throw new CadError('SNAPSHOT_NOT_FOUND','Snapshot is not in this workspace.');if(graph.snapshot.engineVersion!==ENGINE_VERSION&&!op.snapshot.reevaluate)throw new CadError('SNAPSHOT_ENGINE','Explicit snapshot.reevaluate:true is required to evaluate old definitions with this engine.');return {graph:structuredClone(graph)};}
        const cursor=op.snapshot?.sequence??this.changes.length;
        if(cursor>this.changes.length)throw new CadError('HISTORY_SEQUENCE','Change sequence does not exist.');
        const graph=freezeGraph(op.documentId,id=>{const change=this.changes.filter(c=>c.documentId===id&&c.sequence<=cursor).at(-1);if(!change||change.deleted)return;const record=this.definitions.get(id+':'+change.version);return record?{document:record.document,version:record.version}:undefined;},cursor);
        const key=snapshotManifest(graph),saved=[...this.snapshots.values()].find(g=>snapshotManifest(g)===key)??graph;
        this.snapshots.set(saved.snapshot.snapshotId,saved);return {graph:structuredClone(saved)};
      }
      case 'list': return { documents: [...this.documents.values()].filter(r => !op.projectId || r.document.projectId === op.projectId).map(r => ({ ...summarize(r.document, r.updatedAt, r.version), active: false })).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) };
      case 'read': return { record: structuredClone(this.documents.get(op.documentId)) };
      case 'body': { const record = this.documents.get(op.documentId); return { body: record && { document: structuredClone(record.document), version: record.version } }; }
      case 'projects': return { projects: structuredClone(this.projects) };
      case 'changes': { const changes = this.changes.filter(c => c.sequence > op.after).slice(0,500); return { changes: structuredClone(changes), cursor: changes.at(-1)?.sequence ?? Math.min(op.after, this.changes.length) }; }
      case 'history': return { revisions: structuredClone((this.revisions.get(op.documentId) ?? []).slice(-40).reverse()) };
      case 'write': {
        const prior = this.documents.get(op.document.documentId); conflict(op.expectedVersion, prior?.version);
        if (!prior && this.revisions.has(op.document.documentId)) throw new CadError('DOCUMENT_DELETED', 'This document identity was deleted. Create a new identity.');
        if (prior && JSON.stringify(prior.document.creation) !== JSON.stringify(op.document.creation)) throw new CadError('CREATION_IMMUTABLE', 'Creation identity cannot be changed.');
        if (prior && op.document.revision < prior.document.revision) throw new CadError('REVISION_CONFLICT', 'Document revisions cannot go backward.');
        for (const [id, version] of Object.entries(op.references ?? {})) conflict(version, this.documents.get(id)?.version);
        const document = modelDocument(op.document); validateStoredWrite(document, records(), this.projects);
        const version = (prior?.version ?? 0) + 1, updatedAt = new Date().toISOString();
        const record = { document, history: structuredClone(op.history), version, updatedAt };
        this.documents.set(document.documentId, record);
        this.definitions.set(document.documentId+':'+version,structuredClone(record));
        this.revisions.set(document.documentId, [...(this.revisions.get(document.documentId) ?? []), { version, revision: document.revision, updatedAt }]);
        event(document.documentId, document.projectId, version); return { version };
      }
      case 'remove': {
        const prior = this.documents.get(op.documentId); conflict(op.expectedVersion, prior?.version); validateRemoval(op.documentId, records(), this.projects);
        this.documents.delete(op.documentId); event(op.documentId, prior?.document.projectId, op.expectedVersion + 1, true); return {};
      }
      case 'project': {
        const prior = this.projects.find(p => p.projectId === op.project.projectId); conflict(op.expectedVersion, prior?.version);
        if (!prior && this.changes.some(c => !c.documentId && c.projectId === op.project.projectId)) throw new CadError('PROJECT_DELETED', 'This project identity was deleted. Create a new identity.');
        const project = { ...op.project, version: (prior?.version ?? 0) + 1 };
        if (project.mainAssemblyId) {
          const doc = this.documents.get(project.mainAssemblyId)?.document;
          if (!doc || doc.projectId !== project.projectId || !(doc.kind === 'assembly' || doc.features.some(f => f.kind === 'instance'))) throw new CadError('INVALID_MAIN_ASSEMBLY', 'Main assembly must be an assembly in this project.');
        }
        this.projects = [...this.projects.filter(p => p.projectId !== project.projectId), project]; event(undefined, project.projectId, project.version); return { projects: structuredClone(this.projects) };
      }
      case 'remove_project': {
        conflict(op.expectedVersion, this.projects.find(p => p.projectId === op.projectId)?.version);
        const contents = validateProjectRemoval(op.projectId, records(), Object.fromEntries([...this.documents].map(([id, record]) => [id, record.version])), op.documentVersions);
        for (const document of contents) { const version = this.documents.get(document.documentId)!.version; this.documents.delete(document.documentId); event(document.documentId, op.projectId, version + 1, true); }
        this.projects = this.projects.filter(p => p.projectId !== op.projectId); event(undefined, op.projectId, op.expectedVersion + 1, true); return {};
      }
    }
  }
}
