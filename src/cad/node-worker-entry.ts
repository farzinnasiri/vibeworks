import { parentPort, threadId } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initOpenCascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { CadError } from "./document";
import { GeometryEngine, loadTextFont } from "./geometry";
import { GeometryWorkerSession } from "./worker-session";
import type { WorkerRequest } from "./types";

const require = createRequire(import.meta.url);
const session = new GeometryWorkerSession(
  async () => {
    for (const name of ["replicad", "replicad-opencascadejs"]) {
      const metadata = JSON.parse(
        await readFile(
          new URL("../package.json", import.meta.resolve(name)),
          "utf8",
        ),
      );
      if (metadata.version !== "1.1.0")
        throw new CadError(
          "KERNEL_VERSION_MISMATCH",
          `Expected ${name}@1.1.0, installed ${metadata.version}. Run npm ci for the matched kernel.`,
        );
    }
    // Resolve the WASM beside the matched JS package, independent of cwd and bundler URLs.
    const wasmBinary = await readFile(
      require.resolve("replicad-opencascadejs/wasm"),
    );
    const oc = await initOpenCascade({
      wasmBinary,
      print: () => {},
      printErr: () => {},
    });
    setOC(oc);
    return new GeometryEngine(oc);
  },
  async () => {
    const font = await readFile(
      new URL("./fonts/IBMPlexSans-Bold.ttf", import.meta.url),
    );
    await loadTextFont(
      font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength),
    );
  },
  (id,event)=>parentPort!.postMessage({id,analysisEvent:event}),
);
parentPort!.on("message", (request: WorkerRequest) => {
  const startedAt = Date.now();
  parentPort!.postMessage({
    id: request.id,
    executionStarted: {
      threadId,
      startedAt,
      type: request.type,
      ...("document" in request
        ? { documentId: request.document.documentId }
        : {}),
    },
  });
  void session.handle(request).then((reply) =>
    parentPort!.postMessage(
      {
        ...reply,
        execution: {
          threadId,
          startedAt,
          finishedAt: Date.now(),
          type: request.type,
          ...("document" in request
            ? { documentId: request.document.documentId }
            : {}),
        },
      },
      reply.ok && "bytes" in reply.value ? [reply.value.bytes] : [],
    ),
  );
});
