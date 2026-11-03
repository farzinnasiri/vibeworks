# Studio images

Studio has Images and Video modes, with Looks, Light, Backdrop, Materials and Output panels. Below every panel except
Output, a quick row offers Fast or High quality, the image size and a button that opens Output. Output holds image size,
Current camera or Product views, sheet or separate PNGs, optional view labels, and Fast or High quality.
Fast is the default and uses Studio's materials, environment, lighting and shadows with supersampled
edges. High quality uses the WebGPU path tracer and denoiser. Progress appears only while work runs.

Use Current camera for deliberate framing. Product views offers six principal directions, eight isometric
corners, Dimetric and Trimetric. Named directions follow world axes and every product view honors the
selected projection. A sheet uses the selected size for the complete page; separate images each use that
size. Sheets are clean by default; Show view labels adds strips. Below-model shots omit the floor so it
cannot hide the underside. Save view ZIP downloads the latest set of separate images together.

Camera settings offers the same named directions and Normal To. Normal To aligns to a clicked display
triangle's transformed normal. Repeating a facing pick flips sides; Escape cancels. This navigation does
not create a persistent exact CAD face reference or save a custom view.

Looks apply a complete scene (lights, surroundings, floor, background) in one click and keep Studio
material choices. Six starting looks are built in; Save current look stores up to 24 personal looks in this
browser for any model. Look thumbnails are small raster previews of this model from the current camera.

Light orders controls by effect: lighting style and Exposure (whole picture), the key light, then the
surroundings photo. The key light map is a top-down view labelled Back, Left, Right and You; it turns with the
camera, so its bottom edge is always your viewpoint. Drag or use arrow keys to set direction and height. Its
shadow and fill positions are drawn from the same rig values. Fill and rim softboxes stay at least 25° and 35°
high when the key is lowered, and the preview shadow range reaches the end of a low light's long shadow. Lights stay
fixed to the model, so orbiting the camera changes which side they light. Surroundings strength and Turn
surroundings change the photo's light and reflections, not the exposure.

Backdrop → Floor offers Seamless (default), Open floor and No floor. Seamless curves the floor into a wall
that blends into the background color, so no horizon appears behind the model. The floor keeps its gloss while
reflection and clear coat fade to zero across the bend (`specularIntensityMap`/`clearcoatMap`, shared by the
preview and path tracer), so the curve cannot mirror lamps or softboxes as streaks. A gloss floor's clear coat
follows Floor roughness. An open floor is edge-on in
front/back/side orthographic views. Background offers Color, Gradient, Environment and Transparent; the seamless
wall covers Environment and Transparent, and the panel offers to switch to an open floor. Transparency
preserves environment lighting and survives PNG sheets, high-quality rendering and denoising. With a floor,
the camera cannot orbit below it; choose No floor to look from underneath.

Unsaved scene changes, the last camera for each model, the open panel and output choices are kept in this
browser and restored on the next visit. They remain personal until Save to model writes the scene into the
document as a new revision, where agents' `render_image` also uses it. Revert discards the browser draft.
Materials highlights a material's parts briefly when opened and while pointing at its name; editing a finish
shows the finish without the highlight.

Camera tools share the single Studio header with the Images/Video modes: perspective/orthographic, View
(direction drawings and Normal To surface…), Lens, Fit and Save preview PNG. Navigation help and the
trackpad/mouse choice sit behind the header's help button; there is no second toolbar row.

A finished image is locked over the preview. A floating bar names it and offers Save PNG and Back to preview;
Escape also returns. Touching, scrolling or resizing cannot discard it, and touching the image nudges the bar.
Back to preview hides the image; the thumbnail stays in the gallery. A scene change still waiting for its
preview refresh is applied when a render starts, so a quick look change followed by Render shows its result. Opening a thumbnail provides Save PNG,
Use this view, Use this scene and Remove image. Sheets have several cameras, so Use this view is unavailable for them.
A new render or a switch to video replaces the displayed overlay, preserving completed images.

The gallery is personal to this browser and app origin, stored in IndexedDB rather than in CAD documents
or the bridge's SQLite database. The render bar shows the latest twelve images; Gallery lists every image for
this model or all models, with a storage meter, multi-select Save and Delete. It holds up to 300 images within
512 MiB. When either bound is reached the oldest images are removed and a notice says so. Studio asks the
browser to keep the gallery persistently; if the browser declines, the gallery says it may be cleared when the
disk is nearly full. Writes are incremental: new images, deletions, then the bound.
The app waits for the storage transaction before reporting rendering/deletion as finished. Concurrent
tabs merge their completed images; metadata is checked when restored. If browser storage is denied or
full, the images remain available in memory and a notice asks the user to save PNGs. A separate set
that exceeds 64 MiB stops with a message; already completed images stay in history. Canceling a batch
also preserves already completed separate images. Canceling a sheet before composition completes does
not add a partial sheet.

Each render owns a frozen Node-produced evaluation, presentation and camera. Later exact edits cannot
change its pixels. Root revision, projection, camera and renderer metadata stay with history entries.
The output is a visual capture, not exact geometry or physical-analysis certification.

## Ownership and verification

`StudioWorkspace.tsx` owns modes, panels, presentation drafts and displayed-image identity.
`StudioImageOptions.tsx` owns output choices and low-resolution layout previews; `studio-image-output.ts`
owns final composition and the shared tile layout. All consume authoritative Node display meshes.
`StudioViewport.tsx` owns the live camera and temporary material highlighting. Highlighting changes
preview emission only, restores it on deselection and never enters exported images. Rendering uses its
own frozen scene. Video recipes and their separate saved scenes are described in [studio-video.md](studio-video.md).

Run focused Studio tests and `make build`. The full isolated exact-model acceptance command is:

