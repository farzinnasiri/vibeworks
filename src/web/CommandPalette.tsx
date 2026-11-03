import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useModalFocus } from './useModalFocus';
import { Icon, type IconName } from './icons';

export interface PaletteItem {
  id: string; label: string; group: string; icon?: IconName; hint?: string;
  /** MCP tool name when the action has an agent equivalent. */
  command?: string; shortcut?: string; disabled?: string; run: () => void;
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog);
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = items.filter(item => (terms.length > 0 || !item.disabled) && terms.every(term => `${item.label} ${item.group} ${item.command ?? ''} ${item.hint ?? ''}`.toLowerCase().includes(term)));
    // Runnable commands first when searching; disabled ones still teach what exists.
    return terms.length ? [...matches.filter(i => !i.disabled), ...matches.filter(i => i.disabled)] : [...new Set(matches.map(item => item.group))].flatMap(group => matches.filter(item => item.group === group));
  }, [items, query]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { setActive(i => Math.max(0, Math.min(i, filtered.length - 1))); }, [filtered.length]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const run = (item?: PaletteItem) => { if (!item || item.disabled) return; onClose(); item.run(); };
  let lastGroup = '';
  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="palette" role="dialog" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} aria-modal="true" aria-label="Command palette">
      <div className="palette-input"><Icon name="search" size={18} />
        <input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="What do you want to do?" aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${filtered[active].id}` : undefined} aria-autocomplete="list"
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.max(0, Math.min(filtered.length - 1, i + 1))); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); }
            else if (event.key === 'Enter') { event.preventDefault(); run(filtered[active]); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          }} />
        <kbd>Esc</kbd>
      </div>
      <ul className="palette-list" id={listId} role="listbox" ref={list} aria-label="Commands">
        {filtered.map((item, index) => {
          const header = !query && item.group !== lastGroup ? item.group : '';
          lastGroup = item.group;
          return <li key={item.id} role="presentation">
            {header && <div className="palette-group" role="presentation">{header}</div>}
            <div id={`${listId}-${item.id}`} role="option" aria-selected={index === active} aria-disabled={!!item.disabled} className={`palette-item ${index === active ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`}
              onMouseMove={() => setActive(index)} onClick={() => run(item)}>
              <span className="palette-icon">{item.icon && <Icon name={item.icon} size={16} />}</span>
              <span className="palette-text"><span>{item.label}</span><small>{item.disabled ?? item.hint}</small></span>
              
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </div>
          </li>;
        })}
        {!filtered.length && <li className="palette-empty">Nothing matches “{query}”.</li>}
      </ul>
      <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span>{filtered.length} commands</span></footer>
    </div>
  </div>;
}
