import { memo } from 'react';
import { Brand } from './Brand';
import { ProgressMeter } from './ProgressMeter';

/** The wave signals real activity without pretending to represent geometric progress. */
export const LoadingField = memo(function LoadingField({ label = 'Preparing model', name, compact = false, startedAt, expectedMs }: { label?: string; name?: string; compact?: boolean; startedAt?: number; expectedMs?: number }) {
  const lines = compact ? 4 : 22;
  return <div className={`loading-field ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
    <div className="wave-field" aria-hidden="true"><svg viewBox={`0 0 1600 ${compact ? 400 : 1000}`} preserveAspectRatio="none">{Array.from({ length: lines }, (_, i) => {
      const y = 150 + i * 34;
      return <path key={i} d={`M-400 ${y} C100 ${y - 400} 420 ${y + 440} 820 ${y} S1420 ${y - 400} 2000 ${y}`} opacity={0.9 - i / (lines - 1) * 0.5} />;
    })}</svg></div>
    {!compact && label && <Brand markOnly className="loading-brand" />}
    {label && <span className="loading-label">{label}</span>}{name && <span className="loading-document">{name}</span>}
    {!compact && label && <ProgressMeter label={label} startedAt={startedAt} expectedMs={expectedMs} />}
  </div>;
});
