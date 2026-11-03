import initOpenCascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { GeometryEngine, loadTextFont } from './geometry';
import fontUrl from './fonts/IBMPlexSans-Bold.ttf?url';
import { GeometryWorkerSession } from './worker-session';
import type { WorkerRequest } from './types';

const session = new GeometryWorkerSession(
  async () => { const oc = await initOpenCascade({ locateFile: () => wasmUrl }); setOC(oc); return new GeometryEngine(oc); },
  () => loadTextFont(fontUrl),
);
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void session.handle(event.data).then(reply => {
    self.postMessage(reply, reply.ok && 'bytes' in reply.value ? { transfer: [reply.value.bytes] } : {});
  });
};
