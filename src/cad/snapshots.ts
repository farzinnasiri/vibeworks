import { assemblyGraph } from './assemblies';
import { CadError, validateDocument } from './document';
import { ENGINE_VERSION, MAX_REFERENCED_DOCUMENTS, type CadDocument, type FrozenGraph } from '../shared/protocol';

export interface VersionedDefinition {document:CadDocument;version:number}
/** Freeze semantic definitions only. Native shapes and frame meshes remain disposable. */
export function freezeGraph(documentId:string,read:(id:string)=>VersionedDefinition|undefined,cursor:number):FrozenGraph {
  const found=new Map<string,VersionedDefinition>();
  const visit=(id:string)=>{
    if(found.has(id))return;
    if(found.size>MAX_REFERENCED_DOCUMENTS)throw new CadError('ASSEMBLY_LIMIT','Snapshot exceeds the referenced-document limit.');
    const record=read(id);if(!record)throw new CadError('SNAPSHOT_SOURCE_MISSING',`No saved definition for '${id}' exists at this point in history.`);
    validateDocument(record.document);found.set(id,record);
    for(const feature of record.document.features)if(feature.kind==='instance')visit(feature.params.document);
  };
  visit(documentId);const root=found.get(documentId)!;
  const ordered=assemblyGraph(root.document,[...found.values()].map(r=>r.document));
  return {
    snapshot:{snapshotId:crypto.randomUUID(),documentId,storageVersion:root.version,revision:root.document.revision,sources:ordered.filter(d=>d.documentId!==documentId).map(d=>({documentId:d.documentId,storageVersion:found.get(d.documentId)!.version,revision:d.revision})),engineVersion:ENGINE_VERSION,cursor,createdAt:new Date().toISOString()},
    document:structuredClone({...root.document,selectedFeatureIds:[]}),
    documents:ordered.filter(d=>d.documentId!==documentId).map(d=>structuredClone({...d,selectedFeatureIds:[]})),
  };
}
export const snapshotManifest = (graph:FrozenGraph)=>JSON.stringify([graph.snapshot.engineVersion,graph.snapshot.documentId,graph.snapshot.storageVersion,graph.snapshot.sources,graph.snapshot.cursor]);
