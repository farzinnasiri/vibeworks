# Agent behavior evals

These evals measure how an agent uses Vibeworks and what it leaves behind. They do not certify
manufacturability, visual quality or mechanism motion. The production bridge remains computation-free. Only
the offline scorer replays geometry in Node, with the same OpenCascade engine as the modeling workers.

## Tasks and expectations

Task JSON files in `scripts/evals/tasks/` contain a prompt, required feature kinds, machine-checkable score
paths and separate human review questions.

- `mounting-bracket.json`: a parameterized aluminum bracket, 80 × 50 × 40 mm overall, one solid, holes and
  finished edges. Checks include exact bounds, parameter/binding use, valid geometry and clean current health.
  A human still verifies hole count and placement and tests a dimension change.
- `planetary-gearbox.json`: sun, three planets, ring, carrier, shafts and housing. Checks require parameter
  use, separate results, declared relationships and clean current health. Human review checks tooth-count
  relationships, subsystem coverage and motion claims.
- `f1-assembly.json`: a detailed car decomposed into part documents and instances, with parameters and
  appearance during construction. There is no feature/component-count ceiling beyond the product's limits. The
  task requires `instance`, supported by the runner and offline workspace scorer. Capture every source
  document with the final assembly; an assembly JSON alone contains references, not its source geometry.

Expectations are minimum evidence gates, not a weighted quality score. They cannot prevent an agent from
producing a trivial or irrelevant model that happens to meet numeric gates. Keep human review and inspect the
returned images. Missing score fields fail expectations instead of becoming zero. Task score exit status is 1
for failed gates, 2 for invalid input or replay failure, and 0 for passed gates. Without a task file, a
defective model still produces a successful diagnostic score.

## Offline scorer

No browser, bridge or model session is needed:

```sh
npx tsx scripts/evals/score.ts artifacts/model.json
npx tsx scripts/evals/score.ts artifacts/model.json --transcript artifacts/transcript.json --task scripts/evals/tasks/mounting-bracket.json
npx tsx scripts/evals/score.ts artifacts/workspace.json --task scripts/evals/tasks/f1-assembly.json
npx tsx scripts/evals/score.ts artifacts/workspace.json --document-id <part-UUID>
```

The input is a complete document JSON or a workspace capture shaped as
`{format:'vibeworks-workspace-v1', activeDocumentId:'<UUID>', documents:[<full document JSON>, ...]}`. The
runner writes this as `workspace.json`. The scorer selects activeDocumentId unless `--document-id UUID`
selects another captured document. It validates the graph, resolves each document's bindings, loads referenced
text fonts, builds real OCCT sources/instances in dependency order and analyzes the selected document even
when its saved auto setting is false. Missing sources, duplicate document IDs, cycles, invalid result
references and assembly limits fail explicitly. Health, counts, parameters and checks describe the selected
document; `workspace.resolvedDocuments` lists its transitive source revisions and `instances` records
placements' source metadata. Unrelated captured documents are not part of that assembly's health; score parts
separately for their own physical checks. It reports:

- Feature, visible-result and solid counts, feature kinds, exact bounds and summed result volume. Summed
  volume can double-count overlapping parts.
- Parameters defined/used, bound fields/features, unions, checks and verified intent declarations.
- Fresh health, full physical analysis and receipt hints, including floating parts, overlaps, failed checks
  and missing effective appearance.
- Saved analysis setting separately from fresh evidence. JSON does not persist analysis reports. Absent
  settings mean today's default, not proof that the original agent kept analysis enabled.
- Optional transcript call counts, recoverable CAD results and errors by code, error rates, analysis calls and
  observed revisions.

Analysis uses the production 20-second budget. `--analysis-budget-ms 60000` can investigate a partial result
offline, but label that separately from the default baseline. An incomplete report stays incomplete; its
partial counts are not final totals. There is no replacement mesh or inferred success when replay fails. Each
invocation has a fresh process/kernel. The engine's synchronous operations can exceed their budget
individually, so the live runner also gives the scorer a 120-second process deadline.

Transcripts use `conversation-and-tools-v1`: `records` contains `tool_call` entries with `tool`, `callId`,
`input`, and `tool_result` entries with the same `callId` and `output`. The scorer prefers structured content
over duplicate text. It also reads JSON inside text blocks from the supplied F1 export. It never executes
recorded code. Unparseable or truncated output is unknown, not successful. The total tool-call count counts
recorded outer calls; wrapped `exec` transcripts do not expose an exact nested CAD call count. Error rates use
recoverable CAD responses as their stated denominator. New runner transcripts record direct MCP requests and
replies, including schema errors, before any forwarding.

## Live runner

This intentionally starts a stack, a headless browser and a paid agent session. Do not use it for an offline
check. Dependencies and authenticated agent CLIs must already be installed. It uses argument arrays with
`spawn`, not shell interpolation, and changes no global agent configuration.

```sh
npx tsx scripts/evals/run.ts scripts/evals/tasks/mounting-bracket.json scripts/evals/codex.example.json
npx tsx scripts/evals/run.ts scripts/evals/tasks/planetary-gearbox.json scripts/evals/claude.example.json
```

