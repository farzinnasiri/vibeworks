import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const state=process.argv[2],root=new URL('../',import.meta.url).pathname;
const marker=JSON.parse(await readFile(join(state,'foundations-stack.json'),'utf8'));assert.equal(marker.owner,'vibeworks-foundations-2026-11-02');
const out=new URL('../artifacts/foundations/d/',import.meta.url),log=new URL('mcp-calls.jsonl',out).pathname;
const env={...process.env,VIBEWORKS_CONNECTION_FILE:join(state,'connection.json'),VIBEWORKS_MCP_LOG:log,VIBEWORKS_MCP_LOG_PARAMETERS:'1'};
const client=new Client({name:'D-shaping-SDK-fixture',version:'1.0'});const calls=[];
async function call(name,args){const r=(await client.callTool({name,arguments:args})).structuredContent;calls.push({name,args,status:r.status,error:r.error});assert.equal(r.status,'success',JSON.stringify(r.error));return r;}
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(root,'src/bridge/mcp.ts')],cwd:root,env}));
 const enrollment=await call('agent_session',{action:'join',client:'D-sdk-fixture',task:'Typed construction, radius and sweep discovery'});env.VIBEWORKS_AGENT_SESSION=enrollment.session.sessionId;
 const project=await call('documents',{action:'create_project',name:'D stdio and CLI fixture'}),created=await call('documents',{action:'create',name:'SDK exact joined construction',projectId:project.createdProjectId});
 const fixtures=JSON.parse(await readFile(new URL('kernel-cases.json',out),'utf8')),fixture=fixtures.find(r=>r.features?.some(f=>f.kind==='join'));
 const args={documentId:created.createdDocumentId,expectedRevision:0,analyze:false,edits:fixture.features.map(feature=>({op:'add',feature}))};assert.equal((await call('apply_edits',{...args,dryRun:true})).dryRun,true);await call('apply_edits',args);
 for(const kind of ['loft','fillet','fill','join','sweep'])assert.ok((await call('describe',{tool:'apply_edits',kind})).help.schema);
 const cli=spawnSync(process.execPath,['--import','tsx',join(root,'src/bridge/cli.ts'),'inspect_model',JSON.stringify({documentId:created.createdDocumentId,detail:'full'})],{cwd:root,env,encoding:'utf8',timeout:30000});assert.equal(cli.status,0,cli.stdout+cli.stderr);const inspected=JSON.parse(cli.stdout);assert.ok(inspected.document.features.some(f=>f.kind==='fill'));
 const law=fixtures.find(r=>r.features?.some(f=>f.kind==='fillet'));
 const cliCreated=await call('documents',{action:'create',name:'CLI exact variable law',projectId:project.createdProjectId});
 const edited=spawnSync(process.execPath,['--import','tsx',join(root,'src/bridge/cli.ts'),'apply_edits',JSON.stringify({documentId:cliCreated.createdDocumentId,expectedRevision:0,analyze:false,edits:law.features.map(feature=>({op:'add',feature}))})],{cwd:root,env,encoding:'utf8',timeout:30000});assert.equal(edited.status,0,edited.stdout+edited.stderr);assert.equal(JSON.parse(edited.stdout).revision,1);
 const logged=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(logged.every(r=>r.parameters&&r.argumentBytes>0&&r.replyBytes>0));
 const commandFixture=JSON.parse(await readFile(new URL('commands.json',out),'utf8')),loft=commandFixture.documents.find(d=>d.kinds.includes('loft'));
 const review=await call('render_views',{documentId:loft.documentId,skipAnalysis:true,views:['isometric'],tileSize:256,outputs:'both',review:{profiles:[{featureId:'loft',sectionIndex:0},{featureId:'loft',sectionIndex:1}]}});assert.equal(review.image.panels.filter(p=>p.kind==='profile').length,2);
 const {copyFile}=await import('node:fs/promises');for(const [i,panel] of review.image.panels.entries())if(panel.path)await copyFile(panel.path,new URL(`loft-review-${i}.png`,out));
 await call('agent_session',{action:'leave',workState:'completed',handoff:'Isolated implementation interface fixture completed.'});
 await writeFile(new URL('interfaces.json',out),JSON.stringify({status:'passed',sdkCalls:calls.length,cliCalls:2,documentId:created.createdDocumentId,calls,parameterLog:log},null,2));console.log(JSON.stringify({status:'passed',sdkCalls:calls.length,cliCalls:2}));
}finally{await client.close();}
