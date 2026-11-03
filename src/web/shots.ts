import * as THREE from 'three';
import { VIEW_DIRECTIONS, type RenderedTile, type Shot, type Vector3 } from '../shared/protocol';
import { CadError } from '../cad/document';

const FRAME_MARGIN = 1.06;
const DEFAULT_FOV = 35;
const round = (value: number) => Number(value.toPrecision(6));
const tuple = (v: THREE.Vector3): Vector3 => [round(v.x), round(v.y), round(v.z)];

/** Named views keep their world direction in the label, so "front" is never mistaken for the part's own front. */
const AXIS_NAMES: Record<string, string> = { front: '−Y', back: '+Y', left: '−X', right: '+X', top: '+Z', bottom: '−Z', isometric: '+X −Y +Z' };
export function shotLabel(shot: Shot, index: number): string {
  if (shot.label) return shot.label;
  if (shot.view) return `${shot.view.toUpperCase()} · from ${AXIS_NAMES[shot.view] ?? `[${VIEW_DIRECTIONS[shot.view].join(", ")}]`}`;
  if (!shot.from && shot.section) return `SECTION ${shot.section.axis} ${shot.section.flip ? '≥' : '≤'} ${shot.section.offset} · facing the cut`;
  return shot.from ? `SHOT ${index + 1} · from [${shot.from.map(v => round(v)).join(', ')}]` : `SHOT ${index + 1}`;
}

/** A section keeps the side at or below its offset (above when flipped); its cut faces the removed side. */
export function cutFacing(section: NonNullable<Shot['section']>): Vector3 {
  const direction: Vector3 = [0, 0, 0];
  direction[['X', 'Y', 'Z'].indexOf(section.axis)] = section.flip ? -1 : 1;
  return direction;
}

/** Up defaults to +Z; looking along Z it is +Y from above and −Y from below, as for the named top/bottom views. */
function cameraAxes(shot: Shot) {
  const direction = new THREE.Vector3(...(shot.from ?? (shot.view || !shot.section ? VIEW_DIRECTIONS[shot.view ?? 'isometric'] : cutFacing(shot.section)))).normalize();
  const up = shot.up ? new THREE.Vector3(...shot.up).normalize()
    : Math.abs(direction.z) > 0.999 ? new THREE.Vector3(0, direction.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, direction);
  if (right.lengthSq() < 1e-12) throw new CadError('INVALID_SHOT', 'A shot up direction must not be parallel to its viewing direction.');
  right.normalize();
  return { direction, right, up: new THREE.Vector3().crossVectors(direction, right).normalize() };
}

export interface ShotCamera { camera: THREE.OrthographicCamera | THREE.PerspectiveCamera; tile: RenderedTile }

/**
 * Place a camera for one shot. `frame` holds the flat xyz points the tile must contain (the framed silhouette,
 * box corners, or nothing for a sphere); `scene` bounds every shown point so depth never clips the model.
 */
export function shotCamera(shot: Shot, index: number, frame: ArrayLike<number>, scene: THREE.Box3, aspect: number, pixelHeight: number): ShotCamera {
  const { direction, right, up } = cameraAxes(shot);
  const sphere = shot.frame && 'radiusMm' in shot.frame ? shot.frame : undefined;
  const center = new THREE.Vector3();
  let horizontal = 0, vertical = 0;
  const offsets: { h: number; v: number; d: number }[] = [];
  if (sphere) {
    center.set(...sphere.center);
    horizontal = vertical = sphere.radiusMm;
  } else {
    if (frame.length < 3) throw new CadError('EMPTY_SHOT', `Shot ${index + 1} frames nothing that is shown.`);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i + 2 < frame.length; i += 3) box.expandByPoint(point.set(frame[i], frame[i + 1], frame[i + 2]));
    box.getCenter(center);
    let h0 = Infinity, h1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i + 2 < frame.length; i += 3) {
      point.set(frame[i] - center.x, frame[i + 1] - center.y, frame[i + 2] - center.z);
      const h = point.dot(right), v = point.dot(up);
      h0 = Math.min(h0, h); h1 = Math.max(h1, h); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      offsets.push({ h, v, d: point.dot(direction) });
    }
    // Recenter on the silhouette, then size to it.
    center.addScaledVector(right, (h0 + h1) / 2).addScaledVector(up, (v0 + v1) / 2);
    horizontal = (h1 - h0) / 2; vertical = (v1 - v0) / 2;
    for (const o of offsets) { o.h -= (h0 + h1) / 2; o.v -= (v0 + v1) / 2; }
  }
  const diagonal = Math.max(scene.isEmpty() ? 0 : scene.getSize(new THREE.Vector3()).length(), 2 * Math.max(horizontal, vertical), 0.1);
  const half = Math.max(vertical, horizontal / Math.max(aspect, 0.1), diagonal * 1e-4) * FRAME_MARGIN;
  // Depth: the whole shown model stays between near and far wherever the camera stands.
  const reach = scene.isEmpty() ? diagonal : Math.max(...[0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z =>
    new THREE.Vector3(x ? scene.max.x : scene.min.x, y ? scene.max.y : scene.min.y, z ? scene.max.z : scene.min.z).sub(center).dot(direction)))));
  let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, distance: number, heightMm: number;
  if (shot.projection === 'perspective') {
    const fov = shot.fovDegrees ?? DEFAULT_FOV, tan = Math.tan((fov * Math.PI) / 360);
    // Far enough that every framed point (or the framed sphere) fits both tile directions.
    distance = sphere ? (sphere.radiusMm * FRAME_MARGIN) / Math.sin(Math.atan(tan * Math.min(1, aspect)))
      : Math.max(...offsets.map(o => o.d + (FRAME_MARGIN * Math.max(Math.abs(o.v), Math.abs(o.h) / Math.max(aspect, 0.1))) / tan), half / tan);
    distance = Math.max(distance, diagonal * 1e-3);
    camera = new THREE.PerspectiveCamera(fov, aspect, distance * 0.01, distance + 2 * diagonal);
    heightMm = 2 * distance * tan;
  } else {
    distance = Math.max(reach, 0) + diagonal + 1;
    camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, Math.max(distance * 1e-4, 1e-3), distance + 2 * diagonal + 1);
    heightMm = 2 * half;
  }
  camera.up.copy(up);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const projection = shot.projection ?? 'orthographic';
  return { camera, tile: {
    label: shotLabel(shot, index), projection, eye: tuple(camera.position), target: tuple(center), up: tuple(up),
    widthMm: round(heightMm * aspect), heightMm: round(heightMm), mmPerPixel: round(heightMm / pixelHeight),
    ...(projection === 'perspective' ? { fovDegrees: shot.fovDegrees ?? DEFAULT_FOV } : {}),
  } };
}

/** 1, 2 or 5 times a power of ten: a scale-bar length near `mm`. */
export function scaleBarLength(mm: number): number {
  const power = 10 ** Math.floor(Math.log10(mm));
  return [5, 2, 1].map(step => step * power).find(length => length <= mm) ?? power;
}
