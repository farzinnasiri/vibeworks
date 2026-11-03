# Curves, loft, sweep, shell and mounts

Requests use the shared command catalog. Send each edit object to `apply_edits`, or wrap it as
`{type:"apply_edits",params:...}` for the browser diagnostic API. Replace document IDs and revisions with
current `inspect_model` results. CLI: `npm run cad -- apply_edits '<JSON params>'`. The examples create new
features; use a fresh part so their IDs do not conflict. A failed request leaves the committed model intact.

## A smooth body through three sections

The section profiles are exact ellipses, and the longitudinal surface is an OCCT smooth through-sections
B-rep. This avoids flat plate stacking. Frames put local U along world Y and normal along world X.

```json
{
  "documentId": "11111111-1111-4111-8111-111111111111",
  "expectedRevision": 0,
  "edits": [{
    "op": "add",
    "feature": {
      "id": "body", "kind": "loft", "appearance": {"material": "carbon_fiber"},
      "mounts": [{"name": "wing", "frame": {"origin": [25,0,12], "normal": [0,0,1], "xDirection": [1,0,0]}}],
      "params": {"ruled": false, "sections": [
        {"profile": {"type":"ellipse","radiusX":5,"radiusY":4}, "frame":{"origin":[-60,0,0],"normal":[1,0,0],"xDirection":[0,1,0]}},
        {"profile": {"type":"ellipse","radiusX":22,"radiusY":12}, "frame":{"origin":[0,0,0],"normal":[1,0,0],"xDirection":[0,1,0]}},
        {"profile": {"type":"ellipse","radiusX":6,"radiusY":5}, "frame":{"origin":[60,0,0],"normal":[1,0,0],"xDirection":[0,1,0]}}
      ]}
    }
  }]
}
```

Use four sections to control both nose and tail independently. `ruled:true` deliberately produces ruled
surfaces between sections. The kernel can fail on incompatible boundaries, excessive twist or intersections.
It does not silently switch to a mesh or a stack of extrusions.

## A wing with continuous pitch variation

Create a separate part, then send this request. Each airfoil is two exact cubic Bezier spans. The three
section U directions give opposite 15-degree tip pitches around the unrotated center; there are no stepped blades.
The local frame normal is +Y, so local V points mainly toward -Z.

```json
{
  "documentId":"22222222-2222-4222-8222-222222222222", "expectedRevision":0,
  "edits":[{"op":"add","feature":{
    "id":"wing", "kind":"loft", "appearance":{"material":"aluminum"},
    "mounts":[{"name":"root","frame":{"origin":[0,0,0],"normal":[0,0,-1],"xDirection":[1,0,0]}}],
    "params":{"ruled":false,"sections":[
      {"profile":{"type":"path","start":[30,0],"segments":[
        {"type":"bezier","controls":[[-25,12],[-30,8]],"to":[-30,0]},
        {"type":"bezier","controls":[[-30,-8],[-20,-5]],"to":[30,0]}]},
       "frame":{"origin":[0,-50,0],"normal":[0,1,0],"xDirection":[0.9659258262890683,0,-0.25881904510252074]}},
      {"profile":{"type":"path","start":[30,0],"segments":[
        {"type":"bezier","controls":[[-25,12],[-30,8]],"to":[-30,0]},
        {"type":"bezier","controls":[[-30,-8],[-20,-5]],"to":[30,0]}]},
       "frame":{"origin":[0,0,0],"normal":[0,1,0],"xDirection":[1,0,0]}},
      {"profile":{"type":"path","start":[30,0],"segments":[
        {"type":"bezier","controls":[[-25,12],[-30,8]],"to":[-30,0]},
        {"type":"bezier","controls":[[-30,-8],[-20,-5]],"to":[30,0]}]},
       "frame":{"origin":[0,50,0],"normal":[0,1,0],"xDirection":[0.9659258262890683,0,0.25881904510252074]}}
    ]}
  }}]
}
```

The same `profile` can be extruded on `plane:{normal,xDirection}` with a separate `origin` and `distance`.
This is useful for a constant-section wing. Loft changes the section continuously for varying chord or pitch.
Bezier controls specify curve geometry, not interpolation points. Quadratic spans have one control; cubic
spans have two. Smoothness across spans follows the authored tangents. No automatic tangent solver is added.

## A curved pipe and an open housing

In another fresh part:

```json
{
  "documentId":"33333333-3333-4333-8333-333333333333", "expectedRevision":0,
  "edits":[
    {"op":"add","feature":{"id":"pipe","kind":"sweep","appearance":{"material":"steel"},"params":{
      "profile":{"type":"circle","radius":2},
      "path":{"frame":{"origin":[0,0,0],"normal":[0,0,1],"xDirection":[1,0,0]},
        "start":[20,0],"segments":[{"type":"arc","via":[14.142135623730951,14.142135623730951],"to":[0,20]}]}
    }}},
    {"op":"add","feature":{"id":"housing","kind":"box","params":{"origin":[40,0,0],"size":[20,30,10]}}},
    {"op":"add","feature":{"id":"cup","kind":"shell","params":{
      "target":"housing","thickness":1,
      "removeFaces":[{"point":[40,0,10],"normal":[0,0,1],"toleranceMm":0.001,"expectedCount":1}]
    }}}
  ]
}
```