Each invocation creates `artifacts/evals/<task>-<unique>/` with a copied source stack and a dependency
symlink. It gives Vite a per-run cache, isolates `.cad-local.json` and exports, and starts direct Node
bridge/Vite processes on alternate ports. The example files use 24318/25173 for Codex and 24319/25174 for
Claude; choose unused ports for each live run. Occupied ports fail before startup; no existing process is
stopped. The named `agent-browser --session <unique>` commands use its default headless browser. No profile is
passed, so the run must not attach to a human browsing session. Verify this behavior for the installed browser
CLI before relying on isolation.

The runner waits for HTTP and a successful geometry `inspect_model`, then runs the configured agent command in
a fresh directory with the task prompt. Codex receives process-local MCP settings and per-tool approvals;
Claude receives a generated `--strict-mcp-config` file and an allowed-tools list. The generated MCP adapter
path points to the copied stack. Existing account/model defaults are inherited; Codex's other configured
servers may still be discoverable, although the task directs it to use only cad tools. Use a dedicated agent
configuration if strict tool isolation is part of the experiment.

Edit a copy of the example config to choose a model, cost cap supported by that CLI, timeout or different
browser launcher. `agentCommand`, `browserOpen` and `browserClose` are argv arrays. Supported placeholders are
`{prompt}`, `{promptFile}`, `{mcpConfig}`, `{url}`, `{session}`, `{directory}`, `{stack}`. The standalone
`{mcpArgs}` expands to provider-specific arguments and is required in `agentCommand`. No shell expansion
occurs. A custom browser-open command must return after opening the page; close must shut down only its
session. The default agent timeout is 1200 seconds, startup 60 seconds, browser open/close 30/15 seconds.
Timeouts terminate only child process groups created by this run.

The runner saves raw agent stdout/stderr, the exact invocation and prompt, normalized `transcript.json`, final
active `final.json`, all documents under `documents/`, a complete `workspace.json` used by the scorer, and
`agent-final-health.json` captured before the offline scorer. PNGs and exports remain under
`stack/artifacts/`. MCP recording omits duplicate image/resource bytes while preserving structured receipts.
`score.stdout.log` is the JSON score; `score.stderr.log` reports scorer failures. `run.json` reports
incomplete runs. The agent must open its final document, as the prompt requests, so `final.json` is the
intended result. A timeout or disconnection can prevent final-document recovery; retained logs are evidence,
not a successful run.

Paid usage can continue until the timeout, and timeout is not a token or dollar budget. The runner has no
autonomous retry loop. Set a provider-supported budget/model in the copied command and start with the bracket.
The F1 assembly task is enabled. Start it only as an authorized live evaluation after the smaller tasks; it
uses the same workspace capture and scorer. No live F1 agent run was performed for this follow-up.

## Exact live verification procedure

1. Review the configured command and browser session behavior. Run the bracket command above once with Codex,
   then with Claude using its config. Read `run.json`, the normalized transcript, `agent-final-health.json`
   and score. Verify the agents receive all eight tools, use parameters, assign appearance during
   construction, keep analysis enabled, read findings and call an issues render. Inspect actual PNG pixels and
   STEP in a separate CAD reader. These behaviors are not established by SDK or scorer tests.
2. Run the gearbox with each agent and the same model/settings used for later comparisons. Compare health,
   bindings, unions/intent and error counts, then perform the task's human review. A small before/after sample
   cannot prove general behavior improvement.
3. For a manual rod check in an authorized fresh browser document, define `length=30` and add
   `rod {from:[0,0,0],to:[30,0,0],radius:2}` bound by `{"to.0":"length"}`, with steel appearance. Add an
   aluminum box at `[30,-4,-4]`, size `[2,8,8]`. Add a contact check between them. Expect one contact, no
   interference and passing contact check. Change length to 31; expect about 12.566 mm³ overlap and a failed
   contact check. Change length to zero; expect rejection with unchanged revision/model. Undo the piercing
   edit and confirm contact returns. Use the UI Rod form, issues/material renders and STEP export, then reload
   JSON and compare exact metrics. Review worker cache hits on an unchanged replay and rebuild on an endpoint
   edit.
4. In a separate scratch document, add three boxes sharing a 7 mm size, with appearance and no parameters.
   Inspect the parameter hint. Add a shared parameter/bindings and confirm it disappears. Turn auto analysis
   off, inspect the persistent risk/freshness hint, then restore it. Check compact MCP and CLI receipts,
   including the five-hint bound.
5. Run `f1-assembly.json` with the same selected provider configuration. Confirm all part documents are
   captured, edit one reusable part, and check that every instance follows it. Inspect all required
   subsystems, suspension endpoints and whole-assembly findings before claiming completion.

## Implementation decisions

The endpoint `rod` is a separate feature because the evidence shows repeated endpoint intent. Extending
cylinder with a second, mutually exclusive origin/height/endpoint representation would complicate its schema
and bindings. Rod stays small: two world endpoint centers, a radius, flat ends and one exact OCCT cylinder
builder. No cap toggle, beam section library, attachment inference or constraint solver was added. The
existing cache includes kind and resolved params, so endpoint/radius changes invalidate it without a special
cache path. Native builder/axis handles follow the existing explicit cleanup pattern.

The rendered guide has an 850-word budget enforced by the MCP/CLI parity test. Count the rendered string
rather than source-template text. Tool descriptions state appearance in the feature shape, query fields,
text's default engrave mode, JSON's whole-document scope, document creation not changing the active document,
and calls that cannot certify completion.
