import { MAX_ASSEMBLY_FEATURES, MAX_INSTANCE_DEPTH, MAX_REFERENCED_DOCUMENTS, type CadDocument } from '../shared/protocol';
import { CadError, validateDocument } from './document';

/**
 * Validate every path, including shared subassemblies reached at different depths. Only documents reachable from
 * the root are validated: callers often pass the whole workspace.
 */
export function assemblyGraph(root: CadDocument, documents: CadDocument[]): CadDocument[] {
  const raw = new Map(documents.map(doc => [doc.documentId, doc]));
  raw.set(root.documentId, root);
  const validated = new Map<string, CadDocument>();
  const byId = { get(id: string): CadDocument | undefined {
    let doc = validated.get(id);
    if (!doc && raw.has(id)) validated.set(id, doc = validateDocument(raw.get(id)));
    return doc;
  } };
  const ordered = new Map<string, CadDocument>();
  let features = 0;
  const heights = new Map<string, number>();
  const visit = (doc: CadDocument, path: string[]): number => {
    if (path.includes(doc.documentId)) throw new CadError('INSTANCE_CYCLE', 'Instances cannot form a document cycle.', { path: [...path, doc.documentId] });
    if (path.length > MAX_INSTANCE_DEPTH) throw new CadError('INSTANCE_DEPTH', `Instances may nest at most ${MAX_INSTANCE_DEPTH} levels.`, { path: [...path, doc.documentId] });
    const known = heights.get(doc.documentId);
    if (known !== undefined) {
      if (path.length + known > MAX_INSTANCE_DEPTH) throw new CadError('INSTANCE_DEPTH', `Instances may nest at most ${MAX_INSTANCE_DEPTH} levels.`);
      return known;
    }
    let height = 0;
    for (const feature of doc.features) if (feature.kind === 'instance') {
      const source = byId.get(feature.params.document);
      if (!source) throw new CadError('DOCUMENT_NOT_FOUND', `Instance '${feature.id}' references missing document '${feature.params.document}'.`);
      height = Math.max(height, 1 + visit(source, [...path, doc.documentId]));
    }
    if (!ordered.has(doc.documentId)) {
      ordered.set(doc.documentId, doc); features += doc.features.length;
      if (ordered.size > MAX_REFERENCED_DOCUMENTS + 1 || features > MAX_ASSEMBLY_FEATURES) throw new CadError('ASSEMBLY_LIMIT', `An assembly may reference ${MAX_REFERENCED_DOCUMENTS} documents and ${MAX_ASSEMBLY_FEATURES} total features.`);
    }
    heights.set(doc.documentId, height);
    return height;
  };
  visit(byId.get(root.documentId)!, []);
  return [...ordered.values()];
}
