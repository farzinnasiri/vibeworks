import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument} from '../src/cad/document';
import {applyEdits} from '../src/cad/edits';
import {modelHealth} from '../src/cad/health';
import {SqliteStore} from '../src/bridge/sqlite-store';
import {parseCommand,LEGACY_PROJECT_ID} from '../src/shared/protocol';
import {AGENT_TOOLS,FEATURE_KINDS} from '../src/shared/protocol';
import {describeTool} from '../src/bridge/discovery';
import {participantFocus,participantState,mergeSessions} from '../src/web/participants';
const box=(id='body')=>({id,kind:'box' as const,params:{origin:[0,0,0] as [number,number,number],size:[10,10,10] as [number,number,number]},appearance:{material:'steel' as const},mounts:[{name:'seat',frame:{origin:[0,0,0] as [number,number,number],normal:[0,0,1] as [number,number,number],xDirection:[1,0,0] as [number,number,number]}}]});
test('unevaluated relationships stay pending and cannot become failed checks or a floating verdict',()=>{
 const document=emptyDocument(),health=modelHealth(document,{geometry:[],meshes:[],visibleFeatureIds:[],analysis:{revision:0,scope:'document',parts:2,toleranceMm:0.01,contacts:[],interferences:[],floating:[{featureId:'b'}],checks:[{id:'fit',a:'a',b:'b',expect:'contact',status:'pending',ok:null,message:'Not evaluated yet'}],coverage:{totalPairs:1,completedPairs:0,totalChecks:1,completedChecks:0},durationMs:1,skipped:'Continue analysis.'} as any},null);
 assert.equal(health.failedChecks,0);assert.equal((health as any).pendingChecks,1);assert.equal(health.floating,null);assert.equal(health.ok,false);
});
test('a read target cannot erase reported feature focus',async()=>{
 const store=new SqliteStore(':memory:');try{
  const doc={...emptyDocument(),features:[box()]};await store.put(doc,null);
  const p=store.collaboration.command({action:'join',client:'test',focus:{projectId:LEGACY_PROJECT_ID,documentId:doc.documentId,featureIds:['body']}});
  store.collaboration.begin(crypto.randomUUID(),p.session.sessionId,parseCommand({type:'inspect_model',params:{documentId:doc.documentId}}));
  const session=store.collaboration.require(p.session.sessionId);assert.deepEqual(session.focus!.featureIds,['body']);assert.equal((session as any).lastTarget.documentId,doc.documentId);
 }finally{store.close();}
});
test('insertion and parameter patch preserve the authored mount and appearance without rebuilding feature definitions',()=>{
 const doc={...emptyDocument(),features:[box(),{id:'finish',kind:'chamfer' as const,params:{target:'body',distance:0.5,edges:'vertical' as const}}]};
 const command=parseCommand({type:'apply_edits',params:{documentId:doc.documentId,expectedRevision:0,edits:[{op:'add',before:'finish',feature:{id:'bore',kind:'drill_holes',params:{target:'body',centers:[[0,5,5]],diameter:2,axis:'X'}}},{op:'patch',id:'finish',params:{target:'bore'}},{op:'patch',id:'body',params:{size:[12,10,10]}}]}});
 assert.equal(command.type,'apply_edits');if(command.type!=='apply_edits')return;const result=applyEdits(doc,command.params.edits);
 assert.deepEqual(result.document.features.map(f=>f.id),['body','bore','finish']);assert.deepEqual(result.document.features[0].mounts,box().mounts);assert.deepEqual(result.document.features[0].appearance,box().appearance);
});
test('cascade deletion and explicit check cleanup are safe in the same atomic batch',()=>{
 const d={...emptyDocument(),features:[box('a'),box('b')],analysis:{checks:[{id:'gap',a:'a',b:'b',expect:'clearance' as const,minGapMm:1,note:'Separate'}]}};
 const r=applyEdits(d,[{op:'delete',featureIds:['a'],cascade:true},{op:'delete_check',id:'gap'}]);assert.equal(r.document.features.length,1);assert.equal(r.document.analysis!.checks!.length,0);assert.deepEqual((r as any).removedChecks,['gap']);assert.equal(d.features.length,2);
});
test('rigid rotation bindings accept a meaningful multi-turn value while revolve sweep limits remain strict',()=>{
 const d={...emptyDocument(),parameters:[{name:'turns',value:12.5}],features:[box(),{id:'rotor',kind:'transform' as const,params:{target:'body',translation:[0,0,0] as [number,number,number],rotationAxis:[0,0,1] as [number,number,number],angleDegrees:0,origin:[0,0,0] as [number,number,number],scale:1,copy:false},bindings:{angleDegrees:'turns * 360'}}]};
 const result=applyEdits(d,[{op:'set_parameter',name:'turns',value:12.5}]);assert.equal((result.document.features[1].params as any).angleDegrees,4500);
 assert.throws(()=>parseCommand({type:'apply_edits',params:{documentId:d.documentId,expectedRevision:0,edits:[{op:'add',feature:{id:'bad',kind:'revolve',params:{points:[[1,0],[2,0],[2,2]],origin:[0,0,0],angleDegrees:4500}}}]}}));
});
test('focused discovery examples validate against the actual shared command parser',()=>{
 for(const tool of AGENT_TOOLS){const help=describeTool({tool});assert.doesNotThrow(()=>parseCommand({type:tool,params:help.example}),tool);}
 for(const kind of FEATURE_KINDS){const help=describeTool({tool:'apply_edits',kind});assert.doesNotThrow(()=>parseCommand({type:'apply_edits',params:help.example}),kind);}
});
test('watching prefers actual work across documents, preserves feature focus during reads, and distinguishes completion and disconnect',()=>{
 const p:any={connected:true,running:0,queued:0,session:{focus:{projectId:'p',documentId:'a',featureIds:['body']},lastTarget:{projectId:'p',documentId:'a',featureIds:[]},workState:'working'}};
 assert.deepEqual(participantFocus(p)?.featureIds,['body']);assert.equal(participantState(p),'Working (reported)');
 p.activeWork=[{documentId:'b',featureIds:['spindle'],projectId:'p'}];assert.equal(participantFocus(p)?.documentId,'b');
 p.connected=false;assert.equal(participantState(p),'Disconnected');p.session.workState='completed';assert.equal(participantState(p),'Completed');
 assert.deepEqual(mergeSessions([{sessionId:'s',phase:'Layout'}] as any,[{sessionId:'s',phase:'Detail'}] as any).map(s=>s.phase),['Detail']);
});
