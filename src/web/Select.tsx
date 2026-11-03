import {useId,useLayoutEffect,useRef,useState,type SelectHTMLAttributes} from 'react';
import {Icon} from './icons';
import {Popover} from './Popover';

/** Native form semantics behind the same visible chooser everywhere in the workspace. */
export function Select(props:SelectHTMLAttributes<HTMLSelectElement>){
 const native=useRef<HTMLSelectElement>(null),button=useRef<HTMLButtonElement>(null),id=useId();
 const [open,setOpen]=useState(false),[keyboard,setKeyboard]=useState(false),[options,setOptions]=useState<{value:string;label:string;disabled:boolean;group?:string}[]>([]),[value,setValue]=useState(''),[label,setLabel]=useState('');
 const search=useRef({text:'',time:0});
 useLayoutEffect(()=>{
  const el=native.current;if(!el)return;
  const choices=[...el.options].map(option=>({value:option.value,label:option.label,disabled:option.disabled||(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled),group:option.parentElement instanceof HTMLOptGroupElement?option.parentElement.label:undefined}));
  setOptions(current=>JSON.stringify(current)===JSON.stringify(choices)?current:choices);setValue(el.value);
  const parent=el.closest('label'),text=parent?.querySelector('.field-label,.sr-only')??parent?.querySelector('span');
  setLabel(props['aria-label']??text?.textContent?.trim()??props.title??'Choose an option');
 });
 const choose=(next:string)=>{const el=native.current;if(!el)return;el.value=next;el.dispatchEvent(new Event('change',{bubbles:true}));setValue(el.value);setOpen(false);button.current?.focus();};
 return <span className="select-control">

  <button ref={button} type="button" role="combobox" data-select-trigger className={`select-trigger ${props.className??''}`} disabled={props.disabled} aria-label={label} aria-labelledby={props['aria-labelledby']} aria-required={props.required} aria-invalid={props['aria-invalid']} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} title={props.title}
   onClick={event=>{event.preventDefault();setKeyboard(event.detail===0);setOpen(!open);}}
   onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setKeyboard(true);setOpen(false);return;}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();setKeyboard(true);setOpen(true);if(open)document.getElementById(id)?.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled),[role=option]:not(:disabled)')?.focus();}else if(event.key.length===1&&event.key!==' '&&!event.metaKey&&!event.ctrlKey){const now=Date.now();search.current={text:(now-search.current.time<700?search.current.text:'')+event.key.toLowerCase(),time:now};const match=options.find(option=>!option.disabled&&option.label.toLowerCase().startsWith(search.current.text));if(match)choose(match.value);}}}>
    <span>{options.find(option=>option.value===value)?.label??'Choose…'}</span><Icon name="chevron" size={13}/>
  </button>
  <select {...props} ref={native} tabIndex={-1} aria-hidden="true" className="select-native" onInvalid={event=>{event.preventDefault();button.current?.focus();}}/>
  <Popover open={open} anchor={button} id={id} role="listbox" label={label} className="select-popover" matchWidth keyboard={keyboard} onClose={()=>setOpen(false)} onKeyDown={event=>{
   if(event.key==='Tab'){setKeyboard(true);setOpen(false);button.current?.focus();}
   else if(event.key.length===1&&event.key!==' '&&!event.metaKey&&!event.ctrlKey){const now=Date.now();search.current={text:(now-search.current.time<700?search.current.text:'')+event.key.toLowerCase(),time:now};const match=options.find(option=>!option.disabled&&option.label.toLowerCase().startsWith(search.current.text));const node=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=option]')].find(el=>el.dataset.value===match?.value);node?.focus();node?.scrollIntoView({block:'nearest'});event.preventDefault();}
  }}>
   {options.map((option,index)=><span className="select-option-group" key={`${option.value}-${index}`}>
    {option.group&&option.group!==options[index-1]?.group&&<span className="menu-label">{option.group}</span>}
    <button type="button" role="option" data-value={option.value} aria-selected={option.value===value} disabled={option.disabled} onClick={event=>{setKeyboard(event.detail===0);choose(option.value);}}><span>{option.label}</span>{option.value===value&&<Icon name="check" size={14}/>}</button>
   </span>)}
  </Popover>
 </span>;
}
