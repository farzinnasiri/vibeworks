import type {CadCommand,CadResult} from '../shared/protocol';

export interface ManualChange {operationId?:string;documentId:string;name:string;revision:number;storageVersion:number;label:string}
/** This tab's manual edits, ordered across source navigation. Kernel history stays document-local. */
export class ManualHistory {
 private undo:ManualChange[]=[];private redo:ManualChange[]=[];
 target(action:'undo'|'redo'){return (action==='undo'?this.undo:this.redo).at(-1);}
 record(command:CadCommand,result:CadResult,name:string){
  if(result.status!=='success'||result.dryRun||result.replayed||!result.documentId||result.revision===undefined||!result.storageVersion)return;
  if(!(command.type==='documents'&&command.params.action==='extract')&&command.type!=='apply_edits'&&!(command.type==='document_action'&&['reset','load'].includes(command.params.action)))return;
  this.undo.push({...(result.extraction?{operationId:result.extraction.operationId}:{}),documentId:result.documentId,name,revision:result.revision,storageVersion:result.storageVersion,label:command.type==='apply_edits'?'edit':command.params.action});
  this.undo=this.undo.slice(-80);this.redo=[];
 }
 matches(target:ManualChange,result:CadResult){return result.status==='success'&&result.documentId===target.documentId&&result.revision===target.revision&&result.storageVersion===target.storageVersion;}
 moved(action:'undo'|'redo',result:CadResult){
  if(result.status!=='success'||result.revision===undefined||!result.storageVersion)return;
  const from=action==='undo'?this.undo:this.redo,to=action==='undo'?this.redo:this.undo,entry=from.pop();if(!entry)return;
  // Undo/redo creates a new revision. Update guards on the next action in this same document.
  for(const stack of[this.undo,this.redo]){const prior=[...stack].reverse().find(item=>item.documentId===entry.documentId);if(prior){prior.revision=result.revision;prior.storageVersion=result.storageVersion;}}
  to.push({...entry,revision:result.revision,storageVersion:result.storageVersion});
 }
}
