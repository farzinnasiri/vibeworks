import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
const state=process.argv[2];assert.ok(state?.includes('vibeworks-foundations-stack-'));
const connection=JSON.parse(await readFile(join(state,'connection.json'),'utf8'));
const out=new URL('../artifacts/foundations/d/',import.meta.url);await mkdir(out,{recursive:true});
const headers={Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json','X-Vibeworks-Fingerprint':connection.fingerprint};
let sessionId;const calls=[];
async function call(type,params,expected='success'){
 const body=JSON.stringify({requestId:type==='documents'&&['create','duplicate','create_project','duplicate_project'].includes(params.action)?params.requestId??crypto.randomUUID():crypto.randomUUID(),sessionId,command:{type,params}}),start=performance.now(),response=await fetch(connection.httpUrl+'/command',{method:'POST',headers,body}),r=await response.json();
 const record={at:new Date().toISOString(),type,params,argumentBytes:Buffer.byteLength(body),resultBytes:Buffer.byteLength(JSON.stringify(r)),durationMs:performance.now()-start,status:r.status,error:r.error};calls.push(record);await appendFile(new URL('calls.jsonl',out),JSON.stringify(record)+'\n');
 assert.equal(r.status,expected,JSON.stringify(r.error));return r;
}
const agent=await call('agent_session',{action:'join',client:'D-implementation-fixture',task:'Verify bounded shaping through public commands'});sessionId=agent.session.sessionId;
const project=await call('documents',{action:'create_project',name:'D shaping verification '+crypto.randomUUID().slice(0,8),requestId:crypto.randomUUID()}),projectId=project.createdProjectId;
const create=async name=>(await call('documents',{action:'create',name,projectId,requestId:crypto.randomUUID()})).createdDocumentId;
const kernel=JSON.parse(await readFile(new URL('kernel-cases.json',out),'utf8'));
const fixtures=kernel.filter(r=>r.features?.some(f=>['loft','fillet','sweep','fill','join'].includes(f.kind)));
const seen=new Set(),documents=[];
for(const fixture of fixtures){
 const key=JSON.stringify(fixture.features);if(seen.has(key))continue;seen.add(key);
 const documentId=await create('Construction and shaping with a deliberately long component name '+String(documents.length));
 const edits=fixture.features.map(feature=>({op:'add',feature}));
 const preview=await call('apply_edits',{documentId,expectedRevision:0,dryRun:true,analyze:false,edits});assert.equal(preview.dryRun,true);
 const unchanged=await call('inspect_model',{documentId,detail:'full'});assert.equal(unchanged.revision,0);assert.equal(unchanged.document.features.length,0);
 const applied=await call('apply_edits',{documentId,expectedRevision:0,expectedStorageVersion:unchanged.storageVersion,analyze:false,edits});
 const full=await call('inspect_model',{documentId,detail:'full'});
 for(const geometry of fixture.result.geometry.filter(g=>fixture.result.visible.includes(g.featureId))){const actual=full.geometry.find(g=>g.featureId===geometry.featureId);assert.ok(actual);assert.ok(Math.abs(actual.volumeMm3-geometry.volumeMm3)<=Math.max(1e-6,geometry.volumeMm3*1e-10));assert.equal(actual.resultKind,geometry.resultKind);}
 documents.push({documentId,features:fixture.features,kinds:fixture.features.map(f=>f.kind),revision:applied.revision,storageVersion:full.storageVersion});
}
const failures=[];
async function rejects(documentId,edits,code){const before=await call('inspect_model',{documentId,detail:'full'});const r=await call('apply_edits',{documentId,expectedRevision:before.revision,analyze:false,edits},'error');if(code)assert.equal(r.error.code,code);const after=await call('inspect_model',{documentId,detail:'full'});assert.deepEqual(after.document,before.document);assert.equal(after.storageVersion,before.storageVersion);failures.push({code:r.error.code,details:r.error.details});}
const loft=documents.find(d=>d.kinds.includes('loft'));
const wrong=structuredClone(loft.features[0]);wrong.params.sections[1].profile={type:'circle',radius:6};
await rejects(loft.documentId,[{op:'update',feature:wrong}],'LOFT_CORRESPONDENCE');
const guide=documents.find(d=>d.features[0].params.guide),conflict=structuredClone(guide.features[0]);conflict.params.guide.path=conflict.params.path;
await rejects(guide.documentId,[{op:'update',feature:conflict}],'SWEEP_GUIDE_CONFLICT');
const variable=documents.find(d=>d.kinds.includes('fillet')),badRef=structuredClone(variable.features.at(-1));badRef.params.edges.refs[0].signature.center=[999,999,999];
await rejects(variable.documentId,[{op:'update',feature:badRef}],'REFERENCE_CHANGED');
const oversized=structuredClone(variable.features.at(-1));oversized.params.radius=10000;
await rejects(variable.documentId,[{op:'update',feature:oversized}],'GEOMETRY_FAILED');
const joined=documents.findLast(d=>d.kinds.includes('join')),unsupported=structuredClone(joined.features.find(f=>f.kind==='fill'));unsupported.params.boundary.forEach(c=>c.continuity='G2');
await rejects(joined.documentId,[{op:'update',feature:unsupported}],'CONTINUITY_UNSUPPORTED');
const fillDoc=documents.find(d=>d.kinds.includes('fill')&&!d.kinds.includes('join')),open=structuredClone(fillDoc.features.find(f=>f.kind==='fill'));open.params.boundary.pop();
await rejects(fillDoc.documentId,[{op:'update',feature:open}],'FILL_BOUNDARY');
const seamGate=structuredClone(joined.features.at(-1));seamGate.params.continuity={maxAngleDeg:0.5};await rejects(joined.documentId,[{op:'update',feature:seamGate}],'CONTINUITY_NOT_MET');
const domeDoc=documents.find(d=>d.features.some(f=>f.kind==='fill'&&f.params.points?.length)&&d.features[0].kind==='cylinder'),g1Dome=structuredClone(domeDoc.features.find(f=>f.kind==='fill'));
const supportTopology=await call('inspect_model',{documentId:domeDoc.documentId,select:{topology:{target:{feature:'base'}}}});const supportFace=supportTopology.inspection.topology[0].faces.find(f=>f.lineage.includes('top'));
g1Dome.params.boundary.forEach(c=>{c.continuity='G1';c.support={feature:'base',select:{faces:['top'],fragments:'one'},signature:{surface:supportFace.surface,areaMm2:supportFace.areaMm2,normal:supportFace.normal}};});await rejects(domeDoc.documentId,[{op:'update',feature:g1Dome}],'CONTINUITY_NOT_MET');
const stale=await call('apply_edits',{documentId:joined.documentId,expectedRevision:0,analyze:false,edits:[{op:'patch',id:joined.features.at(-1).id,label:'stale'}]},'error');assert.equal(stale.error.code,'REVISION_CONFLICT');
const staleStorage=await call('apply_edits',{documentId:joined.documentId,expectedRevision:1,expectedStorageVersion:999,analyze:false,edits:[{op:'patch',id:joined.features.at(-1).id,label:'stale'}]},'error');assert.equal(staleStorage.error.code,'STORAGE_CONFLICT');
for(const format of ['step','stl','glb','json']){
 const r=await call('export_model',{documentId:joined.documentId,format,skipAnalysis:true});const bytes=Buffer.from(r.artifact.base64,'base64');assert.ok(bytes.length>100);await writeFile(new URL(`cap.${format}`,out),bytes);
 if(format==='glb'){assert.equal(bytes.readUInt32LE(0),0x46546c67);const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());assert.equal(gltf.meshes.length,1);await writeFile(new URL('cap-glb.json',out),JSON.stringify(gltf,null,2));}
 if(format==='json'){const portable=JSON.parse(bytes.toString());const clone=await create('D portable construction history');await call('document_action',{documentId:clone,expectedRevision:0,action:'load',document:portable,analyze:false});const result=await call('inspect_model',{documentId:clone,detail:'full'});assert.deepEqual(result.document.features,portable.features);}
}
const fillExport=await call('export_model',{documentId:fillDoc.documentId,format:'step',skipAnalysis:true});assert.ok(fillExport.warnings.some(w=>w.includes('CONSTRUCTION_SHEETS_OMITTED')));
const analysis=await call('analyze_model',{documentId:fillDoc.documentId,action:'run'});const facts=await call('analyze_model',{jobId:analysis.analysisJob.id,action:'result',waitMs:20000});assert.equal(facts.analysis.parts,1);
const prior=await call('inspect_model',{documentId:joined.documentId,detail:'full'});const undo=await call('document_action',{documentId:joined.documentId,expectedRevision:prior.revision,action:'undo',analyze:false});assert.equal((await call('inspect_model',{documentId:joined.documentId,detail:'full'})).document.features.length,0);await call('document_action',{documentId:joined.documentId,expectedRevision:undo.revision,action:'redo',analyze:false});
const beforeExtract=await call('inspect_model',{documentId:joined.documentId,detail:'full'});const extractionId=crypto.randomUUID();const extractArgs={action:'extract',documentId:joined.documentId,expectedRevision:beforeExtract.revision,expectedStorageVersion:beforeExtract.storageVersion,requestId:extractionId,features:[joined.features.at(-1).id],name:'Exact joined cap with retained construction helpers',shared:'copy',parameters:'copy',incoming:'remap'};
const plan=await call('documents',{...extractArgs,dryRun:true});await call('documents',{...extractArgs,planToken:plan.extraction.planToken});const extracted=await call('inspect_model',{documentId:extractionId,detail:'full'});assert.ok(extracted.document.features.some(f=>f.kind==='fill'));assert.equal(extracted.geometry.at(-1).volumeMm3,beforeExtract.geometry.at(-1).volumeMm3);
await call('document_action',{documentId:joined.documentId,expectedRevision:beforeExtract.revision+1,action:'undo_operation',operationId:extractionId});assert.deepEqual((await call('inspect_model',{documentId:joined.documentId,detail:'full'})).document.features,beforeExtract.document.features);
for(const kind of ['loft','fillet','fill','join','sweep']){const help=await call('describe',{tool:'apply_edits',kind});assert.ok(help.help.schema);assert.ok(help.help.notes.length);}
await writeFile(new URL('commands.json',out),JSON.stringify({projectId,documents,failures,analysisJob:facts.analysisJob,calls:calls.length},null,2));console.log(JSON.stringify({status:'passed',cases:documents.length,calls:calls.length,projectId,joined:joined.documentId}));
