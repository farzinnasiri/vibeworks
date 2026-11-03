import {checkRoot} from '../shared/protocol';
import { resolveAppearance, type AppearanceLayer } from '../shared/appearance-resolver';
import { checkFeatures, documentSchema, type Appearance, type CadDocument, type Feature } from '../shared/protocol';

export class CadError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

export function emptyDocument(): CadDocument {
  return { schemaVersion: 1, documentId: crypto.randomUUID(), revision: 0, units: 'mm', features: [], selectedFeatureIds: [] };
}

export function references(feature: Feature): string[] {
  if(feature.kind==='fill')return [...new Set(feature.params.boundary.flatMap(b=>[b.edge.feature,...(b.support?[b.support.feature]:[])]))];
  if(feature.kind==='join')return [feature.params.target,...feature.params.surfaces];
  if (feature.kind === 'instance') {
    const target = feature.params.attachment?.target;
    return target && 'featureId' in target ? [target.featureId] : [];
  }
  if (feature.kind === 'subtract' || feature.kind === 'union' || feature.kind === 'intersect') return [feature.params.target, ...feature.params.tools];
  if (feature.kind === 'fillet' || feature.kind === 'chamfer') return [feature.params.target, ...seamInputs(feature)];
  if ('target' in feature.params && feature.params.target) return [feature.params.target];
  return [];
}
/** Seam selectors read two earlier inputs' surfaces; they order and pin the blend but are not consumed by it. */
const seamInputs = (feature: Extract<Feature, { kind: 'fillet' | 'chamfer' }>) =>
  typeof feature.params.edges === 'string' ? [] : feature.params.edges.between ?? [];

/** Validate the whole ordered graph before allocating kernel objects. */
export function validateDocument(value: unknown): CadDocument {
  const doc = documentSchema.parse(value);
  const seen = new Set<string>();
  for (const feature of doc.features) {
    if(feature.graphicEdits&&feature.kind!=='instance')throw new CadError('APPEARANCE_FIELD_NOT_ALLOWED','Keyed occurrence graphic overrides belong to instances. Use appearance.graphics for a source result.');
    if(new Set(feature.paintRegions?.map(r=>r.id)).size!==(feature.paintRegions?.length??0))throw new CadError('REGION_ID','Paint region IDs must be unique.');
    for(const region of feature.paintRegions??[])if(region.target.feature!==feature.id||!('faces'in region.target.select)||!region.target.signature)throw new CadError('REFERENCE_TARGET','A paint region requires named support faces, a captured signature and its owning feature.');
    if (seen.has(feature.id)) throw new CadError('DUPLICATE_FEATURE', `Feature '${feature.id}' already exists.`);
    for(const style of feature.surfaceStyles??[])if(style.target.feature!==feature.id)throw new CadError('REFERENCE_TARGET','A surface style must target its owning feature.');
    const refs = references(feature);
    if (new Set(refs).size !== refs.length) throw new CadError('INVALID_REFERENCE', `Feature '${feature.id}' repeats a target or tool.`);
    for (const ref of refs) {
      if (!seen.has(ref)) throw new CadError('INVALID_REFERENCE', `Feature '${feature.id}' must reference an earlier feature, but '${ref}' is missing or later.`);
    }
    seen.add(feature.id);
  }
  for (const id of doc.selectedFeatureIds) {
    if (!seen.has(id)) throw new CadError('INVALID_SELECTION', `Selected feature '${id}' does not exist.`);
  }
  if (new Set(doc.selectedFeatureIds).size !== doc.selectedFeatureIds.length) throw new CadError('INVALID_SELECTION', 'Selection contains duplicate IDs.');
  const analysis = doc.analysis;
  if (analysis?.ground && !seen.has(checkRoot(analysis.ground))) throw new CadError('INVALID_REFERENCE', `Analysis ground '${analysis.ground}' does not exist.`);
  const checkIds = new Set<string>();
  for (const check of analysis?.checks ?? []) {
    if (checkIds.has(check.id)) throw new CadError('DUPLICATE_CHECK', `Check '${check.id}' is defined twice.`);
    checkIds.add(check.id);
    for (const ref of checkFeatures(check)) if (!seen.has(ref)) throw new CadError('INVALID_REFERENCE', `Check '${check.id}' refers to '${ref}', which does not exist.`);
    if ('b' in check && JSON.stringify(check.a) === JSON.stringify(check.b)) throw new CadError('INVALID_REFERENCE', `Check '${check.id}' compares '${check.a}' with itself.`);
  }
  return doc;
}

