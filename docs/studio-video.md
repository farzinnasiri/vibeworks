# Studio video

Open Studio and choose Video in the camera toolbar. Turntable makes an eight-second orbit from the
current perspective view. It can replace a sequence; Undo sequence change restores the preceding one.

For a custom clip, frame the model and choose Add view. Reposition the camera and add another view.
Select a view to preview it. Expand Edit to rename, reorder or remove it, adjust movement and hold times,
or replace its camera and scene with Update from current view. Push in and Pull back insert a direct
camera movement after the selected view. Orbit interpolates camera direction and distance around the
target; Move directly interpolates positions. A direct move can pass through the model, so preview it.

Each view captures lighting, environment, material looks and staging. The previous scene stays fixed
during travel; the destination scene appears on arrival. Cut changes the view and scene immediately.
Use a hold to keep a cut visible. Play and the scrubber use the same camera evaluation as final rendering.
Manual camera interaction pauses playback. Playback starts only on an explicit Play action, including
when Reduce Motion is enabled.

Video starts in Studio mode, using the same lighting, materials, shadows and WebGL renderer settings as the
live preview. Path traced is a separate, slower choice for full light transport. Its quality is separate
from image output and starts at Draft with denoising, retaining the existing 24/64/160-sample denoised
budgets and higher raw sample budgets. Choose 1080p or 720p in the video panel. Render video captures the current Node-produced display evaluation, including nested
source meshes and appearances, and the complete camera/scene recipe before starting. Later live model
edits, source updates, scene changes or camera navigation do not alter that capture. The viewer records
the captured root revision and shows when the live revision has advanced. This is visual output, not a
new exact-geometry or analysis certificate.

Save MP4 downloads the finished H.264 video. The last finished video stays available while this Video
panel is open. Leaving Video or Studio releases it, so download it first. Sequences are personal browser
storage keyed by document ID; they are not shared CAD data or included in document JSON. Storage failures
leave the current sequence usable and display a notice. Exiting Studio or closing the tab cancels local
tracing. An encoder that loses its client is removed at its deadline.

## Requirements and limits

- Studio export requires WebGL. Path traced export requires WebGPU. The selected renderer is explicit;
  failed tracing never substitutes Studio frames.
- The local bridge needs FFmpeg on PATH with libx264 support. No encoder package is installed by the app.
  Restart the bridge after installing FFmpeg or changing its PATH. MP4 export is local.
- 24 fps, 16:9, 1920 × 1080 or 1280 × 720. Between 0.5 and 20 seconds, at most twelve views and 480 frames.
- One encoder per bridge. PNG uploads are sequential and at most 16 MiB each; they pass into FFmpeg's
  bounded stdin stream. Frames are not accumulated in browser memory or saved as a PNG directory.
- One temporary MP4, a 64 MiB delivered-output limit, and a 30-minute deadline from encoder start.
  Completion, cancellation, failure and bridge shutdown remove the temporary encoder output.
- Rendering is offline, frame by frame. Studio exports are faster; path tracing can still take minutes
  per second of video. Progress counts completed frames and, for tracing, real samples in the current frame.
  The estimate waits for three completed frames and uses up to eight recent frame times, excluding the
  first frame's initial scene/shader setup. Draft and 720p can reduce the wait. There is no resumable render after a closed tab or
  restarted bridge.
- Path-traced frames use the existing per-image denoiser. Identical consecutive camera/scene frames,
  including holds, reuse one completed PNG rather than tracing and denoising it again. Temporal denoising and motion blur are not implemented.
  Reflective materials, fine detail and longer scenes still require visual review for flicker.

## Implementation

`src/shared/protocol.ts` owns camera, sequence and private encoder request/acknowledgement schemas.
`src/web/studio-video-camera.ts` evaluates Z-up camera movement and per-view scene changes.
`StudioVideoPanel.tsx` owns personal sequences, playback, captured jobs and the finished-video viewer.
`studio-video-render.ts` builds an independent set of Studio assets and uploads each completed PNG before
starting the next frame. `studio-video-preview.ts` owns one reusable WebGL renderer and scene for Studio
export. Path tracing keeps the same StudioRenderer. Holds retain at most one completed PNG. The existing image renderer and denoiser
are unchanged. `src/bridge/studio-video-encoder.ts` owns FFmpeg and temporary-output cleanup. The private
HTTP routes reuse the bridge's host, origin, bearer-token and loaded-fingerprint checks. Encoding never
enters the CAD mutation authority. This version adds no agent-facing video command.

## Verification on 28 October 2026

The final full suite passed 264 tests, and the production build passed. Focused additions exercise private-endpoint authentication,
version/origin rejection and request bounds. The encoder test runs real FFmpeg/ffprobe and verifies a
complete twelve-frame, half-second 1080p H.264 file at 24 fps, as well as cancellation and missing FFmpeg.
Camera tests cover opposite directions without a shortcut through the model, angular wraparound, the
complete turntable, holds, cuts, arrival lighting, direct movement and sequence/output limits.

An isolated browser/bridge workspace on ports 45373/44328 exercised saved camera views, turntable,
playback interruption, cuts/holds, sequence undo, 390-pixel layout, image-mode start/cancel and a complete
path-traced, denoised twelve-frame 1080p MP4. A live exact CAD edit during rendering advanced the document
while the clip retained its captured root revision. FFprobe confirmed codec, dimensions, frame rate,
duration and frame count; Chromium loaded and played the exported MP4 at its full dimensions. Decoded
frames were inspected. The first measured export took about two minutes;
that is a local short-scene result, not a throughput guarantee. The final browser workflow reported no
page or console errors. Long clips and broad temporal-quality comparisons remain unverified.

Artifacts are under `output/playwright/cinematic/`, including `cinematic-proof.mp4` and the decoded frame
sheet. Browser and exact-output evidence are separate from the protocol/unit checks above.


## Studio controls and rendering follow-up, 29 October

Apply preset starts at the current camera. Full turntable, Half orbit, Close-up and pull back, and
Detail and reveal supply editable sequences. The selected view's editor is visible immediately. Its
camera distance is in millimetres; moving the preview followed by Use current camera for this view
replaces that saved camera and scene. Push in and Pull back insert views. Selecting, editing and
reordering a view place the playhead at its arrival instead of silently resetting it to the start.

Video prefers Studio rendering. The client and encoder have a thirty-minute budget. After eight recent
steady frame timings, an estimate beyond that total budget stops the export early and names Studio,
720p or a shorter sequence as recovery choices. Neither failure nor a slow estimate changes rendering
mode silently. Initial shader setup is excluded from the steady-frame estimate. Completed holds reuse
a finished frame. No thirty-minute job was run merely to test elapsed wall time.

Image mode now has its own Fast and High quality choice and product-view output. Persistent image
history, gesture protection, sheet export and separate PNG ZIPs are documented in studio-images.md.
The complete serial suite passed 282 tests after these additions. Isolated browser checks covered
presets from the current camera, editable distance, updating a view, Push in/Pull back, history reload
and deletion, protected images during touch/resize, complete Fast and path-traced still images, a
four-view sheet and a three-image ZIP. PNG dimensions and ZIP contents were checked. Both the small
fixture and current Flowline runs reported no page or console errors. Earlier completed Studio and
traced MP4 proofs remain under output/playwright/performance.


Studio video progress and Cancel now appear in the same reserved top process area used by image jobs
and preview preparation. The camera editor no longer contains its own progress rail. Preparation,
rendering and encoding share the location while preserving their different counts and indeterminate
states. The full-screen Studio loading wave has been removed.
