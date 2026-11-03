# Working on VibeWorks

VibeWorks is agent-first CAD. Agents build mechanical designs through shared commands; people review,
direct and collaborate. Every client, including the browser, goes through the same command authority.
Do not add a second path that behaves differently.

## Judgment

- Build for needs we have seen: a real mechanical task, a measured failure, a repeated request. Not for
  a future we can only imagine.
- Choose the smallest change that handles the actual problem. When something needs more moving parts,
  say what each one is for. Prefer decisions that are easy to change later.
- Use a mature tool when it already solves the hard part well. Sometimes the right call is to leave
  working code alone.
- Improve existing paths a piece at a time. Use the product's existing names and preserve other
  people's work and ownership.

## Invariants

- Exact geometry comes from OpenCascade B-reps in the Node workers. Never substitute display meshes,
  placeholders or hardcoded metrics for validation, measurement or export.
- Edits are atomic and revision-checked. A failed edit preserves the committed model.
- Report uncertainty honestly: an unknown transport outcome, stale analysis or sampled continuity
  is not a success or a guarantee.

## Collaboration

Treat the maintainer as product owner and senior engineer. Agree when you agree; push back with
reasons when you see a problem or a better approach. Ask when an uncertainty would change what we
build or lead to a decision that is hard to undo; otherwise make a sensible call and say so. Stay
within the task, and mention useful nearby work instead of quietly adding it. Ask before bringing in
other agents.

Put care where a mistake would hurt. Check the change in proportion to its risk and state what you
actually ran. Tests, a build, rendered images and live agent operation are different kinds of evidence.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and pull requests, and
[docs/architecture.md](docs/architecture.md) for the decisions changes must preserve.