/** Placement references affect ordering/deletion, but do not consume their target's geometry. */
export function consumedReferences(feature: Feature): string[] {
  if(feature.kind==='fill')return [];
  if (feature.kind === 'fillet' || feature.kind === 'chamfer') return [feature.params.target];
  return feature.kind === 'instance' || ((feature.kind === 'transform' || feature.kind === 'mirror') && feature.params.copy) ? [] : references(feature);
}
export function visibleFeatures(doc: CadDocument): string[] {
  const consumed = new Set(doc.features.flatMap(consumedReferences));
  return doc.features.filter(f => !consumed.has(f.id)).map(f => f.id);
}

export function checkContext(doc: CadDocument, context: {documentId: string; expectedRevision: number}): void {
  if (context.documentId !== doc.documentId) throw new CadError('DOCUMENT_MISMATCH', 'This command targets another document. Inspect the connected model before editing.', { documentId: doc.documentId, revision: doc.revision });
  if (context.expectedRevision !== doc.revision) throw new CadError('REVISION_CONFLICT', `Expected revision ${context.expectedRevision}, but the current revision is ${doc.revision}. Inspect before retrying.`, { documentId: doc.documentId, revision: doc.revision });
}

export const copyDocument = (doc: CadDocument): CadDocument => structuredClone(doc);

export function nextRevision(doc: CadDocument): number {
  if (!Number.isSafeInteger(doc.revision) || doc.revision >= Number.MAX_SAFE_INTEGER) throw new CadError('REVISION_LIMIT', 'Document revision cannot be incremented safely.');
  return doc.revision + 1;
}

/** Dependency closure is also used by the UI to preview exactly what deletion removes. */
export function deletionIds(doc: CadDocument, ids: string[], cascade: boolean): string[] {
  const removed = new Set(ids);
  for (const id of ids) if (!doc.features.some(f => f.id === id)) throw new CadError('FEATURE_NOT_FOUND', `Feature '${id}' does not exist.`);
  const dependents: string[] = [];
  for (const feature of doc.features) {
    if (!removed.has(feature.id) && references(feature).some(id => removed.has(id))) {
      removed.add(feature.id); dependents.push(feature.id);
    }
  }
  if (!cascade && dependents.length) throw new CadError('FEATURE_HAS_DEPENDENTS', 'Other features depend on this selection. Delete with cascade to remove them too.', { dependentFeatureIds: dependents });
  return doc.features.filter(f => removed.has(f.id)).map(f => f.id);
}

/**
 * The appearance a feature shows: its own, or the one of the part it was built from (its target chain).
 * Set a material on a base block and every later cut, fillet or copy keeps it.
 */
export function appearanceLayers(doc: CadDocument, featureId: string): AppearanceLayer[] {
  const byId = new Map(doc.features.map(f => [f.id, f]));
  let feature = byId.get(featureId);
  const layers: AppearanceLayer[]=[];
  for(let guard=0;feature&&guard<=doc.features.length;guard++){
    if(feature.appearance)layers.unshift({value:feature.appearance,from:{documentId:doc.documentId,featureId:feature.id,layer:'source'}});
    feature='target'in feature.params&&feature.params.target?byId.get(feature.params.target):undefined;
  }
  return layers;
}
export function effectiveAppearance(doc: CadDocument, featureId: string): Appearance | undefined {
  const layers=appearanceLayers(doc,featureId);
  return layers.length?resolveAppearance(layers).effective:undefined;
}
