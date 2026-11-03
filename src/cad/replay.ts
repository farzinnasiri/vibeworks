import { MAX_ASSEMBLY_FEATURES, type CadDocument, type Feature, type ReplayStep } from '../shared/protocol';
import { CadError, references, visibleFeatures } from './document';

export interface ReplayNode {
  document: CadDocument;
  feature: Feature;
  /** Only geometric ancestors of the selected final results. Mount targets stay placement inputs. */
  features: Feature[];
  resultIds?: string[];
}
export interface ReplayEntry { nodes: ReplayNode[]; step: ReplayStep }

/** Metadata only, bounded before producing any frame meshes. Repeated instances build independently. */
export function replayPlan(root: CadDocument, documents: CadDocument[]): ReplayEntry[] {
  const byId = new Map([root, ...documents].map(doc => [doc.documentId, doc]));
  const entries: ReplayEntry[] = [];
  const visit = (doc: CadDocument, resultIds: string[] | undefined, parents: ReplayNode[]) => {
    const needed = new Set<string>();
    const include = (id: string) => {
      if (needed.has(id)) return;
      needed.add(id);
      const feature = doc.features.find(f => f.id === id)!;
      if (feature.kind !== 'instance') references(feature).forEach(include);
    };
    resultIds?.forEach(include);
    const features = resultIds ? doc.features.filter(f => needed.has(f.id)) : doc.features;
    for (const feature of features) {
      const nodes = [...parents, { document: doc, feature, features, resultIds }];
      if (feature.kind === 'instance') {
        const source = byId.get(feature.params.document)!;
        visit(source, feature.params.featureId ? [feature.params.featureId] : visibleFeatures(source), nodes);
      }
      if (entries.length >= MAX_ASSEMBLY_FEATURES)
        throw new CadError('REPLAY_LIMIT', `Component replay supports at most ${MAX_ASSEMBLY_FEATURES} expanded steps. Use Assembly steps or simplify the assembly.`);
      entries.push({ nodes, step: {
        rootStep: root.features.indexOf(nodes[0].feature) + 1,
        path: nodes.map(n => ({ documentId: n.document.documentId, name: n.document.name ?? 'Untitled', featureId: n.feature.id, label: n.feature.label ?? n.feature.id })),
        kind: feature.kind,
      } });
    }
  };
  visit(root, undefined, []);
  return entries;
}

/** Exact prefixes for an active branch. Shared sources and mount-driven branches retain full evaluation. */
export function replayDefinitions(root:CadDocument,graph:CadDocument[],entry:ReplayEntry):{documents:CadDocument[];partial:Set<string>}{
 const rootPrefix={...root,features:root.features.slice(0,entry.step.rootStep),selectedFeatureIds:[],analysis:undefined};
 const prefixes=new Map<string,CadDocument>();
 for(const node of entry.nodes.slice(1))prefixes.set(node.document.documentId,{...node.document,features:node.features.slice(0,node.features.indexOf(node.feature)+1),selectedFeatureIds:[],analysis:undefined});
 const definitions=graph.map(doc=>doc.documentId===root.documentId?rootPrefix:prefixes.get(doc.documentId)??doc);
 const uses=new Map<string,number>();
 for(const doc of definitions)for(const feature of doc.features)if(feature.kind==='instance')uses.set(feature.params.document,(uses.get(feature.params.document)??0)+1);
 const mounted=definitions.some(doc=>doc.features.some(feature=>feature.kind==='instance'&&feature.params.attachment));
 if(mounted||[...prefixes.keys()].some(id=>(uses.get(id)??0)>1))return{documents:graph.map(doc=>doc.documentId===root.documentId?rootPrefix:doc),partial:new Set()};
 return{documents:definitions,partial:new Set(prefixes.keys())};
}
