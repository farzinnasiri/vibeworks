import * as THREE from 'three';
import type { StudioVideoCamera, StudioVideoView } from '../shared/protocol';
import { studioSettings } from '../shared/studio';

export function videoDuration(views: StudioVideoView[]) {
  return views.reduce((n, v, i) => n + v.hold + (i && v.motion !== 'cut' ? v.seconds : 0), 0);
}

export function videoViewTime(views: StudioVideoView[], index: number) {
  return views.slice(0, index + 1).reduce((n, view, i) => n + (i && view.motion !== 'cut' ? view.seconds : 0) + (i < index ? view.hold : 0), 0);
}

/** Z-up orbit interpolation retains distance, including when views face opposite directions. */
export function interpolateVideoCamera(a: StudioVideoCamera, b: StudioVideoCamera, t: number, motion: 'orbit' | 'move'): StudioVideoCamera {
  const target = new THREE.Vector3(...a.target).lerp(new THREE.Vector3(...b.target), t);
  let position: THREE.Vector3;
  if (motion === 'orbit') {
    const spherical = (c: StudioVideoCamera) => {
      const v = new THREE.Vector3(...c.position).sub(new THREE.Vector3(...c.target));
      return { radius: v.length(), azimuth: Math.atan2(v.y, v.x), elevation: Math.atan2(v.z, Math.hypot(v.x, v.y)) };
    };
    const x = spherical(a), y = spherical(b);
    let delta = y.azimuth - x.azimuth;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const azimuth = x.azimuth + delta * t, elevation = THREE.MathUtils.lerp(x.elevation, y.elevation, t), radius = THREE.MathUtils.lerp(x.radius, y.radius, t);
    position = target.clone().add(new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)).multiplyScalar(radius));
  } else position = new THREE.Vector3(...a.position).lerp(new THREE.Vector3(...b.position), t);
  return { position: position.toArray(), target: target.toArray(), fov: THREE.MathUtils.lerp(a.fov, b.fov, t), focalLengthMm: THREE.MathUtils.lerp(a.focalLengthMm, b.focalLengthMm, t) };
}

const ANGLES = new Set(['lightRotation', 'environmentRotation']);
const mixHex = (a: string, b: string, t: number) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('');
/**
 * Scene settings travel with the camera: numbers and colours blend, angles take the short way round, and
 * choices (floor, environment photo, background mode) switch halfway. Equal scenes return the same object.
 */
export function blendPresentation(a: StudioVideoView['presentation'], b: StudioVideoView['presentation'], t: number): StudioVideoView['presentation'] {
  if (a === b || JSON.stringify(a) === JSON.stringify(b)) return a;
  const out: Record<string, unknown> = {};
  // An unset value means Studio's default, so it blends from (or to) that default rather than snapping.
  const defaults = studioSettings({}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const fill = (v: unknown, other: unknown) => v === undefined && typeof other === typeof defaults[key] ? defaults[key] : v;
    const x = fill((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]), y = fill((b as Record<string, unknown>)[key], (a as Record<string, unknown>)[key]);
    if (typeof x === 'number' && typeof y === 'number') {
      if (ANGLES.has(key)) { const d = Math.atan2(Math.sin((y - x) * Math.PI / 180), Math.cos((y - x) * Math.PI / 180)) * 180 / Math.PI; out[key] = ((x + d * t + 540) % 360) - 180; }
      else out[key] = x + (y - x) * t;
    } else if (typeof x === 'string' && typeof y === 'string' && /^#[0-9a-f]{6}$/i.test(x) && /^#[0-9a-f]{6}$/i.test(y)) out[key] = mixHex(x, y, t);
    else out[key] = t < 0.5 ? x : y;
    if (out[key] === undefined) delete out[key];
  }
  return out as StudioVideoView['presentation'];
}

/** Stops ease only at holds, cuts and sequence ends. Intermediate orbit views retain their pace. */
export function videoFrameAt(views: StudioVideoView[], time: number): { camera: StudioVideoCamera; presentation: StudioVideoView['presentation']; index: number } {
  if (!views.length) throw new Error('Add a camera view first.');
  time = Math.max(0, Math.min(time, videoDuration(views)));
  let cursor = 0;
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    if (i && view.motion !== 'cut') {
      if (time < cursor + view.seconds) {
        let t = (time - cursor) / view.seconds;
        const start = i === 1 || views[i - 1].hold > 0 || views[i - 1].motion === 'cut';
        const end = i === views.length - 1 || view.hold > 0 || views[i + 1]?.motion === 'cut';
        // Cubic Hermite time mapping, with zero velocity only where the sequence stops.
        const easing = view.easing ?? 'auto';
        const m0 = easing === 'auto' ? start ? 0 : 1 : easing === 'ease_in' || easing === 'ease_in_out' ? 0 : 1;
        const m1 = easing === 'auto' ? end ? 0 : 1 : easing === 'ease_out' || easing === 'ease_in_out' ? 0 : 1;
        t = (-2 * t ** 3 + 3 * t ** 2) + m0 * (t ** 3 - 2 * t ** 2 + t) + m1 * (t ** 3 - t ** 2);
        return { camera: view.motion === 'smooth' ? smoothCamera(views, i, t) : interpolateVideoCamera(views[i - 1].camera, view.camera, t, view.motion), presentation: blendPresentation(views[i - 1].presentation, view.presentation, t), index: i };
      }
      cursor += view.seconds;
    }
    if (time < cursor + view.hold || i === views.length - 1) return { camera: view.camera, presentation: view.presentation, index: i };
    cursor += view.hold;
  }
  throw new Error('Invalid camera sequence.');
}

