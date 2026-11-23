# Headless authority and lifecycle

`make headless` is the product modeling service. It owns the SQLite database and initializes two exact
Node `worker_threads` kernels before reporting ready. No web server, viewer tab, automation page or manual
bootstrap is required to create/manage projects, edit, inspect, analyze, undo or export STEP/STL/JSON.

```sh
make install
make renderer-install
make headless
# another terminal
make doctor
pnpm --silent run cad agent_session '{"action":"join","client":"cli"}'
# Copy session.sessionId into subsequent commands:
pnpm --silent run cad documents '{"action":"create","name":"Part"}' --session <session-uuid>
pnpm --silent run cad inspect_model '{"documentId":"UUID from creation"}' --session <session-uuid>
```

Use explicit document IDs in multi-document work. A read with no ID addresses the service's startup document.
The commands and their schemas live in `src/shared/protocol.ts`. `--latest` fills missing context;
explicit IDs/revisions are safer for concurrent work. SDK stdio instructions remain in [mcp-setup.md](mcp-setup.md).
Receipts include `authority.kind:"node"`, matched kernel packages, worker slot and source revision provenance.
These fields describe deterministic modeling work, not a live model-agent session.

The default DB is `~/Library/Application Support/Vibeworks/vibeworks.db` on macOS. `VIBEWORKS_DB_PATH`
overrides it. `VIBEWORKS_CONNECTION_FILE` overrides the owner-only connection file used by adapters.
`VIBEWORKS_BRIDGE_PORT` and `VIBEWORKS_WEB_PORT` isolate ports. There is no migration/import of old data.
SIGINT/SIGTERM stop accepted work, terminate native workers, close the managed renderer and SQLite, and
remove this service's connection file. Process termination cannot undo a transaction already committed.

## Authority and concurrency

`CommandAuthority` has two runtime slots by default. Each slot reuses the existing `CadRuntime` command and
commit implementation and its own `NodeGeometryWorker`. They read the bridge-owned SQLite store directly.
One command occupies one slot. Commands for the same document serialize in accepted order; the next
same-revision contender receives `REVISION_CONFLICT` or `STORAGE_CONFLICT`. A queued command for another
document can bypass a blocked document and use the other slot. There is no promise of unconstrained parallelism.
The bridge admits at most 32 running/queued commands; the next gets `BRIDGE_BUSY` before execution. Queue
wait counts toward the 57-second runtime deadline. Native operations have at most 55 seconds and are
terminated on expiry. A job waiting at least 50 seconds expires before dispatch. Synchronous SQLite writes
serialize briefly; independent kernel work overlaps.

A candidate does not enter committed runtime/history state before its conditional SQLite transaction succeeds.
The transaction checks root and observed transitive-source storage versions, then atomically writes model,
40-entry undo/redo, audit and feed. Persistence failures discard the worker caches. Failed geometry releases
staged shapes. Reads and outputs compare observed versions after computation, returning a conflict without
bytes if a source changed. A read snapshot has a linearization point; sources may change after it returns.
Inspecting an assembly with a semantic reference failure can return retained geometry with explicit
`referenceError`; render and geometry output remain blocked until repair. Worker/storage refresh failures
instead fail the read and retain a retry marker. A plain retry reevaluates current sources. If the source
edit already committed, its receipt stays successful with a refresh warning. Refresh never writes history
or feed rows. No stale geometry is silently certified current.

Each worker uses matched `replicad@1.1.0` / `replicad-opencascadejs@1.1.0`, resolved JS/WASM assets and bundled
IBM Plex Sans Bold. There are no placeholder meshes or alternate metrics. BRepCheck, BRepGProp and
BRepBndLib remain authoritative. Each runtime retains six sessions; each kernel retains the existing 500-entry
exact cache and 96 MiB mesh budget, plus 500 analysis parts / 32,000 pairs / 32 MiB overlap arrays. Active
results can exceed soft budgets. Workers recycle after 128 operations or 256 MiB WASM capacity. The Node JS
heap limit is 384 MiB per worker; it does not bound WASM or process RSS. Native timeout, crash or decoding
failure discards that kernel. The next operation creates a replacement. No indefinite leak-free or hard
single-operation RSS guarantee is made. Two kernels begin with about 200 MiB total WASM capacity.

Local measured evidence is in the Step 3 handoff. Worker execution intervals overlap for real independent
documents, with correct analytic results. Recent intervals and process RSS are diagnostic observations, not
a throughput or total-system-memory guarantee. Managed Chromium runs in separate OS processes.

## Images and mesh exports

PNG and GLB start one managed Playwright Chromium headless-shell process automatically. It runs bundled
Three.js contact-sheet/GLTFExporter code with Node-produced meshes, exact metrics, materials and provenance.
It has no CAD kernel, storage connection, UI or agent-code endpoint. STEP/STL come from the exact Node kernel;
JSON retains editable features/bindings/mounts. GLB is tessellated presentation geometry in metres/Y-up,
including material definitions and document/source provenance in extras. STEP/STL use millimetres; STL has
no material format. Assembly JSON references workspace IDs, not bundled source documents.

Install the rendering dependency once with `make renderer-install`. Playwright pins Chromium 145.0.7632.6,
headless shell revision 1208. It needs functioning WebGL; SwiftShader is requested for headless software
rendering. The renderer needs neither Vite nor a human tab. It performs one output at a time, accepts at most
eight outputs including running work and has a 25-second deadline including queue wait. Failure closes its browser and the
next request starts a replacement. Missing executable gives `RENDERER_DEPENDENCY`; WebGL and runtime failures
remain explicit. MCP returns actual image content as well as a saved PNG path, never an image placeholder.

