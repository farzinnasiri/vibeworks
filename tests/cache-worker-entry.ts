// Real OCCT in an isolated Node worker. Production uses browser Workers and URL assets.
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { GeometryEngine, loadTextFont } from '../src/cad/geometry';
import { GeometryWorkerSession } from '../src/cad/worker-session';
const session = new GeometryWorkerSession(async () => {
  const wasmBinary = await readFile(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  const oc = await initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} });
  setOC(oc);
  return new GeometryEngine(oc);
}, async () => {
  const font = await readFile(new URL('../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
  await loadTextFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
});
parentPort!.on('message', (request: import('../src/cad/types').WorkerRequest) => {
  void session.handle(request).then(reply => parentPort!.postMessage(reply, reply.ok && 'bytes' in reply.value ? [reply.value.bytes] : []));
});
