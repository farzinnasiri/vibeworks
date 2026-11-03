import { Matrix4, Quaternion, Vector3 as Vec } from 'three';
import type { Feature, Frame, ResolvedMount, Vector3 } from '../shared/protocol';
import { CadError } from './document';

export const normalizeDegrees=(degrees:number)=>((degrees%360)+540)%360-180;

type Instance = Extract<Feature, { kind: 'instance' }>;
export type Placement = Pick<Instance['params'], 'translation' | 'rotationAxis' | 'angleDegrees' | 'origin'>;
const tuple = (v: Vec) => v.toArray() as Vector3;
export function frameAxes(frame: Frame): [Vec, Vec, Vec] {
  const z = new Vec(...frame.normal).normalize();
  const x = new Vec(...frame.xDirection).addScaledVector(z, -new Vec(...frame.xDirection).dot(z)).normalize();
  return [x, new Vec().crossVectors(z, x).normalize(), z];
}
export function framePoint(frame: Frame, u: number, v: number): Vector3 {
  const [x, y] = frameAxes(frame);
  return tuple(new Vec(...frame.origin).addScaledVector(x, u).addScaledVector(y, v));
}
export function normalizeFrame(frame: Frame): Frame {
  const [x, , z] = frameAxes(frame);
  return { origin: [...frame.origin], xDirection: tuple(x), normal: tuple(z) };
}
function rotation(p: Placement): Quaternion {
  return new Quaternion().setFromAxisAngle(new Vec(...p.rotationAxis).normalize(), normalizeDegrees(p.angleDegrees) * Math.PI / 180);
}
export function placeFrame(frame: Frame, p: Placement): Frame {
  const q = rotation(p);
  return { origin: tuple(new Vec(...frame.origin).sub(new Vec(...p.origin)).applyQuaternion(q).add(new Vec(...p.origin)).add(new Vec(...p.translation))),
    xDirection: tuple(new Vec(...frame.xDirection).applyQuaternion(q)), normal: tuple(new Vec(...frame.normal).applyQuaternion(q)) };
}
export function findMount(mounts: ResolvedMount[] | undefined, name: string, owner: string): Frame {
  const found = mounts?.find(m => m.name === name);
  if (!found) throw new CadError('MOUNT_NOT_FOUND', `Mount '${name}' is missing on '${owner}'. Inspect geometry.mounts and repair the attachment.`, { featureId: owner, name, availableMounts: mounts?.map(m => m.name) ?? [] });
  return found.frame;
}
/** Map source coordinates into target coordinates. Offsets use the target's original axes. */
export function attachmentPlacement(source: Frame, target: Frame, attachment: NonNullable<Instance['params']['attachment']>): Placement {
  const [tx, ty, tz] = frameAxes(target), [sx, sy, sz] = frameAxes(source);
  const targetRotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(tx, ty, tz));
  const sourceRotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(sx, sy, sz));
  // Twist the target frame first. Mate is about its now-twisted local U, preserving that U.
  // With U'=cos(a)U+sin(a)V and V'=-sin(a)U+cos(a)V, mate gives (U',-V',-N).
  // These are local frame rotations, so the desired basis is T * twistZ * mateX.
  const desired = targetRotation.clone().multiply(new Quaternion().setFromAxisAngle(new Vec(0, 0, 1), normalizeDegrees(attachment.twistDegrees) * Math.PI / 180));
  if (attachment.mode === 'mate') desired.multiply(new Quaternion().setFromAxisAngle(new Vec(1, 0, 0), Math.PI));
  const q = desired.multiply(sourceRotation.invert()).normalize();
  // Canonical shortest rotation makes cache identity independent of quaternion sign.
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, q.w))), sin = Math.sin(angle / 2);
  const translation = new Vec(...target.origin).addScaledVector(tx, attachment.offset[0]).addScaledVector(ty, attachment.offset[1]).addScaledVector(tz, attachment.offset[2]).sub(new Vec(...source.origin).applyQuaternion(q));
  return { origin: [0, 0, 0], translation: tuple(translation), rotationAxis: sin < 1e-10 ? [0, 0, 1] : [q.x / sin, q.y / sin, q.z / sin], angleDegrees: angle * 180 / Math.PI };
}
/** Mounts are static authored references, inherited through the single target chain. */
export function derivedMounts(feature: Feature, inherited: ResolvedMount[] = []): ResolvedMount[] {
  let mounts = structuredClone(inherited);
  if (feature.kind === 'pattern') mounts = [];
  if (feature.kind === 'transform') {
    const p = feature.params;
    mounts = mounts.map(m => ({ ...m, frame: placeFrame({ ...m.frame, origin: m.frame.origin.map((v, i) => p.origin[i] + (v - p.origin[i]) * p.scale) as Vector3 }, p) }));
  }
  if (feature.kind === 'mirror') {
    const p = feature.params, axis = { YZ: 0, XZ: 1, XY: 2 }[p.plane];
    const reflected = (v: Vector3, point = false) => v.map((n, i) => i === axis ? (point ? 2 * p.origin[i] : 0) - n : n) as Vector3;
    mounts = mounts.map(m => ({ ...m, frame: { origin: reflected(m.frame.origin, true), xDirection: reflected(m.frame.xDirection), normal: reflected(m.frame.normal) } }));
  }
  const byName = new Map(mounts.map(m => [m.name, m]));
  for (const mount of feature.mounts ?? []) byName.set(mount.name, { name: mount.name, frame: normalizeFrame(mount.frame) });
  if (byName.size > 256) throw new CadError('MOUNT_LIMIT', `Feature '${feature.id}' exceeds 256 resolved mounts. Select one source result or reduce mounts.`);
  return [...byName.values()];
}
