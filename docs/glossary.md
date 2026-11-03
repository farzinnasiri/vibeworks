# Vibeworks

Language for mechanical designs shared by people and agents. Prefer these names in the interface and documentation.

## Designs

**Project**: A collection of related parts and assemblies, optionally with a main assembly.

**Document**: The saved definition of one part or assembly. Prefer the specific kind in the interface when known.
_Avoid_: File, model, build when referring to a saved definition.

**Part**: A reusable mechanical design defined by features. It may contain more than one visible result or solid.

**Assembly**: A design containing placed components and, where needed, its own features.

**Main assembly**: The assembly designated as the project's usual starting point. A project need not have one.

**Component**: One placed occurrence of a source part or assembly. Several components may use the same source.
_Avoid_: Part when the distinction between a source and one placement matters.

**Source**: The part or assembly referenced by a component. Editing it affects every component that follows it.

**Feature**: An operation or primitive in a design's construction, such as an extrusion, union or placement.

**Result**: A feature's output that remains visible in the finished design. It may contain several solids.

**Input**: An earlier feature used to construct a later feature. An input may have several dependents.

**Variable**: A named value driving dimensions in its owning design.
_Avoid_: Parameter as a competing interface label for the same named value.

**Mount**: A named position and orientation used to place a component relative to another component or reference frame.

## Change and review

**Change**: One committed operation on a saved design, attributed to a person, agent or unknown author.

**Revision**: A numbered geometry state of one document. It does not identify its source documents' states.

**Snapshot**: A frozen view of a document and the source states it used.

**History**: The recorded sequence of committed changes, including changes by both people and agents.

**Restore**: An explicit edit that copies a historical document definition into a new revision. It preserves
later history and leaves source documents at their current revisions.

**Construction**: The ordered features that build a design within a particular state.
_Avoid_: History when referring only to feature order.

**Replay**: Playback of construction or recorded changes. It does not edit or restore the current design.

**Activity**: Observed work, including reads, queued operations and failed attempts, whether or not it creates a revision.

**Preview**: The possible result of an unapplied edit, or a visual approximation of a rendering. The context must say which.

**Checks**: Geometry validation, physical analysis and declared design targets, with freshness and unresolved findings.

**Studio**: The workspace for composing and rendering images and videos of a design.

**Look**: A complete Studio scene without material choices: lights, surroundings, floor and background.
Starting looks are built in; saved looks are personal to the browser and reusable on any model.

**Surroundings**: The environment photo around a Studio scene. It adds soft light and is what shiny parts
reflect. It appears behind the model only when the background is set to show it.
_Avoid_: Environment brightness (say surroundings strength).

**Gallery**: Finished Studio images kept in this browser, separate from the model and its history.

**Modeling service**: The local command authority and geometry workers shared by the browser and agents.

**Follow**: An opt-in mode in which the human's main view tracks an agent's current design and focus until
paused or ended. **Return to my view** restores the prior document, selection and camera.
_Avoid_: Watch.

**Side view**: An extra read-only view of an agent's current design beside the human's own view.

**MCP client**: An initialized agent connection to Vibeworks through an MCP adapter. An online modeling
service does not imply that an MCP client is connected.


## Surfaces and foundations

**Face**: One trimmed surface of an exact result. Its display index belongs to one geometry delivery.

**Edge**: One exact boundary curve shared by faces where applicable.

**Surface reference**: A persisted named selector with a captured signature and explicit fragment policy.
Numeric face indices and hashes are display aids, never semantic references.

**Fragment**: One of several faces carrying the same supported lineage meaning after a split.

**Occurrence path**: The ordered instance feature IDs and final source result identifying one placement.

**Paint region**: A named visual layer bounded by predicates on support faces. Its displayed boundary is a
triangular approximation; it does not change the physical solid.

**Crest**: A numerical, tolerance-qualified locus of section extrema on a smooth support surface. It is not a
B-rep edge.

**Graphic asset**: Image bytes addressed by their SHA256 digest, with metadata separate from the payload.

**Leaf body**: One solid in an occurrence, including individual solids inside compounds and patterns.

**Analysis job**: A durable check of a frozen source graph and its settings. It advances automatically, can be cancelled, and resumes after restart. Partial or unknown coverage is not a passing result.

**Extract**: A guarded operation that moves a dependency closure into a reusable part or assembly and replaces its original placement with a component, preserving its coordinates. Preview reports shared dependencies and incoming references; operation undo restores all affected documents.


**Construction sheet**: An exact open face used as a modeling helper. Visible for construction, with zero
physical volume; excluded from physical analysis and solid exports. JSON/history retain it.

**Authored loft correspondence**: Explicit pairing of connected profile edges across ordered sections. A seam
chooses a normalized perimeter start, exact splits trim existing curves, and reversal changes traversal. The
kernel cannot silently change edge compatibility in this mode.

**Radius station**: A radius at a normalized arclength fraction along one native forward fillet edge. It is not
a fraction of the edge's underlying curve parameter.

**Guide**: An exact curve controlling a surface. A sweep guide is an auxiliary spine that determines the
frame normal using equal curvilinear ratios and no contact. A loft guide follows a named authored segment's
start vertex through every section and bounds the corresponding surface patches.

**Sampled continuity**: Distance, normal-angle or curvature measurements at stated locations on exact surfaces.
G0 checks position, G1 checks tangent planes and G2 checks curvature in inverse millimeters. Fill and join
report these bounded measurements; sampling is not a global proof. Loft C1/C2 internal smoothness controls
are separate, and guided loft patch seams are G0.
