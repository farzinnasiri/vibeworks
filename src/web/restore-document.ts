import type {CadDocument,CadResult} from '../shared/protocol';
import type {RuntimeClient} from '../cad/runtime';
/** Restore a document definition as a new conditional edit. Source documents retain their current states. */
export function restoreDocument(runtime:RuntimeClient,historical:CadDocument,head:{revision:number;storageVersion:number}):Promise<CadResult>{
 return runtime.execute({type:'document_action',params:{action:'load',documentId:historical.documentId,
  expectedRevision:head.revision,expectedStorageVersion:head.storageVersion,document:historical,analyze:true}});
}
