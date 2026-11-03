import {useLayoutEffect,useRef,useState} from 'react';

/** Fit both ends of a name in its actual available width. The full name stays accessible. */
export function MiddleTruncate({text,className=''}:{text:string;className?:string}){
 const ref=useRef<HTMLSpanElement>(null),[shown,setShown]=useState(text);
 useLayoutEffect(()=>{
  const el=ref.current;if(!el)return;
  const context=document.createElement('canvas').getContext('2d');if(!context)return;
  const fit=()=>{
   context.font=getComputedStyle(el).font;
   const width=el.clientWidth,characters=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),s=>s.segment);
   if(context.measureText(text).width<=width){setShown(text);return;}
   let low=0,high=characters.length;
   const candidate=(count:number)=>{const end=Math.ceil(count*.45),start=count-end;return characters.slice(0,start).join('')+'…'+(end?characters.slice(-end).join(''):'');};
   while(low<high){const mid=Math.ceil((low+high)/2);if(context.measureText(candidate(mid)).width<=width)low=mid;else high=mid-1;}
   setShown(candidate(low));
  };
  fit();const observer=new ResizeObserver(fit);observer.observe(el);void document.fonts.ready.then(fit);
  return()=>observer.disconnect();
 },[text]);
 return <span ref={ref} className={`middle-truncate ${className}`} title={text} aria-label={text}>{shown}</span>;
}
