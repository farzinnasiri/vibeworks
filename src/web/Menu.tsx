import {useRef,useState,type ReactNode} from 'react';
import {Icon,type IconName} from './icons';
import {Popover} from './Popover';

export function Menu({id,open,onToggle,label,icon,children,className='',align='end',ariaLabel,title}:{
 id:string;open:boolean;onToggle:(id:string|null)=>void;label:ReactNode;icon?:IconName;children:ReactNode;
 className?:string;align?:'start'|'end'|'up';ariaLabel?:string;title?:string;
}){
 const ref=useRef<HTMLButtonElement>(null),[keyboard,setKeyboard]=useState(false);
 return <div className={`menu ${className}`}>
  <button ref={ref} type="button" className={`bar-button ${open?'open':''}`} aria-label={ariaLabel} title={title} aria-haspopup="menu" aria-expanded={open} aria-controls={open?`menu-${id}`:undefined}
   onClick={event=>{setKeyboard(event.detail===0);onToggle(open?null:id);}}
   onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setKeyboard(true);onToggle(id);}}}>
   {icon&&<Icon name={icon} size={17}/>}{label}
  </button>
  <Popover open={open} anchor={ref} align={align} id={`menu-${id}`} label={ariaLabel??(typeof label==='string'?label:undefined)} keyboard={keyboard} onClose={()=>onToggle(null)} onClick={event=>{if((event.target as HTMLElement).closest('[role="menuitem"]:not(:disabled)')){onToggle(null);ref.current?.focus();}}}>{children}</Popover>
 </div>;
}
export const MenuItem = ({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  icon?: IconName;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) => (
  <button
    type="button"
    role="menuitem"
    className={danger ? 'danger' : ''}
    disabled={disabled}
    onClick={onClick}
  >
    {icon ? <Icon name={icon} size={16} /> : <span />}
    <span>{label}</span>
    {hint && <small>{hint}</small>}
  </button>
);
