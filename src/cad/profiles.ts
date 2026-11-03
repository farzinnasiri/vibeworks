import { assembleWire, getOC, makeLine, makeBezierCurve, makeThreePointArc, makeCircle, makeEllipse, Edge, Sketch, type Wire } from 'replicad';
import type { CurvePath, Frame, Profile, Vector3 } from '../shared/protocol';
import { frameAxes, framePoint } from './frames';
import { CadError } from './document';

/** Exact kernel edges, with explicit ownership of the assembled wire and input edge wrappers. */
export function pathWire(path: CurvePath, frame: Frame, close = false): Wire {
  const edges: Edge[] = [];
  let from = path.start;
  const point = (p: [number, number]) => framePoint(frame, ...p);
  try {
    for (const segment of path.segments) {
      if (Math.hypot(segment.to[0] - from[0], segment.to[1] - from[1]) < 1e-7)
        throw new CadError('INVALID_PROFILE', 'Curve segment endpoints must differ. Use two arcs for a full circle.');
      edges.push(segment.type === 'line' ? makeLine(point(from), point(segment.to))
        : segment.type === 'arc' ? makeThreePointArc(point(from), point(segment.via), point(segment.to))
        : makeBezierCurve([point(from), ...segment.controls.map(point), point(segment.to)]));
      from = segment.to;
    }
    if (close && Math.hypot(from[0] - path.start[0], from[1] - path.start[1]) > 1e-7) edges.push(makeLine(point(from), point(path.start)));
    if (!close && Math.hypot(from[0] - path.start[0], from[1] - path.start[1]) < 1e-7)
      throw new CadError('INVALID_PATH', 'A sweep path must be open.');
    return assembleWire(edges);
  } finally { for (const edge of edges) edge.delete(); }
}
/** An exact C2 B-spline through the points in order (OCCT GeomAPI_Interpolate), as a one-edge wire. */
export function splineWire(points: Vector3[]): Wire {
  const oc = getOC();
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(value: T): T => { owned.push(value); return value; };
  try {
    const array = own(new oc.NCollection_Array1_gp_Pnt(1, points.length));
    points.forEach((point, i) => array.SetValue(i + 1, own(new oc.gp_Pnt(...point))));
    const interpolation = own(new oc.GeomAPI_Interpolate(own(new oc.NCollection_HArray1_gp_Pnt(array)), false, 1e-6));
    interpolation.Perform();
    if (!interpolation.IsDone()) throw new CadError('INVALID_PATH', 'The path points could not be interpolated. Spread them out and avoid doubling back.');
    const maker = own(new oc.BRepBuilderAPI_MakeEdge(own(interpolation.Curve())));
    const edge = new Edge(maker.Edge());
    try { return assembleWire([edge]); } finally { edge.delete(); }
  } finally { for (const value of owned.reverse()) value.delete(); }
}
export function profileSketch(profile: Profile, frame: Frame): Sketch {
  const ids=profile.type==='polygon'?profile.segmentIds:profile.type==='path'?profile.segments.flatMap(s=>s.id?[s.id]:[]):undefined;
  if(ids&&(new Set(ids).size!==ids.length||profile.type==='polygon'&&ids.length!==profile.points.length))throw new CadError('INVALID_PROFILE','Authored segment IDs must be unique and match the polygon segment count.');
  let wire: Wire;
  if (profile.type === 'circle' || profile.type === 'ellipse') {
    const [x, y, z] = frameAxes(frame);
    const rx = profile.type === 'circle' ? profile.radius : profile.radiusX;
    const ry = profile.type === 'circle' ? profile.radius : profile.radiusY;
    const edge = rx === ry ? makeCircle(rx, frame.origin, z.toArray())
      : makeEllipse(Math.max(rx, ry), Math.min(rx, ry), frame.origin, z.toArray(), (rx > ry ? x : y).toArray());
    try { wire = assembleWire([edge]); } finally { edge.delete(); }
  } else {
    let path: CurvePath;
    if (profile.type === 'path') path = profile;
    else {
      const points: [number, number][] = profile.type === 'polygon' ? profile.points : [
        [-profile.width / 2, -profile.height / 2], [profile.width / 2, -profile.height / 2],
        [profile.width / 2, profile.height / 2], [-profile.width / 2, profile.height / 2],
      ];
      path = { start: points[0], segments: points.slice(1).map(to => ({ type: 'line', to })) };
    }
    wire = pathWire(path, frame, true);
  }
  return new Sketch(wire, { defaultOrigin: frame.origin, defaultDirection: frameAxes(frame)[2].toArray() as Vector3 });
}
export function extrusionFrame(plane: 'XY' | 'XZ' | 'YZ' | Omit<Frame, 'origin'>, origin: Vector3): Frame {
  if (typeof plane !== 'string') return { ...plane, origin };
  return { origin, xDirection: plane === 'YZ' ? [0, 1, 0] : [1, 0, 0], normal: plane === 'XY' ? [0, 0, 1] : plane === 'XZ' ? [0, -1, 0] : [1, 0, 0] };
}
