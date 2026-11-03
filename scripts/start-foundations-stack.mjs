import {mkdtemp,mkdir,readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {startBridge} from '../src/bridge/server.ts';
const options=new Map();for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--resume')options.set(key,true);else if(['--state','--bridge-port','--web-port','--workers'].includes(key)&&process.argv[i+1])options.set(key,process.argv[++i]);else throw Error(`Unknown or incomplete option: ${key}`);}
const project=fileURLToPath(new URL('../',import.meta.url));
const state=options.has('--state')?resolve(options.get('--state')):await mkdtemp(join(tmpdir(),'vibeworks-foundations-stack-'));
await mkdir(state,{recursive:true,mode:0o700});
const actual=await realpath(state),temp=await realpath(tmpdir()),inside=relative(temp,actual);if(inside.startsWith('..')||isAbsolute(inside)||!inside)throw Error('This fixture launcher requires a dedicated directory beneath the system temporary directory.');
const marker=join(state,'foundations-stack.json');let previous;
try{previous=JSON.parse(await readFile(marker,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(previous&&(!options.get('--resume')||previous.owner!=='vibeworks-foundations-2026-11-02'))throw Error('Existing state requires --resume and a matching fixture ownership marker.');
if(!previous){try{await stat(join(state,'workspace.db'));throw Error('Refusing an existing database without fixture ownership.');}catch(error){if(error.code!=='ENOENT')throw error;}}
const bridgePort=Number(options.get('--bridge-port')??previous?.bridgePort??45381),webPort=Number(options.get('--web-port')??previous?.webPort??45382),workers=Number(options.get('--workers')??1);
if(![bridgePort,webPort].every(p=>Number.isInteger(p)&&p>1024&&p<=65535)||bridgePort===webPort||![1,2,3,4].includes(workers))throw Error('Choose distinct unprivileged ports and 1–4 workers.');
process.env.VIBEWORKS_BRIDGE_PORT=String(bridgePort);process.env.VIBEWORKS_WEB_PORT=String(webPort);
process.env.VIBEWORKS_DB_PATH=join(state,'workspace.db');process.env.VIBEWORKS_CONNECTION_FILE=join(state,'connection.json');
const manifest={owner:'vibeworks-foundations-2026-11-02',state,project,bridgePort,webPort,workers};
let bridge,web,closing=false;
async function close(){if(closing)return;closing=true;await web?.close();await bridge?.close();}
try{
 bridge=await startBridge({port:bridgePort,workers,databasePath:process.env.VIBEWORKS_DB_PATH,connectionFile:process.env.VIBEWORKS_CONNECTION_FILE,webOrigins:[`http://127.0.0.1:${webPort}`]});await bridge.ready();
 web=await createServer({root:project,configFile:join(project,'vite.config.ts')});await web.listen();
 await writeFile(marker,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({...manifest,pid:process.pid,url:`http://127.0.0.1:${webPort}`,connectionFile:process.env.VIBEWORKS_CONNECTION_FILE,mcp:{command:'node',args:['--import','tsx',join(project,'src/bridge/mcp.ts')],cwd:project,env:{VIBEWORKS_CONNECTION_FILE:process.env.VIBEWORKS_CONNECTION_FILE,VIBEWORKS_MCP_LOG:join(state,'mcp-effort.jsonl'),VIBEWORKS_MCP_LOG_PARAMETERS:'1'}},ready:true},null,2));
 for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>void close().then(()=>process.exit(0)));
}catch(error){await close();throw error;}
