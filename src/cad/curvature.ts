import type { Face } from 'replicad';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type { Vector3 } from '../shared/protocol';
import { CadError } from './document';

const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = (a: number[]) => a.map(v => v / Math.hypot(...a));

/** Difference of second fundamental forms in one orthonormal world tangent frame, in inverse mm. */
export function curvatureDifference(oc: OpenCascadeInstance, a: Face, b: Face, point: Vector3): number {
  const derivatives = (face: Face) => {
    const [u,v] = face.uvCoordinates(point), adaptor = new oc.BRepAdaptor_Surface(face.wrapped, true);
    try {
      const values = adaptor.EvalD2(u,v);
      try {
        const tuple = (p: typeof values.D1U) => [p.X(),p.Y(),p.Z()];
        return { du:tuple(values.D1U), dv:tuple(values.D1V), duu:tuple(values.D2U), dvv:tuple(values.D2V), duv:tuple(values.D2UV) };
      } finally { Object.values(values).forEach(value => value.delete()); }
    } finally { adaptor.delete(); }
  };
  const A = derivatives(a), B = derivatives(b), normal = unit(cross(A.du,A.dv));
  const x = unit(A.du), y = cross(normal,x);
  const form = (s: typeof A) => {
    const E=dot(s.du,s.du), F=dot(s.du,s.dv), G=dot(s.dv,s.dv), det=E*G-F*F;
    if (!Number.isFinite(det) || det <= E*G*1e-14) throw new CadError('CONTINUITY_UNSUPPORTED', 'Curvature cannot be measured at a singular surface parameter.');
    let n=unit(cross(s.du,s.dv)); if(dot(n,normal)<0)n=n.map(v=>-v);
    const coefficients=(direction:number[])=>[(G*dot(s.du,direction)-F*dot(s.dv,direction))/det,(E*dot(s.dv,direction)-F*dot(s.du,direction))/det];
    const [xu,xv]=coefficients(x),[yu,yv]=coefficients(y),L=dot(n,s.duu),M=dot(n,s.duv),N=dot(n,s.dvv);
    return [L*xu*xu+2*M*xu*xv+N*xv*xv,L*xu*yu+M*(xu*yv+xv*yu)+N*xv*yv,L*yu*yu+2*M*yu*yv+N*yv*yv];
  };
  const first=form(A),second=form(B),difference=first.map((v,i)=>v-second[i]);
  const residual=Math.hypot(difference[0],Math.SQRT2*difference[1],difference[2]);
  if(!Number.isFinite(residual))throw new CadError('CONTINUITY_UNSUPPORTED','Exact surface derivatives did not yield a finite curvature measurement.');
  return residual;
}
