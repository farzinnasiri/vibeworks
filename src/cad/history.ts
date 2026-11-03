import type { Shape3D } from 'replicad';
import type { OpenCascadeInstance, TopoDS_Shape, BRepBuilderAPI_MakeShape, BRepBuilderAPI_Sewing } from 'replicad-opencascadejs';
import { indexedShapes } from './topology';

/** Only strings survive builders. Native indices are ephemeral, aligned to the current exact shape. */
export class ShapeHistory {
  private names = new WeakMap<Shape3D, string[][]>();
  constructor(private oc: OpenCascadeInstance) {}
  private hash(raw:TopoDS_Shape){return this.oc.ReplicadShapeHasher.HashCode(raw,2147483647);}
  private buckets(shapes:TopoDS_Shape[]){const buckets=new Map<number,number[]>();shapes.forEach((s,i)=>{const h=this.hash(s),items=buckets.get(h)??[];items.push(i);buckets.set(h,items);});return buckets;}
  get(shape: Shape3D) { return this.names.get(shape); }
  set(shape: Shape3D, names: string[][]) { this.names.set(shape, names.map(labels=>labels.length<=64&&labels.every(n=>n.length<=512)?labels:[])); }
  capture(result: Shape3D, builder: BRepBuilderAPI_MakeShape, inputs: Shape3D[], edges = false, offset = false) {
    const out = indexedShapes(this.oc, result.wrapped, 'FACE'), names: string[][] = out.map(() => []);
    const buckets=this.buckets(out);
    const add = (raw: TopoDS_Shape, labels: string[]) => {
      if(!labels.length)return;
      for(const i of buckets.get(this.hash(raw))??[])if(out[i].IsSame(raw))names[i].push(...labels);
    };
    const list = (items: ReturnType<BRepBuilderAPI_MakeShape['Modified']>, labels: string[]) => {
      // Work on a value copy; removing from a builder-owned list would corrupt its history.
      const copy = new this.oc.NCollection_List_TopoDS_Shape(items);
      try { while (!copy.IsEmpty()) { const raw = copy.First(); try { add(raw, labels); } finally { raw.delete(); } copy.RemoveFirst(); } }
      finally { copy.delete(); items.delete(); }
    };
    try {
      for (const input of inputs) {
        const faces = indexedShapes(this.oc, input.wrapped, 'FACE'), labels = this.get(input) ?? faces.map(() => []);
        try { faces.forEach((face, i) => {
          if(!labels[i]?.length)return;
          if (!builder.IsDeleted(face)) add(face, labels[i]);
          const changed=offset?labels[i].map(name=>`inner(${name})`):labels[i];
          list(builder.Modified(face), changed);
          list(builder.Generated(face), changed);
        });
        if (edges) {
          for(const kind of ['EDGE','VERTEX'] as const){
            const entities=indexedShapes(this.oc,input.wrapped,kind),byHash=this.buckets(entities),adjacent=entities.map(()=>new Set<string>());
            try{
              faces.forEach((face,i)=>{
                const children=indexedShapes(this.oc,face,kind);
                try{for(const child of children){const index=byHash.get(this.hash(child))?.find(index=>entities[index].IsSame(child));if(index!==undefined)labels[i].forEach(label=>adjacent[index].add(label));}}
                finally{children.forEach(child=>child.delete());}
              });
              entities.forEach((entity,i)=>{if(adjacent[i].size)list(builder.Generated(entity),[`${kind==='EDGE'?'blend':'corner'}(${[...adjacent[i]].sort().join('|')})`]);});
            }finally{entities.forEach(entity=>entity.delete());}
          }
        }
        } finally { faces.forEach(f => f.delete()); }
      }
      this.set(result, names.map(n => [...new Set(n)].sort()));
    } finally { out.forEach(f => f.delete()); }
  }
  authored(result: Shape3D, builder: BRepBuilderAPI_MakeShape & {FirstShape():TopoDS_Shape;LastShape():TopoDS_Shape}, wire: TopoDS_Shape, ids?: string[], loft = false) {
    const out = indexedShapes(this.oc, result.wrapped, 'FACE'), edges = indexedShapes(this.oc, wire, 'EDGE'), names: string[][] = out.map(() => []);
    const buckets=this.buckets(out);
    const add = (raw: TopoDS_Shape, name: string) => {const children=indexedShapes(this.oc,raw,'FACE');try{for(const r of [raw,...children])for(const i of buckets.get(this.hash(r))??[])if(out[i].IsSame(r))names[i].push(name);}finally{children.forEach(f=>f.delete());}};
    try {
      for (const [i, edge] of edges.entries()) {
        const generated = builder.Generated(edge), copy = new this.oc.NCollection_List_TopoDS_Shape(generated);
        try { while (!copy.IsEmpty()) { const raw = copy.First(); try { add(raw, `side.${ids?.[i] ?? i}`); } finally { raw.delete(); } copy.RemoveFirst(); } }
        finally { copy.delete(); generated.delete(); }
        if (loft) { const raw = (builder as import('replicad-opencascadejs').BRepOffsetAPI_ThruSections).GeneratedFace(edge); try { add(raw, `side.${ids?.[i] ?? i}`); } finally { raw.delete(); } }
      }
      const first = builder.FirstShape(), last = builder.LastShape();
      try { add(first, 'cap.start'); add(last, 'cap.end'); } finally { first.delete(); last.delete(); }
      this.set(result, names.map(n => [...new Set(n)].sort()));
    } finally { out.forEach(f => f.delete()); edges.forEach(e => e.delete()); }
  }
  sewn(result:Shape3D,builder:BRepBuilderAPI_Sewing,inputs:Shape3D[]){
    const output=indexedShapes(this.oc,result.wrapped,'FACE'),buckets=this.buckets(output),names=output.map(()=>new Set<string>());
    try{
      for(const input of inputs){const faces=indexedShapes(this.oc,input.wrapped,'FACE'),labels=this.get(input)??[];
        try{faces.forEach((face,i)=>{
          const modified=builder.IsModifiedSubShape(face)?builder.ModifiedSubShape(face):face.Oriented(face.Orientation());
          try{for(const index of buckets.get(this.hash(modified))??[])if(output[index].IsSame(modified))labels[i]?.forEach(label=>names[index].add(label));}
          finally{modified.delete();}
        });}finally{faces.forEach(face=>face.delete());}
      }
      this.set(result,names.map(labels=>[...labels].sort()));
    }finally{output.forEach(face=>face.delete());}
  }
}
