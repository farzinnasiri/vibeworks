import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';

/** One anchored overlay for command menus, context menus and value choices. */
export function Popover({open,anchor,point,align='start',onClose,children,id,role='menu',label,className='',keyboard=false,matchWidth=false,onKeyDown,onClick}: {
 open:boolean;anchor?:RefObject<HTMLElement|null>;point?:{x:number;y:number};align?:'start'|'end'|'up';onClose:()=>void;
 children:ReactNode;id?:string;role?:'menu'|'listbox'|'dialog';label?:string;className?:string;keyboard?:boolean;matchWidth?:boolean;
 onKeyDown?:React.KeyboardEventHandler<HTMLDivElement>;onClick?:React.MouseEventHandler<HTMLDivElement>;
}){
 const uid=useId(),ref=useRef<HTMLDivElement>(null),[present,setPresent]=useState(open),motion=useRef<Animation|undefined>(undefined);
 const immediate=useRef(false);const close=useRef(onClose);close.current=onClose;
 useLayoutEffect(()=>{if(open)setPresent(true);},[open]);
 useLayoutEffect(()=>{
  const el=ref.current;if(!el)return;const viewport=window.visualViewport;let frame=0;
  const place=()=>{
   const target=anchor?.current;if(anchor&&(!target?.isConnected||!target.getClientRects().length)){if(open)close.current();return;}
   const rect=target?.getBoundingClientRect();if(!rect&&!point)return;
   const margin=8,gap=8;
   const leftEdge=viewport?.offsetLeft??0,topEdge=viewport?.offsetTop??0,width=viewport?.width??innerWidth,height=viewport?.height??innerHeight;
   el.style.maxWidth=`${width-margin*2}px`;
   if(matchWidth&&rect)el.style.minWidth=`${Math.min(rect.width,width-margin*2)}px`;
   const naturalHeight=el.scrollHeight+2,popWidth=el.offsetWidth;
   const below=point?point.y:(rect!.bottom+gap),above=point?point.y:(rect!.top-gap);
   const roomBelow=topEdge+height-margin-below,roomAbove=above-topEdge-margin;
   const up=align==='up'?roomAbove>=Math.min(naturalHeight,120):roomBelow<naturalHeight&&roomAbove>roomBelow;
   const maxHeight=Math.max(64,up?roomAbove:roomBelow);
   el.style.maxHeight=`${Math.min(height-margin*2,maxHeight)}px`;
   const popHeight=el.offsetHeight;
   const idealLeft=point?point.x:align==='end'?rect!.right-popWidth:align==='up'?rect!.left+(rect!.width-popWidth)/2:rect!.left;
   const left=Math.max(leftEdge+margin,Math.min(leftEdge+width-popWidth-margin,idealLeft));
   const top=Math.max(topEdge+margin,Math.min(topEdge+height-popHeight-margin,up?above-popHeight:below));
   el.style.left=`${left}px`;el.style.top=`${top}px`;
   el.style.transformOrigin=`${Math.max(0,Math.min(popWidth,(rect?.left??point!.x)-left+(rect?.width??0)/2))}px ${up?'100%':'0%'}`;
   el.dataset.side=up?'top':'bottom';el.style.visibility='visible';
  };
  place();
  const opacity=getComputedStyle(el).opacity,transform=getComputedStyle(el).transform;
  motion.current?.cancel();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(open){
   if(!keyboard)motion.current=el.animate([{opacity:0,transform:reduced?'none':'scale(.97)'},{opacity:1,transform:'none'}],{duration:reduced?80:180,easing:getComputedStyle(el).getPropertyValue('--ease').trim()});
   const selected=el.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled),[role="menuitem"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled),[role="option"]:not(:disabled)'+(role==='dialog'?',button:not(:disabled)':''));selected?.focus({preventScroll:true});selected?.scrollIntoView({block:'nearest'});
  }else{
   el.style.pointerEvents='none';
   if(keyboard||immediate.current){immediate.current=false;setPresent(false);return;}
   motion.current=el.animate([{opacity,transform},{opacity:0,transform:reduced?'none':'scale(.97)'}],{duration:reduced?60:120,easing:getComputedStyle(el).getPropertyValue('--ease').trim(),fill:'forwards'});
   motion.current.onfinish=()=>setPresent(false);
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;place();});};
  window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
  viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);
  const observer=new ResizeObserver(schedule);observer.observe(el);if(anchor?.current)observer.observe(anchor.current);
  return()=>{window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);observer.disconnect();cancelAnimationFrame(frame);motion.current?.cancel();};
 },[open,present,align,point?.x,point?.y,keyboard,matchWidth]);
 useEffect(()=>{
  if(!open)return;
  const away=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node)&&!anchor?.current?.contains(event.target as Node))close.current();};
  const other=(event:Event)=>{if((event as CustomEvent).detail!==uid)close.current();};
  const blur=()=>close.current();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){immediate.current=true;event.preventDefault();event.stopPropagation();close.current();anchor?.current?.focus();}};
  window.addEventListener('pointerdown',away,true);window.addEventListener('vibeworks:popover-open',other);window.addEventListener('blur',blur);
  window.addEventListener('keydown',escape,true);
  window.dispatchEvent(new CustomEvent('vibeworks:popover-open',{detail:uid}));
  return()=>{window.removeEventListener('pointerdown',away,true);window.removeEventListener('vibeworks:popover-open',other);window.removeEventListener('blur',blur);window.removeEventListener('keydown',escape,true);};
 },[open,uid]);
 useEffect(()=>()=>motion.current?.cancel(),[]);
 if(!present&&!open)return null;
 return createPortal(<div ref={ref} id={id} role={role} aria-label={label} aria-hidden={!open||undefined} inert={!open||undefined} className={`menu-pop portal shared-popover ${className}`} style={{position:'fixed',visibility:'hidden',pointerEvents:open?'auto':'none'}}
 onClick={onClick} onContextMenu={e=>e.preventDefault()} onKeyDown={event=>{
  if(event.key==='Escape'){immediate.current=true;event.preventDefault();event.stopPropagation();close.current();anchor?.current?.focus();return;}
  onKeyDown?.(event);if(event.defaultPrevented)return;
  if(event.key==='Tab'&&role==='dialog'){
   event.stopPropagation();
   const items=[...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length>0);
   const index=items.indexOf(document.activeElement as HTMLElement);
   if(items.length&&(event.shiftKey?index<=0:index===items.length-1)){event.preventDefault();items[event.shiftKey?items.length-1:0].focus();}
   return;
  }
  if(event.key==='Tab'&&role!=='dialog'){immediate.current=true;close.current();anchor?.current?.focus();return;}
  if(role!=='dialog'&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&!(event.target as HTMLElement).closest('input,textarea')){
   const items=[...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled),[role="option"]:not(:disabled)')];
   const current=items.indexOf(document.activeElement as HTMLElement),index=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
   items[index]?.focus();items[index]?.scrollIntoView({block:'nearest'});event.preventDefault();
  }
 }}>{children}</div>,document.body);
}
