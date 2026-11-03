import * as THREE from 'three';
import type { StudioVideoCamera, StudioVideoView } from '../shared/protocol';

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
        const m0 = start ? 0 : 1, m1 = end ? 0 : 1;
        t = (-2 * t ** 3 + 3 * t ** 2) + m0 * (t ** 3 - 2 * t ** 2 + t) + m1 * (t ** 3 - t ** 2);
        return { camera: interpolateVideoCamera(views[i - 1].camera, view.camera, t, view.motion), presentation: views[i - 1].presentation, index: i };
      }
      cursor += view.seconds;
    }
    if (time < cursor + view.hold || i === views.length - 1) return { camera: view.camera, presentation: view.presentation, index: i };
    cursor += view.hold;
  }
  throw new Error('Invalid camera sequence.');
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
