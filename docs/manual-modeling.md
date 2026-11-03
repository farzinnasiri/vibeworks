# Manual mechanical modeling

The manual tools and MCP use the same revision-checked commands, exact OpenCascade worker, feature document
and undo history. Dimensions are millimeters; angles are degrees. New documents use schema version 1. The current fresh workspace does not migrate old model data. Exact geometry runs in the local Node authority; the browser displays results and submits the same commands. Start the service before using manual controls. Closing the browser does not stop agent modeling.

## The useful core

| Manual control                    | Agent equivalent                                                 | Behavior                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Insert part                       | add `instance` through `apply_edits`                             | Pick a document and visible results, then place numerically or attach by a named source/target mount. Available in the assembly dock and command search.                                                                                                                      |
| Box / Cylinder                    | `apply_edits` add `box` / `cylinder`                             | Minimum-corner XYZ box, or bottom-center cylinder along +Z.                                                                                                                                                                                                              |
| Rod                               | add `rod` through `apply_edits`                                  | Flat-ended circular bar between world endpoint centers, with radius.                                                                                                                                                                                                     |
| Extrude                           | add `extrude`                                                    | Rectangle, circle, ellipse, polygon or exact arc/Bezier boundary on a preset or arbitrary local plane. Edit dimensions, curve segments, origin, normal and U direction. Depth follows the normal.                                                                                     |
| Loft / Sweep / Shell             | add `loft` / `sweep` / `shell`                                    | Ordered profile sections for smooth bodies and pitch variation; open curved paths for swept parts; inward thickness with counted planar opening queries for hollow parts. |
| Revolve                           | add `revolve`                                                    | Closed profile of radius/height points, rotated 0.1–360 degrees about world Z through an explicit origin. Useful for shafts, stepped flanges and spacers.                                                                                                                |
| Hole                              | add `drill_holes`                                                | Up to 32 circular holes along world X, Y or Z, automatically through the target bounds. Each center must remove material. The coordinate along the hole axis is ignored.                                                                                                 |
| Pattern                           | add `pattern`                                                    | Linear or circular copies of a solid as one compound, without Boolean fusion.                                                                                                                                                                                            |
| Text                              | add `text`                                                       | Engraves into or embosses onto a target solid's face plane, in IBM Plex Sans Bold. ASCII, up to 80 characters.                                                                                                                                                           |
| Move / Rotate / Scale             | add `transform`, or update `instance` for rigid placement        | Uniform scale about pivot, then axis-angle rotation about pivot, then world XYZ translation. Handles submit one feature on release.                                                                                                                                      |
| Duplicate                         | `transform` with `copy: true`                                    | Retains the source and appends a linked copy, optionally translated, rotated or scaled.                                                                                                                                                                                  |
| Mirror                            | add `mirror`                                                     | Reflection through XY, XZ or YZ at an explicit origin. Optionally retains the source.                                                                                                                                                                                    |
| Union / Cut / Intersect           | add `union` / `subtract` / `intersect`                           | First selected solid is the initial target; the inspector chooses the remaining tools. Union can contain disconnected solids. An empty intersection fails.                                                                                                               |
| Fillet / Chamfer                  | add `fillet` / `chamfer`                                         | All edges, vertical edges, or a query: parallel to an axis, on a plane, near points, by curve type or length. **Pick edges** in the tool adds clicked viewport edges as near points. Chamfer distance is equal setback. Kernel failures preserve the committed document. |
| Inspector parameters              | `apply_edits` update                                             | Typed fields for every feature kind; replay all dependent geometry. Name changes use the same operation.                                                                                                                                                                 |
| Material, colour, finish          | `appearance` on any feature                                      | 26 materials, a colour override and matte/satin/gloss/mirror. Children inherit their target's look. Mass follows from density and exact volume.                                                                                                                          |
| Delete                            | `apply_edits` delete                                             | Reject dependent features by default. Explicit cascade deletes the transitive dependent set. Undo restores it. Construction inputs may reappear after deleting a result.                                                                                                 |
| Click / Shift-click / Add         | `select_features`                                                | Shared semantic object selection. Selection keeps the revision, does not rebuild geometry and adds no undo step, so clicking around never makes an agent's pending edit stale.                                                                                           |
| Physical analysis panel           | `analyze_model`; `apply_edits` with `set_analysis` / `set_check` | Touching, interpenetrating and floating parts, plus declared checks. "Analyze after every change" is the document's shared setting.                                                                                                                                      |
| Document switcher                 | `documents`                                                      | New part and New assembly, plus duplicate, rename, delete and open. Referenced documents cannot be deleted.                                                                                                                                                              |
| Undo / Redo, save/load and export | `document_action` / `export_model`                               | History, persistence, named and coloured STEP, STL, GLB with materials, or editable JSON.                                                                                                                                                                                |

