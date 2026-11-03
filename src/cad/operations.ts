import type {CadDocument,StoredDocument,StorageOperation} from '../shared/protocol';
import {CadError} from './document';
export interface OperationRecord {identity:string;receipt:Record<string,unknown>;before:StoredDocument[];after:StoredDocument[];versions:Record<string,number>;createdIds:string[];state:'applied'|'undone'}
export function guardWorkspace(expected:Record<string,number>,records:StoredDocument[]){const actual=Object.fromEntries(records.map(r=>[r.document.documentId,r.version]));if(JSON.stringify(Object.entries(expected).sort())!==JSON.stringify(Object.entries(actual).sort()))throw new CadError('STORAGE_CONFLICT','Workspace documents or a read dependency changed after planning. Preview extraction again.',{expected,actual});}
export function restoreOperation(op:OperationRecord,direction:'undo'|'redo',records:StoredDocument[]):CadDocument[]{
 if(op.state!==(direction==='undo'?'applied':'undone'))throw new CadError('OPERATION_STATE','Operation is already in that state.');
 const conflicts=Object.entries(op.versions).filter(([id,v])=>records.find(r=>r.document.documentId===id)?.version!==v);if(conflicts.length)throw new CadError('OPERATION_CONFLICT','An affected document changed after the operation.',{documents:conflicts.map(([id])=>id)});
 return (direction==='undo'?op.before:op.after.filter(r=>!op.createdIds.includes(r.document.documentId))).map(r=>({...structuredClone(r.document),revision:records.find(x=>x.document.documentId===r.document.documentId)!.document.revision+1}));
}
export type BatchOperation=Extract<StorageOperation,{action:'batch'}>;