```sh
node --import tsx scripts/verify-studio.mjs
```

The focused camera/removal check, including a transparent denoised WebGPU PNG, is:

```sh
node --import tsx scripts/verify-view-controls.mjs --quality
```

Both create isolated services and temporary databases. They write disposable results beneath
`output/playwright/`; they do not modify the user's project database. Browser checks, live-agent operation,
external CAD interoperability and physical-device accessibility are separate evidence.

## Agent rendering API


`render_image` uses Studio's actual WebGPU path tracer and guided denoiser in managed headless Chromium.
It needs no human tab. `render_views` remains the faster raster inspection tool for sections, issues,
ghosts and repeated modeling checks. Use final Studio images to review materials, reflections and details.

Start against an inspected document. Supply a fresh UUID `requestId`; it is also the returned `jobId`.
`expectedRevision` and `expectedStorageVersion` optionally require the inspected version at capture time.

```json
{
  "action": "start",
  "documentId": "<document UUID>",
  "expectedRevision": 7,
  "requestId": "<fresh UUID>",
  "shot": {
    "from": [-1.3, -1.8, 0.8],
    "projection": "perspective",
    "fovDegrees": 30
  },
  "output": {"size": "hd", "quality": "standard", "denoise": true},
  "presentation": {"environmentPreset": "dark_studio", "backdrop": "sweep", "floor": "polished_concrete"}
}
```

The authority atomically freezes the committed root/source definitions and returns the job immediately.
One bounded Node worker prepares exact display geometry and completes whole-document analysis inside
the image job, then is released before GPU rendering starts. Ordinary modeling deadlines stay unchanged. An agent
can continue editing while it renders. Returned `revision`, `storageVersion` and `provenance.sources`
always describe that capture, including when the live document has changed or been deleted.
Health describes analysis at capture time. A finished image does not certify geometric or physical validity.
`skipAnalysis:true` is available for intermediate images and retains the warning.

Use `describe {"tool":"render_image"}` for the full current schema. Subsequent actions take no document
context and return promptly without joining the geometry queue:

```json
{"action":"status","jobId":"<request UUID>"}
{"action":"result","jobId":"<request UUID>"}
{"action":"cancel","jobId":"<request UUID>"}
```

`renderJob` reports queued/running/complete/cancelled/error state, preparation/compilation/tracing/finishing
phase, samples, targetSamples, total elapsed time including preparation and an estimated remaining time when available. Status has no
image bytes. Result returns image bytes only after completion. MCP returns a real PNG image content block
and a saved artifact path. CLI prints the same metadata/path. Errors carry no substitute preview PNG.
Cancellation closes the active image's managed browser; the next image gets a fresh context.

CLI syntax is the same command and JSON, for example:

```sh
npm run -s cad -- render_image '{"action":"status","jobId":"<UUID>"}' --session <agent-session-UUID>
```

Omit presentation to use the document's saved scene. Supplied fields override the saved top-level fields
without saving anything. Material looks, HDRs, softboxes, floors and sweep backdrops share Studio code.
Use the existing shot `view` or `from`, `up`, `frame` and `hide` controls. Frame a feature, explicit model-mm
box or detail sphere for close-ups. `fovDegrees` sets perspective compression; orthographic is also available.
The receipt records the resolved camera in model millimetres. Section and ghost overlays are intentionally
rejected by this final-image command; inspect them with `render_views`.

Output defaults to HD, Standard and denoising. Sizes are `hd` 1920×1080, `qhd` 2560×1440,
`uhd` 3840×2160, `square` 2048×2048 and `portrait` 1600×2000. Quality/sample/bounce budgets match the
browser's Draft/Standard/High presets; arbitrary samples and viewport-dependent dimensions are not accepted.

One image may run and one may queue per bridge. Each has ten minutes including queue time. Up to eight
terminal receipts remain for fifteen minutes, subject to a shared 64 MiB encoded-PNG retention limit.
Each capture is capped at 32 MiB and each PNG at the existing 20 MiB artifact limit. One prepared
32 MiB display capture is cached by frozen graph identity for repeated camera/lighting requests; a
changed graph replaces it. The cache is released when the service closes. Old terminal jobs may
be evicted to admit new work. Saved artifact files remain after job eviction; clean them as other artifacts.
Identical start retries recover retained jobs. Reusing the UUID with different inputs reports
`REQUEST_ID_CONFLICT`. Jobs do not survive bridge restart; `RENDER_JOB_NOT_FOUND` requires a new start.

Install the pinned browser with `make renderer-install`. Final images require a hardware WebGPU adapter.
The macOS launch selects Metal explicitly. A missing browser, unavailable GPU, device loss, denoising error,
PNG-size overflow or deadline returns an explicit failure. Raster inspection remains available separately.


## Verification on 28 October 2026

The actual MCP SDK rendered the full Electric blue VWR 12 from an isolated SQLite workspace copy.
The captured graph includes all five transitive source revisions. Cold geometry preparation, complete
whole-model analysis, HD Draft tracing and guided denoising finished in 125.974 seconds on this host.
The resulting 1920×1080 PNG was 2,926,157 bytes. The SDK image content, MCP saved artifact and CLI
retrieval were byte-identical. These are observations, not cross-device latency guarantees.

A separate exact part check changed its live dimensions after accepting the image and verified that
result metadata and image framing retained the earlier revision. Actual SDK checks also covered matching
start retries, queued cancellation and active cancellation. The large-shot regression covers the bounded
silhouette sampling that prevented a Chromium argument-stack overflow on the full car. Temporary
verification files and renders were removed after the session at the owner's request.
No user workspace document was modified. HD with denoising was rendered; every other size/quality
combination and non-macOS GPU backend has not been exercised in this pass.