## Interaction

The canvas fills the workspace. Build and Activity share the left panel; the inspector and active tool share
the right. On phones, Build and Inspect buttons open bottom sheets. With no selection, the dock offers
creation tools. With one selection, it offers transforms, hole/edge tools and copies; with several, it offers
Boolean operations. New and Command/Ctrl+K make every creation tool available regardless of selection. File
contains editable JSON; Export offers STEP and STL for all results or the selected object. GLB is available
through `export_model` in MCP, CLI or HTTP.

Open a tool, enter values and apply. While a form has an unapplied value, the viewport shows the exact kernel
result of that value as a dry run (`apply_edits` with `dryRun`) and the panel compares its volume and extents
with the committed model. A value that would fail says so before you apply it. Drag a field label, or an X/Y/Z
badge, sideways to change the number continuously; Shift is fine and Alt coarse. Move, rotate and scale
preview through their handles instead. Fields use the document revision at tool opening. If an agent or
another control changes the model, the form asks for an explicit refresh before applying. This prevents an old
form from replacing a newer edit.

Select a single visible result to use handles. `W` moves, `E` rotates, `R` scales uniformly. Drag the colored
handles, rings or center control. Release submits exact geometry; the preview alone never changes CAD state.
`Escape` cancels. Snap rounds movement to 1 mm, rotation to 15 degrees and scale to 0.1 increments. Numeric
forms remain available for precise pivots and dimensions. To change an earlier construction feature, return
to latest, select its row in Build and edit Parameters in the inspector.

The slider at the top of Build shows the current model's ordered construction after each feature. Later
parameter and feature edits are included. This is view-only construction, not original edit chronology,
or undo. It pins the root and all source versions when playback starts. Replay pauses/resumes; 1× cycles through 2×, 4× and 8×. `[` and `]` step when
focus is outside a field. Escape or Back to latest exits, including Escape on a history slider. Editing,
exports and final-model inspector measurements are disabled or hidden while viewing construction.

For an assembly, Assembly steps keeps the top-level timeline. Include components builds each referenced
part's actual features before completing its instance, including nested assemblies. Repeated instances build
separately. Only selected source results and their geometric construction appear. Each intermediate shape
uses the instance's resolved final placement, including mount attachment, and inherits source appearance and
instance overrides. A later root operation appears at its own step. The path and step count identify what is
shown. The last component step stays available until you return to latest. Camera and selection survive replay.

Component steps load one exact frame at a time. Scrubbing replaces the pending destination; the displayed
step count describes the frame already shown. A canceled reply cannot reappear. A failed load keeps the last successful frame and offers Retry or Back to latest. A first-frame load has a finite timeout. Root/source edits do not change the frozen graph. Document switching exits replay. Reconnection can retry the same snapshot without retrying writes. Invalid references
block component replay until repaired. More than 2,000 expanded steps returns a limit message; Assembly steps
remains available. On a phone, close Build to see the full viewport and use the bottom replay controls.

Show topology edges in the view controls toggles between shaded with edges, the default, and plain shaded.
Selection, hover, construction ghosts, issue outlines and edge-picking feedback remain visible. Sections,
measurement and handles still work. Measurements clear when displayed geometry changes. This changes no
exact geometry, measurements or exports.

Start orbit rotates the camera steadily around its current target, keeping distance, height and zoom. A Top
or Bottom view tilts to 45 degrees when orbit starts because a pole view has no azimuth. Start is always
explicit, including with reduced motion. Stop orbit, a pointer/wheel gesture, a tool, Fit, named view, replay,
a root/source change, hidden tab or unavailable authority stops it. It never restarts automatically. These
choices belong to this tab. Agent contact sheets and GLB exports remain static.

## Build parts, then assemble

Use New part on the empty screen or document menu, give it a name, and build its feature history. Create a New
assembly and choose Insert part. Select the part document and optionally one visible result, then set its
translation, rotation axis, angle and pivot. Apply inserts one exact instance. Select it and use Move or
Rotate with the existing handles or numeric fields. These actions update its placement as one undo step and
preserve its instance ID.

Build lists instances with their part names and resolved revisions. The inspector shows the source and Open
part. After opening it, the top-bar return button goes back to the assembly. Appearance override changes only
the specified fields; Use part appearance restores inheritance. Editing the source updates open assemblies
automatically. The assembly revision stays unchanged; health records the source revisions used. A failed
source reference leaves previous geometry visible with a repair message and blocks renders and geometry
exports. Select the instance in Build and choose a valid source/result. JSON export with `skipAnalysis:true`
remains available for recovery.

