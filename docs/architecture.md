# Architecture and decisions

VibeWorks is a local mechanical design workspace. A coding agent builds through typed commands; a person
can inspect, direct, change and export the same design in the browser. Both clients use one command authority.
The project is an early implementation, not a complete SolidWorks or AutoCAD replacement.

## One design, one authority

```text
Coding agent ── MCP or CLI ──┐
                            ├── Local bridge ── bounded Node workers ── OpenCascade B-reps
Browser ── HTTP/WebSocket ───┘        │
                                     └── SQLite definitions, history, snapshots and analysis facts
```

The bridge manages authentication, command ordering, persistence and delivery. Exact operations run in
isolated Node workers with the pinned OpenCascade WASM binding through replicad. The browser displays
worker-produced geometry and submits edits and exact previews through that same authority.

This separation lets modeling continue without an open browser, bounds native failures and gives agents
and people the same modeling behavior. Display meshes are derived data. They never replace exact solid
validation, measurement or STEP construction.

Tool descriptions, validation and wire types come from `src/shared/protocol.ts`. MCP, CLI, HTTP and browser
adapters should translate transport details without introducing a second command contract. Agents discover
focused syntax through `describe`; documentation should explain workflows rather than copy the entire schema.

## Edits and recovery

An edit batch is an atomic, revision-checked operation. Successful application rebuilds the affected design,
creates one revision and one undo step. A rejected edit preserves the committed document and history. Dry
runs use the same validation and exact computation as commits.

A lost response does not establish that an edit failed. Keep request identity and reconcile the committed
state before retrying. Do not hide an uncertain transport outcome behind a success message or a blind retry.
Post-commit rendering can fail independently; retry its evidence request without repeating a successful edit.

SQLite is the durable authority for documents, operation receipts, revision history, source graph snapshots,
attribution and analysis work. Cameras, local selection and personal display preferences belong to each viewer.
Closing or moving a viewer must not silently change the saved mechanical design.

## Parts, assemblies and references

A project groups part and assembly documents. A component is an occurrence of a source document, not a copy
of its editable history. Several occurrences may follow one source. Source changes can update an assembly's
geometry without advancing the assembly's own authored revision.

Review therefore pins the root and its transitive source definitions. A root revision alone is insufficient
to identify what the reviewer saw. Extraction and multi-document operations must preserve reference and
storage guards across all affected documents.

Named mounts are static placement frames. Face and edge references use supported native lineage with
captured signatures and explicit fragment policies. Display indices are temporary picking coordinates.
Missing, changed, ambiguous or unsupported references require an honest error and repair choices. Never
silently redirect a saved reference to a nearby face.

## Exact geometry, display and appearance

Feature construction, solid validity, physical dimensions and mass derive from exact B-reps. Display detail,
lighting, printed graphics and Studio looks affect presentation. Material density determines physical mass;
a visual finish override does not change it.

Keep derived data bounded and tied to the complete source graph and engine version. Cached displays can
speed up loading but cannot certify a fresh physical analysis or supply exact STEP geometry. Old snapshots
retain their authorship; reevaluating with a different engine is explicit.

Native validity, sampled continuity, independent export readback, visual inspection and engineering judgment
answer different questions. Reports should identify which evidence supports each claim. In particular,
sampled G1/G2 checks are not a global continuity guarantee, and guided loft patch seams currently remain G0.

## Analysis and rendering

Physical analysis is an automatically advancing background job over a captured graph. Completed exact facts
persist across interruption. Pending, stale or unknown coverage must remain visible and cannot pass health.

Managed rendering uses a display-only browser process for images, GLB and Studio output. It has no authority
to edit the mechanical document or invent exact results. Renders show the design; they are not manufacturing
certificates. Exact modeling and STEP/STL/JSON exports work without this renderer.

## Human and agent collaboration

Keep location, selection, ownership, proposed action and return path clear. Editing a source and editing one
placement have different effects and must be presented explicitly. Committed History and operational Activity
also have separate jobs. Agent-reported intent is distinct from observed commands and stored changes.

Use the user's existing agent host rather than embedding a custom AI runtime. The browser is the place to
review and direct shared work, not a prerequisite for an agent to make a valid design.

## Scope and evolution

Favor small, replaceable decisions and existing tools. Add complexity when a demonstrated mechanical task,
measured failure or repeated user need requires it. Keep modeling capabilities in shared commands before
building client-specific shortcuts.

General sketch constraints, arbitrary persistent topology, a general surface-network solver, assembly
motion, remote modeling and a custom agent execution runtime are not part of the current implementation.
Future product directions belong in the README's vision, with a clear distinction from shipped behavior.

The service binds loopback and uses per-launch local credentials. It is not designed as an internet-facing
multi-user server. Connection receipts, private models and runtime credentials do not belong in Git.

See [contribution guidance](../CONTRIBUTING.md), [design principles](design.md), [terminology](glossary.md)
and [headless operation](headless.md) for the related workflows.
