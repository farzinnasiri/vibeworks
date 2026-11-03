import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './useModalFocus';
import { Icon, type IconName } from './icons';
import {Popover} from './Popover';

/**
 * In-app confirm and prompt dialogs. They replace window.confirm/prompt so questions use the workspace's
 * own type, focus handling and wording, and stay out of the browser's chrome.
 */
interface Field { label: string; initial?: string; placeholder?: string; maxLength?: number }
interface Choice { value: string; label: string; hint?: string; icon?: IconName }
interface Request {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  field?: Field;
  choices?: Choice[];
  resolve: (value: string | boolean | { text: string; choice: string } | null) => void;
}
let current: Request | null = null;
const listeners = new Set<() => void>();
const publish = (next: Request | null) => { current = next; listeners.forEach(l => l()); };
const open = (request: Omit<Request, 'resolve'>) =>
  new Promise<string | boolean | { text: string; choice: string } | null>(resolve => {
    current?.resolve(null);
    publish({ ...request, resolve });
  });

export const dialogs = {
  confirm: (options: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) =>
    open(options).then(value => value === true),
  prompt: (options: { title: string; body?: ReactNode; confirmLabel?: string } & Field) => {
    const { label, initial, placeholder, maxLength, ...rest } = options;
    return open({ ...rest, field: { label, initial, placeholder, maxLength } }).then(value =>
      typeof value === 'string' && value.trim() ? value.trim() : null);
  },
  /** A name plus one required choice, such as a new project's first document. */
  form: (options: { title: string; body?: ReactNode; confirmLabel?: string; choices: Choice[] } & Field) => {
    const { label, initial, placeholder, maxLength, ...rest } = options;
    return open({ ...rest, field: { label, initial, placeholder, maxLength } }).then(value =>
      value && typeof value === 'object' && value.text.trim() ? { text: value.text.trim(), choice: value.choice } : null);
  },
};

export function DialogHost() {
  const request = useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current
  );
  return request ? <Dialog key={request.title + (request.field?.initial ?? '')} request={request} /> : null;
}

function Dialog({ request }: { request: Request }) {
  const ref = useRef<HTMLFormElement>(null);
  useModalFocus(ref);
  const [value, setValue] = useState(request.field?.initial ?? '');
  const [choice, setChoice] = useState(request.choices?.[0]?.value ?? '');
  const close = (result: string | boolean | { text: string; choice: string } | null) => { publish(null); request.resolve(result); };
  const submit = () => close(request.choices ? { text: value, choice } : request.field ? value : true);
  return createPortal(
    <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(null); }}>
      <form
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(null); } }}
        onSubmit={event => { event.preventDefault(); if (!request.field || value.trim()) submit(); }}
      >
        <h2 id="dialog-title">{request.title}</h2>
        {request.body && <div className="dialog-body">{request.body}</div>}
        {request.field && <label className="dialog-field">
          <span className="field-label">{request.field.label}</span>
          <input className="text-input" value={value} maxLength={request.field.maxLength ?? 120}
            placeholder={request.field.placeholder} onChange={event => setValue(event.target.value)}
            onFocus={event => event.target.select()} />
        </label>}
        {request.choices && <div className="dialog-choices" role="radiogroup" aria-label="Start with">
          {request.choices.map(option => <label key={option.value} className={`dialog-choice ${choice === option.value ? 'checked' : ''}`}>
            <input type="radio" name="dialog-choice" checked={choice === option.value} onChange={() => setChoice(option.value)} />
            {option.icon && <Icon name={option.icon} size={18} />}
            <span><b>{option.label}</b>{option.hint && <small>{option.hint}</small>}</span>
          </label>)}
        </div>}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={() => close(null)}>Cancel</button>
          <button type="submit" className={request.danger ? 'danger-button' : 'primary-button'}
            disabled={!!request.field && !value.trim()}>{request.confirmLabel ?? 'OK'}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}

export interface ContextAction { label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
export type ContextEntry = ContextAction | 'separator';

/** A right-click menu at the pointer. Shared by the viewport and Build rows so both offer the same actions. */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: ContextEntry[]; onClose: () => void }) {
  const restore=useRef(document.activeElement);
  return <Popover open point={{x,y}} label={title??'Actions'} onClose={()=>{onClose();if(restore.current instanceof HTMLElement)restore.current.focus();}} className="context-menu">
      {title && <div className="menu-label context-title">{title}</div>}
      {items.map((item, i) => item === 'separator' ? <hr key={i} /> :
        <button key={item.label} type="button" role="menuitem" className={item.danger ? 'danger' : ''} disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect(); }}>
          {item.icon ? <Icon name={item.icon} size={16} /> : <span />}
          <span>{item.label}</span>
          {item.hint && <small>{item.hint}</small>}
        </button>)}
  </Popover>;
}
