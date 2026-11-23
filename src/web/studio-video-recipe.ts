import * as THREE from 'three';
import type { Evaluation } from '../cad/types';
import { studioShotSchema, type Presentation, type Shot, type StudioVideoCamera, type StudioVideoRecipe, type StudioVideoView } from '../shared/protocol';
import { shotCamera } from './shots';
import { modelBounds } from './scene';
import { studioFramePoints } from './studio-output';
import { videoDuration, videoFrameAt } from './studio-video-camera';

/** What a recipe needs to know about the captured model and the output frame. */
export interface RecipeContext {
  parts: Evaluation['meshes']; bounds: THREE.Box3; width: number; height: number; presentation: Presentation;
}

/** A recipe context for a live evaluation and an output size. */
export function recipeContext(evaluation: Evaluation, width: number, height: number, presentation: Presentation): RecipeContext {
  const raw = modelBounds(evaluation);
  return { parts: evaluation.meshes.filter(m => evaluation.visibleFeatureIds.includes(m.featureId)),
    bounds: new THREE.Box3(new THREE.Vector3(...raw.min), new THREE.Vector3(...raw.max)), width, height, presentation };
}
/** Exact camera keyframes for a sequence: what Save to model stores and agents can replay. */
export function viewsToRecipe(views: StudioVideoView[], output: StudioVideoRecipe['output'], animation?: StudioVideoRecipe['animation']): StudioVideoRecipe {
  return { keyframes: views.map(({ name, camera, motion, seconds, hold, presentation, easing, focus }) => ({ name, camera, motion, seconds, hold, presentation,
    ...(easing ? { easing } : {}), ...(focus ? { focus } : {}) })), output, ...(animation ? { animation } : {}) };
}

const DEFAULT_FOCAL_MM = 50;
/** Studio's 35 mm film gate: the long side of the frame is 35 mm. */
export function focalToFov(focalLengthMm: number, aspect: number) {
  const filmHeight = 35 / Math.max(aspect, 1);
  return THREE.MathUtils.radToDeg(2 * Math.atan(filmHeight / (2 * focalLengthMm)));
}
export function fovToFocal(fov: number, aspect: number) {
  return Math.round(35 / Math.max(aspect, 1) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) * 10) / 10;
}

/** A semantic shot, framed for this output's aspect ratio. Video is always perspective. */
export function shotVideoCamera(shot: Shot | undefined, ctx: RecipeContext): StudioVideoCamera {
  if (shot?.frame) shot = { ...shot, frame: resolveVideoFocus(shot.frame, ctx) };
  const aspect = ctx.width / ctx.height;
  // A shot names a view or a direction; with neither, use the three-quarter isometric view.
  const base = studioShotSchema.parse({ ...(shot?.view || shot?.from ? {} : { view: 'isometric' }), ...shot, projection: 'perspective' });
  const fov = base.fovDegrees ?? focalToFov(DEFAULT_FOCAL_MM, aspect);
  const framed = { ...base, fovDegrees: fov };
  const fitted = shotCamera(framed, 0, studioFramePoints(ctx.parts, framed), ctx.bounds, aspect, ctx.height);
  return { position: fitted.camera.position.toArray(), target: fitted.tile.target as [number, number, number], fov, focalLengthMm: fovToFocal(fov, aspect) };
}

/** Components name all their visible occurrence meshes; never silently drop an unresolved target. */
export function resolveVideoFocus(frame: NonNullable<Shot['frame']>, ctx: RecipeContext): NonNullable<Shot['frame']> {
  if (!('featureIds' in frame)) return frame;
  const featureIds = new Set<string>();
  for (const id of frame.featureIds) {
    const matches = ctx.parts.filter(p => p.featureId === id || p.occurrencePath?.includes(id));
    if (!matches.length) throw new Error(`Video focus names a result that is not visible: ${id}`);
    matches.forEach(p => featureIds.add(p.featureId));
  }
  return { featureIds: [...featureIds] };
}

