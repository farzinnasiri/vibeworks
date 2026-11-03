import { z } from 'zod';
import { DocumentStore } from '../cad/store';
import { CadError } from '../cad/document';
import { storageRequestSchema, storageResponseSchema, type StorageOperation, type StorageResponse } from '../shared/protocol';

declare const __VIBEWORKS_FINGERPRINT__: string;
const buildFingerprint = typeof __VIBEWORKS_FINGERPRINT__ === 'string' ? __VIBEWORKS_FINGERPRINT__ : 'unbuilt';
const connectionSchema = z.object({ wsUrl: z.string(), token: z.string().min(1), fingerprint: z.string() });
/** No automatic mutation retry. A lost/malformed reply may follow a committed SQLite transaction. */
export class BridgeStore extends DocumentStore {
  private connection?: z.infer<typeof connectionSchema>;
  async operation(operation: StorageOperation): Promise<Omit<StorageResponse, 'requestId' | 'fingerprint' | 'ok'>> {
    if (!this.connection) {
      const response = await fetch('/api/connection', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new CadError('STORAGE_UNAVAILABLE', `Storage bootstrap returned HTTP ${response.status}. Start the local bridge and reload.`);
      this.connection = connectionSchema.parse(await response.json());
    }
    if (this.connection.fingerprint !== buildFingerprint) throw new CadError('VERSION_SKEW', 'Storage client and bridge differ. Restart the matched stack and reload.');
    const envelope = storageRequestSchema.parse({ requestId: crypto.randomUUID(), operation });
    const mutation = ['write','remove','project','remove_project','duplicate_project'].includes(operation.action);
    let parsed: StorageResponse;
    try {
      const response = await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.connection.token}`, 'X-Vibeworks-Fingerprint': buildFingerprint }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 409) {
        this.connection = undefined;
        throw new CadError('STORAGE_UNAVAILABLE', `Storage rejected the request before execution (HTTP ${response.status}). Read state before retrying.`);
      }
      if (!response.ok) throw new Error(`Storage returned HTTP ${response.status}`);
      parsed = storageResponseSchema.parse(await response.json());
      if (parsed.requestId !== envelope.requestId || parsed.fingerprint !== buildFingerprint || (!parsed.ok && !parsed.error)) throw new Error('Storage response identity is invalid.');
      const expectedField = {batch:'batchReceipt',operation_request:undefined,operation_history:'batchReceipt', duplicate_project:'duplication', snapshot:'graph', list:'documents', read:undefined, body:undefined, write:'version', remove:undefined, projects:'projects', project:'projects', remove_project:undefined, changes:'changes', history:'revisions' }[operation.action];
      if (parsed.ok && expectedField && !(expectedField in parsed)) throw new Error('Storage response is missing its result.');
      if (parsed.ok && operation.action === 'changes' && parsed.cursor === undefined) throw new Error('Storage change response is missing its cursor.');
      if (parsed.ok && operation.action === 'write' && parsed.version !== (operation.expectedVersion ?? 0) + 1) throw new Error('Storage write response has an unexpected version.');
      if (parsed.record && operation.action === 'read' && parsed.record.document.documentId !== operation.documentId) throw new Error('Storage returned another document.');
      if (parsed.body && operation.action === 'body' && parsed.body.document.documentId !== operation.documentId) throw new Error('Storage returned another document.');
    } catch (error) {
      this.connection = undefined;
      if (error instanceof CadError) throw error;
      throw new CadError(mutation ? 'STORAGE_OUTCOME_UNKNOWN' : 'STORAGE_UNAVAILABLE', `${error instanceof Error ? error.message : String(error)}. ${mutation ? 'The write may have committed. Inspect persisted state before another mutation; do not blindly retry.' : 'Read again after the bridge reconnects.'}`);
    }
    if (!parsed.ok) throw new CadError(parsed.error!.code, parsed.error!.message, parsed.error!.details);
    return parsed;
  }
  async getPreference(key: string) { try { return sessionStorage.getItem(`vibeworks.view.${key}`) ?? undefined; } catch { return undefined; } }
  async setPreference(key: string, value: string) { sessionStorage.setItem(`vibeworks.view.${key}`, value); }
}
