# Contributing to VibeWorks

VibeWorks is an early, local CAD application built for agents to design and people to review. Contributions
should make that shared workflow more capable, dependable or easier to understand.

## Start with a concrete problem

For a bug, include the steps, expected behavior, actual behavior and a small reproducible model when possible.
Remove private model data, local connection files and credentials before sharing a reproduction.

For a substantial feature or architectural change, open an issue first. Explain the mechanical task it enables
and how an agent and a reviewer would use it. Small fixes can go straight to a pull request.

Keep each change focused. Preserve useful existing behavior and other contributors' work. Prefer improving
an existing path over adding a second way to do the same thing. AI-assisted contributions are welcome;
the person submitting the change is responsible for understanding and checking it.

## Development

Use Node.js 22.13 or newer and Make. From the repository root:

```sh
make install
make renderer-install
make dev
```

The application opens at `http://127.0.0.1:5173`. The renderer installation provides Playwright Chromium
for image/GLB output and browser checks. It is unnecessary for exact STEP/STL/JSON modeling alone.
On a Linux machine that lacks browser system libraries, use
`make renderer-install ARGS=--with-deps`.

Portless is optional. `make dev` uses ordinary localhost; `make dev-portless` uses an existing portless
installation for a named HTTPS URL. `make preview` serves a production build without portless, and
`make preview-portless` offers the optional named URL.

For agent-only work, run `make headless`. [MCP setup](docs/mcp-setup.md) explains how to connect a client.
The [architecture guide](docs/architecture.md) records the decisions that changes must preserve.

## Check the change

```sh
make typecheck
make test
make build
```

The test script runs files serially to keep simultaneous native kernels within a smaller memory budget. For a focused
run, use `node --import tsx --test tests/<name>.test.ts`. Test the behavior affected by the change; a build
alone does not verify an interaction, exact export interoperability or live agent operation.

UI changes should cover the full journey, keyboard access, long names, light/dark appearance and a narrow
layout. Exact geometry changes need native validity, dimensions or other independent measurements and
failed-edit preservation. Export changes need readback through an appropriate independent reader.

Use an isolated workspace for verification. Never run destructive examples or experiments against an
existing user's database. Most browser verification scripts create their own temporary services. For manual
isolation, set `VIBEWORKS_DB_PATH`, `VIBEWORKS_CONNECTION_FILE`, `VIBEWORKS_BRIDGE_PORT` and
`VIBEWORKS_WEB_PORT` to separate paths and unused ports; see [headless operation](docs/headless.md).

Generated files in `artifacts/`, `output/` and `dist/` are ignored. Tests and verification scripts regenerate
their outputs. Keep reusable fixtures with the tests, and keep bundled artwork, fonts, rendering assets and
their license notices in source control.

## Pull requests

Explain the problem and resulting behavior. Include the relevant checks you actually ran, any limitations
and screenshots for visible changes. Keep future ideas separate from the implementation. If a check could
not run, say so directly. Generated images and passing unit tests are different kinds of evidence.

Follow the surrounding TypeScript and UI conventions. Use the product's existing terms, and update the
relevant user documentation when behavior changes. Avoid unrelated formatting or dependency upgrades.

## License

VibeWorks uses [Apache License 2.0](LICENSE). Contributions submitted for inclusion are under that license
unless explicitly stated otherwise. Keep third-party copyright and license notices intact. Bundled libraries,
fonts and rendering assets retain their own licenses; see [third-party notices](src/web/third-party-notices.txt).
