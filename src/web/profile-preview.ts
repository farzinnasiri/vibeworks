import type { CadDocument,Profile,RenderedPNG } from '../shared/protocol';
import { CadError } from '../cad/document';

type Point=[number,number];
function arcCircle(a:Point,b:Point,c:Point){
  const d=2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]));
  if(Math.abs(d)<1e-10)throw new CadError('PROFILE_PREVIEW_FAILED','The authored arc is degenerate.');
  const s=(p:Point)=>p[0]*p[0]+p[1]*p[1];
  const x=(s(a)*(b[1]-c[1])+s(b)*(c[1]-a[1])+s(c)*(a[1]-b[1]))/d;
  const y=(s(a)*(c[0]-b[0])+s(b)*(a[0]-c[0])+s(c)*(b[0]-a[0]))/d;
  const angle=(p:Point)=>Math.atan2(p[1]-y,p[0]-x),turn=(v:number)=>(v+Math.PI*2)%(Math.PI*2);
  const start=angle(a),end=angle(c),via=angle(b);
  return {x,y,r:Math.hypot(a[0]-x,a[1]-y),start,end,anticlockwise:turn(via-start)>turn(end-start)};
}

/** The authored local outline, never a substitute for a B-rep section or solid validation. */
export function profilePreview(document:CadDocument,featureId:string,sectionIndex=0,size=512,diagnostics?:Record<string,unknown>):RenderedPNG {
  const feature=document.features.find(f=>f.id===featureId);
  let profile:Profile|undefined,description='Local U/V coordinates · mm';
  if(feature?.kind==='extrude'||feature?.kind==='sweep')profile=feature.params.profile;
  else if(feature?.kind==='loft'){
    const section=feature.params.sections[sectionIndex];profile=section?.profile;
    if(section)description+=` · section ${sectionIndex} at [${section.frame.origin.join(', ')}]`;
  }
  if(!profile)throw new CadError('PROFILE_UNAVAILABLE',`Feature ${featureId} has no requested extrude, sweep or loft profile.`);
  const points:Point[]=[];
  if(profile.type==='circle'||profile.type==='ellipse'){
    const x=profile.type==='circle'?profile.radius:profile.radiusX,y=profile.type==='circle'?profile.radius:profile.radiusY;
    points.push([-x,-y],[x,y]);
  }else if(profile.type==='rectangle')points.push([-profile.width/2,-profile.height/2],[profile.width/2,profile.height/2]);
  else if(profile.type==='polygon')points.push(...profile.points);
  else{
    let from=profile.start;points.push(from);
    for(const segment of profile.segments){
      points.push(segment.to);
      if(segment.type==='bezier')points.push(...segment.controls);
      if(segment.type==='arc'){
        const a=arcCircle(from,segment.via,segment.to);points.push([a.x-a.r,a.y-a.r],[a.x+a.r,a.y+a.r]);
      }
      from=segment.to;
    }
  }
  const min=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1]))],max=[Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  const canvas=globalThis.document.createElement('canvas');canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#eef1f2';ctx.fillRect(0,0,size,size);ctx.fillStyle='#20313b';ctx.font='bold 14px Arial';
  ctx.fillText(`${featureId} · authored ${profile.type} profile`,14,23,size-28);ctx.font='11px Arial';ctx.fillText(description,14,43,size-28);
  ctx.fillStyle='#56636d';ctx.fillText('Profile illustration; solid validity and continuity are separate.',14,size-15,size-28);
  const scale=Math.min((size-72)/Math.max(max[0]-min[0],.01),(size-115)/Math.max(max[1]-min[1],.01));
  ctx.save();ctx.translate(size/2,60+(size-115)/2);ctx.scale(scale,-scale);ctx.translate(-(min[0]+max[0])/2,-(min[1]+max[1])/2);
  ctx.lineWidth=1/scale;ctx.strokeStyle='#bdc7ce';ctx.beginPath();
  ctx.moveTo(min[0],0);ctx.lineTo(max[0],0);ctx.moveTo(0,min[1]);ctx.lineTo(0,max[1]);ctx.stroke();
  ctx.beginPath();
  if(profile.type==='circle')ctx.arc(0,0,profile.radius,0,Math.PI*2);
  else if(profile.type==='ellipse')ctx.ellipse(0,0,profile.radiusX,profile.radiusY,0,0,Math.PI*2);
  else if(profile.type==='rectangle')ctx.rect(-profile.width/2,-profile.height/2,profile.width,profile.height);
  else if(profile.type==='polygon'){
    ctx.moveTo(...profile.points[0]);for(const point of profile.points.slice(1))ctx.lineTo(...point);ctx.closePath();
  }else{
    ctx.moveTo(...profile.start);let from=profile.start;
    for(const segment of profile.segments){
      if(segment.type==='line')ctx.lineTo(...segment.to);
      else if(segment.type==='bezier'){
        if(segment.controls.length===1)ctx.quadraticCurveTo(...segment.controls[0],...segment.to);
        else ctx.bezierCurveTo(...segment.controls[0],...segment.controls[1],...segment.to);
      }else{
        const a=arcCircle(from,segment.via,segment.to);ctx.arc(a.x,a.y,a.r,a.start,a.end,a.anticlockwise);
      }
      from=segment.to;
    }
    ctx.closePath();
  }
  ctx.fillStyle='#dce7ef';ctx.fill();ctx.strokeStyle='#263d50';ctx.lineWidth=2/scale;ctx.stroke();
  if(feature?.kind==='loft'){
    const report=(diagnostics?.sections as {vertices?:number[][];names?:string[]}[]|undefined)?.[sectionIndex],frame=feature.params.sections[sectionIndex]?.frame;
    if(report?.vertices&&frame){
      const x=frame.xDirection.map(v=>v/Math.hypot(...frame.xDirection)),n=frame.normal.map(v=>v/Math.hypot(...frame.normal)),y=[n[1]*x[2]-n[2]*x[1],n[2]*x[0]-n[0]*x[2],n[0]*x[1]-n[1]*x[0]];
      report.vertices.forEach((p,i)=>{const delta=p.map((v,k)=>v-frame.origin[k]),u=delta.reduce((a,v,k)=>a+v*x[k],0),v=delta.reduce((a,v,k)=>a+v*y[k],0);ctx.beginPath();ctx.arc(u,v,(i===0?5:3)/scale,0,Math.PI*2);ctx.fillStyle=i===0?'#ee740e':'#168da6';ctx.fill();ctx.save();ctx.translate(u+6/scale,v+6/scale);ctx.scale(1/scale,-1/scale);ctx.font='11px Arial';ctx.fillStyle='#20313b';ctx.fillText(i===0?`seam · ${report.names?.[i]??i}`:report.names?.[i]??String(i),0,0);ctx.restore();});
    }
  }
  ctx.restore();
  return {kind:'profile',label:`${featureId} profile ${sectionIndex}`,featureId,sectionIndex,mimeType:'image/png',width:size,height:size,base64:canvas.toDataURL('image/png').split(',')[1]};
}
