import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

export type AgentLayout = 'grid' | 'columns' | 'rows';

/** Keep pane order stable while rearranging grid cells, so cameras survive layout changes. */
export function AgentViewLayout({ panes, layout, expanded }: { panes: { id: string; content: ReactNode }[]; layout: AgentLayout; expanded?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [mainRatio, setMainRatio] = useState(.6), [rail, setRail] = useState([1, 1, 1]), [gridRatio, setGridRatio] = useState(.5);
  const dragging = useRef(false);
  const followers = panes.length - 1;
  const grid = layout === 'grid' && panes.length === 4;
  const stacked = layout === 'rows';
  const weights = rail.slice(0, followers), total = weights.reduce((a, b) => a + b, 0);
  const railTracks = weights.map(w => `minmax(0, ${w}fr)`).join(' ');
  const primaryTracks = `minmax(0, ${mainRatio}fr) minmax(0, ${1 - mainRatio}fr)`;
  const styles: CSSProperties = expanded ? { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }
    : grid ? { gridTemplateColumns: primaryTracks, gridTemplateRows: `minmax(0, ${gridRatio}fr) minmax(0, ${1 - gridRatio}fr)` }
      : stacked ? { gridTemplateColumns: railTracks, gridTemplateRows: primaryTracks }
        : { gridTemplateColumns: primaryTracks, gridTemplateRows: railTracks };
  const cell = (index: number): CSSProperties => expanded ? { gridArea: '1 / 1' }
    : grid ? { gridColumn: index % 2 + 1, gridRow: Math.floor(index / 2) + 1 }
      : stacked ? index === 0 ? { gridRow: 1, gridColumn: `1 / span ${followers}` } : { gridRow: 2, gridColumn: index }
        : index === 0 ? { gridColumn: 1, gridRow: `1 / span ${followers}` } : { gridColumn: 2, gridRow: index };
  const clamp = (value: number, low = .22, high = .78) => Math.min(high, Math.max(low, value));
  const divider = (key: string, axis: 'x' | 'y', value: number, update: (ratio: number) => void, style: CSSProperties, reset: () => void) => <div key={key}
    className={`agent-view-divider axis-${axis}`} role="separator" tabIndex={0} aria-label={key === 'main' ? 'Resize main view' : 'Resize agent views'}
    aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} style={style}
    onDoubleClick={reset} onPointerDown={event => { event.preventDefault(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={() => { dragging.current = false; }}
    onPointerMove={event => { if (!dragging.current) return; const bounds = host.current!.getBoundingClientRect(); update(axis === 'x' ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height); }}
    onKeyDown={event => { const decrease = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', increase = axis === 'x' ? 'ArrowRight' : 'ArrowDown'; if (event.key === decrease || event.key === increase) { event.preventDefault(); update(value + (event.key === decrease ? -.05 : .05)); } }} />;
  const position = (fraction: number, gaps = 1, index = 0) => `calc(${fraction * 100}% + ${8 * (index + .5) - 8 * gaps * fraction}px)`;
  const edge = position(mainRatio);
  return <div ref={host} className={`agent-view-grid layout-${layout} ${expanded ? 'has-expanded' : ''}`} style={styles}>
    {panes.map((pane, index) => <div className="agent-view-slot" style={cell(index)} key={pane.id} hidden={!!expanded && expanded !== pane.id}>{pane.content}</div>)}
    {!expanded && <>
      {divider('main', stacked ? 'y' : 'x', mainRatio, value => setMainRatio(clamp(value)), stacked ? { top: edge } : { left: edge }, () => setMainRatio(.5))}
      {grid ? divider('grid', 'y', gridRatio, value => setGridRatio(clamp(value)), { top: position(gridRatio) }, () => setGridRatio(.5))
        : weights.slice(0, -1).map((_, index) => {
          const before = weights.slice(0, index).reduce((a, b) => a + b, 0) / total;
          const boundary = before + weights[index] / total;
          const after = boundary + weights[index + 1] / total;
          const update = (ratio: number) => setRail(previous => { const next = [...previous], value = clamp(ratio, before + .12, after - .12); next[index] = (value - before) * total; next[index + 1] = (after - value) * total; return next; });
          return divider(`rail-${index}`, stacked ? 'x' : 'y', boundary, update,
            stacked ? { left: position(boundary, followers - 1, index), top: edge } : { top: position(boundary, followers - 1, index), left: edge }, () => setRail([1, 1, 1]));
        })}
    </>}
  </div>;
}