/** Time-weighted Catmull-Rom/Hermite tangents keep velocity continuous through unequal segment lengths. */
function smoothCamera(views: StudioVideoView[], i: number, t: number): StudioVideoCamera {
  const a = views[i - 1], b = views[i], previous = views[i - 2], next = views[i + 1];
  if (t === 0) return a.camera;
  if (t === 1) return b.camera;
  const mix = (key: 'position' | 'target', axis: number) => {
    const x = a.camera[key][axis], y = b.camera[key][axis];
    const m0 = previous && !a.hold && a.motion === 'smooth' ? (y - previous.camera[key][axis]) * b.seconds / (a.seconds + b.seconds) : y - x;
    const m1 = next && !b.hold && next.motion === 'smooth' ? (next.camera[key][axis] - x) * b.seconds / (b.seconds + next.seconds) : y - x;
    return (2*t**3-3*t*t+1)*x + (t**3-2*t*t+t)*m0 + (-2*t**3+3*t*t)*y + (t**3-t*t)*m1;
  };
  const focalLengthMm = THREE.MathUtils.lerp(a.camera.focalLengthMm, b.camera.focalLengthMm, t);
  const gate = THREE.MathUtils.lerp(Math.tan(THREE.MathUtils.degToRad(a.camera.fov / 2)) * a.camera.focalLengthMm,
    Math.tan(THREE.MathUtils.degToRad(b.camera.fov / 2)) * b.camera.focalLengthMm, t);
  const position = [0,1,2].map(n => mix('position', n)) as [number,number,number];
  const target = [0,1,2].map(n => mix('target', n)) as [number,number,number];
  if (new THREE.Vector3(...position).distanceTo(new THREE.Vector3(...target)) < 1e-6) throw new Error('Camera path crosses its focus. Move a keyframe away from the target.');
  return { position, target, focalLengthMm, fov: THREE.MathUtils.radToDeg(2 * Math.atan(gate / focalLengthMm)) };
}

export function turntableViews(camera: StudioVideoCamera, presentation: StudioVideoView['presentation']): StudioVideoView[] {
  const offset = new THREE.Vector3(...camera.position).sub(new THREE.Vector3(...camera.target));
  return Array.from({ length: 5 }, (_, i) => ({
    id: crypto.randomUUID(), name: i === 0 ? 'Start' : i === 4 ? 'Full orbit' : `Orbit ${i * 90}°`,
    camera: { ...camera, position: offset.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), i * Math.PI / 2).add(new THREE.Vector3(...camera.target)).toArray() },
    presentation: structuredClone(presentation), motion: 'orbit', seconds: 2, hold: 0,
  }));
}

export type VideoPreset = 'turntable' | 'half-orbit' | 'push-pull' | 'detail-reveal';
/** Every preset starts at the user's current camera, including its target and focal length. */
export function videoPresetViews(preset: VideoPreset, camera: StudioVideoCamera, presentation: StudioVideoView['presentation']): StudioVideoView[] {
  if (preset === 'turntable') return turntableViews(camera, presentation);
  const offset = new THREE.Vector3(...camera.position).sub(new THREE.Vector3(...camera.target));
  const points = preset === 'half-orbit' ? [[1,0], [1,90], [1,180]] : preset === 'push-pull' ? [[1,0], [.55,0], [1.3,0]] : [[1,0], [.6,0], [.75,45], [1.2,90]];
  return points.map(([distance, degrees], i) => ({ id: crypto.randomUUID(), name: i === 0 ? 'Start' : preset === 'half-orbit' ? `Orbit ${degrees}°` : i === 1 ? 'Close-up' : i === points.length - 1 ? 'Reveal' : 'Detail orbit',
    camera: { ...camera, position: offset.clone().multiplyScalar(distance).applyAxisAngle(new THREE.Vector3(0,0,1), THREE.MathUtils.degToRad(degrees)).add(new THREE.Vector3(...camera.target)).toArray() },
    presentation: structuredClone(presentation), motion: preset === 'push-pull' || i === 1 ? 'move' : 'orbit', seconds: 2.5, hold: .5,
  }));
}