Assembly JSON references workspace document IDs. Export every source document separately to keep the editable
parts; there is no bundle or ID-remapping import. When restoring into another workspace, load the sources
first and update instance document IDs manually, from the parts upward. STEP/STL/GLB are geometry exports.
Assemblies place parts statically. Mount mating sets a fixed placement; it does not solve joints or simulate motion.

## Parameters

**Params** in the left panel lists named design values. Add one (for example `thickness = 5`), then type its
name, or an expression like `thickness + 20` or `width - 2 * hole_inset`, into any number field of a tool or
the inspector. Bound fields show the expression on a dashed background, with the resolved value beside it.
Typing a plain number unbinds the field. Arithmetic without names, such as `2*15`, just stores the result.
Changing or dragging a value in Params previews the whole part exactly; Apply commits all changed values as
one transaction and one undo step. A parameter that still drives fields cannot be deleted. Agents use the same
mechanism through `apply_edits` (`set_parameter`, `delete_parameter`, and `bindings` on features).

## Hole layouts, section and measure

The Hole tool's Layout control generates centers as a bolt circle (radius, count, start angle, center) or a
grid (columns, rows, pitch, first hole) across the drilling axis. Values update the markers and exact preview
as you type. The document stores only the resulting centers.

Section view (`Q`, view bar) clips the display along X, Y or Z at an adjustable offset, with cut faces filled
orange; the flip control keeps the other side. Clipped material cannot be picked. Measure (`G`) reports the
distance and ΔX/ΔY/ΔZ between two clicked points. Clicks within 8 px of a mesh corner snap to it, so
edge-to-edge and corner readings are exact; points on curved faces are display-mesh picks, accurate to about
the 0.05 mm tessellation. Neither tool changes the model.

Shift/Ctrl/Command-click adds or removes objects from selection. The Add toggle in the dock provides the same
behavior with ordinary clicks or taps. Boolean operations require at least two selected objects; deletion
accepts several. Transform and dimension controls operate on one object at a time. The viewport can orbit, pan
and zoom using standard Three.js OrbitControls.

Transforms and mirrors append history features rather than baking a display matrix into meshes. Copies retain
parametric links to their sources. Editing a source rebuilds its copies and downstream operations.
Delete/cascade refers to these actual dependencies, even when an input is hidden in the viewport.

## Example: robot mounting bracket

1. Extrude an 80 x 50 mm rectangle on XY by 5 mm.
2. Add an upright box at [-40,20,5], size [80,5,35].
3. Select both and Union.
4. Drill diameter-6 holes along Z at [-25,-10,0] and [25,-10,0].
5. Drill diameter-6 holes along Y at [-25,0,25] and [25,0,25].
6. Inspect, move or rotate the result, then export STEP.

The unrounded bracket has volume `34000 - 180*PI` mm3. The first two holes cross the 5 mm foot; the next two
cross the 5 mm upright. `make demo-mechanical ARGS=--reset` reproduces this through MCP, with a JSON backup
before replacing the connected document. It also checks a turned shaft, chamfer, copies/mirror, scale,
intersection/cut, dependency deletion/history and exports. It is an SDK test, not a model-driven agent
session.

## Deliberate limits

These tools cover common plates, brackets, housings made by Boolean cuts, shafts, spacers and flanges. Polygon
points and numeric dimensions are editable; there is no interactive constrained sketch workbench. There are no
arbitrary-axis hole features, draft, nonplanar sweep paths, threads, joints, or motion simulation. Physical
analysis reports static contact, interference and connectivity only. Orient a hole-bearing part with Transform
when a world-axis drill is insufficient. Scale is uniform. Feature references are semantic IDs; persistent
face naming remains outside this implementation.

Each document is limited to 250 features. Assemblies may reference 64 documents with at most four instance
levels and 2,000 unique features. The evaluated graph has a six-million display-value limit and each evaluated
document has a 2,000 expanded-piece limit. The persistent worker reuses exact geometry by content. Handle
gestures consume one history step; instance Move/Rotate updates placement, while other transforms append a
feature. Save editable JSON for durable design versions; bounded undo/redo stacks persist in SQLite. STEP exports exact
evaluated B-reps; STL/GLB export their tessellated display geometry, while imported STEP editing remains
outside scope.


## Projects and local storage

Open the document menu to select or create a project, browse its parts and assemblies, rename it, move the
current document or choose a main assembly. Only empty non-default projects can be deleted. Clear a main
assembly before moving/deleting it. Parameters still belong to individual documents.

The bridge autosaves to local SQLite. The update starts a fresh workspace and does not import existing
IndexedDB data. Active document/project and selection are independent per tab. Undo and redo each retain
40 entries across reloads. JSON exports save current editable content, not database audit history.
A storage conflict keeps the committed model unchanged; inspect/refresh before editing again. If a transport
failure says the outcome is unknown, the database may have committed. Reconcile before retrying.


