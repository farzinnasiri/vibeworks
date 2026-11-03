export function ComparisonSplit({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="comparison-divider" style={{ left: `${value * 100}%` }}>
    <span className="comparison-side before">Before</span><span className="comparison-side after">After</span>
    <button type="button" aria-label="Move comparison split" title="Drag to compare the two recorded models" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
      onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const rect = e.currentTarget.closest('.stage')!.getBoundingClientRect(); onChange(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))); }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(Math.max(0, Math.min(1, value + (e.key === 'ArrowRight' ? .02 : -.02)))); } }}>↔</button>
  </div>;
}
