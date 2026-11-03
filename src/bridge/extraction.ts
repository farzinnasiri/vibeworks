import { createHash } from 'node:crypto';
import type { CadCommand, CadResult, OperationContext } from '../shared/protocol';
import { ENGINE_VERSION } from '../shared/protocol';
import { planExtraction, type ExtractArgs } from '../cad/extract';
import { DocumentStore } from '../cad/store';
import { NodeGeometryWorker } from '../cad/node-worker';
import { CadError } from '../cad/document';
import { findMount } from '../cad/frames';
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export async function extractComponent(store:DocumentStore,worker:NodeGeometryWorker,params:Extract<CadCommand,{type:'documents'}>['params'],context?:OperationContext):Promise<CadResult>{
 const args=params as ExtractArgs;const {dryRun,planToken,sessionId,...identityArgs}=params;const identity=digest([ENGINE_VERSION,identityArgs]);
 const prior=(await store.operation({action:'operation_request',requestId:args.requestId})).batchReceipt;
 if(prior){if(prior.identity!==identity)throw new CadError('REQUEST_ID_CONFLICT','This extraction requestId belongs to different arguments.');const {identity:_,...receipt}=prior;return {...receipt,status:'success',operation:'documents',replayed:true} as unknown as CadResult;}
 const records=await Promise.all((await store.list()).map(async d=>{const r=await store.read(d.documentId);if(!r)throw new CadError('STORAGE_CONFLICT','Workspace contents changed.');return r;}));
 const plan=planExtraction(args,records),before=records.map(r=>r.document),after=[...before.filter(d=>!plan.writes.some(w=>w.documentId===d.documentId)),plan.created,...plan.writes];
 const selections=await store.persistedSurfaceSelections();if(selections.some(s=>plan.writes.some(w=>w.documentId===s.documentId)))throw new CadError('EXTRACT_SURFACE_SELECTION','Persisted surface selections in an affected document need explicit clearing before extraction. No selection or appearance was dropped.',{documents:selections.filter(s=>plan.writes.some(w=>w.documentId===s.documentId)).map(s=>s.documentId)});
 if(args.componentFrame&&'mount'in args.componentFrame){const target=args.componentFrame.mount;const root=before.find(d=>d.documentId===args.documentId)!;const evaluation=await worker.evaluate(root,undefined,undefined,before,undefined,undefined,undefined,{meshes:false});const frame=findMount(evaluation.geometry.find(g=>g.featureId===target.featureId)?.mounts,target.name,target.featureId);const feature=plan.created.features.find(f=>f.id===args.features[0])!;if(feature.mounts?.some(m=>m.name==='component'))throw new CadError('EXTRACT_MOUNT_CONFLICT','Component mount already exists.');feature.mounts=[...(feature.mounts??[]),{name:'component',frame}];}
 const validated=await worker.validateExtraction(before,after,plan.writes.map(d=>d.documentId));
 const token=digest([ENGINE_VERSION,identity,plan]);if(!dryRun&&planToken!==token)throw new CadError('EXTRACT_PLAN_CHANGED','Apply requires the planToken from the current successful dry run. Preview again.',{planToken:token});
 const publicPlan={closure:plan.closure,shared:plan.shared,parameters:plan.parameters,incoming:plan.incoming,remaps:plan.remaps,guards:plan.guards,mounts:plan.created.features.flatMap(f=>(f.mounts??[]).map(m=>({feature:f.id,...m}))),newDocumentId:plan.created.documentId,replacement:args.replacement??'single',coordinates:'preserved',assets:Object.keys(plan.created.graphicAssets??{}),checks:plan.writes[0].analysis?.checks??[]};
 const source=plan.writes[0];const receipt:CadResult={operation:'documents',status:'success',documentId:source.documentId,revision:source.revision,storageVersion:args.expectedStorageVersion+1,createdDocumentId:plan.created.documentId,requestId:args.requestId,created:[],updated:args.features,warnings:plan.warnings,extraction:{operationId:args.requestId,planToken:token,plan:publicPlan,equivalence:validated.equivalence}};
 if(dryRun)return {...receipt,dryRun:true,revision:args.expectedRevision,storageVersion:args.expectedStorageVersion};
 await store.operation({action:'batch',requestId:args.requestId,identity,guards:plan.guards,creates:[plan.created],writes:plan.writes.map(document=>{const record=records.find(r=>r.document.documentId===document.documentId)!;return {document,history:{undo:[...record.history.undo,record.document].slice(-40),redo:[]}};}),receipt:receipt as unknown as Record<string,unknown>,context});
 return {...receipt,document:source,documents:(await store.list()).map(d=>({...d,active:d.documentId===source.documentId})),history:{canUndo:true,canRedo:false}};
}
