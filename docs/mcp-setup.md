# Connect an agent

VibeWorks uses your existing coding agent. Codex, Claude Code, Grok Build and other MCP clients connect to a local
modeling service through a stdio adapter. The browser is optional; it shows the same saved designs and
committed changes. There is no embedded chat service or separate AI subscription inside VibeWorks.

## Start the service

Use Node.js 22.13 or newer. From this checkout:

```sh
make install
make renderer-install
make headless
```

The renderer installation is needed for PNG and GLB, not exact STEP/STL/JSON modeling. Wait for the service
to report ready, then use another terminal in the same checkout:

```sh
make doctor
make mcp-config
```

`make mcp-config` prints invocation-specific Codex and Claude Code commands with your checkout and Node
paths, with the CAD tools approved for that session. Copy the command for your client. It does not register
a global server or change any configuration. The README also includes
[copyable launch commands](../README.md#connect-your-agent).
For other MCP clients, use the generic stdio configuration below.
Grok Build supports local stdio servers through its [MCP configuration](https://docs.x.ai/build/features/mcp-servers).

Codex uses `mcp_servers.cad.default_tools_approval_mode="approve"`; Claude Code uses
`--allowedTools 'mcp__cad__*'`. These settings apply to CAD tools, including model edits, while the client's
other permissions remain in place. See the official
[Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options) and
[Claude Code permission rules](https://code.claude.com/docs/en/permissions#mcp).

For the human workspace, run `make dev` instead of headless, or add `make dev-web` to an already
running headless service. Use one bridge per workspace. Stop only the service you started.

## Stdio configuration

Configure your MCP client to launch Node directly. Replace every `/absolute/path/vibeworks` with this
checkout's absolute path and use the Node executable returned by `command -v node` if your client needs
an absolute executable path.

```json
{
  "mcpServers": {
    "vibeworks": {
      "command": "node",
      "args": [
        "--import",
        "/absolute/path/vibeworks/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/vibeworks/src/bridge/mcp.ts"
      ]
    }
  }
}
```

This JSON is the common Claude-style `mcpServers` form. Clients with another configuration format need
the same command and arguments. `make mcp-config` supplies the Codex invocation form. Avoid running the
stdio adapter through `pnpm run`, whose startup banners can corrupt the protocol stream.

The adapter discovers the checkout's owner-only `.cad-local.json` connection receipt. Do not copy its token
into MCP settings. If you use `VIBEWORKS_CONNECTION_FILE` for an isolated workspace, give the adapter the
same path through its environment. The receipt is refreshed on service restart.

Check your client's MCP status to confirm that tools are available. The adapter announces the shared agent
guide, tools and strict schemas directly, so the agent does not need to read this repository to use the app.
A fresh adapter is required after command-contract changes; `doctor` reports version mismatches.

## A first task

Try a small, checkable brief:

> Create a parameterized aluminum mounting plate, 100 by 60 by 5 mm, with four diameter-5 through-holes
> and rounded corners. Inspect the exact dimensions, check the result, render it and export STEP.

An agent should enroll with `agent_session` before modeling. The MCP adapter binds the returned session
and maintains presence. Every concurrent participant needs its own session identity and should include its
returned `sessionId` on every call. Attribution is local workspace identity, not authentication or inherited
model memory.

The normal workflow is to inspect, discover focused syntax with `describe`, apply an atomic batch, inspect
health and findings, then review a render. Keep request identifiers when reconciling uncertain responses.
A render failure after a committed edit calls for a rendering retry, not a repeated edit.

Physical analysis starts once and advances automatically. Read progress with `analyze_model` using
`action:"status"` or `action:"result"` and the returned job ID. Pending, stale or unknown coverage is not a
passing design. Manufactured suitability and visual review remain separate judgments.

## CLI alternative

The CLI uses the same schemas and authority. It is useful for agents with shell access and for debugging.

```sh
pnpm --silent run cad tools
pnpm --silent run cad help apply_edits
pnpm --silent run cad schema apply_edits --kind box
pnpm --silent run cad agent_session '{"action":"join","client":"cli"}'
```

Copy `session.sessionId` from enrollment into later commands:

```sh
pnpm --silent run cad documents '{"action":"create","name":"Mounting plate"}' --session <session-uuid>
pnpm --silent run cad inspect_model --session <session-uuid>
pnpm --silent run cad describe '{"tool":"apply_edits","kind":"box"}' --session <session-uuid>
```

`--latest` resolves the connected client's document context for supported commands. Explicit document IDs
and revision guards are clearer when working on more than one part. Use `patch` for partial changes;
`update` replaces the whole feature. Read current syntax through help or `describe` rather than guessing.

To leave useful continuity, record a concise `handoff` and end the session with `leave`. A later adapter can
`resume` an inactive identity and inspect its saved activity and handoff.

## Shared human review

Activity shows reported intent alongside observed commands. History shows committed changes and captured
source graphs. A person's camera and selection remain local unless they explicitly follow an agent or
acknowledge a prepared view. Agent selection and headless rendering do not silently take over a human tab.

Use `workspace_view` to propose a view for a human reviewer and inspect its acknowledgment. A prepared or
pending view is not evidence that a person has seen or approved the design.

## Isolation and troubleshooting

For experiments, use a separate database, connection file and unused ports. See
[headless operation](headless.md) for environment variables, service diagnostics and verification scripts.
Never share a user's live database with an evaluation runner.

For a rejected request, inspect its structured error and recovery instructions. For an uncertain mutation,
read the committed state before retrying. For a contract mismatch, restart the outdated service or adapter.
Do not change global agent settings or disable validation to make a call succeed.

See [modeling examples](modeling-examples.md), [agent evaluations](evals.md) and
[architecture and decisions](architecture.md) for more detail.
