# Duplicate projects and documents

Project duplication creates an independent variant of the documents owned by one project. Document
duplication copies one part or assembly and retains its instance sources. Both use the existing
`documents` command through the Node authority. They do not change the source or other clients' views.

## App paths

- Projects page: select a project, then **Duplicate project…**. Name the copy. The page selects the new
  project, where **Open project** opens its copied main assembly or latest document.
- Open workspace: project breadcrumb, then **Duplicate project…**. Name the copy. The workspace opens its
  copied main assembly or latest document.
- Open workspace: document breadcrumb, then the document's **⋯** or right-click menu, then **Duplicate…**.
  Name the copy and choose **Duplicate and open**.

The project dialog explains that internal sources become copies and outside sources stay shared. The
assembly dialog explains that its parts remain shared and directs users to project duplication for
independent part edits. The document dialog captures the source's displayed storage version. The project
dialog captures the project version and all its displayed document storage versions before waiting for a
name. Changes during the dialog reject the copy with `STORAGE_CONFLICT`. Review the refreshed list and retry.

An empty project stays empty when copied. It receives no invented part or main assembly.

## Commands and receipts

Run these against the intended bridge connection and registered session. First list the source project:

```sh
pnpm --silent run cad documents '{"action":"list","projectId":"11111111-1111-4111-8111-111111111111"}'
```

`projects[].version` is the project version. Each `documents[].storageVersion` belongs in the complete
`documentVersions` map. A project version alone cannot detect changed parts or project membership.

```sh
pnpm --silent run cad documents '{"action":"duplicate_project","projectId":"11111111-1111-4111-8111-111111111111","name":"F1 blue","requestId":"22222222-2222-4222-8222-222222222222","expectedStorageVersion":2,"documentVersions":{"33333333-3333-4333-8333-333333333333":5,"44444444-4444-4444-8444-444444444444":3}}'
```

Replace these example UUIDs and versions with the observed source identities. `name` is optional and
defaults to the source name plus ` copy`, truncated to 120 characters. The CLI, MCP and browser generate a
request UUID if omitted. Supplying it yourself permits recovery when delivery fails.

The additional success fields are:

```ts
{
  requestId: string;
  duplication: {
    sourceProjectId: string;
    projectId: string;                  // equals requestId
    documentIds: Record<string, string>; // source documentId -> copied documentId
    externalDocumentIds: string[];      // direct instance sources outside the source project
  };
  replayed?: true;
  projects: Project[];
  documents: DocumentSummary[];
  warnings: string[];
}
```

The normal `documentId` and `revision` in a project-management receipt describe the authority's existing
active document. Use `duplication.projectId` and `duplication.documentIds` to identify the copies. The
receipt includes a warning when any outside references remain shared. Listing does not filter the
`projects` array by `requestId`; find the project whose ID equals the original request UUID.

A single-document copy uses:

```sh
pnpm --silent run cad documents '{"action":"duplicate","documentId":"33333333-3333-4333-8333-333333333333","name":"Body blue","requestId":"55555555-5555-4555-8555-555555555555","expectedStorageVersion":5}'
```

`projectId` optionally places the copy in another existing project. `expectedStorageVersion` is optional
for existing callers; the app always supplies it. Even without it, the write checks that the source has
not changed between reading and committing. `createdDocumentId` and `documentId` identify this new
single document; its revision is 0. Its creation arguments include an explicitly supplied source storage
version. An assembly copy warns that its instance sources remain shared.

## Ownership and transaction rules

A project copy gives every owned document a new UUID, revision 0, storage version 1 and empty undo/redo
history. It preserves names, feature IDs, parameters, bindings, mounts, analysis configuration, appearance,
embedded graphics and saved presentation. Internal instance document IDs and the main assembly ID map to
the copies. Feature IDs stay stable within their new document, preserving feature and attachment links.
The original project's main assembly and every incoming reference from other projects stay unchanged.

Outside documents are deliberately shared, including their transitive source graphs. Editing an outside
source can affect both projects. Copying one assembly also deliberately shares its part sources. Browser
selection, camera, render history, computed geometry and completed analysis are not copied. Opening or
inspecting a copy uses the existing exact Node evaluation and analysis paths.

SQLite validates the complete candidate graph and exact source project membership/versions under
`BEGIN IMMEDIATE`. New project, bodies, empty histories, initial audit revisions, change feed,
attribution and request receipt commit together. Storage HTTP rejects this mutation; it must enter
through CAD command authority. `MemoryStore` implements the same candidate checks and publishes without
an await after validation.

Project request arguments and the source-to-copy map persist in `project_duplications`, an additive table
created when SQLite opens. Repeating identical arguments and the same request UUID returns the original
mapping with `replayed:true`, even if the source later changes. Changed arguments fail
`REQUEST_ID_CONFLICT`. A deleted copy fails `PROJECT_DELETED` and is never recreated under that identity.
The mapping describes the original creation; later moves, edits or deletions of individual copies do not
rewrite it. No transport layer retries mutations automatically.

After an uncertain project outcome, list projects and look for the original request UUID, then repeat
the exact original command with that UUID to recover the mapping. After an uncertain document copy,
use `documents {action:"list",requestId}` and inspect the recovered document. Do not choose a new request
UUID merely because a response was lost.

## Local verification

The duplication suite uses MemoryStore, in-memory/temporary SQLite and the real bounded Node geometry
worker through CommandAuthority. It starts no HTTP server or browser and does not open the user's database.

```sh
pnpm exec tsx --test tests/duplication.test.ts tests/cad-runtime.test.ts tests/projects.test.ts tests/validation.test.ts tests/round2-contract.test.ts tests/runtime-storage.test.ts
make typecheck
```

The suite checks nested remapping, main assembly ownership, preserved outside references and appearance,
independent exact geometry after a copied part edit, fresh history, stale metadata/membership conflicts,
forced SQLite rollback, restart recovery, deleted-copy recovery, strict advertised schemas, compact
receipts and attributed project commits. Browser layout/navigation, HTTP/MCP delivery on a live stack,
rendering fidelity and export interoperability need their own verification.
