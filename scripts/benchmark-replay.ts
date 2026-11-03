/** Read-only exact replay benchmark. Example: node --import tsx scripts/benchmark-replay.ts <document-id> [1,2,16] */
import {DatabaseSync} from 'node:sqlite';
import {defaultDatabasePath} from '../src/bridge/sqlite-store';
import {assemblyGraph} from '../src/cad/assemblies';
import {NodeGeometryWorker} from '../src/cad/node-worker';
import type {CadDocument} from '../src/shared/protocol';
const id=process.argv[2],steps=(process.argv[3]??'1,2').split(',').map(Number);
if(!id||steps.some(step=>!Number.isInteger(step)||step<1))throw Error('Supply a document UUID and optional comma-separated positive steps. VIBEWORKS_DB_PATH selects the database.');
const db=new DatabaseSync(defaultDatabasePath(),{readOnly:true});
let documents:CadDocument[],version:number;
try{db.exec('BEGIN');documents=db.prepare('SELECT body FROM documents').all().map(row=>JSON.parse(String(row.body)));version=Number(db.prepare('SELECT version FROM documents WHERE id=?').get(id)?.version);db.exec('COMMIT');}finally{db.close();}
const document=documents.find(doc=>doc.documentId===id);if(!document)throw Error('Document not found.');
const graph=assemblyGraph(document,documents),sources=graph.filter(doc=>doc.documentId!==id),worker=new NodeGeometryWorker();
try{for(const step of steps){const start=performance.now();const frame=await worker.evaluate(document,55_000,undefined,sources,{step,key:'read-only-benchmark'},{expectedRevision:document.revision,expectedStorageVersion:version,detail:'coarse'},true);
 console.log(JSON.stringify({document:document.name,revision:document.revision,step,wallMs:Math.round(performance.now()-start),kernelMs:Math.round(frame.stats?.durationMs??0),meshes:frame.meshes.length,valid:frame.geometry.every(info=>info.valid),cache:frame.stats?.cache}));
}}finally{await worker.close();}