const dist = (c: StudioVideoCamera) => offsetOf(c).length();
const offsetOf = (c: StudioVideoCamera) => new THREE.Vector3(...c.position).sub(new THREE.Vector3(...c.target));
/** Rotate about the vertical axis through the target, scale the distance and optionally set an elevation. */
function around(c: StudioVideoCamera, degrees: number, distance = 1, elevationDeg?: number, target?: THREE.Vector3): StudioVideoCamera {
  const t = target ?? new THREE.Vector3(...c.target);
  const o = offsetOf(c);
  const radius = Math.max(o.length() * distance, 1e-3);
  const azimuth = Math.atan2(o.y, o.x) + THREE.MathUtils.degToRad(degrees);
  const elevation = elevationDeg === undefined ? Math.atan2(o.z, Math.hypot(o.x, o.y)) : THREE.MathUtils.degToRad(elevationDeg);
  const position = t.clone().add(new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)).multiplyScalar(radius));
  return { ...c, position: position.toArray(), target: t.toArray() as [number, number, number] };
}

type Draft = Pick<StudioVideoView, 'name' | 'camera' | 'motion' | 'seconds' | 'hold' | 'easing' | 'focus'>;

/**
 * Frame the shot again from a new direction (relative to the start: azimuth offset, optional elevation), for this
 * output's aspect, then move in or out by `closeness`. Every preset view is fitted this way, so a wide model seen
 * side-on in a tall frame is never clipped.
 */
function fitFrom(start: StudioVideoCamera, shot: Shot, ctx: RecipeContext, degrees: number, elevationDeg?: number, closeness = 1, frame = shot.frame): StudioVideoCamera {
  const o = offsetOf(start);
  const azimuth = Math.atan2(o.y, o.x) + THREE.MathUtils.degToRad(degrees);
  const elevation = elevationDeg === undefined ? Math.atan2(o.z, Math.hypot(o.x, o.y)) : THREE.MathUtils.degToRad(elevationDeg);
  const { view: _view, from: _from, ...rest } = shot;
  const fitted = shotVideoCamera({ ...rest, frame, fovDegrees: start.fov,
    from: [Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)] }, ctx);
  return closeness === 1 ? fitted : around(fitted, 0, closeness);
}

function presetViews(preset: NonNullable<StudioVideoRecipe['preset']>, ctx: RecipeContext, from?: StudioVideoCamera): Draft[] {
  const sign = preset.direction === 'clockwise' ? -1 : 1;
  const shot = (preset.shot ?? { view: 'isometric' }) as Shot;
  // People start a preset from the camera they are looking through; agents start from a shot.
  const start = from ?? shotVideoCamera(shot, ctx);
  // The close-up looks from the same direction as the start, framed on the focus.
  const focus = preset.focus ? shotVideoCamera({ ...shot, frame: preset.focus }, ctx) : undefined;
  const close = focus ?? around(start, 0, 0.55);
  // Orbits keep one distance: the farthest any of their angles needs, so the model never leaves the frame.
  const orbit = (angles: number[]) => {
    const needed = Math.max(...angles.map(a => dist(fitFrom(start, shot, ctx, a))));
    const base = around(start, 0, needed / dist(start));
    return angles.map(a => around(base, a));
  };
  switch (preset.name) {
    case 'turntable':
      return orbit([0, 90, 180, 270, 360].map(a => sign * a)).map((camera, i) => ({ name: i ? i === 4 ? 'Full orbit' : `Orbit ${i * 90}°` : 'Start', camera, motion: 'orbit', seconds: 2, hold: 0 }));
    case 'half_orbit':
      return orbit([0, 90, 180].map(a => sign * a)).map((camera, i) => ({ name: i ? `Orbit ${i * 90}°` : 'Start', camera, motion: 'orbit', seconds: 3, hold: 0 }));
    case 'push_pull':
      return [
        { name: 'Start', camera: start, motion: 'move', seconds: 2.5, hold: 0.3 },
        { name: 'Close-up', camera: close, motion: 'move', seconds: 2.5, hold: 0.6 },
        { name: 'Pull back', camera: around(start, 0, 1.3), motion: 'move', seconds: 2.6, hold: 0.4 },
      ];
    case 'detail_reveal':
      return [
        { name: 'Start', camera: start, motion: 'move', seconds: 2.5, hold: 0.3 },
        { name: 'Close-up', camera: close, motion: 'move', seconds: 2.5, hold: 0.3 },
        { name: 'Detail orbit', camera: around(close, sign * 45), motion: 'orbit', seconds: 2.5, hold: 0 },
        { name: 'Reveal', camera: fitFrom(start, shot, ctx, sign * 90, undefined, 1.15), motion: 'move', seconds: 2.5, hold: 0.5 },
      ];
    case 'crane':
      // Low on the far side, rise over the model, settle on the focus or a close three-quarter view.
      return [
        { name: 'Low pass', camera: fitFrom(start, shot, ctx, sign * 150, 5), motion: 'orbit', seconds: 2.5, hold: 0.2 },
        { name: 'Rise', camera: fitFrom(start, shot, ctx, sign * 95, 38), motion: 'orbit', seconds: 3.2, hold: 0 },
        { name: 'Settle', camera: focus ? fitFrom(start, shot, ctx, sign * 25, 28, 1, preset.focus) : fitFrom(start, shot, ctx, sign * 25, 28, 0.9), motion: 'orbit', seconds: 3.0, hold: 0.6 },
      ];
  }
}

