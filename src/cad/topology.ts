import { Face, Edge, type Shape3D } from 'replicad';
import { prepareShapeForMesh } from 'replicad/shape-functions';
import { CadError } from './document';
import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { DisplayMesh, Feature, TopologyTable, Vector3 } from '../shared/protocol';

/** Exact IsSame identity, including location. Hashes never identify a face. Caller owns returned handles. */
export function indexedShapes(oc: OpenCascadeInstance, shape: TopoDS_Shape, kind: 'FACE' | 'EDGE' | 'VERTEX' | 'SOLID' | 'SHELL' | 'WIRE', hashOf = (item: TopoDS_Shape) => oc.ReplicadShapeHasher.HashCode(item, 2147483647)): TopoDS_Shape[] {
  const buckets = new Map<number, TopoDS_Shape[]>();
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[`TopAbs_${kind}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const found: TopoDS_Shape[] = [];
  try {
    for (; explorer.More(); explorer.Next()) {
      const item = explorer.Current();
      const hash = hashOf(item);
      const bucket = buckets.get(hash) ?? [];
      if (bucket.some(prior => prior.IsSame(item))) item.delete();
      else { bucket.push(item); buckets.set(hash, bucket); found.push(item); }
    }
    return found;
  } catch (error) { found.forEach(s => s.delete()); throw error; }
  finally { explorer.delete(); }
}

function primitiveFaceLineage(feature: Feature, surface: string, normal?: Vector3): string[] {
  if (feature.kind === 'box' && normal) {
    const axis = normal.findIndex(value => Math.abs(value) > 1 - 1e-7);
    if (axis >= 0) return [`${normal[axis] > 0 ? '+' : '-'}${'XYZ'[axis]}`];
  } else if (feature.kind === 'cylinder' || feature.kind === 'rod') {
    if (surface === 'CYLINDRE') return ['side'];
    if (normal) {
      if (feature.kind === 'rod') return [normal.reduce((sum, v, i) => sum + v * (feature.params.to[i] - feature.params.from[i]), 0) > 0 ? 'end' : 'start'];
      return [normal[2] > 0 ? 'top' : 'bottom'];
    }
  }
  return [];
}

/** Construction history needs names only. Exact inspection metrics remain lazy. */
export function topologyLineage(oc: OpenCascadeInstance, shape: Shape3D, feature: Feature): string[][] {
  const faces = indexedShapes(oc, shape.wrapped, 'FACE');
  try {
    return faces.map(raw => {
      if (feature.kind !== 'box' && feature.kind !== 'cylinder' && feature.kind !== 'rod') return [];
      const face = new Face(oc.TopoDS.Face(raw));
      try {
        const normal = face.geomType === 'PLANE' ? face.normalAt() : undefined;
        try { return primitiveFaceLineage(feature, face.geomType, normal?.toTuple()); }
        finally { normal?.delete(); }
      } finally { face.delete(); }
    });
  } finally { faces.forEach(face => face.delete()); }
}

export function topologyTable(oc: OpenCascadeInstance, shape: Shape3D, feature: Feature, names?: string[][]): TopologyTable {
  const faces = indexedShapes(oc, shape.wrapped, 'FACE');
  const edges = indexedShapes(oc, shape.wrapped, 'EDGE');
  try {
    const records = faces.map((raw, faceIndex) => {
      const face = new Face(oc.TopoDS.Face(raw));
      const props = new oc.GProp_GProps();
      try {
        oc.BRepGProp.SurfaceProperties(raw, props, false, false);
        const p = props.CentreOfMass();
        const center: Vector3 = [p.X(), p.Y(), p.Z()]; p.delete();
        const normal = face.geomType === 'PLANE' ? face.normalAt() : undefined;
        const n = normal?.toTuple().map(v => v === 0 ? 0 : v) as Vector3 | undefined; normal?.delete();
        const lineage = names ? names[faceIndex] ?? [] : primitiveFaceLineage(feature, face.geomType, n);
        let shapeSamples: Vector3[]|undefined;
        if(face.geomType!=='PLANE'){
          const adaptor=new oc.BRepAdaptor_Surface(face.wrapped,true),bounds=oc.BRepTools.UVBounds(face.wrapped);
          try{shapeSamples=[];for(const u of [0.1,0.5,0.9])for(const v of [0.1,0.5,0.9]){const p=adaptor.Value(bounds.UMin+(bounds.UMax-bounds.UMin)*u,bounds.VMin+(bounds.VMax-bounds.VMin)*v);try{shapeSamples.push([p.X(),p.Y(),p.Z()]);}finally{p.delete();}}}finally{adaptor.delete();}
        }
        return { lineage, ...(shapeSamples?{shapeSamples}:{}), surface: face.geomType, areaMm2: props.Mass(), center, ...(n ? { normal: n } : {}), neighbours: [] as number[] };
      } finally { face.delete(); props.delete(); }
    });
    const solids=indexedShapes(oc,shape.wrapped,'SOLID'),faceBuckets=new Map<number,number[]>();
    faces.forEach((face,i)=>{const h=oc.ReplicadShapeHasher.HashCode(face,2147483647),b=faceBuckets.get(h)??[];b.push(i);faceBuckets.set(h,b);});
    const solidIndices=new Map<number,number>();
    try{solids.forEach((solid,solidIndex)=>{const children=indexedShapes(oc,solid,'FACE');try{for(const child of children)for(const i of faceBuckets.get(oc.ReplicadShapeHasher.HashCode(child,2147483647))??[])if(faces[i].IsSame(child))solidIndices.set(i,solidIndex);}finally{children.forEach(f=>f.delete());}});}finally{solids.forEach(s=>s.delete());}
    records.forEach((record,i)=>Object.assign(record,{solidIndex:solidIndices.get(i)}));
    const edgeBuckets = new Map<number,number[]>();
    edges.forEach((e,i)=>{const h=oc.ReplicadShapeHasher.HashCode(e,2147483647);const b=edgeBuckets.get(h)??[];b.push(i);edgeBuckets.set(h,b);});
    const membership: number[][] = edges.map(()=>[]);
    faces.forEach((face,i)=>{
      const children=indexedShapes(oc,face,'EDGE');
      try{for(const child of children){const h=oc.ReplicadShapeHasher.HashCode(child,2147483647);const index=edgeBuckets.get(h)?.find(j=>edges[j].IsSame(child));if(index!==undefined)membership[index].push(i);}}
      finally{children.forEach(e=>e.delete());}
    });
    const edgeRecords = edges.map((raw, index) => {
      const members=membership[index];
      for (const a of members) for (const b of members) if (a !== b && !records[a].neighbours.includes(b)) records[a].neighbours.push(b);
      const edge = new Edge(oc.TopoDS.Edge(raw));
      try {
        const p = edge.pointAt(0.5); const center = p.toTuple(); p.delete();
        const a=edge.startPoint,b=edge.endPoint;let endpoints:[Vector3,Vector3];try{endpoints=[a.toTuple(),b.toTuple()];}finally{a.delete();b.delete();}
        return { endpoints,lineage: members.length && members.every(i => records[i].lineage.length) ? [`edge(${members.flatMap(i => records[i].lineage).sort().join('|')})`] : [], faces: members, center, lengthMm: edge.length };
      } finally { edge.delete(); }
    });
    return { faces: records, edges: edgeRecords };
  } finally { faces.forEach(s => s.delete()); edges.forEach(s => s.delete()); }
}

/** Mesh each indexed exact face; this avoids the extractor's hash-only faceId contract entirely. */
export function topologyMesh(oc: OpenCascadeInstance, shape: Shape3D, options: { tolerance: number; angularTolerance: number }, valueLimit = Infinity): Pick<DisplayMesh, 'vertices' | 'normals' | 'triangles' | 'faceRanges'> {
  prepareShapeForMesh(shape, options);
  const faces = indexedShapes(oc, shape.wrapped, 'FACE');
  const vertices: number[] = [], normals: number[] = [], triangles: number[] = [], faceRanges: number[] = [];
  try {
    faces.forEach((raw, i) => {
      const face = oc.TopoDS.Face(raw), location = new oc.TopLoc_Location();
      let triangulation: ReturnType<typeof oc.BRep_Tool.Triangulation> | undefined;
      try {
        triangulation = oc.BRep_Tool.Triangulation(face, location, 0);
        if (!triangulation || triangulation.isNull()) return;
        const nodes = triangulation.NbNodes(), count = triangulation.NbTriangles();
        const values = vertices.length + normals.length + triangles.length + faceRanges.length + nodes * 6 + count * 3 + 4;
        if (values > valueLimit) throw new CadError('MODEL_TOO_COMPLEX', 'This tessellation exceeds the remaining display budget.', { values, limit: valueLimit });
        const transform = location.Transformation(), offset = vertices.length / 3;
        const forward = face.Orientation() === oc.TopAbs_Orientation.TopAbs_FORWARD, sign = forward ? 1 : -1;
        try {
          if (!triangulation.HasNormals()) triangulation.ComputeNormals();
          // Do not use replicad's triangulateFace here: it registers every temporary point/normal
          // for deferred finalization. A synchronous assembly can exhaust JS heap before those run.
          for (let n = 1; n <= nodes; n++) {
            const point = triangulation.Node(n), normal = triangulation.Normal(n);
            try {
              point.Transform(transform); normal.Transform(transform);
              vertices.push(Math.fround(point.X()), Math.fround(point.Y()), Math.fround(point.Z()));
              normals.push(Math.fround(normal.X() * sign), Math.fround(normal.Y() * sign), Math.fround(normal.Z() * sign));
            } finally { point.delete(); normal.delete(); }
          }
          faceRanges.push(triangles.length / 3, count, i, 0);
          for (let n = 1; n <= count; n++) {
            const triangle = triangulation.Triangle(n);
            try {
              const a = triangle.Value(1) - 1 + offset, b = triangle.Value(2) - 1 + offset, c = triangle.Value(3) - 1 + offset;
              triangles.push(forward ? a : b, forward ? b : a, c);
            } finally { triangle.delete(); }
          }
        } finally { transform.delete(); }
      } finally { triangulation?.delete(); location.delete(); face.delete(); }
    });
    return { vertices, normals, triangles, faceRanges };
  } finally { faces.forEach(s => s.delete()); }
}
