import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_FEATURES, type CadDocument, type Feature } from '../shared/protocol';
import { expressionNames } from '../cad/parameters';
import type { Evaluation } from '../cad/types';
import { consumedReferences } from '../cad/document';
import { Icon } from './icons';
import { featureName, featureSummary, kindIcons, kindLabels } from './modeling';

/**
 * Construction order over a frozen source graph. Frame meshes load on demand without editing.
 */
export function ConstructionTimeline({ document, step, replaying, agentTouched, onStep, onReplay, speed, onSpeed }: {
  document: CadDocument; step: number | null; replaying: boolean; agentTouched: Map<string, number>;
  onStep: (step: number | null) => void; onReplay: () => void; speed: number; onSpeed: () => void;
}) {
  const total = document.features.length;
  const at = step ?? total;
  const current = document.features[at - 1];
  return <div className={`timeline ${step !== null ? 'scrubbed' : ''}`}>
    <button type="button" className="icon-button quiet" aria-label={replaying ? 'Pause replay' : 'Replay the build step by step'} title={replaying ? 'Pause' : 'Replay build'} onClick={onReplay}><Icon name={replaying ? 'pause' : 'play'} size={15} /></button>
    <div className="timeline-track" style={{ ['--at' as string]: total > 1 ? (at - 1) / (total - 1) : 1 }}>
      <div className="timeline-ticks" aria-hidden="true">{document.features.map((feature, i) =>
        <span key={feature.id} className={`tick ${i < at ? 'done' : ''} ${agentTouched.has(feature.id) ? 'agent' : ''}`} />)}</div>
      <input type="range" min={1} max={Math.max(total, 1)} step={1} value={at} disabled={total < 2}
        aria-label="Construction step" aria-valuetext={`Step ${at} of ${total}${current ? `: ${featureName(current)}` : ''}`}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onStep(null); } }}
        onChange={event => { const next = Number(event.target.value); onStep(next); }} />
    </div>
    <span className="timeline-count">{at}<small>/{total}</small></span>
    <button type="button" className="speed-button" aria-label={`Replay speed ${speed}×`} title="Replay speed" onClick={onSpeed}>{speed}×</button>
    {step !== null && <button type="button" className="icon-button quiet" aria-label="Back to latest" title="Back to latest · Esc" onClick={() => onStep(null)}><Icon name="latest" size={15} /></button>}
  </div>;
}

const drivers = (feature: Feature) => [...new Set(Object.values(feature.bindings ?? {}).flatMap(text => { try { return expressionNames(text); } catch { return []; } }))];

export interface Author { name: string; color: string }

/**
 * The document's features. Live, it is a tree: results at the top, the inputs a feature consumed nested under
 * it. While viewing history it is the flat construction order the slider walks.
 */
