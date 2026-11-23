# Studio video

Open Studio and choose Video in the camera toolbar. Turntable makes an eight-second orbit from the
current perspective view. It can replace a sequence; Undo sequence change restores the preceding one.

For a custom clip, frame the model and choose Add view. Reposition the camera and add another view.
Select a view to preview it. Expand Edit to rename, reorder or remove it, adjust movement and hold times,
or replace its camera and scene with Update from current view. Push in and Pull back insert a direct
camera movement after the selected view. Orbit interpolates camera direction and distance around the
target; Move directly interpolates positions. A direct move can pass through the model, so preview it.

Each view captures lighting, environment, material looks and staging. While the camera travels, numeric
settings and colours blend toward the next view's scene (angles take the short way round); choices such as
the floor, environment photo or background mode switch halfway. Cut changes the view and scene immediately.
Use a hold to keep a cut visible. Play and the scrubber use the same camera evaluation as final rendering.
Manual camera interaction pauses playback. Playback starts only on an explicit Play action, including
when Reduce Motion is enabled.

Video uses Fast rendering with Studio lighting, materials, shadows and WebGL. Realistic video is disabled
until path-traced jobs can resume after interruption: current frame costs can exceed the time budget.
High quality still images remain available in Image mode. Render video captures a fresh Node-produced
display evaluation of the committed model, including nested
source meshes and appearances, and the complete camera/scene recipe before starting. Later live model
edits, source updates, scene changes or camera navigation do not alter that capture. The viewer records
the captured root revision and shows when the live revision has advanced. This is visual output, not a
new exact-geometry or analysis certificate.

Output (the sliders button under the sequence) chooses the frame (16:9, 9:16, 1:1 or 4:5), size, frame rate,
encoding quality, final surface detail and optional depth of field. The preview shows the exact crop, and thumbnails use the same
shape. Presets (Turntable, Half orbit, Close-up, Detail reveal, Crane) start from the current camera and are
framed for the chosen frame; changing the frame of an untouched preset reframes it. The scrubber marks each view.

Save move to model stores the sequence and its output with the model (the same `set_video` edit agents use),
so agents and other people get it too. A badge shows whether the sequence is saved, differs from the saved move
(Use saved move restores it) or exists only in this browser. Opening Video on a model with a saved move and no
personal sequence loads the saved move.

Save MP4 downloads the finished H.264 video. The last finished video stays available while this Video
panel is open. Leaving Video or Studio releases it, so download it first. Sequences are personal browser
storage keyed by document ID; they are not shared CAD data or included in document JSON. Storage failures
leave the current sequence usable and display a notice. Exiting Studio or closing the tab requests cancellation of the panel job. An encoder that loses its client is removed at its deadline.

## Agent rendering API

`render_video` gives agents the same Studio video without a browser tab, through MCP or the CLI. It follows
`render_image`: start with a fresh UUID `requestId` (also the `jobId`), then poll `status`, read `result`,
or `cancel`. The start call freezes the committed definitions, the saved scene and the recipe; later edits
never change the job. The video uses Studio rendering (the same look as the live preview), not path tracing.

A recipe is either a preset or keyframes, plus output. Presets are the quick path:

```json
{"action":"start","documentId":"<UUID>","requestId":"<fresh UUID>",
 "video":{"preset":{"name":"detail_reveal","focus":{"featureIds":["rear_wing"]},"seconds":8}},
 "output":{"aspect":"9:16","resolution":"1080p","fps":30}}
```

`turntable` and `half_orbit` circle the model; `push_pull` and `detail_reveal` move in on `focus` (a shot
frame: feature ids, a box or a detail sphere) and back out; `crane` starts low on the far side, rises over
the model and settles on the focus. Every preset starts from `shot` (default: the isometric three-quarter
view) and accepts `seconds` and `direction`. Each preset view is framed from its own direction for the chosen
aspect, so a long model seen side-on in a tall frame stays in view; orbits keep the largest distance any of
their angles needs.

For full control give 2-12 keyframes. Prefer `shot` to `camera`: a shot such as
`{"from":[1,-1,0.3],"frame":{"featureIds":["engine_cover"]}}` keeps its meaning after edits and is framed at
render time. `motion` is `orbit`, `move` or `cut`; `seconds` is the travel into a keyframe, `hold` a pause on
it, and `presentation` changes the scene there (blending while the camera travels).

`motion: "smooth"` follows a time-weighted Catmull-Rom path through the surrounding keyframes. It keeps
velocity continuous through intermediate views, including unequal travel times. `orbit` retains distance
around the target, `move` is direct and `cut` jumps. Existing recipes keep their orbit default.
New views captured in the panel use Smooth path. `easing` is `auto`, `linear`, `ease_in`, `ease_out` or
`ease_in_out`; automatic easing starts and ends at rest and keeps moving through intermediate views.

Each keyframe can set `focalLengthMm` from 10 to 300 and a `focus` using the same feature/component ids,
box or detail sphere as a shot frame. Focus resolves against the captured model and aims the camera there;
lenses interpolate while travelling. A missing target fails clearly. In the panel, click a part and choose
Frame selected to add a framed view, or Aim at selected to change a view's target. Edit view exposes lens
and easing controls. Saving the move retains these settings.

The panel and agent result warn with `VIDEO_CROP` when sampled model bounds leave the frame. This is a
conservative bounds projection at up to 20 samples per second, not a visibility proof. Detail shots may
crop intentionally; warnings never change the authored cameras.

## Model animation

A recipe's optional `animation` applies over the camera sequence:

- `{"kind":"construction"}` renders exact construction replay from the captured root and source graph.
  `fromStep` and `toStep` optionally limit its expanded build range. Prefixes come from the Node geometry
  worker, including changing booleans and placed source components. Frames sample build steps across the
  clip, so a short clip may skip intermediate steps. The final frame reaches the requested final step.