The pipe's exact volume is `40*PI*PI` mm³, a radius-2 disk swept around a quarter circle of radius 20.
Its bounds are `[0,0,-2]` to `[22,22,2]`. The housing's exact remaining volume is
`20*30*10 - 18*28*9 = 1464` mm³. Shell queries identify whole planar faces on their plane. They are not
nearest-face picks. Different faces on the same plane all match. The required count detects ambiguity.

## Assemble using named mounts

Create an assembly with `documents {action:"create",kind:"assembly",name:"Car"}`. With the body and wing
source UUIDs above, this places the body without rotation, then mates the wing root to its inherited mount.
The wing's root normal -Z opposes the target's +Z, so mating leaves the wing upright. Target-local offset
adds 4 mm above the body. These are semantic design coordinates, not claimed surface-derived anchors.

```json
{
  "documentId":"44444444-4444-4444-8444-444444444444", "expectedRevision":0,
  "edits":[
    {"op":"add","feature":{"id":"chassis","kind":"instance","params":{
      "document":"11111111-1111-4111-8111-111111111111","featureId":"body",
      "translation":[0,0,0],"rotationAxis":[0,0,1],"angleDegrees":0,"origin":[0,0,0]
    }}},
    {"op":"add","feature":{"id":"rear_wing","kind":"instance","params":{
      "document":"22222222-2222-4222-8222-222222222222","featureId":"wing",
      "translation":[0,0,0],"rotationAxis":[0,0,1],"angleDegrees":0,"origin":[0,0,0],
      "attachment":{"source":{"featureId":"wing","name":"root"},
        "target":{"featureId":"chassis","name":"body/wing"},
        "mode":"mate","offset":[0,0,4],"twistDegrees":0}
    }}}
  ]
}
```

Use `inspect_model` to discover `geometry[].mounts`, including names such as `body/wing` on chassis and
`wing/root` on rear_wing. Nested instances add prefixes. `target:{frame:{origin,normal,xDirection}}`
places a source mount directly in world coordinates without a target feature. U and normal are normalized,
perpendicular, right-handed; V = normal cross U. Offset is in the original target axes. Positive twist is
right-handed about its normal, before the optional 180-degree mate flip about the now-twisted local U.
For target axes U, V, N and twist a, the twisted axes are U' = cos(a)U + sin(a)V and
V' = -sin(a)U + cos(a)V. Align uses (U', V', N); mate uses (U', -V', -N). Both keep the same U'.
The source mount origin lands at target origin + offset[0]U + offset[1]V + offset[2]N.

For example, a 20 x 10 x 4 box has its source mount at [0,0,4], U = +X and N = +Z. A target at
[50,-20,8] has U = +Y and N = +Z. Offset [3,4,5] lands the mount at [46,-17,13]. Positive 90-degree
twist gives U' = -X. Mate keeps that U', gives V = +Y and N = -Z, and places box bounds at
[26,-17,13] to [46,-7,17]. Negative 90-degree mate instead gives [46,-27,13] to [66,-17,17].

Mount names have up to 64 identifier characters, with 32 authored mounts per feature and 256 resolved mounts
per result. Own names override inherited names. Normal derived operations inherit the first target's mounts;
patterns require explicit mounts. Transform scales origins uniformly and rotates axes. Mirror reflects U and
normal and recomputes V. Mounts authored on a feature use its output document coordinates, including on an
instance; they override inherited frames after placement. Mount fields are static, without parameter bindings.
Attachment offset/twist and numeric profile/frame/thickness paths support normal feature bindings.

In the profile editor, appending a loft section or curve span retains existing bindings. New copies start
with literal values. Removing a section, span or polygon point drops its bindings and moves surviving
bindings with their entries to the new indices. Changing a profile/segment type drops bindings within that
replacement; other sections, frames and spans retain theirs. Switching cubic to quadratic retains the first
control's bindings and drops the removed control's bindings. Body/wing presets replace all section bindings.

Editing a source mount changes affected placements without changing the source B-rep. Missing or renamed
mounts fail explicitly. A committed source change can make dependent assemblies stale; prior geometry remains
visible, while render/geometry export are blocked until repair. Undoing the source mount edit repairs refresh.
Mounts never track raw faces/edges. Static alignment does not promise physical contact, collision avoidance,
joints or motion. Run whole-document analysis and review the images before calling an assembly complete.