export function BuildLog({ document, evaluation, disabled, agentTouched, authors, onSelect, onHover, onContextMenu, step, replaying, onStep, onReplay, speed, onSpeed, components }: {
  components?: { enabled: boolean; onMode: (enabled: boolean) => void; controls: ReactNode };
  document: CadDocument; evaluation: Evaluation; disabled: boolean; agentTouched: Map<string, number>; authors?: Map<string, Author>;
  onSelect: (id: string, additive: boolean) => void; onHover: (id?: string) => void; onContextMenu?: (id: string, x: number, y: number) => void;
  step: number | null; replaying: boolean; onStep: (step: number | null) => void; onReplay: () => void; speed: number; onSpeed: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const name = (id: string) => featureName(document.features.find(f => f.id === id)) || id;
  const index = useMemo(() => new Map(document.features.map((f, i) => [f.id, i])), [document.features]);
  // Each consumed input nests under the first later feature that consumes it.
  const parent = useMemo(() => {
    const map = new Map<string, string>();
    for (const feature of document.features) for (const id of consumedReferences(feature)) if (!map.has(id) && index.has(id)) map.set(id, feature.id);
    return map;
  }, [document.features, index]);
  const children = useMemo(() => {
    const map = new Map<string, Feature[]>();
    for (const feature of document.features) { const up = parent.get(feature.id); if (up) map.set(up, [...(map.get(up) ?? []), feature]); }
    return map;
  }, [document.features, parent]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const first = document.selectedFeatureIds[0];
  // A selection made elsewhere (viewport, agent) opens its parents and scrolls into view.
  useEffect(() => {
    if (!first) return;
    const ancestors: string[] = [];
    for (let up = parent.get(first); up; up = parent.get(up)) ancestors.push(up);
    if (ancestors.some(id => !open.has(id))) setOpen(current => new Set([...current, ...ancestors]));
    requestAnimationFrame(() => list.current?.querySelector(`[data-feature="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [first, parent]);
  const move = (event: KeyboardEvent<HTMLOListElement>) => {
    const row = (globalThis.document.activeElement as HTMLElement | null)?.closest<HTMLElement>('button.log-row');
    const id = row?.dataset.feature;
    if (id && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && children.has(id)) {
      event.preventDefault();
      setOpen(current => { const next = new Set(current); if (event.key === 'ArrowRight') next.add(id); else next.delete(id); return next; });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...list.current!.querySelectorAll<HTMLButtonElement>('button.log-row')];
    const at = buttons.indexOf(row as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { event.preventDefault(); next.focus(); }
  };
  if (!document.features.length) return <div className="log-empty"><p>No features yet.</p><p className="field-hint">Every feature, by you or a connected agent, lands here in order. Earlier features stay editable.</p></div>;
  const total = document.features.length;
  const history = step !== null;
  const row = (feature: Feature, depth: number): ReactNode => {
    const i = index.get(feature.id)!;
    const future = history && i >= step!;
    const here = history && i === step! - 1;
    const visible = evaluation.visibleFeatureIds.includes(feature.id);
    const selected = document.selectedFeatureIds.includes(feature.id);
    const kids = history ? [] : children.get(feature.id) ?? [];
    const expanded = open.has(feature.id);
    const author = authors?.get(feature.id);
    const agent = !author && agentTouched.has(feature.id);
    const usedBy = parent.get(feature.id);
    return <li key={feature.id} role="treeitem" aria-level={depth + 1} aria-expanded={kids.length ? expanded : undefined} aria-selected={selected}>
      <div className="log-line" style={{ ['--depth' as string]: depth }}>
        {kids.length ? <button type="button" className="log-caret" aria-label={`${expanded ? 'Hide' : 'Show'} ${kids.length} input${kids.length === 1 ? '' : 's'} of ${featureName(feature)}`}
          tabIndex={-1} onClick={() => setOpen(current => { const next = new Set(current); if (expanded) next.delete(feature.id); else next.add(feature.id); return next; })}>
          <Icon name="chevron" size={12} className={expanded ? '' : 'collapsed'} /></button> : <span className="log-caret" />}
        <button type="button" data-feature={feature.id} className={`log-row ${selected && !history ? 'selected' : ''} ${visible ? 'result' : 'construction'} ${future ? 'future' : ''} ${here ? 'here' : ''}`} aria-pressed={!history ? selected : here} aria-current={here ? 'step' : undefined} disabled={disabled}
          onClick={event => history ? onStep(i + 1 >= total ? null : i + 1) : onSelect(feature.id, event.shiftKey || event.metaKey || event.ctrlKey)}
          onContextMenu={event => { if (history || !onContextMenu) return; event.preventDefault(); if (!selected) onSelect(feature.id, false); onContextMenu(feature.id, event.clientX, event.clientY); }}
          onMouseEnter={() => onHover(visible ? undefined : feature.id)} onFocus={() => onHover(visible ? undefined : feature.id)} onBlur={() => onHover(undefined)}
          title={visible ? `Result · step ${i + 1}` : `Input · step ${i + 1}${usedBy ? ` · used by ${name(usedBy)}` : ''}. Hover to ghost it in the viewport.`}>
          <span className="log-icon"><Icon name={kindIcons[feature.kind]} size={15} /></span>
          <span className="log-text">
            <span className="log-name">{featureName(feature)}{feature.bindings && <span className="bound-mark" title={`Driven by ${drivers(feature).join(', ')}`}><Icon name="link" size={12} /><span className="sr-only">Driven by parameters</span></span>}</span>
            <span className="log-summary">{feature.kind === 'instance' ? `${(evaluation.instances?.find(x => x.featureId === feature.id)?.name ?? 'Source part').split('|').at(-1)?.trim()} · r${evaluation.instances?.find(x => x.featureId === feature.id)?.revision ?? '?'}` : `${kindLabels[feature.kind]} · ${featureSummary(feature, name)}`}</span>
          </span>
          {author ? <span className="author-dot" style={{ background: author.color }} title={`Last changed by ${author.name}`}><span className="sr-only">Last changed by {author.name}</span></span>
            : agent ? <span className="author-dot agent" title="Changed by an agent in this session"><span className="sr-only">Changed by an agent</span></span>
              : <span className="log-index">{i + 1}</span>}
        </button>
      </div>
      {kids.length > 0 && expanded && <ol role="group">{kids.map(kid => row(kid, depth + 1))}</ol>}
    </li>;
  };
  const roots = history ? document.features : document.features.filter(f => !parent.has(f.id));
  return <>
    {components?.enabled ? components.controls : <ConstructionTimeline document={document} step={step} replaying={replaying} agentTouched={agentTouched} onStep={onStep} onReplay={onReplay} speed={speed} onSpeed={onSpeed} />}
    {components && <label className="replay-mode list-toggle"><input type="checkbox" checked={components.enabled} onChange={event => components.onMode(event.target.checked)} />Replay inside parts</label>}
    <ol className={`build-log ${history ? 'scrubbed' : ''}`} role="tree" aria-label="Features" ref={list} onKeyDown={move} onMouseLeave={() => onHover(undefined)}>
      {roots.map(feature => row(feature, 0))}
    </ol>
    {(history || total > MAX_FEATURES * .8) && <footer className="log-foot"><span>{history ? 'Viewing construction · click a step' : `${total} of ${MAX_FEATURES} features`}</span></footer>}
  </>;
}
