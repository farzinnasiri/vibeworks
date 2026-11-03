import { ENGINE_VERSION, type CadDocument, type DisplayEvaluation } from '../shared/protocol';
/** Definitions, exact engine and replay position. Shared by live and frozen topology reads. */
export async function identifyDisplay(evaluation: DisplayEvaluation, document: CadDocument, documents: CadDocument[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(['topology-display-v1', ENGINE_VERSION, [document, ...documents].map(d=>({...d,selectedFeatureIds:[]})).sort((a,b)=>a.documentId.localeCompare(b.documentId)), { replay:evaluation.replay ? {step:evaluation.replay.step,key:evaluation.replay.key} : undefined }]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  evaluation.displayKey = Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
}
