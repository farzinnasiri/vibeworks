import type { Frame, Vector3 } from '../../src/shared/protocol';

// Test oracle uses scalar vector arithmetic and explicit world-axis Rodrigues rotations.
// It does not import Three.js, frames.ts or any product placement helpers.
export const add = (a: Vector3, b: Vector3): Vector3 => a.map((v, i) => v + b[i]) as Vector3;
export const scale = (a: Vector3, k: number): Vector3 => a.map(v => v * k) as Vector3;
export const dot = (a: Vector3, b: Vector3) => a.reduce((sum, v, i) => sum + v * b[i], 0);
export const cross = (a: Vector3, b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const unit = (a: Vector3) => scale(a, 1 / Math.hypot(...a));
export function turn(point: Vector3, axis: Vector3, degrees: number): Vector3 {
  const n = unit(axis), angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(point, c), scale(cross(n, point), s)), scale(n, dot(n, point) * (1 - c)));
}

export interface PlacementCase {
  name: string; source: Frame; target: Frame; mode: 'align' | 'mate'; twistDegrees: number; offset: Vector3;
}
export function placementCases(): PlacementCase[] {
  const frames: { name: string; source: Frame; target: Frame }[] = [
    { name: 'review-box', source: { origin: [0,0,4], xDirection: [1,0,0], normal: [0,0,1] },
      target: { origin: [50,-20,8], xDirection: [0,1,0], normal: [0,0,1] } },
    { name: 'skew', source: { origin: [3,4,5], xDirection: [2,-1,0], normal: [1,2,2] },
      target: { origin: [-7,13,19], xDirection: [1,2,0], normal: [2,-1,2] } },
  ];
  return frames.flatMap(f => (['align', 'mate'] as const).flatMap(mode => [-90, -37, 0, 37, 90].map(twistDegrees => ({
    ...f, mode, twistDegrees, offset: [3,4,5] as Vector3, name: `${f.name}-${mode}-${twistDegrees}`,
  }))));
}
export function expectedPlacement(c: PlacementCase) {
  const su = unit(c.source.xDirection), sn = unit(c.source.normal), sv = cross(sn, su);
  const tu = unit(c.target.xDirection), tn = unit(c.target.normal), tv = cross(tn, tu);
  const landing = add(c.target.origin, add(add(scale(tu, c.offset[0]), scale(tv, c.offset[1])), scale(tn, c.offset[2])));
  const twistedU = turn(tu, tn, c.twistDegrees);
  const orient = (v: Vector3) => {
    const twisted = turn(v, tn, c.twistDegrees);
    // The local U axis after twisting, expressed explicitly in world coordinates.
    return c.mode === 'mate' ? turn(twisted, twistedU, 180) : twisted;
  };
  const u = orient(tu), v = orient(tv), n = orient(tn);
  const point = (p: Vector3) => {
    const d = add(p, scale(c.source.origin, -1));
    return add(landing, add(add(scale(u, dot(d, su)), scale(v, dot(d, sv))), scale(n, dot(d, sn))));
  };
  const corners = [0,20].flatMap(x => [0,10].flatMap(y => [0,4].map(z => point([x,y,z]))));
  const min = [0,1,2].map(i => Math.min(...corners.map(p => p[i]))) as Vector3;
  const max = [0,1,2].map(i => Math.max(...corners.map(p => p[i]))) as Vector3;
  return { landing, u, v, n, point, min, max };
}
