import {guardWorkspace,restoreOperation,type OperationRecord} from '../cad/operations';
import {createHash} from 'node:crypto';
import { normalizeGraphicAssets } from '../shared/graphic-assets';
import { PreparedDisplayCache } from './prepared-display-cache';
import { WorkspaceViews } from './workspace-views';
import { Collaboration } from './collaboration';
import { freezeGraph, snapshotManifest } from '../cad/snapshots';
import { ENGINE_VERSION, type FrozenGraph } from '../shared/protocol';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { LEGACY_PROJECT_ID, projectSchema, storedDocumentSchema, storageOperationSchema, type CadDocument, type Project, type StorageOperation, type StorageResponse, type StoredDocument } from '../shared/protocol.ts';
import { DocumentStore, conflict, modelDocument, summarize, validateRemoval, validateProjectRemoval, validateStoredWrite, prepareProjectDuplicate, projectDuplicateIdentity, emptyHistory } from '../cad/store.ts';
import { CadError } from '../cad/document.ts';

const ANALYZING = new Set(['analyze_model', 'render_views', 'export_model']);
export function defaultDatabasePath(): string {
  return process.env.VIBEWORKS_DB_PATH ?? join(homedir(), ...(process.platform === 'darwin' ? ['Library', 'Application Support', 'Vibeworks'] : ['.local', 'share', 'Vibeworks']), 'vibeworks.db');
}
/** SQLite alone owns durable state. Every mutation, audit entry and feed entry shares one transaction. */
export class SqliteStore extends DocumentStore {
  private db: DatabaseSync;
  readonly collaboration: Collaboration;
  readonly preparedDisplay: PreparedDisplayCache;
  readonly workspaceViews: WorkspaceViews;
  constructor(readonly path = defaultDatabasePath(), options:{allowMigration?:boolean}={}) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_schema'").get();
    const oldVersion=fresh?undefined:Number(this.db.prepare('SELECT version FROM workspace_schema').get()!.version);
    if(oldVersion!==undefined&&oldVersion!==1&&oldVersion!==2){this.db.close();throw new Error('Unsupported SQLite workspace version.');}
    let backup:string|undefined;
    if(oldVersion===1){
      if(!options.allowMigration&&process.env.VIBEWORKS_ALLOW_V2_MIGRATION!=='1'){this.db.close();throw new CadError('WORKSPACE_MIGRATION_CONSENT_REQUIRED','Opening this v1 workspace requires an explicit v2 migration opt-in. A full VACUUM INTO backup is mandatory before upgrading.');}
      backup=`${path}.pre-v2-${Date.now()}-${crypto.randomUUID()}`;
      try{this.db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);}
      catch(error){this.db.close();throw new Error(`Workspace migration backup failed. No schema upgrade was applied: ${String(error)}`);}
    }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,mime TEXT NOT NULL,width INTEGER,height INTEGER,bytes INTEGER NOT NULL,body BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_schema(version INTEGER NOT NULL);
      INSERT INTO workspace_schema SELECT 2 WHERE NOT EXISTS(SELECT 1 FROM workspace_schema);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, main_assembly TEXT);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL, features INTEGER NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL, history TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_project_updated ON documents(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL, version INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(document_id,version));
      CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT, project_id TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'revision history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'revision history is append-only'); END;`);
    if(oldVersion===1)this.db.exec('UPDATE workspace_schema SET version=2');
    if ((this.db.prepare('SELECT version FROM workspace_schema').get() as { version: number }).version !== 2) { this.db.close(); throw new Error('Unsupported SQLite workspace version.'); }
    // A starter is an ordinary deletable project, created once, never resurrected on reconnect.
    if (fresh) this.db.prepare('INSERT INTO projects(id,name,version) VALUES(?,?,1)').run(LEGACY_PROJECT_ID, 'My project');
    this.db.exec('CREATE TABLE IF NOT EXISTS project_duplications(id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS graph_snapshots(id TEXT PRIMARY KEY, manifest TEXT NOT NULL UNIQUE, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS operation_requests(id TEXT PRIMARY KEY,identity TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operation_documents(operation_id TEXT NOT NULL,document_id TEXT NOT NULL,before_version INTEGER,after_version INTEGER NOT NULL,PRIMARY KEY(operation_id,document_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS analysis_graphs(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pair_facts(key TEXT PRIMARY KEY,body TEXT NOT NULL,used_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS analysis_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at INTEGER NOT NULL)');
    this.db.exec('CREATE INDEX IF NOT EXISTS pair_facts_lru ON pair_facts(used_at); CREATE INDEX IF NOT EXISTS analysis_jobs_updated ON analysis_jobs(updated_at)');
    this.preparedDisplay = new PreparedDisplayCache(this.db);
    this.collaboration = new Collaboration(this.db, undefined, () => this.documents());
    this.workspaceViews = new WorkspaceViews(this.db, id => this.documents().find(d=>d.documentId===id));
  }
  override async analysisRecords(){return this.db.prepare('SELECT body FROM analysis_jobs ORDER BY updated_at').all().map(r=>{const saved=JSON.parse(String(r.body));if(!saved.graph){const graph=this.db.prepare('SELECT body FROM analysis_graphs WHERE id=?').get(saved.graphId);if(!graph)throw new CadError('ANALYSIS_STORAGE','Pinned analysis graph is missing.');saved.graph=JSON.parse(String(graph.body));}delete saved.graphId;return saved as import('./analysis-jobs').SavedJob;});}
  override async saveAnalysis(id:string,value:import('./analysis-jobs').SavedJob){
    const graphId=value.graph.snapshot.snapshotId;
    if(!this.db.prepare('SELECT 1 FROM analysis_graphs WHERE id=?').get(graphId))this.db.prepare('INSERT INTO analysis_graphs VALUES(?,?)').run(graphId,JSON.stringify(value.graph));
    const {graph,...saved}=value;
    this.db.prepare('INSERT OR REPLACE INTO analysis_jobs VALUES(?,?,?)').run(id,JSON.stringify({...saved,graphId}),Date.now());
    this.db.prepare("DELETE FROM analysis_jobs WHERE id IN (SELECT id FROM analysis_jobs WHERE json_extract(body,'$.job.state') NOT IN ('queued','running') ORDER BY updated_at DESC LIMIT -1 OFFSET 64)").run();
    this.db.prepare("DELETE FROM analysis_graphs WHERE id NOT IN (SELECT json_extract(body,'$.graphId') FROM analysis_jobs WHERE json_extract(body,'$.graphId') IS NOT NULL)").run();
  }
  override async pairFacts(){return this.db.prepare('SELECT body FROM pair_facts ORDER BY used_at DESC LIMIT 32000').all().map(r=>JSON.parse(String(r.body)) as import('../cad/analysis-plan').DurablePair);}
  override async savePairFact(fact:import('../cad/analysis-plan').DurablePair){const key=createHash('sha256').update(fact.key).digest('hex');this.db.prepare('INSERT OR REPLACE INTO pair_facts VALUES(?,?,?)').run(key,JSON.stringify(fact),Date.now());this.db.prepare('DELETE FROM pair_facts WHERE key IN (SELECT key FROM pair_facts ORDER BY used_at DESC LIMIT -1 OFFSET 1000000)').run();}
  graphicAsset(hash:string){const row=this.db.prepare('SELECT * FROM assets WHERE hash=?').get(hash);return row?{mime:String(row.mime),bytes:Number(row.bytes),width:row.width===null?undefined:Number(row.width),height:row.height===null?undefined:Number(row.height),base64:Buffer.from(row.body as Uint8Array).toString('base64')}:undefined;}
  override async storedOperation(id:string){const row=this.db.prepare('SELECT body FROM operation_requests WHERE id=?').get(id);return row?JSON.parse(String(row.body)) as OperationRecord:undefined;}
  override async persistedSurfaceSelections(){const table=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='surface_selections'").get();return table?this.db.prepare("SELECT document,body FROM surface_selections WHERE body!='[]'").all().map(r=>({documentId:String(r.document),value:JSON.parse(String(r.body))})):[];}
  surfaceSelection(client:string,documentId:string,value?:unknown){
    this.db.exec('CREATE TABLE IF NOT EXISTS surface_selections(client TEXT NOT NULL,document TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(client,document))');
    if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO surface_selections VALUES(?,?,?)').run(client,documentId,JSON.stringify(value));
    const row=this.db.prepare('SELECT body FROM surface_selections WHERE client=? AND document=?').get(client,documentId);return row?JSON.parse(String(row.body)):[];
  }
  close() { this.db.close(); }
  storageBytes():number {
    if(this.path===':memory:')return Number(this.db.prepare('PRAGMA page_count').get()!.page_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    return [this.path,this.path+'-wal',this.path+'-shm'].reduce((total,path)=>{try{return total+statSync(path).size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return total;throw error;}},0);
  }
  /**
   * A cheap check for viewers: the workspace change cursor, plus the latest finished work in the project that can
   * change health without a write (analysis runs inside analyze/render/export). Bounded to recent operations.
   */
  probe(projectId?: string): { changes: number; work: number } {
    const changes = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get()!.n);
    const recent = projectId ? this.db.prepare("SELECT sequence,body FROM operations WHERE project_id=? AND status='success' ORDER BY sequence DESC LIMIT 64").all(projectId) : [];
    const analyzed = recent.find(row => ANALYZING.has(String(JSON.parse(String(row.body)).operation)));
    return { changes, work: analyzed ? Number(analyzed.sequence) : 0 };
  }
  private projects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name,id').all().map(r => projectSchema.parse({ projectId: r.id, name: r.name, version: r.version, ...(r.main_assembly ? { mainAssemblyId: r.main_assembly } : {}) }));
  }
  /**
   * Parsed bodies and records keyed by storage version. Versions only grow, and every process writes through
   * SQLite, so a matching version is the same content; callers receive copies of records.
   */
  private parsedBodies = new Map<string, { version: number; document: CadDocument }>();
  private records = new Map<string, { version: number; record: StoredDocument }>();
  /** Every document body, parsed once per version. Read-only: shared by validation and attribution. */
  documents(): CadDocument[] {
    const rows = this.db.prepare('SELECT id,version FROM documents').all();
    const live = new Set<string>();
    const documents = rows.map(row => {
      const id = String(row.id), version = Number(row.version);
      live.add(id);
      let cached = this.parsedBodies.get(id);
      if (cached?.version !== version) {
        const body = this.db.prepare('SELECT body FROM documents WHERE id=?').get(id)!;
        this.parsedBodies.set(id, cached = { version, document: JSON.parse(String(body.body)) });
      }
      return cached.document;
    });
    for (const id of this.parsedBodies.keys()) if (!live.has(id)) this.parsedBodies.delete(id);
    return documents;
  }
  override async bodies(): Promise<CadDocument[]> { return this.documents(); }
  private currentBody(id: string): { document: CadDocument; version: number } | undefined {
    const row = this.db.prepare('SELECT version FROM documents WHERE id=?').get(id);
    if (!row) return undefined;
    const version = Number(row.version);
    let cached = this.parsedBodies.get(id);
    if (cached?.version !== version) {
      const body = this.db.prepare('SELECT body FROM documents WHERE id=?').get(id)!;
      this.parsedBodies.set(id, cached = { version, document: JSON.parse(String(body.body)) });
    }
    return { document: structuredClone(cached.document), version };
  }
  private record(id: string): StoredDocument | undefined {
    const current = this.db.prepare('SELECT version FROM documents WHERE id=?').get(id);
    if (!current) { this.records.delete(id); return undefined; }
    let cached = this.records.get(id);
    if (cached?.version !== Number(current.version)) {
      const row = this.db.prepare('SELECT body,version,history,updated_at FROM documents WHERE id=?').get(id)!;
      cached = { version: Number(row.version), record: storedDocumentSchema.parse({ document: JSON.parse(String(row.body)), version: row.version, history: JSON.parse(String(row.history)), updatedAt: row.updated_at }) };
      this.records.set(id, cached);
      if (this.records.size > 128) this.records.delete(this.records.keys().next().value!);
    }
    return structuredClone(cached.record);
  }
  async operation(input: StorageOperation): Promise<Omit<StorageResponse, 'requestId' | 'fingerprint' | 'ok'>> {
    const op = storageOperationSchema.parse(input);
    if(op.action==='write')await normalizeGraphicAssets(op.document);
    // BEGIN IMMEDIATE serializes read/check/write against other bridge processes too.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.execute(op); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private snapshot(documentId:string,request:{id?:string;sequence?:number;reevaluate?:true}={},versions?:Record<string,number>):FrozenGraph {
    if(request.id){
      const row=this.db.prepare('SELECT body FROM graph_snapshots WHERE id=?').get(request.id);
      if(!row)throw new CadError('SNAPSHOT_NOT_FOUND','Frozen graph is not in this workspace. Start playback again.');
      const saved=JSON.parse(String(row.body)) as FrozenGraph['snapshot'];
      if(saved.documentId!==documentId)throw new CadError('SNAPSHOT_DOCUMENT','Snapshot belongs to another document.');
      if(saved.engineVersion!==ENGINE_VERSION&&!request.reevaluate)throw new CadError('SNAPSHOT_ENGINE','This snapshot was authored with another exact engine. Explicitly request snapshot.reevaluate:true to evaluate its definitions with the current engine. Original evidence is not transferred.',{authoredEngine:saved.engineVersion,currentEngine:ENGINE_VERSION});
      const load=(id:string,version:number)=>{const r=this.db.prepare('SELECT body FROM revisions WHERE document_id=? AND version=?').get(id,version);if(!r)throw new CadError('SNAPSHOT_SOURCE_MISSING','A frozen definition is missing.');return JSON.parse(String(r.body));};
      return {snapshot:saved,document:load(documentId,saved.storageVersion),documents:saved.sources.map(r=>load(r.documentId,r.storageVersion))};
    }
    const latest=Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get()!.n),cursor=request.sequence??latest;
    if(cursor>latest)throw new CadError('HISTORY_SEQUENCE','The requested change sequence does not exist.');
    const graph=freezeGraph(documentId,id=>{
      const explicit=versions?.[id];
      if(explicit){const row=this.db.prepare('SELECT body FROM revisions WHERE document_id=? AND version=?').get(id,explicit);return row?{document:JSON.parse(String(row.body)),version:explicit}:undefined;}
      const change=this.db.prepare('SELECT version,deleted FROM changes WHERE document_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(id,cursor);
      if(!change || change.deleted)return undefined;
      const row=this.db.prepare('SELECT body FROM revisions WHERE document_id=? AND version=?').get(id,change.version as number);return row?{document:JSON.parse(String(row.body)),version:Number(change.version)}:undefined;
    },cursor);
    const manifest=snapshotManifest(graph),existing=this.db.prepare('SELECT id FROM graph_snapshots WHERE manifest=?').get(manifest);
    if(existing)return this.snapshot(documentId,{id:String(existing.id)});
    this.db.prepare('INSERT INTO graph_snapshots VALUES(?,?,?)').run(graph.snapshot.snapshotId,manifest,JSON.stringify(graph.snapshot));return graph;
  }
  private event(documentId: string | null, projectId: string | null, version: number, deleted = false) {
    this.db.prepare('INSERT INTO changes(document_id,project_id,version,deleted) VALUES(?,?,?,?)').run(documentId, projectId, version, deleted ? 1 : 0);
    return Number(this.db.prepare('SELECT last_insert_rowid() AS n').get()!.n);
  }
  private publishRecord(document:CadDocument,history:import('../shared/protocol').SavedHistory,context?:import('../shared/protocol').OperationContext,references?:Record<string,number>){
    const prior=this.record(document.documentId);
        const version = (prior?.version ?? 0) + 1, updatedAt = new Date().toISOString(), summary = summarize(document, updatedAt, version);
        for(const [hash,asset] of Object.entries(document.graphicAssets??{}))this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?)').run(hash,asset.mime,asset.width??null,asset.height??null,asset.bytes,Buffer.from(asset.base64,'base64'),updatedAt);
        const body = JSON.stringify(document), historyBody = JSON.stringify({ undo: history.undo.map(modelDocument), redo: history.redo.map(modelDocument) });
        this.db.prepare(`INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,kind=excluded.kind,revision=excluded.revision,version=excluded.version,features=excluded.features,updated_at=excluded.updated_at,body=excluded.body,history=excluded.history`).run(document.documentId, document.projectId!, summary.name, summary.kind!, document.revision, version, summary.features, updatedAt, body, historyBody);
        this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(document.documentId, version, document.revision, updatedAt, body);
        const sequence=this.event(document.documentId, document.projectId!, version);
        if(context){const graph=this.snapshot(document.documentId,{},references);this.collaboration.committed(context,document.documentId,document.projectId!,prior?.version,version,document.revision,sequence,references??{},graph.snapshot.snapshotId);}
        return { version };
  }
  private execute(op: StorageOperation): Omit<StorageResponse, 'requestId' | 'fingerprint' | 'ok'> {
    if ('context' in op) this.collaboration.validate(op.context);
    switch (op.action) {
      case 'operation_request':{const row=this.db.prepare('SELECT identity,body FROM operation_requests WHERE id=?').get(op.requestId);return {batchReceipt:row?{...(JSON.parse(String(row.body)) as OperationRecord).receipt,identity:String(row.identity)}:undefined};}
      case 'operation_history':{
        const row=this.db.prepare('SELECT body FROM operation_requests WHERE id=?').get(op.operationId);if(!row)throw new CadError('OPERATION_NOT_FOUND','Operation is not stored.');const saved=JSON.parse(String(row.body)) as OperationRecord;
        const records=this.documents().map(d=>this.record(d.documentId)!);if(op.guards)guardWorkspace(op.guards,records);const documents=restoreOperation(saved,op.direction,records),all=[...this.documents().filter(d=>!documents.some(x=>x.documentId===d.documentId)),...documents];for(const d of documents)validateStoredWrite(d,all,this.projects());
        for(const d of documents){const history=(op.direction==='undo'?saved.before:saved.after).find(r=>r.document.documentId===d.documentId)!.history;const result=this.publishRecord(d,history,op.context);saved.versions[d.documentId]=result.version!;}
        saved.state=op.direction==='undo'?'undone':'applied';this.db.prepare('UPDATE operation_requests SET body=? WHERE id=?').run(JSON.stringify(saved),op.operationId);return {batchReceipt:{...saved.receipt,state:saved.state,retainedDocumentId:saved.createdIds[0]}};
      }
      case 'batch':{
        const prior=this.db.prepare('SELECT identity,body FROM operation_requests WHERE id=?').get(op.requestId);if(prior){if(prior.identity!==op.identity)throw new CadError('REQUEST_ID_CONFLICT','Extraction requestId has different arguments.');return {batchReceipt:(JSON.parse(String(prior.body)) as OperationRecord).receipt,replayed:true};}
        const records=this.documents().map(d=>this.record(d.documentId)!);guardWorkspace(op.guards,records);
        for(const d of op.creates)if(this.db.prepare('SELECT 1 FROM revisions WHERE document_id=?').get(d.documentId))throw new CadError('REQUEST_ID_CONFLICT','Created identity already used.');
        const all=[...this.documents().filter(d=>!op.writes.some(w=>w.document.documentId===d.documentId)),...op.creates,...op.writes.map(w=>w.document)];for(const d of[...op.creates,...op.writes.map(w=>w.document)])validateStoredWrite(d,all,this.projects());
        const before=op.writes.map(w=>this.record(w.document.documentId)!);
        // Publish every body first, then record provenance against the complete candidate graph.
        for(const w of[...op.creates.map(document=>({document,history:emptyHistory()})),...op.writes])this.publishRecord(modelDocument(w.document),w.history);
        const after=[...op.creates,...op.writes.map(w=>w.document)].map(d=>this.record(d.documentId)!);
        for(const r of after){this.db.prepare('INSERT INTO operation_documents VALUES(?,?,?,?)').run(op.requestId,r.document.documentId,before.find(b=>b.document.documentId===r.document.documentId)?.version??null,r.version);if(op.context){const graph=this.snapshot(r.document.documentId);const sequence=Number(this.db.prepare('SELECT MAX(sequence) AS n FROM changes WHERE document_id=?').get(r.document.documentId)!.n);this.collaboration.committed(op.context,r.document.documentId,r.document.projectId!,before.find(b=>b.document.documentId===r.document.documentId)?.version,r.version,r.document.revision,sequence,op.guards,graph.snapshot.snapshotId);}}
        const saved:OperationRecord={identity:op.identity,receipt:op.receipt,before,after,versions:Object.fromEntries(after.map(r=>[r.document.documentId,r.version])),createdIds:op.creates.map(d=>d.documentId),state:'applied'};this.db.prepare('INSERT INTO operation_requests VALUES(?,?,?)').run(op.requestId,op.identity,JSON.stringify(saved));return {batchReceipt:op.receipt};
      }

      case 'duplicate_project': {
        const identity = projectDuplicateIdentity(op), prior = this.db.prepare('SELECT identity,result FROM project_duplications WHERE id=?').get(op.requestId);
        if (prior) {
          if (prior.identity !== identity) throw new CadError('REQUEST_ID_CONFLICT', 'This requestId belongs to different project duplication arguments.');
          if (!this.projects().some(p => p.projectId === op.requestId)) throw new CadError('PROJECT_DELETED', 'The copied project was deleted.');
          return { duplication: JSON.parse(String(prior.result)), replayed: true };
        }
        if (this.db.prepare('SELECT 1 FROM changes WHERE project_id=? AND document_id IS NULL LIMIT 1').get(op.requestId)) throw new CadError('PROJECT_DELETED', 'This project identity was deleted.');
        const versions = Object.fromEntries(this.db.prepare('SELECT id,version FROM documents').all().map(r => [String(r.id), Number(r.version)]));
        const copy = prepareProjectDuplicate(op, this.projects(), this.documents(), versions);
        this.db.prepare('INSERT INTO projects VALUES(?,?,1,?)').run(copy.project.projectId, copy.project.name, copy.project.mainAssemblyId ?? null);
        const sequences = new Map<string, number>();
        for (const document of copy.documents) {
          const updatedAt = new Date().toISOString(), summary = summarize(document, updatedAt, 1), body = JSON.stringify(document);
          this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?)').run(document.documentId, copy.project.projectId, summary.name, summary.kind!, 0, 1, summary.features, updatedAt, body, JSON.stringify(emptyHistory()));
          this.db.prepare('INSERT INTO revisions VALUES(?,1,0,?,?)').run(document.documentId, updatedAt, body);
          sequences.set(document.documentId, this.event(document.documentId, copy.project.projectId, 1));
        }
        const projectSequence = this.event(null, copy.project.projectId, 1);
        // Snapshots need all copied sources to exist first, including nested assemblies.
        for (const document of copy.documents) {
          if (!op.context) continue;
          const graph = this.snapshot(document.documentId);
          const references = Object.fromEntries(graph.snapshot.sources.map(s => [s.documentId, s.storageVersion]));
          this.collaboration.committed(op.context, document.documentId, copy.project.projectId, undefined, 1, 0, sequences.get(document.documentId)!, references, graph.snapshot.snapshotId);
        }
        this.collaboration.committedEvent(op.context, undefined, copy.project.projectId, undefined, 1, projectSequence,
          { affectedDocumentIds: copy.documents.map(d => d.documentId), affectedProjectIds: [copy.project.projectId], snapshotId: undefined, revision: undefined });
        this.db.prepare('INSERT INTO project_duplications VALUES(?,?,?)').run(op.requestId, identity, JSON.stringify(copy.duplication));
        return { duplication: copy.duplication };
      }
      case 'snapshot': return {graph:this.snapshot(op.documentId,op.snapshot)};
      case 'list': {
        const rows = op.projectId ? this.db.prepare('SELECT id,project_id,name,kind,revision,version,features,updated_at FROM documents WHERE project_id=? ORDER BY updated_at DESC,id').all(op.projectId) : this.db.prepare('SELECT id,project_id,name,kind,revision,version,features,updated_at FROM documents ORDER BY updated_at DESC,id').all();
        return { documents: rows.map(r => ({ documentId: String(r.id), projectId: String(r.project_id), name: String(r.name), kind: r.kind as 'part'|'assembly', revision: Number(r.revision), storageVersion: Number(r.version), features: Number(r.features), updatedAt: String(r.updated_at), active: false })) };
      }
      case 'read': return { record: this.record(op.documentId) };
      case 'body': return { body: this.currentBody(op.documentId) };
      case 'projects': return { projects: this.projects() };
      case 'changes': {
        const changes = this.db.prepare('SELECT * FROM changes WHERE sequence>? ORDER BY sequence LIMIT 500').all(op.after).map(r => ({ sequence: Number(r.sequence), ...(r.document_id ? { documentId: String(r.document_id) } : {}), ...(r.project_id ? { projectId: String(r.project_id) } : {}), version: Number(r.version), deleted: Boolean(r.deleted) }));
        return { changes, cursor: changes.at(-1)?.sequence ?? Math.min(op.after, Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM changes').get()!.maximum)) };
      }
      case 'history': return { revisions: this.db.prepare('SELECT version,revision,updated_at FROM revisions WHERE document_id=? ORDER BY version DESC LIMIT 40').all(op.documentId).map(r => ({ version: Number(r.version), revision: Number(r.revision), updatedAt: String(r.updated_at) })) };
      case 'write': {
        const document = modelDocument(op.document), prior = this.record(document.documentId);
        conflict(op.expectedVersion, prior?.version);
        if (!prior && this.db.prepare('SELECT 1 FROM revisions WHERE document_id=? LIMIT 1').get(document.documentId)) throw new CadError('DOCUMENT_DELETED', 'This document identity was deleted. Create a new identity.');
        for (const [id, expected] of Object.entries(op.references ?? {})) conflict(expected, this.record(id)?.version);
        if (prior && JSON.stringify(prior.document.creation) !== JSON.stringify(document.creation)) throw new CadError('CREATION_IMMUTABLE', 'Creation identity cannot be changed.');
        if (prior && document.revision < prior.document.revision) throw new CadError('REVISION_CONFLICT', 'Document revisions cannot go backward.');
        validateStoredWrite(document, this.documents(), this.projects());
        return this.publishRecord(document,op.history,op.context,op.references);
      }
      case 'remove': {
        const prior = this.record(op.documentId); conflict(op.expectedVersion, prior?.version);
        validateRemoval(op.documentId, this.documents(), this.projects());
        this.db.prepare('DELETE FROM documents WHERE id=?').run(op.documentId);
        const seq=this.event(op.documentId, prior!.document.projectId!, op.expectedVersion + 1, true);this.collaboration.committedEvent(op.context,op.documentId,prior!.document.projectId!,op.expectedVersion,op.expectedVersion+1,seq);return {};
      }
      case 'project': {
        const prior = this.projects().find(p => p.projectId === op.project.projectId); conflict(op.expectedVersion, prior?.version);
        if (!prior && this.db.prepare('SELECT 1 FROM changes WHERE project_id=? AND document_id IS NULL LIMIT 1').get(op.project.projectId)) throw new CadError('PROJECT_DELETED', 'This project identity was deleted. Create a new identity.');
        const p = { ...op.project, version: (prior?.version ?? 0) + 1 };
        if (p.mainAssemblyId) {
          const doc = this.record(p.mainAssemblyId)?.document;
          if (!doc || doc.projectId !== p.projectId || !(doc.kind === 'assembly' || doc.features.some(f => f.kind === 'instance'))) throw new CadError('INVALID_MAIN_ASSEMBLY', 'Main assembly must be an assembly in this project.');
        }
        this.db.prepare('INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,main_assembly=excluded.main_assembly').run(p.projectId,p.name,p.version,p.mainAssemblyId ?? null);
        const seq=this.event(null,p.projectId,p.version);this.collaboration.committedEvent(op.context,undefined,p.projectId,prior?.version,p.version,seq);return {projects:this.projects()};
      }
      case 'remove_project': {
        conflict(op.expectedVersion, this.projects().find(p => p.projectId === op.projectId)?.version);
        const versions = Object.fromEntries(this.db.prepare('SELECT id,version FROM documents').all().map(row => [String(row.id), Number(row.version)]));
        const contents = validateProjectRemoval(op.projectId, this.documents(), versions, op.documentVersions);
        for (const document of contents) {
          this.db.prepare('DELETE FROM documents WHERE id=?').run(document.documentId);
          const seq = this.event(document.documentId, op.projectId, versions[document.documentId] + 1, true);
          this.collaboration.committedEvent(op.context, document.documentId, op.projectId, versions[document.documentId], versions[document.documentId] + 1, seq);
        }
        this.db.prepare('DELETE FROM projects WHERE id=?').run(op.projectId); this.event(null,op.projectId,op.expectedVersion+1,true); return {};
      }
    }
  }
}
