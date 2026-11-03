import { cast, Face, makeVertex, measureDistanceBetween, type Shape3D } from 'replicad';
import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { PaintRegion, TopologyTable, Vector3 } from '../shared/protocol';
import { indexedShapes } from './topology';
import { resolveFaces } from './surface-reference';
import { CadError } from './document';
import {crestBoundary,sectionMaximum} from './regions';

/** Exact surface imprints for paint regions. Crest boundaries retain their declared numerical tolerance. */
export function stepRegions(oc: OpenCascadeInstance, shape: Shape3D, sourceShape:Shape3D, table: TopologyTable, regions: PaintRegion[], colors: Map<number,string>, toWorld: (point:Vector3,direction?:boolean)=>Vector3, toLocal:(point:Vector3)=>Vector3) {
  const supported=regions.filter(r=>r.look.color),warnings:string[]=[];
  if(!supported.length)return {shape,colors,warnings};
  const owned:{delete():void}[]=[],own=<T extends{delete():void}>(v:T):T=>{owned.push(v);return v;};
  const original=indexedShapes(oc,shape.wrapped,'FACE');original.forEach(own);
  const sourceFaces=indexedShapes(oc,sourceShape.wrapped,'FACE');sourceFaces.forEach(own);
  const tools:TopoDS_Shape[]=[],targets=supported.map(r=>new Set(resolveFaces(table,r.target)));
  const bounds=original.map(raw=>{const face=own(oc.TopoDS.Face(raw));return oc.BRepTools.UVBounds(face);});
  let splitShape:Shape3D|undefined;
  try{
    const dot=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i],0),unit=(a:number[])=>a.map(v=>v/Math.hypot(...a));
    const addPlane=(index:number,origin:Vector3,normal:Vector3)=>{
      const box=own(new oc.Bnd_Box());oc.BRepBndLib.AddOptimal(sourceFaces[index],box,false,false);
      const min=own(box.CornerMin()),max=own(box.CornerMax()),lo=[min.X(),min.Y(),min.Z()],hi=[max.X(),max.Y(),max.Z()];
      const lower=dot(normal.map((v,i)=>v>=0?lo[i]:hi[i]),normal),upper=dot(normal.map((v,i)=>v>=0?hi[i]:lo[i]),normal),station=dot(origin,normal);
      // Do not re-imprint existing end boundaries. Bounds are conservative for arbitrary axes.
      if(station<=lower+1e-7*Math.hypot(...normal)||station>=upper-1e-7*Math.hypot(...normal))return;
      const plane=own(new oc.gp_Pln(own(new oc.gp_Pnt(...toWorld(origin))),own(new oc.gp_Dir(...toWorld(normal,true)))));
      const section=own(new oc.BRepAlgoAPI_Section(own(oc.TopoDS.Face(original[index])),plane,false));
      section.ComputePCurveOn1(true);section.Approximation(true);section.Build();
      const raw=own(section.Shape());
      for(const edge of indexedShapes(oc,raw,'EDGE'))tools.push(own(edge));
    };
    const crestTests=new Map<string,(point:Vector3)=>boolean>();
    for(const [ri,region]of supported.entries())for(const index of targets[ri]){
      const face=own(oc.TopoDS.Face(original[index]));
      for(const [pi,predicate]of region.keep.entries()){
        if('side'in predicate){
          addPlane(index,predicate.side.plane.origin,predicate.side.plane.normal);
        }else if('iso'in predicate){
          const surface=own(oc.BRep_Tool.Surface(face));
          const b=bounds[index];
          for(const [axis,interval]of Object.entries(predicate.iso))if(interval)for(const value of interval){
            if(value===0||value===1)continue;
            const u=axis==='u',parameter=(u?b.UMin:b.VMin)+value*((u?b.UMax:b.VMax)-(u?b.UMin:b.VMin));
            const curve=own(u?surface.UIso(parameter):surface.VIso(parameter));
            const edge=own(new oc.BRepBuilderAPI_MakeEdge(curve,u?b.VMin:b.UMin,u?b.VMax:b.UMax));
            tools.push(own(edge.Edge()));
          }
        }else if('crest'in predicate){
          const c=predicate.crest,axis=unit(c.axis),extreme=unit(c.extreme),lateral=unit([axis[1]*extreme[2]-axis[2]*extreme[1],axis[2]*extreme[0]-axis[0]*extreme[2],axis[0]*extreme[1]-axis[1]*extreme[0]]);
          const boundary=crestBoundary(oc,sourceFaces[index],c),samples=boundary.samples;
          crestTests.set(`${ri}:${index}:${pi}`,point=>{const s=dot(point,axis);return s>=c.fromMm-1e-8&&s<=c.toMm+1e-8&&boundary.side(point)>=0;});
          for(const station of[c.fromMm,c.toMm])addPlane(index,axis.map(v=>v*station) as Vector3,axis as Vector3);
          const first=samples[0],last=samples.at(-1)!,l0=dot(first.p,lateral),slope=(dot(last.p,lateral)-l0)/(last.s-first.s);
          if(samples.every(s=>Math.abs(dot(s.p,lateral)-l0-slope*(s.s-first.s))<1e-8)){
            addPlane(index,axis.map((v,i)=>v*first.s+lateral[i]*l0) as Vector3,lateral.map((v,i)=>v-slope*axis[i]) as Vector3);
          }else{
            const sourceFace=own(new Face(oc.TopoDS.Face(sourceFaces[index]))),sourceSurface=own(new oc.BRepAdaptor_Surface(sourceFace.wrapped,true));
            const nodes=samples.map(s=>({s:s.s,p:s.p as Vector3,uv:sourceFace.uvCoordinates(s.p as Vector3)}));
            // Piecewise-linear UV curves stay exactly on the native support. Refine and
            // measure in mm; the painted boundary is numerical, the solid surfaces are exact.
            let maximum=0;
            for(let i=0;i<nodes.length-1;i++){
              const a=nodes[i],b=nodes[i+1],uv=a.uv.map((v,k)=>(v+b.uv[k])/2),p=sourceSurface.Value(uv[0],uv[1]);
              let actual:Vector3;try{actual=[p.X(),p.Y(),p.Z()];}finally{p.delete();}
              const station=dot(actual,axis),expected=sectionMaximum(oc,sourceFaces[index],axis,station,extreme,c.toleranceMm/4),error=Math.hypot(...actual.map((v,k)=>v-expected[k]));
              if(error>c.toleranceMm/2){
                if(nodes.length>=400)throw new CadError('CREST_LIMIT','STEP crest boundary cannot meet its dimensional tolerance within 400 UV stations.');
                const mid=(a.s+b.s)/2,point=sectionMaximum(oc,sourceFaces[index],axis,mid,extreme,c.toleranceMm/4) as Vector3;
                nodes.splice(i+1,0,{s:mid,p:point,uv:sourceFace.uvCoordinates(point)});i--;
              }else maximum=Math.max(maximum,error);
            }
            const poles=own(new oc.NCollection_Array1_gp_Pnt2d(1,nodes.length)),knots=own(new oc.NCollection_Array1_double(1,nodes.length)),multiplicities=own(new oc.NCollection_Array1_int(1,nodes.length));
            nodes.forEach((node,i)=>{poles.SetValue(i+1,own(new oc.gp_Pnt2d(...node.uv)));knots.SetValue(i+1,node.s);multiplicities.SetValue(i+1,i===0||i===nodes.length-1?2:1);});
            const curve=own(new oc.Geom2d_BSplineCurve(poles,knots,multiplicities,1,false)),surface=own(oc.BRep_Tool.Surface(face)),builder=own(new oc.BRepBuilderAPI_MakeEdge(curve,surface)),edge=own(builder.Edge());
            if(!oc.BRepLib.BuildCurves3d(edge,Math.min(1e-9,c.toleranceMm/100),oc.GeomAbs_Shape.GeomAbs_C0,8,1000))throw new CadError('CREST_UNRESOLVED','The numerical UV crest could not be converted to a bounded native edge.');
            tools.push(edge);
            warnings.push(`STEP_CREST_BOUNDARY: ${region.id}; ${nodes.length} UV stations; sampled midpoint deviation ${maximum} mm; requested tolerance ${c.toleranceMm} mm. Exact solid surfaces and volume are unchanged.`);
          }
        }
        if(tools.length>128)throw new CadError('STEP_REGION_LIMIT','STEP region export supports at most 128 exact splitting edges per piece.');
      }
    }
    const splitter=tools.length?own(new oc.BRepAlgoAPI_Splitter()):undefined;
    if(splitter){
      const args=own(new oc.NCollection_List_TopoDS_Shape()),toolList=own(new oc.NCollection_List_TopoDS_Shape());
      args.Append(shape.wrapped);tools.forEach(tool=>toolList.Append(tool));splitter.SetArguments(args);splitter.SetTools(toolList);splitter.SetNonDestructive(true);splitter.Build();
      if(!splitter.IsDone())throw new CadError('STEP_REGION_FAILED','Exact region boundaries could not be imprinted on the exported solid.');
      splitShape=cast(own(splitter.Shape())).asShape3D();
    }else splitShape=shape.clone();
    const check=own(new oc.BRepCheck_Analyzer(splitShape.wrapped,true,false,true));
    // On trimmed splines, integration error estimates can be conservative. Establish
    // geometric equivalence independently by requiring empty exact differences both ways.
    for(const [a,b]of[[shape,splitShape],[splitShape,shape]]){
      const cut=own(new oc.BRepAlgoAPI_Cut()),args=own(new oc.NCollection_List_TopoDS_Shape()),tools=own(new oc.NCollection_List_TopoDS_Shape());args.Append(a.wrapped);tools.Append(b.wrapped);cut.SetArguments(args);cut.SetTools(tools);cut.SetNonDestructive(true);cut.Build();
      if(!cut.IsDone())throw new CadError('STEP_REGION_FAILED','Exact two-way region equivalence could not be evaluated.');
      const difference=own(cut.Shape()),remaining=indexedShapes(oc,difference,'FACE');
      try{if(remaining.length)throw new CadError('STEP_REGION_FAILED','Region splitting left a nonempty exact solid difference.',{faces:remaining.length});}finally{remaining.forEach(f=>f.delete());}
    }
    const volume=(s:Shape3D)=>{const p=own(new oc.GProp_GProps());const error=oc.BRepGProp.VolumePropertiesGK(s.wrapped,p,1e-12,true,true,false,false,false);if(!Number.isFinite(error)||error<0||!Number.isFinite(p.Mass()))throw new CadError('STEP_REGION_FAILED','Span-aware exact-surface volume integration failed.',{error});return p.Mass();};
    const before=volume(shape),after=volume(splitShape);
    const solids=(s:Shape3D)=>{const all=indexedShapes(oc,s.wrapped,'SOLID');try{return all.length;}finally{all.forEach(s=>s.delete());}};
    if(!check.IsValid()||solids(shape)!==solids(splitShape)||Math.abs(before-after)>Math.max(1e-8,Math.abs(before)*1e-9))throw new CadError('STEP_REGION_FAILED','Region splitting did not preserve valid solids and exact volume.',{valid:check.IsValid(),before,after,relativeDifference:Math.abs(before-after)/Math.max(1,Math.abs(before)),beforeSolids:solids(shape),afterSolids:solids(splitShape)});
    const output=indexedShapes(oc,splitShape.wrapped,'FACE');output.forEach(own);
    const mapped=new Map<number,number>();
    for(const [source,face]of original.entries()){
      const descendants=[face];
      if(splitter){const modified=own(splitter.Modified(face)),copy=own(new oc.NCollection_List_TopoDS_Shape(modified));while(!copy.IsEmpty()){descendants.push(own(copy.First()));copy.RemoveFirst();}}
      output.forEach((candidate,index)=>{if(descendants.some(d=>d.IsSame(candidate))){if(mapped.has(index)&&mapped.get(index)!==source)throw new CadError('STEP_REGION_MAPPING','Two source faces mapped to the same exported face.');mapped.set(index,source);}});
    }
    if(mapped.size!==output.length)throw new CadError('STEP_REGION_MAPPING','An exported face lost its original surface identity.');
    const painted=new Map<number,string>();
    const interior=(raw:TopoDS_Shape):{point:Vector3;uv:[number,number]}=>{
      const face=own(new Face(oc.TopoDS.Face(raw))),adaptor=own(new oc.BRepAdaptor_Surface(face.wrapped,true)),b=oc.BRepTools.UVBounds(face.wrapped);
      for(const u of[0.5,0.2113248654,0.7886751346,0.1,0.9])for(const v of[0.5,0.2113248654,0.7886751346,0.1,0.9]){
        const uv:[number,number]=[b.UMin+u*(b.UMax-b.UMin),b.VMin+v*(b.VMax-b.VMin)],p=adaptor.Value(...uv);
        try{const point:Vector3=[p.X(),p.Y(),p.Z()],vertex=makeVertex(point);try{if(measureDistanceBetween(vertex,face)<1e-7)return{point,uv};}finally{vertex.delete();}}finally{p.delete();}
      }
      throw new CadError('STEP_REGION_MAPPING','No interior point could be established for an exported region face.');
    };
    output.forEach((face,index)=>{
      const source=mapped.get(index)!;if(colors.has(source))painted.set(index,colors.get(source)!);
      const candidates=supported.flatMap((region,ri)=>targets[ri].has(source)?[{region,ri}]:[]);if(!candidates.length)return;
      const {point,uv}=interior(face),local=toLocal(point),b=bounds[source];
      for(const {region,ri} of candidates)if(region.keep.every((predicate,pi)=>{
        if('side'in predicate)return local.reduce((sum,v,i)=>sum+(v-predicate.side.plane.origin[i])*predicate.side.plane.normal[i],0)>=0;
        if('iso'in predicate){const u=(uv[0]-b.UMin)/(b.UMax-b.UMin),v=(uv[1]-b.VMin)/(b.VMax-b.VMin);return(!predicate.iso.u||u>=predicate.iso.u[0]-1e-9&&u<=predicate.iso.u[1]+1e-9)&&(!predicate.iso.v||v>=predicate.iso.v[0]-1e-9&&v<=predicate.iso.v[1]+1e-9);}
        return crestTests.get(`${ri}:${source}:${pi}`)!(local);
      }))painted.set(index,region.look.color!);
    });
    const result={shape:splitShape,colors:painted,warnings};splitShape=undefined;return result;
  }finally{splitShape?.delete();owned.reverse().forEach(v=>v.delete());}
}