/** Resolve a recipe into concrete camera views; the same result drives preview, export and agent renders. */
export function resolveVideoRecipe(recipe: StudioVideoRecipe, ctx: RecipeContext, from?: StudioVideoCamera): StudioVideoView[] {
  let drafts: (Draft & { presentation?: Presentation })[];
  if (recipe.keyframes) {
    drafts = recipe.keyframes.map((k, i) => {
      let camera = k.camera ?? shotVideoCamera(k.focalLengthMm ? { ...k.shot, fovDegrees: focalToFov(k.focalLengthMm, ctx.width / ctx.height) } : k.shot, ctx);
      if (k.focalLengthMm) camera = { ...camera, focalLengthMm: k.focalLengthMm, fov: focalToFov(k.focalLengthMm, ctx.width / ctx.height) };
      if (k.focus) camera = { ...camera, target: shotVideoCamera({ frame: k.focus }, ctx).target };
      return { name: k.name ?? `View ${i + 1}`, camera, motion: k.motion, seconds: k.seconds, hold: k.hold,
        presentation: k.presentation, ...(k.easing ? { easing: k.easing } : {}), ...(k.focus ? { focus: k.focus } : {}) };
    });
  } else {
    drafts = presetViews(recipe.preset!, ctx, from);
    const wanted = recipe.preset!.seconds;
    if (wanted) {
      const views = drafts.map(d => ({ ...d, id: '', presentation: ctx.presentation }));
      const scale = wanted / videoDuration(views);
      drafts = drafts.map(d => ({ ...d, seconds: Math.min(10, Math.max(0.5, d.seconds * scale)), hold: Math.min(5, d.hold * scale) }));
    }
  }
  return drafts.map(d => ({ id: crypto.randomUUID(), name: d.name, camera: d.camera, motion: d.motion, seconds: d.seconds, hold: d.hold,
    presentation: { ...ctx.presentation, ...d.presentation }, ...(d.easing ? { easing: d.easing } : {}), ...(d.focus ? { focus: d.focus } : {}) }));
}

/** Conservative AABB projection, sampled at up to 20 Hz. A close-up may crop intentionally; warn, never reframe it. */
export function videoCropWarnings(views: StudioVideoView[], ctx: RecipeContext): string[] {
  if (!views.length || ctx.bounds.isEmpty()) return [];
  const corners: THREE.Vector3[] = [];
  for (const x of [ctx.bounds.min.x, ctx.bounds.max.x]) for (const y of [ctx.bounds.min.y, ctx.bounds.max.y])
    for (const z of [ctx.bounds.min.z, ctx.bounds.max.z]) corners.push(new THREE.Vector3(x,y,z));
  const camera = new THREE.PerspectiveCamera(35, ctx.width / ctx.height, .00001, 1e12); camera.up.set(0,0,1);
  const duration = videoDuration(views), count = Math.max(1, Math.min(400, Math.ceil(duration * 20)));
  let first: number | undefined, last = 0, cropped = 0;
  for (let i = 0; i <= count; i++) {
    const time = duration * i / count, view = videoFrameAt(views, time).camera;
    camera.position.fromArray(view.position); camera.fov = view.fov; camera.lookAt(new THREE.Vector3(...view.target));
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    if (corners.some(p => { const eye = p.clone().applyMatrix4(camera.matrixWorldInverse), q = p.clone().project(camera);
      return eye.z >= 0 || Math.abs(q.x) > 1.001 || Math.abs(q.y) > 1.001; })) { first ??= time; last = time; cropped++; }
  }
  return cropped ? [`VIDEO_CROP: Model bounds leave the frame near ${first!.toFixed(2)}–${last.toFixed(2)} s (${cropped}/${count+1} sampled views). Close-ups may be intentional; this bounds check is conservative.`] : [];
}
