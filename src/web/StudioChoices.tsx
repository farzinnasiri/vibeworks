import {useEffect,useId,useRef,useState} from 'react';
import {DataUtils,HalfFloatType} from 'three';
import type {Presentation} from '../shared/protocol';
import {STUDIO_FLOOR_IDS,type StudioFloor} from '../shared/materials';
import {STUDIO_FLOORS,STUDIO_ENVIRONMENTS} from '../shared/studio';
import {loadStudioEnvironment} from './studio-scene';
import {floorPattern,type ProceduralFloor} from './floor-patterns';
import {Icon} from './icons';
function FloorSample({floor}:{floor:StudioFloor}){
 const canvas=useRef<HTMLCanvasElement>(null),look=STUDIO_FLOORS[floor];
 const [texture,setTexture]=useState<string>();
 useEffect(()=>{let alive=true;setTexture(undefined);if(look.source==='image')void import('./assets/floors/embedded').then(({floorImages})=>{if(alive)setTexture(floor==='tiles'?floorImages.tiles.map:floorImages.concrete.map);});return()=>{alive=false;};},[floor]);
 useEffect(()=>{if(!canvas.current||look.source!=='procedural')return;
  const size=96,data=floorPattern(floor as ProceduralFloor,size),ctx=canvas.current.getContext('2d');if(!ctx)return;
  const pixels=ctx.createImageData(size,size),color=look.color.match(/\w\w/g)!.map(v=>parseInt(v,16));
  for(let i=0;i<size*size;i++){for(let c=0;c<3;c++)pixels.data[4*i+c]=color[c]*data.albedo[i];pixels.data[4*i+3]=255;}ctx.putImageData(pixels,0,0);
 },[floor]);
 if(floor==='none')return <span className="surface-sample transparent-sample"><Icon name="close" size={22}/></span>;
 if(look.source==='procedural')return <canvas ref={canvas} width={96} height={96} className="surface-sample" aria-hidden="true"/>;
 return <span className={`surface-sample surface-${floor}`} style={{backgroundColor:look.color,backgroundImage:texture?`url(${texture})`:undefined}}/>;
}
export function FloorChoices({value,onChange,compact=false,choices=STUDIO_FLOOR_IDS}:{value:StudioFloor;onChange:(value:StudioFloor)=>void;compact?:boolean;choices?:readonly StudioFloor[]}){
 const name=useId();return <fieldset className={`visual-choice-field ${compact?'compact-choices':''}`}><legend>Surface</legend><div className="surface-choices">{choices.map(floor=><label key={floor} className={value===floor?'chosen':''}><input type="radio" name={name} aria-label={STUDIO_FLOORS[floor].name} checked={value===floor} onChange={()=>onChange(floor)}/><FloorSample floor={floor}/><span>{STUDIO_FLOORS[floor].name}</span>{value===floor&&<Icon name="check" size={13}/>}</label>)}</div></fieldset>;
}
type Environment=keyof typeof STUDIO_ENVIRONMENTS;
function EnvironmentSample({preset}:{preset:Environment}){
 const canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{let alive=true;void loadStudioEnvironment(preset).then(texture=>{
  if(!alive||!canvas.current)return;const width=168,height=62,ctx=canvas.current.getContext('2d');if(!ctx)return;
  const {data,width:sw,height:sh}=texture.image as {data:Uint16Array|Float32Array;width:number;height:number};
  const pixels=ctx.createImageData(width,height),half=texture.type===HalfFloatType;
  const srgb=(v:number)=>{const mapped=1-Math.exp(-Math.max(0,v));return 255*(mapped<=.0031308?12.92*mapped:1.055*mapped**(1/2.4)-.055);};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const source=4*(Math.min(sh-1,Math.floor(y/height*sh))*sw+Math.floor(x/width*sw)),target=4*(y*width+x);
   for(let c=0;c<3;c++)pixels.data[target+c]=srgb(half?DataUtils.fromHalfFloat(data[source+c]):data[source+c]);pixels.data[target+3]=255;
  }ctx.putImageData(pixels,0,0);
 }).catch(()=>{/* The named environment remains available if its preview cannot load. */});return()=>{alive=false;};},[preset]);
 return <canvas ref={canvas} width={168} height={62} className="surface-sample environment-sample" aria-hidden="true"/>;
}
export function EnvironmentChoices({value,onChange,compact=false,legend='Environment'}:{value:Environment;onChange:(value:Environment)=>void;compact?:boolean;legend?:string}){
 const name=useId();return <fieldset className={`visual-choice-field ${compact?'compact-choices environment-strip':''}`} role="radiogroup" aria-label="Environment"><legend>{legend}</legend><div className="surface-choices">{(Object.keys(STUDIO_ENVIRONMENTS) as Environment[]).map(preset=><label key={preset} className={value===preset?'chosen':''}><input type="radio" name={name} aria-label={STUDIO_ENVIRONMENTS[preset].name} checked={value===preset} onChange={()=>onChange(preset)}/><EnvironmentSample preset={preset}/><span>{STUDIO_ENVIRONMENTS[preset].name}</span>{value===preset&&<Icon name="check" size={13}/>}</label>)}</div></fieldset>;
}
export function BackgroundChoices({value,color,top,environment,onChange}:{value:NonNullable<Presentation['backgroundMode']>;color:string;top:string;environment:Environment;onChange:(mode:NonNullable<Presentation['backgroundMode']>)=>void}){
 const name=useId(),options=[['color','Solid color'],['gradient','Gradient'],['environment','Surroundings'],['transparent','Transparent']] as const;
 return <fieldset className="visual-choice-field"><legend>Background</legend><div className="background-choices">{options.map(([mode,label])=><label key={mode} className={value===mode?'chosen':''}><input type="radio" name={name} aria-label={`${label} background`} checked={value===mode} onChange={()=>onChange(mode)}/>{mode==='environment'?<EnvironmentSample preset={environment}/>:<span className={`background-sample ${mode==='transparent'?'transparent-sample':''}`} style={{background:mode==='color'?color:mode==='gradient'?`linear-gradient(${top},${color})`:undefined}}/>}<span>{label}</span></label>)}</div></fieldset>;
}