On this machine Node 26 stalled in the Playwright ZIP extractor; Node 22 completed the same pinned installer:

```sh
pnpm --package=node@22 dlx node node_modules/playwright/cli.js install chromium --only-shell
```

This is an installation workaround only. The shipped authority was verified under Node 26. No global Node
or agent configuration is changed. Other OS dependency installation may need Playwright's documented host setup.

## Browser contract

Run only `make dev-web` to attach Bench to an existing headless service, or `make dev` to
start both together. `RemoteRuntime` sends the same validated commands to `/view-command` and receives a
validated display delivery. `/command` serves CLI/MCP. `/storage` is read-only; writes require commands.
The `/api` same-origin proxy retains exact host/origin checks, token auth, fingerprints and correlated UUIDs.
There is no controlling tab or automatic browser-kernel fallback. A disconnected UI retains its display
and cannot mutate until reconnected. Geometry continues with all tabs closed.

Each tab retains its own active document and selection in sessionStorage. Camera/sections/controls remain
local React/Three state. Reload restores active document/selection, while camera/control state has the same
existing reload limits. Agent document open/selection does not move human clients. Headless selection validates
IDs and applies only to the command client; it never claims a visible human selection. Polling every 1.5 seconds
and on focus reads current Node results. A polling failure retries reads later; it never repeats a mutation.
A stale draft is rejected. Lost/malformed mutation replies preserve `outcomeUnknown` and require reconciliation.

## Reproduce verification

```sh
make test
make typecheck
make build
make verify-headless
# Optional isolated stack retained for an independent human-control check:
VIBEWORKS_VERIFY_OUTPUT=artifacts/my-step3-check make verify-headless ARGS=--serve
```

The product script owns a temporary DB/connection file and removes them on exit. It uses the actual stdio MCP
entry, CLI doctor, two real Node workers, documented curved examples, parameter/source refresh, durable
undo/restart, font/text, actual MCP PNG, STEP/STL/JSON/GLB and an independent `occt-import-js` reader. It validates
GLB scale/axis/material/provenance and independent STEP bounds plus approximate mesh-volume consistency.
It records recent worker intervals and RSS. It does not establish live Codex/Claude model operation or browser
human controls. The separate Step 3 handoff records those UI checks and image review. `--serve` uses port 49381
for its isolated web server; ensure that port is unused. Stop it with Ctrl+C to clean up only its own processes.


## Current-construction projection

The optional `inspect_model.replay` object requests one exact frame without a renderer or a durable write:
`{step:1,expectedRevision:1,expectedStorageVersion:2}` together with `documentId`. The result and private
display delivery identify the same frame with `replay:{key,step,steps}`. Pass `key` on subsequent frames.
Root storage context and the observed transitive source versions must still match. Post-evaluation observed
version checks reject concurrent changes. A stale key returns `REPLAY_STALE`; worker failures remain retryable.
Semantic assembly reference failures block projection. The command remains a read among the CAD command catalog.

The worker evaluates the same full committed graph and reuses its cached per-feature exact results, display
meshes and resolved mount placements. It projects only the requested prefix, rather than retaining all prefix
meshes. Metadata expands at most 2,000 steps, each instance path at most four source levels. The existing
2,000-piece, six-million display-value, response-byte and native deadline budgets still apply. A filtered copied
result hides its retained source after construction. Attachment targets supply placement without leaking
unselected results. Frame metrics measure its exact placed B-reps; final physical analysis is not replayed.
Projection never overwrites a committed evaluation or enters model/history/feed. Browser cancellation discards
late read replies. Contact sheets, exports, authoritative camera-independent modeling and undo are unchanged.

Root history, hidden construction and detail changes use `inspect_model.display` with root `documentId`,
`expectedRevision` and `expectedStorageVersion`. Optional `step`, `featureIds` and `detail` (`auto`, `fine`,
`coarse`) choose a display projection. Root and transitive source versions are checked before delivery.
The private display wire packs shared mesh assets once and restores shared arrays on decode; rigid instance
matrices place them in world space. Consumers must apply those transforms for picking, sections and export.
Saved definitions and JSON backup bypass display evaluation. See [architecture and decisions](architecture.md)
for the authority and recovery rules. Native worker, graph and response bounds remain in force.

## Agent tracking and frozen construction

External callers enroll through `agent_session`; the adapter keeps the identity separate from geometry worker
slots. Project `activity` comes from a SQLite ledger. Commit attribution, source-version manifests and the
model revision share one transaction. A failed commit cannot leave a successful attribution. Unknown delivery
outcomes retain any recorded commit link. Browser observation polls do not add operations to the ledger.

Frozen construction loads immutable root/source definitions and reuses exact cached B-reps between steps.
Auto construction detail uses coarse tessellation; Fine remains explicit. Exact geometry and STEP stay the same.
Construction workers recycle after 128 evaluations or 768 MiB of retained WASM capacity; regular editing keeps
its 256 MiB recycling threshold. These are recycling thresholds, not per-model geometry limits or hard process
RSS ceilings. A cold first frame still rebuilds exact geometry and has a finite deadline.

A snapshot stores a version manifest and reuses the existing semantic revision bodies. It stores no B-rep, mesh,
PNG, model conversation or private reasoning. Old revisions have unknown authorship. Engine mismatch and missing
versions fail explicitly. Historical viewing never writes the selected version into the live document.
