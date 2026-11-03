import { CONTRACT_FINGERPRINT } from '../src/bridge/fingerprint.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WebSocket } from 'ws';
import { startBridge } from '../src/bridge/server.ts';
import { saveArtifact } from '../src/bridge/artifacts.ts';
import { toMcpResult } from '../src/bridge/mcp.ts';
import { runCli } from '../src/bridge/cli.ts';
import { PROJECT_ROOT, readConnection } from '../src/bridge/connection.ts';
import { forwardCommand, useAgentSession } from '../src/bridge/client.ts';
import { createServer } from 'node:http';
import { AGENT_TOOLS, WEB_ORIGIN, type CadCommand, type CadResult } from '../src/shared/protocol.ts';

const documentId = randomUUID();
const base = { documentId, revision: 7, status: 'success' as const, created: [], updated: [], warnings: [] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0noAAAAASUVORK5CYII=';
const structured = (result: CallToolResult): Record<string, any> => result.structuredContent as Record<string, any>;

test('official SDK v2 clients use the actual headless product through stdio, CLI and HTTP', async t => {
  const directory=await mkdtemp(join(tmpdir(),'cad-mcp-node-'));
  const file=join(directory,'connection.json');
  const bridge=await startBridge({port:0,connectionFile:file,workers:1});
  t.after(async()=>{await bridge.close();await rm(directory,{recursive:true,force:true});});await bridge.ready();
  const client=new Client({name:'node-product-sdk',version:'1.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(PROJECT_ROOT,'src/bridge/mcp.ts')],cwd:PROJECT_ROOT,env:{...process.env,VIBEWORKS_CONNECTION_FILE:file} as Record<string,string>}));
  t.after(()=>client.close());
  const listed=(await client.listTools()).tools;
  assert.deepEqual(listed.map(tool=>tool.name).sort(),[...AGENT_TOOLS].sort());
  const printed:string[]=[];await runCli(['tools','--json'],async()=>{throw Error('not called');},text=>{printed.push(text);});
  const cli=JSON.parse(printed[0]);assert.equal(client.getInstructions(),cli.instructions);
  for(const tool of listed){const peer=cli.tools.find((p:any)=>p.name===tool.name);assert.equal(tool.description,peer.description);assert.deepEqual(tool.inputSchema,peer.inputSchema);}
  assert.ok(cli.instructions.trim().split(/\s+/).length<=850);
  const enrollment=structured(await client.callTool({name:'agent_session',arguments:{action:'join',client:'codex-sdk-test'}}));assert.ok(enrollment.session.sessionId);
  const resumed=structured(await client.callTool({name:'agent_session',arguments:{action:'resume',agent:enrollment.agent.name,client:'codex-sdk-test'}}));
  assert.equal(resumed.session.sessionId,enrollment.session.sessionId);
  const project=structured(await client.callTool({name:'documents',arguments:{action:'create_project',name:'SDK automatic identity'}}));
  assert.match(project.createdProjectId,/^[0-9a-f-]{36}$/);
  assert.equal(project.projects.length,1);assert.equal(project.projects[0].projectId,project.createdProjectId);
  assert.deepEqual(project.documents,[],'project creation should not return unrelated workspace contents');
  const inspected=structured(await client.callTool({name:'inspect_model',arguments:{}}));assert.equal(inspected.authority.kind,'node');
  const invalid=await client.callTool({name:'apply_edits',arguments:{unexpected:1}});assert.equal(invalid.isError,true);
  const edited=structured(await client.callTool({name:'apply_edits',arguments:{documentId:inspected.documentId,expectedRevision:0,edits:[{op:'add',feature:{id:'part',kind:'box',params:{origin:[0,0,0],size:[10,20,30]},appearance:{material:'aluminum'}}}]}}));
  assert.equal(edited.results[0].volumeMm3,6000);assert.ok(edited.analysisJob);if(edited.analysisJob.state!=='complete')assert.equal(edited.health.ok,false);const checked=structured(await client.callTool({name:'analyze_model',arguments:{jobId:edited.analysisJob.id,action:'result',waitMs:20000}}));assert.equal(checked.health.analysis,'current');
  const prepared=structured(await client.callTool({name:'workspace_view',arguments:{action:'present',documentId:inspected.documentId,state:{panes:[{view:'top'}]}}}));
  assert.equal(prepared.workspaceView.request.status,'saved');
  const preparedStatus=structured(await client.callTool({name:'workspace_view',arguments:{action:'status',requestId:prepared.workspaceView.request.requestId}}));
  assert.equal(preparedStatus.workspaceView.request.requestId,prepared.workspaceView.request.requestId,'status uses a fresh transport identity rather than replaying the presentation mutation');
  await forwardCommand({type:'agent_session',params:{action:'join',client:'cli-test'}},async()=>bridge.connection);t.after(()=>useAgentSession(undefined));
  const output:string[]=[];assert.equal(await runCli(['inspect_model',JSON.stringify({documentId:inspected.documentId})],command=>forwardCommand(command,async()=>bridge.connection),text=>{output.push(text);}),0);assert.equal(JSON.parse(output[0]).revision,1);
  const image=await client.callTool({name:'render_views',arguments:{documentId:inspected.documentId,views:['top','isometric'],tileSize:192,appearance:'materials'}});
  assert.equal(image.isError,undefined,JSON.stringify(image));const block=image.content.find(c=>c.type==='image');assert.ok(block && block.type==='image' && block.data.length>1000);
  const receipt=structured(image);assert.equal(receipt.authority.kind,'node');assert.equal(receipt.image.base64,undefined);t.after(()=>rm(receipt.image.path,{force:true}));
  assert.deepEqual(receipt.image.tiles.map((tile:any)=>tile.label),['TOP · from +Z','ISOMETRIC · from +X −Y +Z']);
  // Chosen cameras: a 4 mm detail sphere on the 10 x 20 x 30 box, zoomed past what the named views show.
  const shot=structured(await client.callTool({name:'render_views',arguments:{documentId:inspected.documentId,tileSize:192,shots:[{from:[1,0,0],frame:{center:[10,10,15],radiusMm:4},label:'corner'},{view:'front',projection:'perspective'}]}}));
  t.after(()=>rm(shot.image.path,{force:true}));
  const [detail,perspective]=shot.image.tiles;assert.equal(detail.label,'corner');assert.deepEqual(detail.target,[10,10,15]);assert.deepEqual(detail.up,[0,0,1]);
  assert.ok(Math.abs(detail.heightMm-8*1.06)<1e-3&&Math.abs(detail.mmPerPixel-detail.heightMm/162)<1e-4,JSON.stringify(detail));assert.equal(perspective.projection,'perspective');
  const empty=structured(await client.callTool({name:'render_views',arguments:{documentId:inspected.documentId,shots:[{view:'top',frame:{center:[900,900,900],radiusMm:5}}]}}));assert.equal(empty.error.code,'EMPTY_SHOT');
  const after=structured(await client.callTool({name:'render_views',arguments:{documentId:inspected.documentId,tileSize:128,shots:[{view:'top',hide:['part'],ghost:['part']}]}}));assert.equal(after.error.code,'EMPTY_SHOT');
  const exported=structured(await client.callTool({name:'export_model',arguments:{documentId:inspected.documentId,format:'json'}}));assert.equal(exported.authority.kind,'node');assert.equal(JSON.parse(await readFile(exported.artifact.path,'utf8')).features[0].id,'part');t.after(()=>rm(exported.artifact.path,{force:true}));
  const created = await forwardCommand({type:'documents',params:{action:'create',name:'CLI explicit target'}},async()=>bridge.connection);
  assert.equal(created.status,'success');
  const targetOutput:string[]=[];
  assert.equal(await runCli(['apply_edits',JSON.stringify({documentId:created.documentId,edits:[{op:'add',feature:{id:'target_box',kind:'box',params:{origin:[0,0,0],size:[2,3,4]}}}]}),'--latest'],command=>forwardCommand(command,async()=>bridge.connection),text=>{targetOutput.push(text);}),0);
  assert.equal(JSON.parse(targetOutput[0]).revision,1);

});

test('actual mcp.ts entry point works from another cwd with no stdout logging', async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', join(PROJECT_ROOT, 'node_modules/tsx/dist/loader.mjs'), join(PROJECT_ROOT, 'src/bridge/mcp.ts')], cwd: tmpdir() });
  const client = new Client({ name: 'actual-entry-test', version: '1.0' }); t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, AGENT_TOOLS.length);
  const invalid = await client.callTool({ name: 'export_model', arguments: { format: 'step', filename: '../escape.step' } }); assert.equal(invalid.isError, true); assert.equal(structured(invalid).error.code, 'INVALID_COMMAND');
});

test('artifact writer prevents traversal, rejects symlinks and does not overwrite existing exports', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cad-artifacts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(saveArtifact(Buffer.from('x'), '../outside.step', 'text/plain', directory));
  const first = await saveArtifact(Buffer.from('first'), 'model.step', 'application/step', directory);
  const second = await saveArtifact(Buffer.from('second'), 'model.step', 'application/step', directory);
  assert.notEqual(first.path, second.path); assert.equal(await readFile(first.path, 'utf8'), 'first');
  const link = join(directory, 'symlink'); await symlink(directory, link); await assert.rejects(saveArtifact(Buffer.from('x'), 'model.step', 'text/plain', link), /symlink/);
});

