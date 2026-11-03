/** Isolated product verification. --serve retains this stack for a separate browser UI check. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startBridge } from "../src/bridge/server";
import { PROJECT_ROOT } from "../src/bridge/connection";
import { parseCommand, type CadResult } from "../src/shared/protocol";
const exec = promisify(execFile);
const out = resolve(
  process.env.VIBEWORKS_VERIFY_OUTPUT ??
    "artifacts/headless-verification-" +
      new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "vibeworks-node-proof-"));
const connectionFile = join(temp, "connection.json"),
  databasePath = join(temp, "workspace.db");
let bridge = await startBridge({
  port: 0,
  connectionFile,
  databasePath,
  webOrigins: ["http://127.0.0.1:49381"],
});
let client: Client | undefined;
let web: ReturnType<typeof spawn> | undefined;
const report: any = {
  evidence: "Deterministic product SDK/CLI/Node; no live model agent",
  startedWithoutViewer: true,
  outputs: [],
  documents: {},
};
const connect = async () => {
  client = new Client({ name: "headless-acceptance", version: "1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(PROJECT_ROOT, "src/bridge/mcp.ts")],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        VIBEWORKS_CONNECTION_FILE: connectionFile,
      } as Record<string, string>,
    }),
  );
  const enrollment = await client.callTool({name:"agent_session",arguments:{action:"join",client:"headless-acceptance"}});
  assert.ok(!enrollment.isError, JSON.stringify(enrollment.structuredContent));
};
const call = async (type: string, params: any) => {
  const result = await client!.callTool({ name: type, arguments: params });
  const receipt = result.structuredContent as any;
  assert.ok(!result.isError, JSON.stringify(receipt));
  assert.equal(receipt.authority.kind, "node");
  return { result, receipt };
};
const inspect = async (id: string) =>
  (await call("inspect_model", { documentId: id })).receipt as CadResult;
const create = async (name: string, projectId: string, kind = "part") =>
  (
    await call("documents", {
      action: "create",
      name,
      projectId,
      kind,
      requestId: randomUUID(),
    })
  ).receipt.documentId as string;
const saveBinary = async (format: string, id: string, name: string) => {
  const { receipt } = await call("export_model", {
    documentId: id,
    format,
    filename: name,
    skipAnalysis: true,
  });
  const dest = join(out, name + "." + format);
  await copyFile(receipt.artifact.path, dest);
  await rm(receipt.artifact.path);
  const bytes = await readFile(dest);
  report.outputs.push({
    name: name + "." + format,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provenance: receipt.provenance,
  });
  return dest;
};
const cleanup = async () => {
  await client?.close();
  if (web) {
    web.kill("SIGTERM");
    await new Promise<void>((r) => web!.once("exit", () => r()));
  }
  await bridge.close();
  await rm(temp, { recursive: true, force: true });
};
try {
  await bridge.ready();
  await connect();
  const initial = (await call("inspect_model", {})).receipt;
  const health = await (
    await fetch(bridge.connection.httpUrl + "/health")
  ).json();
  assert.equal(health.browserConnected, false);
  report.initialHealth = health.diagnosis;
  const projectId = randomUUID();
  await call("documents", {
    action: "create_project",
    projectId,
    name: "Headless proof",
  });
  const examples = [
    ...(
      await readFile(join(PROJECT_ROOT, "docs/step2-examples.md"), "utf8")
    ).matchAll(/```json\n([\s\S]*?)```/g),
  ].map((m) => JSON.parse(m[1]));
  const keys = ["body", "wing", "pipe-shell", "assembly"];
  const ids: string[] = [];
  for (const key of keys)
    ids.push(
      await create(key, projectId, key === "assembly" ? "assembly" : "part"),
    );
  const mapping: Record<string, string> = {};
  examples.forEach((e, i) => {
    mapping[e.documentId] = ids[i];
  });
  for (let i = 0; i < examples.length; i++)
    examples[i] = JSON.parse(
      JSON.stringify(examples[i]).replace(
        /(?:11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|33333333-3333-4333-8333-333333333333|44444444-4444-4444-8444-444444444444)/g,
        (id) => mapping[id],
      ),
    );
  examples[0].edits.unshift({ op: "set_parameter", name: "waist", value: 22 });
  examples[0].edits.at(-1).feature.bindings = {
    "sections.1.profile.radiusX": "waist",
  };
  const accepted = Date.now();
  await Promise.all([
    call("apply_edits", { ...examples[0], analyze: false }),
    call("apply_edits", { ...examples[1], analyze: false }),
  ]);
  await call("apply_edits", examples[2]);
  await call("apply_edits", examples[3]);
  const events = bridge
    .diagnostics()
    .workers.flatMap((w) => w.executions)
    .filter(
      (e) =>
        e.type === "evaluate" &&
        e.startedAt >= accepted &&
        ids.slice(0, 2).includes(e.documentId!),
    );
  assert.ok(
    events.some((a) =>
      events.some(
        (b) =>
          a.threadId !== b.threadId &&
          a.documentId !== b.documentId &&
          Math.min(a.finishedAt, b.finishedAt) >
            Math.max(a.startedAt, b.startedAt),
      ),
    ),
  );
  report.concurrency = {
    events,
    rssBytes: bridge.diagnostics().rssBytes,
    queueLimit: 32,
    workers: 2,
  };
  const pipe = await inspect(ids[2]);
  assert.ok(
    Math.abs(
      pipe.geometry!.find((g) => g.featureId === "pipe")!.volumeMm3 -
        40 * Math.PI * Math.PI,
    ) < 1e-7,
  );
  assert.ok(
    Math.abs(
      pipe.geometry!.find((g) => g.featureId === "cup")!.volumeMm3 - 1464,
    ) < 1e-7,
  );
  const before = await inspect(ids[3]);
  await call("apply_edits", {
    documentId: ids[0],
    expectedRevision: 1,
    edits: [{ op: "set_parameter", name: "waist", value: 25 }],
  });
  const refreshed = await inspect(ids[3]);
  assert.ok(
    refreshed.provenance!.sources.some(
      (s) => s.documentId === ids[0] && s.revision === 2,
    ),
  );
  assert.notEqual(
    refreshed.geometry![0].volumeMm3,
    before.geometry![0].volumeMm3,
  );
  await call("document_action", {
    documentId: ids[0],
    expectedRevision: 2,
    action: "undo",
  });
  const loft = await create("analytic-loft", projectId);
  await call("apply_edits", {
    documentId: loft,
    expectedRevision: 0,
    edits: [
      {
        op: "add",
        feature: {
          id: "frustum",
          kind: "loft",
          appearance: { material: "brass" },
          params: {
            ruled: true,
            sections: [
              {
                profile: { type: "circle", radius: 5 },
                frame: {
                  origin: [0, 0, 0],
                  normal: [0, 0, 1],
                  xDirection: [1, 0, 0],
                },
              },
              {
                profile: { type: "circle", radius: 10 },
                frame: {
                  origin: [0, 0, 20],
                  normal: [0, 0, 1],
                  xDirection: [1, 0, 0],
                },
              },
            ],
          },
        },
      },
    ],
  });
  assert.ok(
    Math.abs(
      (await inspect(loft)).geometry![0].volumeMm3 - (3500 * Math.PI) / 3,
    ) < 1e-7,
  );
  ids.push(loft);
  keys.push("analytic-loft");
  const text = await create("text", projectId);
  await call("apply_edits", {
    documentId: text,
    expectedRevision: 0,
    edits: [
      {
        op: "add",
        feature: {
          id: "letters",
          kind: "text",
          appearance: { material: "steel", color: "#aa4422" },
          params: {
            text: "Node CAD",
            plane: "XY",
            origin: [0, 0, 0],
            size: 6,
            depth: 1,
          },
        },
      },
    ],
  });
  ids.push(text);
  keys.push("text");
  await call("documents", {
    action: "set_main_assembly",
    projectId,
    documentId: ids[3],
    expectedStorageVersion: 1,
  });
  await call("analyze_model", { documentId: ids[3] });
  const image = await call("render_views", {
    documentId: ids[3],
    appearance: "materials",
    views: ["front", "right", "top", "isometric"],
    tileSize: 384,
  });
  const block = image.result.content.find((c) => c.type === "image");
  assert.ok(block && block.type === "image");
  if (block.type === "image")
    await writeFile(
      join(out, "assembly-views.png"),
      Buffer.from(block.data, "base64"),
    );
  report.image = {
    ...image.receipt.image,
    mcpImageBytes:
      block.type === "image" ? Buffer.from(block.data, "base64").length : 0,
  };
  await rm(image.receipt.image.path);
  for (let i = 0; i < ids.length; i++) {
    const model = await inspect(ids[i]);
    report.documents[keys[i]] = model;
    await saveBinary("step", ids[i], keys[i]);
    await saveBinary("json", ids[i], keys[i]);
  }
  const glb = await saveBinary("glb", ids[3], "assembly");
  await saveBinary("stl", ids[2], "pipe-shell");
  const glbBytes = await readFile(glb);
  assert.equal(glbBytes.toString("ascii", 0, 4), "glTF");
  const gltf = JSON.parse(
    glbBytes.toString("utf8", 20, 20 + glbBytes.readUInt32LE(12)).trim(),
  );
  const root = gltf.nodes.find((n: any) => n.extras?.documentId === ids[3]);
  assert.ok(
    root.matrix &&
      [0, 4, 8].every(
        (i) =>
          Math.abs(
            Math.hypot(root.matrix[i], root.matrix[i + 1], root.matrix[i + 2]) -
              0.001,
          ) < 1e-12,
      ),
  );
  assert.ok(
    Math.abs(root.matrix[6] + 0.001) < 1e-12 &&
      Math.abs(root.matrix[9] - 0.001) < 1e-12,
  );
  assert.equal(root.extras.exportedUnits, "m");
  assert.equal(root.extras.sources.length, 2);
  assert.ok(gltf.materials.length >= 2);
  report.glb = { root, materials: gltf.materials };
  // Independent OCCT import package, distinct implementation and WASM from the modeling kernel.
  const require = createRequire(import.meta.url);
  const reader = await require("occt-import-js")();
  report.imports = [];
  for (const key of keys) {
    const bytes = await readFile(join(out, key + ".step"));
    const imported = reader.ReadStepFile(bytes, null);
    assert.equal(imported.success, true, key);
    const model = report.documents[key] as CadResult;
    let triangles = 0;
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    let signedVolume = 0;
    for (const mesh of imported.meshes) {
      const v = mesh.attributes.position.array;
      for (let i = 0; i < v.length; i++) {
        min[i % 3] = Math.min(min[i % 3], v[i]);
        max[i % 3] = Math.max(max[i % 3], v[i]);
      }
      const ix = mesh.index.array;
      triangles += ix.length / 3;
      for (let i = 0; i < ix.length; i += 3) {
        const a = ix[i] * 3,
          b = ix[i + 1] * 3,
          c = ix[i + 2] * 3;
        signedVolume +=
          (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
            v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
            v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
          6;
      }
    }
    const expectedMin = [0, 1, 2].map((i) =>
        Math.min(...model.geometry!.map((g) => g.bounds.min[i])),
      ),
      expectedMax = [0, 1, 2].map((i) =>
        Math.max(...model.geometry!.map((g) => g.bounds.max[i])),
      );
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(min[i] - expectedMin[i]) < 0.05, key + " minimum");
      assert.ok(Math.abs(max[i] - expectedMax[i]) < 0.05, key + " maximum");
    }
    const exact = model.geometry!.reduce((n, g) => n + g.volumeMm3, 0);
    assert.ok(
      Math.abs(Math.abs(signedVolume) - exact) < Math.max(0.2, exact * 0.005),
      key + " mesh-volume consistency",
    );
    report.imports.push({
      key,
      meshes: imported.meshes.length,
      triangles,
      min,
      max,
      meshVolume: Math.abs(signedVolume),
      exactVolume: exact,
    });
  }
  const cli = await exec(
    process.execPath,
    ["--import", "tsx", "src/bridge/cli.ts", "doctor", "--json"],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, VIBEWORKS_CONNECTION_FILE: connectionFile },
    },
  );
  report.cliDoctor = JSON.parse(cli.stdout);
  assert.equal(report.cliDoctor.kernel.phase, "ready");
  await client!.close();
  client = undefined;
  await bridge.close();
  bridge = await startBridge({
    port: 0,
    connectionFile,
    databasePath,
    webOrigins: ["http://127.0.0.1:49381"],
  });
  await bridge.ready();
  await connect();
  const persisted = await inspect(ids[0]);
  assert.equal(persisted.revision, 3);
  assert.equal(persisted.history!.canRedo, true);
  report.restart = { revision: persisted.revision, history: persisted.history };
  report.finalDiagnostics = bridge.diagnostics();
  await writeFile(
    join(out, "REPORT.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "HEADLESS_PROOF",
    JSON.stringify({
      out,
      documents: ids,
      concurrency: report.concurrency,
      imports: report.imports.length,
    }),
  );
  if (process.argv.includes("--serve")) {
    web = spawn(
      process.execPath,
      [
        join(PROJECT_ROOT, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "49381",
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          VIBEWORKS_BRIDGE_PORT: new URL(bridge.connection.httpUrl).port,
          VIBEWORKS_WEB_PORT: "49381",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    await writeFile(
      join(out, "STACK.json"),
      JSON.stringify(
        {
          pid: process.pid,
          webPid: web.pid,
          url: "http://127.0.0.1:49381",
          connectionFile,
          documentIds: Object.fromEntries(keys.map((key, i) => [key, ids[i]])),
          projectId,
          temp,
        },
        null,
        2,
      ) + "\n",
    );
    await new Promise<void>((r) => {
      process.once("SIGTERM", () => r());
      process.once("SIGINT", () => r());
    });
  }
} finally {
  await cleanup();
}
