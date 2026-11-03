import {useRef,useState,useEffect,useLayoutEffect,type MouseEvent,type ReactNode} from 'react';
import {Icon} from './icons';

export type PanelMode='collapsed'|'compact'|'expanded';
export type PanelSide='left'|'right';
const KEY='vibeworks.view.panels';
const valid=(value:unknown):value is PanelMode=>value==='collapsed'||value==='compact'||value==='expanded';
export function usePanelLayout(){
 const [modes,setModes]=useState<{left:PanelMode;right:PanelMode;open:Record<PanelSide,PanelMode>}>(()=>{
  try{const saved=JSON.parse(localStorage.getItem(KEY)??'null');if(valid(saved?.left)&&valid(saved?.right))return{left:saved.left,right:saved.right,open:{left:(saved.open?.left??saved.left)==='compact'?'compact':'expanded',right:(saved.open?.right??saved.right)==='compact'?'compact':'expanded'}};}catch{}
  return{left:'expanded',right:'expanded',open:{left:'expanded',right:'expanded'}};
 });
 useEffect(()=>{try{localStorage.setItem(KEY,JSON.stringify(modes));}catch{}},[modes]);
 return{...modes,set:(side:PanelSide,mode:PanelMode)=>setModes(current=>current[side]===mode?current:{...current,[side]:mode,open:mode==='collapsed'?current.open:{...current.open,[side]:mode}})};
}