test('missing/corrupt binary outputs become actionable MCP tool errors', async () => {
  const render: CadCommand = { type: 'render_views', params: {} };
  for (const image of [undefined, { mimeType: 'image/png' as const, base64: Buffer.from('not PNG').toString('base64'), width: 1, height: 1, tiles: [{ label: 'TOP', projection: 'orthographic' as const, eye: [0, -10, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], widthMm: 10, heightMm: 10, mmPerPixel: 0.1 }] }]) {
    const result = await toMcpResult(render, { ...base, operation: 'render_views', image }); assert.equal(result.isError, true); assert.equal(structured(result).error.code, 'IMAGE_DELIVERY_FAILED');
  }
  const result = await toMcpResult({ type: 'export_model', params: { format: 'step' } }, { ...base, operation: 'export_model', artifact: { filename: 'x.step', mimeType: 'application/step', base64: 'eA==', byteLength: 200 } });
  assert.equal(result.isError, true); assert.equal(structured(result).error.code, 'EXPORT_DELIVERY_FAILED');
});

test('connection reader rejects permissive files, symlinks and non-loopback URLs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cad-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.cad-local.json');
  const connection = { httpUrl: 'http://127.0.0.1:4318', wsUrl: 'ws://127.0.0.1:4318/runtime', token: 'a'.repeat(64), pid: process.pid, protocolVersion: 1, fingerprint: CONTRACT_FINGERPRINT };
  await writeFile(path, JSON.stringify(connection), { mode: 0o600 }); assert.deepEqual(await readConnection(path), connection);
  await writeFile(path, JSON.stringify({ ...connection, httpUrl: 'http://127.0.0.1:80', wsUrl: 'ws://127.0.0.1:80/runtime' }));
  assert.equal((await readConnection(path)).httpUrl, 'http://127.0.0.1:80');
  await writeFile(path, JSON.stringify(connection));
  await chmod(path, 0o644); await assert.rejects(readConnection(path), /owner-only/); await chmod(path, 0o600);
  const link = join(directory, 'link'); await symlink(path, link); await assert.rejects(readConnection(link), { code: 'ELOOP' });
  await writeFile(path, JSON.stringify({ ...connection, httpUrl: 'http://remote.example' })); await assert.rejects(readConnection(path));
});