## Smooth bodies, wings and hollow parts

Choose Loft from the dock, New menu or command search. The Smooth body preset starts with four ellipse
sections on planes normal to X. Expand each section to edit its profile and frame. Twisted wing uses exact
cubic Bezier airfoil sections with changing pitch; one smooth loft runs through all three. Smooth surfaces
are OCCT's through-sections result, not stacked plates. Ruled intentionally creates straight joins between
sections. Add/remove sections within the 2–12 section bound. Section order, compatible boundaries and sensible
twist matter. A general constrained sketch editor is outside this step.

Extrude and each section offer Curved path / spline. Edit the starting U/V point, then each segment's end
and arc-through point or Bezier controls. One control gives a quadratic spline; two give a cubic. Each
span is an exact kernel curve. The final edge closes straight back to the start when needed. For a smooth
closed boundary, end the last spline at the first point with compatible tangent directions. A full circle
needs the circle profile or two arcs, not an arc with identical start/end points. Profiles have no holes.

Local planes/frames use an origin, normal and U direction. U and normal must be perpendicular and nonzero;
length is normalized. V is normal cross U. This controls section pitch without quaternion inputs. Circle,
ellipse and rectangle profiles center on the origin. Polygon/path coordinates are literal U/V coordinates.

Sweep carries one profile along an open path of the same exact line, arc and Bezier spans. The path lies
on its own arbitrary frame. At its start the profile is perpendicular to the initial tangent, with profile
U along the path-plane normal; V completes the right-handed frame. Corrected Frenet transport follows the
path. There is no twist law or nonplanar spine. Keep the section smaller than the tightest bend and use
smooth path joins. Kernel failure leaves the committed model intact.

Select one solid and choose Shell. Positive thickness goes inward. The default query opens its top Z plane;
edit the point/normal for other planar faces. A query removes every planar face lying on its plane, with
either normal sign. Expected faces must match exactly. Multiple queries must not overlap. Nonplanar openings
and closed-shell/no-opening offsets are not supported. Small radii, excessive thickness or topology changes
can make shell fail. There is no persistent face index or automatic alternate opening.

## Named mount placement

In a part's Parameters, expand Mount points and add a unique name, origin, normal and U direction. Frames
are static references in that feature result's document coordinates, not face attachments. Ordinary derived
results inherit the first target's mounts. Transform/scale moves their origins; rigid rotations turn their
axes. Mirror reflects U and normal and recomputes V to keep the frame right-handed. Pattern copies need
explicit authored mounts. Own names override inherited ones. Mount coordinates have no parameter bindings;
profile/section dimensions, shell thickness and attachment offsets/twist accept the usual numeric bindings.

Select a result and expand Available mounts above Parameters to discover the actual inherited names and
frames. Insert part, select its source, enable Attach by mount, and choose Source mount and Target mount.
The target can be an earlier result's mount or an explicit world frame. Set an optional Target-local offset
and Mount twist. Align matches axes. Mate flips V and normal about U. Twist rotates about the target's
normal before this flip. The flip uses the now-twisted local U, so mating keeps the twisted U direction;
offsets always use the original target axes. Attached instances have zero manual
translation, angle and pivot, and use offsets/twist instead of viewport handles. Disabling attachment resets
to the neutral manual placement, not the previously evaluated attached pose. Preview before applying.

An instance exposes inherited mount names as sourceResultId/mountName. Nested instances add another result
prefix, so discover names through Available mounts or inspect_model geometry.mounts. Changing a referenced
source mount refreshes placements from committed documents, including unopened nested sources. An unrelated
mount edit does not rebuild solids. Deleting/renaming a referenced mount reports MOUNT_NOT_FOUND and marks
dependent assemblies stale until repaired or undone. The source edit still commits. Targets are dependencies
for deletion/cascade and ordering, but remain visible. Static mount placement does not certify physical
contact, prevent collisions or provide a joint/constraint solver. See [modeling examples](modeling-examples.md)
for complete requests.

## Participants and recorded changes

Open the agents button in the top bar for Project work. Participants lists everyone who has worked in the
current project, including disconnected agents. Reported tasks and client/model names come from the caller.
Working and queued commands come from the authority. Follow focus opens the participant's document and
selects its named features. Manual interaction outside that panel stops following; cameras stay local.

Changes shows committed versions in chronological order. Filter by participant or inspect across projects.
View historical model pins that version and its transitive sources. Play loaded changes advances through
the loaded commits, waiting for each exact frame. Load earlier work retrieves older pages. Return to latest
leaves the historical view without undoing anyone's work. Activity also includes reads and failed commands.
Older saved revisions have unknown authorship. Handoffs and supplied operation purposes explain recorded
decisions; the app does not infer an agent's private reasoning.
