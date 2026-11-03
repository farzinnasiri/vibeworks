import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { CadDocument } from '../shared/protocol';
import type { Evaluation, PreparedDisplayStore } from '../cad/types';
import { packDisplay } from '../shared/display';
import { displayDeliverySchema, MAX_RESPONSE_BYTES } from './validation';

const MAX_CACHE_BYTES = 96 * 1024 * 1024;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
// Derived data is reusable only by the code/kernel/font that checked and tessellated it.
// Hash loaded source bytes once per bridge; source contract fingerprints alone do not cover the modeler.
let engineVersion: string | undefined;
function engineFingerprint(): string {
  if (engineVersion) return engineVersion;
  const hash = createHash('sha256');
  const cad = new URL('../cad/', import.meta.url);
  const files = readdirSync(cad).filter(f => /\.(ts|mjs)$/.test(f)).sort().map(f => new URL(f, cad));
  files.push(new URL('../cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
  for (const name of ['protocol', 'materials', 'display', 'appearance-resolver', 'graphic-assets', 'studio']) files.push(new URL(`../shared/${name}.ts`, import.meta.url));
  for (const name of ['replicad', 'replicad-opencascadejs']) files.push(new URL(`../../node_modules/${name}/package.json`, import.meta.url));
  for (const file of files) hash.update(readFileSync(file)).update('\0');
  engineVersion = hash.digest('hex');
  return engineVersion;
}
const envelope = (document: CadDocument, evaluation: Evaluation) => ({ result: { operation: 'inspect_model' as const, status: 'success' as const, documentId: document.documentId, revision: document.revision, created: [], updated: [], warnings: [] }, evaluation });

/** Optional derived display data. No B-reps, analysis certification, model writes, history or feed entries. */
export class PreparedDisplayCache implements PreparedDisplayStore {
  constructor(private db: DatabaseSync, private version = engineFingerprint(), private maxBytes = MAX_CACHE_BYTES) {
    db.exec('CREATE TABLE IF NOT EXISTS prepared_displays(document_id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL, used_at INTEGER NOT NULL)');
  }
  private key(document: CadDocument, documents: CadDocument[]): string {
    const graph = [document, ...documents].sort((a, b) => a.documentId.localeCompare(b.documentId));
    // Frozen storage and runtime validation can emit identical fields in different orders.
    return createHash('sha256').update(this.version).update(JSON.stringify(canonical(graph))).digest('hex');
  }
  get(document: CadDocument, documents: CadDocument[]): Evaluation | undefined {
    try {
      const key = this.key(document, documents);
      const row = this.db.prepare('SELECT cache_key,body,bytes FROM prepared_displays WHERE document_id=?').get(document.documentId);
      if (!row) return;
      if (row.cache_key !== key || Number(row.bytes) > MAX_RESPONSE_BYTES) {
        this.db.prepare('DELETE FROM prepared_displays WHERE document_id=?').run(document.documentId);
        return;
      }
      const parsed = displayDeliverySchema.safeParse(JSON.parse(String(row.body)));
      if (!parsed.success || !parsed.data.evaluation || parsed.data.evaluation.meshes.some(m=>m.topology)&&!parsed.data.evaluation.displayKey || parsed.data.result.documentId !== document.documentId || parsed.data.result.revision !== document.revision) {
        this.db.prepare('DELETE FROM prepared_displays WHERE document_id=?').run(document.documentId);
        return;
      }
      this.db.prepare('UPDATE prepared_displays SET used_at=? WHERE document_id=?').run(Date.now(), document.documentId);
      return parsed.data.evaluation;
    } catch {
      // An unavailable/corrupt derived cache falls back to exact preparation, never to stale geometry.
      return;
    }
  }
  put(document: CadDocument, documents: CadDocument[], evaluation: Evaluation): void {
    if (evaluation.displayError || evaluation.referenceError || evaluation.replay || evaluation.sections) return;
    try {
      // Analysis belongs to a current runtime, not a durable display. Old timing/cache counters are not a new evaluation.
      const { analysis: _analysis, stats: _stats, referencesChanged: _changed, ...display } = evaluation;
      if (!displayDeliverySchema.safeParse(envelope(document, display)).success) return;
      const body = JSON.stringify(packDisplay(envelope(document, display))), bytes = Buffer.byteLength(body);
      if (bytes > Math.min(MAX_RESPONSE_BYTES, this.maxBytes)) return;
      this.db.prepare('INSERT OR REPLACE INTO prepared_displays VALUES(?,?,?,?,?)').run(document.documentId, this.key(document, documents), body, bytes, Date.now());
      let total = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM prepared_displays').get()!.total);
      for (const row of this.db.prepare('SELECT document_id,bytes FROM prepared_displays ORDER BY used_at,document_id').all()) {
        if (total <= this.maxBytes) break;
        this.db.prepare('DELETE FROM prepared_displays WHERE document_id=?').run(row.document_id!);
        total -= Number(row.bytes);
      }
    } catch {
      // Optional acceleration must not turn a successful exact read into a failed model operation.
    }
  }
}
