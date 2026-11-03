import type { CadDocument, CheckTarget, Feature, Frame, StoredDocument } from '../shared/protocol';
import { checkRoot, checkFeatures } from '../shared/protocol';
import { references, visibleFeatures, validateDocument, CadError } from './document';
import { expressionNames } from './parameters';
export interface ExtractArgs {requestId:string;documentId:string;expectedRevision:number;expectedStorageVersion:number;features:string[];name:string;projectId?:string;replacement?:'single'|'per_result';shared?:'error'|'copy'|Record<string,'copy'>;parameters?:'error'|'copy'|Record<string,'copy'|'move'>;componentFrame?:{mount:{featureId:string;name:string}}|{frame:Frame};incoming?:'error'|'remap';dryRun?:boolean;planToken?:string}
export interface ExtractPlan {created:CadDocument;writes:CadDocument[];closure:string[];shared:{id:string;users:string[]}[];parameters:{name:string;shared:boolean;policy:'copy'|'move'}[];incoming:{documentId:string;features:string[]}[];remaps:{documentId:string;feature:string;replacement:string;prefix:string[]}[];warnings:string[];guards:Record<string,number>}
const policy=(choice:ExtractArgs['shared']|ExtractArgs['parameters'],id:string)=>typeof choice==='object'?choice[id]:choice;
/** Pure definition planner. It never changes an input record or assigns an implicit copy policy. */
export function planExtraction(args:ExtractArgs,records:StoredDocument[]):ExtractPlan {
 const record=records.find(r=>r.document.documentId===args.documentId);if(!record)throw new CadError('DOCUMENT_NOT_FOUND','Extraction source is missing.');
 const source=structuredClone(record.document),before=record.document;
 if(before.revision!==args.expectedRevision)throw new CadError('REVISION_CONFLICT','Extraction revision changed.');
 if(record.version!==args.expectedStorageVersion)throw new CadError('STORAGE_CONFLICT','Extraction storage version changed.');
 const selected=new Set(args.features);if(!selected.size||selected.size!==args.features.length||args.features.some(id=>!visibleFeatures(before).includes(id)))throw new CadError('EXTRACT_SELECTION','Select distinct current visible results in the source document.');
 const closure=new Set<string>();const visit=(id:string)=>{if(closure.has(id))return;const f=before.features.find(f=>f.id===id);if(!f)throw new CadError('INVALID_REFERENCE',`Missing ${id}.`);closure.add(id);references(f).forEach(visit);};args.features.forEach(visit);
 const visible=new Set(visibleFeatures(before));
 const shared=before.features.filter(f=>closure.has(f.id)&&!selected.has(f.id)).flatMap(f=>{const users=before.features.filter(u=>!closure.has(u.id)&&references(u).includes(f.id)).map(u=>u.id);return users.length||visible.has(f.id)?[{id:f.id,users:[...users,...(visible.has(f.id)?['visible result retained in source']:[])]}]:[];});
 const unresolved=shared.filter(f=>policy(args.shared,f.id)!=='copy');if(unresolved.length)throw new CadError('EXTRACT_SHARED_HELPER','Choose Copy explicitly for shared helpers.',{shared:unresolved,closure:[...closure]});
 // Copies include the helper's inputs as well. Retaining only its last node would break the source DAG.
 const retained=new Set<string>();const retain=(id:string)=>{if(retained.has(id))return;retained.add(id);references(before.features.find(f=>f.id===id)!).forEach(retain);};shared.forEach(f=>retain(f.id));
 const perResult=args.replacement==='per_result'||selected.size===1;
 const replacement=(id:string)=>perResult?id:args.features[0];
 const mapTarget=(target:CheckTarget):CheckTarget=>{
  const root=checkRoot(target);if(!closure.has(root)||retained.has(root))return target;
  let result=root;if(!selected.has(root)){
   const candidates=args.features.filter(id=>{const reach=new Set<string>();const walk=(i:string)=>{if(reach.has(i))return;reach.add(i);references(before.features.find(f=>f.id===i)!).forEach(walk);};walk(id);return reach.has(root);});
   if(candidates.length!==1)throw new CadError('EXTRACT_TARGET_AMBIGUOUS','A hidden check target belongs to multiple extracted results. Select an occurrence explicitly.',{target,candidates});result=candidates[0];
  }
  const t=typeof target==='string'?{}:target;
  return {...t,feature:replacement(result),path:[result,...(typeof target==='string'?[]:target.path??[])]};
 };
 const newDocument:CadDocument={...structuredClone(before),documentId:args.requestId,revision:0,name:args.name,projectId:args.projectId??before.projectId,features:before.features.filter(f=>closure.has(f.id)).map(f=>structuredClone(f)),selectedFeatureIds:[],creation:{requestId:args.requestId,action:'extract',documentId:before.documentId,extractedFrom:{documentId:before.documentId,storageVersion:record.version,revision:before.revision,featureIds:args.features}}};
 newDocument.kind=newDocument.features.some(f=>f.kind==='instance')?'assembly':'part';
 const internal=(before.analysis?.checks??[]).filter(c=>checkFeatures(c).length>0&&checkFeatures(c).every(id=>closure.has(id)));
 newDocument.analysis={...newDocument.analysis,checks:internal};if(newDocument.analysis.ground&&!closure.has(checkRoot(newDocument.analysis.ground)))delete newDocument.analysis.ground;
 const uses=(features:Feature[])=>new Set(features.flatMap(f=>Object.values(f.bindings??{}).flatMap(expressionNames)));
 const inside=uses(newDocument.features),outside=uses(before.features.filter(f=>!closure.has(f.id)||retained.has(f.id)));
 const parameters=(before.parameters??[]).filter(p=>inside.has(p.name)).map(p=>{const common=outside.has(p.name),choice=policy(args.parameters,p.name);if(common&&choice!=='copy')throw new CadError('EXTRACT_SHARED_PARAMETER','Choose Copy explicitly for parameters used in both documents.',{parameter:p.name});return {name:p.name,shared:common,policy:common||choice==='copy'?'copy' as const:'move' as const};});
 newDocument.parameters=before.parameters?.filter(p=>inside.has(p.name));source.parameters=before.parameters?.filter(p=>!parameters.some(x=>x.name===p.name&&x.policy==='move'));
 if(!perResult){const dependents=before.features.filter(f=>!closure.has(f.id)&&references(f).some(id=>selected.has(id)&&id!==args.features[0]));if(dependents.length)throw new CadError('EXTRACT_EXTERNAL_DEPENDENT','Use one component per result to preserve outside input identities.',{features:dependents.map(f=>f.id)});}
 const remaps=args.features.map(id=>({documentId:before.documentId,feature:id,replacement:replacement(id),prefix:[id]}));
 const replacements=new Map<string,Feature>();for(const id of args.features){const key=replacement(id);if(replacements.has(key))continue;const f=before.features.find(f=>f.id===key)!;replacements.set(key,{id:key,label:f.label??args.name,kind:'instance',params:{document:args.requestId,...(perResult?{featureId:id}:{}),translation:[0,0,0],origin:[0,0,0],rotationAxis:[0,0,1],angleDegrees:0}});}
 source.features=[];const added=new Set<string>();
 for(const f of before.features){if(closure.has(f.id)&&!retained.has(f.id)){if(selected.has(f.id)){const id=replacement(f.id);if(!added.has(id)){source.features.push(replacements.get(id)!);added.add(id);}}}else source.features.push(structuredClone(f));}
 // Placement attachments in retained/outside features must follow the qualified inherited mount name.
 const remapMount=(f:Feature)=>{if(f.kind==='instance'&&f.params.attachment&&'featureId' in f.params.attachment.target){const t=f.params.attachment.target;if(selected.has(t.featureId)){const old=t.featureId;t.featureId=replacement(old);t.name=`${old}/${t.name}`;}else if(closure.has(t.featureId)&&!retained.has(t.featureId))throw new CadError('EXTRACT_MOUNT_AMBIGUOUS','Mount target is an extracted helper rather than a result.',{target:t});}};
 source.features.forEach(remapMount);
 const remapCheck=(c:NonNullable<CadDocument['analysis']>['checks'] extends (infer T)[]|undefined?T:never)=>({...c,...(c.a?{a:mapTarget(c.a)}:{}),...('b' in c?{b:mapTarget(c.b)}:{})});
 if(source.analysis){source.analysis.checks=source.analysis.checks?.map(remapCheck);if(source.analysis.ground)source.analysis.ground=mapTarget(source.analysis.ground);}
 source.selectedFeatureIds=[...new Set(source.selectedFeatureIds.map(id=>selected.has(id)?replacement(id):id))];source.kind='assembly';source.revision++;
 const incoming:ExtractPlan['incoming']=[],writes=[source];
 const original=new Map(records.map(r=>[r.document.documentId,r.document]));
 const remapPath=(documentId:string,path:string[],depth=0):string[]=>{
  if(!path.length)return path;
  if(depth>4)throw new CadError('ASSEMBLY_DEPTH','Extraction occurrence exceeds instance depth.');
  const [id,...rest]=path;
  if(documentId===before.documentId&&selected.has(id))return [replacement(id),id,...rest];
  const feature=original.get(documentId)?.features.find(f=>f.id===id);
  if(feature?.kind!=='instance')return path;
  // Direct selected-source references are retargeted to the created document, retaining their piece path.
  if(feature.params.document===before.documentId&&feature.params.featureId&&selected.has(feature.params.featureId))return path;
  return [id,...remapPath(feature.params.document,rest,depth+1)];
 };
 for(const rec of records){
  if(rec.document.documentId===before.documentId)continue;
  const candidate=structuredClone(rec.document),affected=new Set<string>();
  const remapOccurrence=(feature:string,path:string[])=>{
   const f=rec.document.features.find(f=>f.id===feature);
   if(f?.kind!=='instance')return path;
   if(f.params.document===before.documentId&&f.params.featureId&&selected.has(f.params.featureId))return path;
   return remapPath(f.params.document,path);
  };
  for(const f of candidate.features){if(f.kind!=='instance')continue;
   for(const target of [...(f.surfaceStyles??[]).map(s=>s.target),...(f.paintRegions??[]).map(r=>r.target)]){
    const old=target.path??[],path=remapOccurrence(f.id,old);
    if(JSON.stringify(path)!==JSON.stringify(old)){target.path=path;affected.add(f.id);}
   }
   if(f.params.document!==before.documentId)continue;
   if(args.incoming==='error')throw new CadError('EXTRACT_INCOMING','Incoming instances require explicit remapping.',{documentId:candidate.documentId,feature:f.id});
   if(f.params.featureId&&selected.has(f.params.featureId)){f.params.document=args.requestId;affected.add(f.id);}
   else if(!f.params.featureId){affected.add(f.id);if(f.params.attachment){const a=f.params.attachment.source;if(selected.has(a.featureId)){const old=a.featureId;a.featureId=replacement(old);a.name=`${old}/${a.name}`;}}}
  }
  const check=(target:CheckTarget):CheckTarget=>{
   if(typeof target==='string'||!target.path)return target;
   const path=remapOccurrence(target.feature,target.path);
   if(JSON.stringify(path)===JSON.stringify(target.path))return target;
   affected.add(target.feature);return {...target,path};
  };
  if(candidate.analysis){candidate.analysis.checks=candidate.analysis.checks?.map(c=>({...c,...(c.a?{a:check(c.a)}:{}),...('b'in c?{b:check(c.b)}:{})}));if(candidate.analysis.ground)candidate.analysis.ground=check(candidate.analysis.ground);}
  if(affected.size){candidate.revision++;writes.push(candidate);incoming.push({documentId:candidate.documentId,features:[...affected]});}
 }
 if(args.componentFrame){const result=newDocument.features.find(f=>f.id===args.features[0])!;if('frame'in args.componentFrame){if(result.mounts?.some(m=>m.name==='component'))throw new CadError('EXTRACT_MOUNT_CONFLICT','A component mount already exists.');result.mounts=[...(result.mounts??[]),{name:'component',frame:args.componentFrame.frame}];}}
 // Mount references resolve to exact evaluated frames in the validation phase.
 for(const document of[newDocument,...writes])validateDocument(document);
 return {created:newDocument,writes,closure:before.features.filter(f=>closure.has(f.id)).map(f=>f.id),shared,parameters,incoming,remaps,warnings:[...(shared.length||parameters.some(p=>p.shared)?['Copied helpers and parameters diverge after later source edits.']:[])],guards:Object.fromEntries(records.map(r=>[r.document.documentId,r.version]))};
}