- `{"kind":"exploded","offsets":[{"featureId":"motor","offsetMm":[0,0,40]}],"direction":"out_and_back"}`
  animates visible result/component offsets in world millimetres. `out` separates parts, `in` assembles them,
  and the default `out_and_back` returns to the original placement. Graphics follow their owning result.
  Offsets never change the authored assembly, geometry, joints or physical checks.

In the panel, choose Model animation under the sequence. Construction previews request exact steps from a
frozen snapshot; scrubbing coalesces pending requests and may wait for geometry. For an exploded view,
click a part, choose Add selected offset and edit its X/Y/Z offsets and direction. Changing back to Static
model restores the assembled display. Save move to model includes the animation.

Fast exports in the panel submit the same `render_video` jobs as agents. The completed MP4 is downloaded
through an authenticated, job-scoped endpoint, with its stored size and hash checked before delivery.

Output is `aspect` (`16:9`, `9:16`, `1:1`, `4:5`), `resolution` (`720p`, `1080p`, `4k`; the short side),
`fps` (24, 30, 60) and `quality` (`standard`, or `high` for more bits and a slower encode). Defaults are
16:9, 1080p, 30 fps, standard.

Save a move with the model through `apply_edits` `{"op":"set_video","video":{...}}` (`null` clears it). It is
display-only, like `set_presentation`: it never rebuilds geometry. `render_video` without `video` uses the
saved recipe, or a turntable when there is none; request `output` fields override the saved output one by one.

The result saves the MP4 under `artifacts/` and returns its path, size and SHA-256, a poster frame (an MCP
image, also saved as a PNG) and `videoJob.keyframes`: the exact cameras the recipe resolved to, ready to send
back as `camera` keyframes to repeat a move after an edit. Look at the poster before reporting a video as done.
One video runs and one can queue; each has a twenty-minute deadline including the queue.

## Final video quality

Final videos default to fine re-tessellation of the exact captured B-reps in the Node worker
(0.005 mm linear and 0.035 rad angular tolerance). The ordinary viewport profile stays unchanged.
Use `output.meshDetail: "standard"` when the finer mesh exceeds the bounded display budget; fine never
silently falls back to coarse meshes. Geometry validation, measurements and exports still use exact solids.

Optional `output.depthOfField: {"fStop": 4}` uses a thin-lens approximation in the final Fast frames.
Focus follows the resolved keyframe target, and focal length interpolates with the move. Omit it for an
all-sharp image. The panel exposes Surface detail, Depth of field and Aperture under Output. Its live
preview stays sharp so small mechanical details remain easy to inspect.

The controlled worker fixture reduced cylinder chord error from 0.014 mm to 0.00076 mm without changing
exact measurements. Paired 720p lens frames retained 91% of focused edge energy and reduced background
edge energy by 86%. These are fixture measurements, not a guarantee for every model. An ambient-occlusion
trial did not establish a useful improvement on that fixture, so it remains out of the product. Motion
blur is deferred at this stopping point; it has not been benchmarked or implemented.

## Requirements and limits

- Video export requires managed Chromium with WebGL. Realistic video is disabled in the panel until
  resumable path-traced jobs exist; there is no silent renderer substitution.
- The local bridge needs FFmpeg on PATH with libx264 support. No encoder package is installed by the app.
  Restart the bridge after installing FFmpeg or changing its PATH. MP4 export is local.
- 24, 30 or 60 fps; 16:9, 9:16, 1:1 or 4:5; 720p, 1080p or 4K (short side). Between 0.5 and 20 seconds,
  at most twelve views and 1,200 frames. The Studio panel and `render_video` offer the same choices.
- Panel and agent exports share one active job and one queued job. Each active job streams frames in order
  to FFmpeg and keeps at most one completed frame for reuse during holds.
- Completed MP4s have a 256 MiB delivery limit. Completion, cancellation, failure and bridge shutdown
  remove temporary encoder output.
- Rendering is offline, frame by frame. Progress counts completed frames. The managed job reports an
  estimate after four frames; preparation and queue time have no invented ETA. Jobs do not resume after
  a restarted bridge.
- Identical consecutive camera/scene frames, including holds, reuse one completed PNG. Temporal
  denoising and motion blur are not implemented.
  Reflective materials, fine detail and longer scenes still require visual review for flicker.

## Terminal states

Managed jobs end in `complete`, `cancelled` or `error`; poll `videoJob.state`, and read
`videoJob.error.code` on failure. The whole job, including queue and preparation, has a twenty-minute
deadline (`RENDER_TIMEOUT`). Cancelling or timing out releases the worker, browser and encoder.
Fine tessellation that exceeds the mesh budget returns `RENDER_MESH_BUDGET` with an explicit Standard
retry; it does not remain in setup or silently lower quality.

Scripts observing the panel can read `.studio-video-panel[data-video-state]` (`idle`, `running`,
`complete`, `cancelled`, `error`) and `data-error-code`. The shared Studio process also exposes its
phase and error code. A script should wait for a terminal state, not only the Save MP4 button.

## Implementation and verification

`studio-video-recipe.ts` resolves camera views for the selected output size. The bridge freezes the
model revision, prepares exact geometry, and runs `studio-video-output-entry.ts` in Chromium.
`studio-video-render.ts` renders video frames in order. The bridge streams them into FFmpeg and
saves the result. The panel downloads the completed MP4 through an authenticated endpoint.

`make test` covers recipe validation, camera paths, exact construction replay, exploded transforms,
mesh detail, bounded jobs, authenticated downloads, and real FFmpeg output. For a live MCP and browser
check with a disposable database, run:

```sh
node --import tsx scripts/verify-studio-video-plan.mjs 6
```