test('adapter never retries an ambiguous HTTP mutation and reports its request ID', async (t) => {
  let deliveries = 0; const requestIds: string[] = [];
  const server = createServer(async (req) => {
    if (req.method !== 'POST') { req.socket.destroy(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    deliveries++; requestIds.push(JSON.parse(Buffer.concat(chunks).toString()).requestId); req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = { httpUrl: `http://127.0.0.1:${address.port}`, wsUrl: '', token: 'test', pid: process.pid, protocolVersion: 1 as const, fingerprint: CONTRACT_FINGERPRINT };
  const command: CadCommand = { type: 'apply_edits', params: { documentId, expectedRevision: 7, edits: [{ op: 'add', feature: { id: 'plate', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 5] } } }] } };
  const result = await forwardCommand(command, async () => connection);
  assert.equal(deliveries, 1); assert.equal(result.error!.code, 'BRIDGE_TRANSPORT_ERROR'); assert.equal(result.error!.outcomeUnknown, true);
  assert.equal((result.error!.details as any).requestId, requestIds[0]);
  const absent = await forwardCommand(command, async () => { throw new Error('absent'); }); assert.equal(absent.error!.code, 'BRIDGE_NOT_RUNNING'); assert.equal(absent.error!.outcomeUnknown, undefined);
});