/** Keep full contents mounted so minimizing a panel cannot discard an unapplied edit. */
export function FloatingPanel({side,mode,onMode,label,heading,compact,task,children,restoreMode='expanded'}:{
 restoreMode?:PanelMode;side:PanelSide;mode:PanelMode;onMode:(mode:PanelMode)=>void;label:string;heading?:ReactNode;compact?:ReactNode;task?:string;children:ReactNode;
}){
 const ref=useRef<HTMLElement>(null),surface=useRef<HTMLDivElement>(null),interior=useRef<HTMLDivElement>(null),id=`${side}-panel-content`;
 const previous=useRef<DOMRect|undefined>(undefined),animations=useRef<Animation[]>([]),instant=useRef(false);
 const focus=useRef<{mode:PanelMode;selector:string}|undefined>(undefined);
 const request=useRef(0),pending=useRef<{animation:Animation;target:PanelMode}|undefined>(undefined);
 const presentation=()=>{
  const el=surface.current!,box=el.getBoundingClientRect();
  return{width:box.width,height:box.height,radius:parseFloat(getComputedStyle(el).borderRadius)};
 };
 // Resize only the empty frame. Its native shadow shares the same animated bounds, without a filter layer.
 useLayoutEffect(()=>{
  const el=ref.current,outline=surface.current,content=interior.current;if(!el||!outline||!content)return;
  request.current++;pending.current?.animation.cancel();pending.current=undefined;
  const running=animations.current.some(a=>a.playState==='running'||a.playState==='paused');
  const before=running?presentation():previous.current?{...{width:previous.current.width,height:previous.current.height},radius:previous.current.width===44?10:12}:undefined;
  animations.current.forEach(a=>a.cancel());animations.current=[];
  outline.style.width='100%';outline.style.height='100%';outline.style.borderRadius='';
  const next=el.getBoundingClientRect();previous.current=next;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(before&&next.width&&next.height&&!instant.current){
   const easing=getComputedStyle(el).getPropertyValue('--ease').trim();
   if(!reduced&&before.width&&before.height){
    const mobile=matchMedia('(max-width: 860px)').matches;
    const frame=(width:number,height:number,radius:number)=>({width:`${width}px`,height:`${height}px`,borderRadius:`${radius}px`});
    const frames=[frame(before.width,before.height,before.radius),frame(next.width,next.height,mode==='collapsed'?10:12)],timing={duration:300,easing};
    const shape=outline.animate(frames,timing);animations.current.push(shape);
    const x=Math.max(0,next.width-before.width),y=Math.max(0,next.height-before.height);
    const reveal=content.animate([{clipPath:`inset(${mobile?y:0}px ${side==='left'?x:0}px ${mobile?0:y}px ${side==='right'?x:0}px round 12px)`},{clipPath:'inset(0px round 12px)'}],timing);
    // Content is already at its final width. Only opacity and clipping change during the handoff.
    animations.current.push(reveal);
   }
   const body=el.querySelector<HTMLElement>('.floating-panel-content');
   if(mode!=='collapsed'&&body)animations.current.push(body.animate([{opacity:0},{opacity:1}],{duration:reduced?80:140,delay:reduced?0:40,fill:'backwards',easing}));
  }
  instant.current=false;
  const destination=focus.current;focus.current=undefined;
  if(destination?.mode===mode){
   const target=el.querySelector<HTMLButtonElement>(destination.selector);
   if(target&&target.getClientRects().length)target.focus({preventScroll:true});
   else document.querySelector<HTMLButtonElement>(side==='left'?'button[aria-label="Model panel"]':'button[aria-label="Details panel"]')?.focus({preventScroll:true});
  }
 },[mode,side]);
 useEffect(()=>{
  const el=ref.current;if(!el)return;
  const observer=new ResizeObserver(()=>{previous.current=el.getBoundingClientRect();});observer.observe(el);
  return()=>{observer.disconnect();request.current++;pending.current?.animation.cancel();animations.current.forEach(a=>a.cancel());};
 },[]);
 const change=(next:PanelMode,event:MouseEvent<HTMLButtonElement>)=>{
  instant.current=event.detail===0;
  const el=ref.current,body=el?.querySelector<HTMLElement>('.floating-panel-content'),ownsFocus=el?.contains(document.activeElement);
  const opacity=body?Number(getComputedStyle(body).opacity):1;
  const cancelRequest=pending.current?.target===next;
  const version=++request.current;pending.current?.animation.cancel();pending.current=undefined;
  // Repeating the same toggle during its exit cancels it, without flashing back to full opacity.
  if(cancelRequest&&!instant.current&&body){
   animations.current.push(body.animate([{opacity},{opacity:1}],{duration:80,easing:getComputedStyle(el!).getPropertyValue('--ease').trim()}));return;
  }
  const commit=()=>{
   if(request.current!==version)return;
   pending.current=undefined;
   if(el&&!animations.current.some(a=>a.playState==='running'||a.playState==='paused'))previous.current=el.getBoundingClientRect();
   if(ownsFocus)focus.current={mode:next,selector:next==='collapsed'?'.panel-reopen':mode==='collapsed'?'.panel-identity':'.panel-size-toggle'};
   onMode(next);
  };
  if(body&&mode!=='collapsed'&&!instant.current&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&opacity>0){
   // Fade the real body before changing its layout. Never draw old and new layouts simultaneously.
   const fade=body.animate([{opacity},{opacity:0}],{duration:80,fill:'forwards',easing:getComputedStyle(el!).getPropertyValue('--ease').trim()});
   animations.current.push(fade);pending.current={animation:fade,target:next};fade.onfinish=commit;
  }else commit();
 };
 const icon=side==='left'?'layers':'inspector';
 const identity=<button type="button" className="icon-button panel-identity" aria-label={`Hide ${label} panel`} title={`Hide ${label} panel`} aria-expanded={true} aria-controls={id} onClick={e=>change('collapsed',e)}><Icon name={icon} size={18}/></button>;
 const sizeToggle=<button type="button" className="icon-button panel-size-toggle" aria-label={`${mode==='expanded'?'Compact':'Expand'} ${label} panel`} title={`${mode==='expanded'?'Compact':'Expand'} ${label} panel`} aria-controls={id} onClick={e=>change(mode==='expanded'?'compact':'expanded',e)}><Icon name={mode==='expanded'?'panel-compact':'panel-expand'} size={18}/></button>;
 return <aside ref={ref} className={`panel ${side}-panel floating-panel`} data-inset={side} data-panel-state={mode} aria-label={`${label} panel`}>
  <div ref={surface} className="panel-surface" aria-hidden="true"/>
  <div ref={interior} className="panel-interior">
   {mode==='collapsed'?<button type="button" className="panel-reopen" aria-label={`Show ${label} panel`} aria-expanded={false} aria-controls={id} title={`Show ${label}${task?` · ${task}`:''}`} onClick={e=>change(restoreMode,e)}><Icon name={icon} size={19}/>{task&&<span className="panel-task-dot" aria-label={`Active task: ${task}`}/>}</button>
    :<header className="floating-panel-head">
      {side==='left'?identity:sizeToggle}
      <div className="floating-panel-heading">{heading??label}</div>
      {side==='left'?sizeToggle:identity}
     </header>}
   <div className="floating-panel-content" id={id} hidden={mode==='collapsed'}>
    {compact!==undefined&&<div className="panel-compact-content" hidden={mode!=='compact'}>{compact}</div>}
    <div className="panel-full-content" hidden={mode==='compact'&&compact!==undefined}>{children}</div>
   </div>
  </div>
 </aside>;
}
