import type { CadResult, CommandName } from '../shared/protocol';

/**
 * Session-only record of who changed or inspected the shared document.
 * Agent entries come from bridge requests; "you" entries from this tab's controls.
 * Nothing here is persisted or sent anywhere.
 */
export type Actor = 'agent' | 'you';
export interface ActivityEntry {
  key: string; actor: Actor; operation: CommandName | string; status: 'running' | 'success' | 'error';
  at: number; revision?: number; created: string[]; updated: string[]; deleted: string[];
  message?: string; durationMs?: number;
  /** Change in total visible volume this operation committed, from exact kernel results. */
  volumeDelta?: number;
  /** The document the operation addressed; agents may work on parts the human is not viewing. */
  documentId?: string;
}

const LIMIT = 80;
let entries: ActivityEntry[] = [];
// Commands finish in the order the runtime commits them, so a document's previous total is this one's baseline.
const lastVolume = new Map<string, number>();
/** documentId → featureId → when an agent last created or changed it. */
let agentTouched = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export const activity = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  entries: () => entries,
  agentTouched: () => agentTouched,
  start(key: string, actor: Actor, operation: string) {
    entries = [{ key, actor, operation, status: 'running' as const, at: Date.now(), created: [], updated: [], deleted: [] }, ...entries].slice(0, LIMIT);
    emit();
  },
  /** Seed a document's volume baseline from its committed model, so its first edit also shows a change. */
  observe(documentId: string, volume: number) { if (!lastVolume.has(documentId)) lastVolume.set(documentId, volume); },
  finish(key: string, result: CadResult) {
    const entry = entries.find(e => e.key === key);
    if (!entry) return;
    const updated = result.operation === 'apply_edits' ? result.updated : [];
    let volumeDelta: number | undefined;
    if (result.status === 'success' && result.geometry && !result.dryRun && result.documentId) {
      const volume = result.geometry.reduce((sum, g) => sum + g.volumeMm3, 0);
      const before = lastVolume.get(result.documentId);
      if (before !== undefined && Math.abs(volume - before) > 1e-6) volumeDelta = volume - before;
      lastVolume.set(result.documentId, volume);
    }
    const next: ActivityEntry = {
      ...entry, status: result.status, revision: result.revision, created: result.created, updated,
      deleted: result.deleted ?? [], message: result.error?.message, durationMs: result.durationMs, volumeDelta, documentId: result.documentId,
    };
    entries = entries.map(e => e === entry ? next : e);
    if (entry.actor === 'agent' && result.status === 'success' && result.documentId && (next.created.length || updated.length)) {
      const touched = new Map(agentTouched.get(result.documentId));
      for (const id of [...next.created, ...updated]) touched.set(id, Date.now());
      agentTouched = new Map(agentTouched).set(result.documentId, touched);
    }
    emit();
  },
};

let sequence = 0;
/** Wrap a manual runtime call so it appears in the shared activity record. */
export async function track(operation: string, run: () => Promise<CadResult>): Promise<CadResult> {
  const key = `you-${++sequence}`;
  activity.start(key, 'you', operation);
  try { const result = await run(); activity.finish(key, result); return result; }
  catch (error) {
    activity.finish(key, { operation: operation as CommandName, status: 'error', created: [], updated: [], warnings: [], error: { code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export const operationLabels: Record<string, string> = {
  apply_edits: 'Applied edits',
  select_features: 'Selected',
  inspect_model: 'Inspected model',
  analyze_model: 'Analyzed model',
  documents: 'Managed documents',
  render_views: 'Rendered views',
  export_model: 'Exported',
  document_action: 'Document action',
};
