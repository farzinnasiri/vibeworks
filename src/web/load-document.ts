import { documentSchema, type CadResult } from '../shared/protocol';
import type { RuntimeClient } from '../cad/runtime';
import { context } from '../cad/demo';

export async function loadDocumentFile(runtime: RuntimeClient, file: Pick<File, 'size' | 'text'>, target = context(runtime.getSnapshot().document)): Promise<CadResult> {
  if (file.size > 1024 * 1024) throw new Error('JSON documents must be under 1 MiB.');
  const document = documentSchema.parse(JSON.parse(await file.text()));
  return runtime.execute({ type: 'document_action', params: { ...target, action: 'load', document } });
}
