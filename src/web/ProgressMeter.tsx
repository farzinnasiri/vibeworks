import { useEffect, useRef, useState } from 'react';

export interface ProgressMeterProps {
  label: string;
  /** A real completed fraction; omit when the underlying operation exposes no counts. */
  value?: number;
  elapsedMs?: number;
  etaMs?: number;
  startedAt?: number;
  expectedMs?: number;
  compact?: boolean;
}
export function waitTime(ms: number) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
}

/** A small measuring rail. Only measured work fills it; uncertain waits keep a scanning indicator. */
export function ProgressMeter({ label, value, elapsedMs, etaMs, startedAt, expectedMs, compact = false }: ProgressMeterProps) {
  const born = useRef(Date.now()), [now, setNow] = useState(Date.now);
  const sample = useRef({ value: elapsedMs, at: Date.now() });
  if (sample.current.value !== elapsedMs) sample.current = { value: elapsedMs, at: Date.now() };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sinceSample = Math.max(0, now - sample.current.at);
  const elapsed = elapsedMs === undefined ? Math.max(0, now - (startedAt ?? born.current)) : elapsedMs + sinceSample;
  const fraction = value === undefined || !Number.isFinite(value) ? undefined : Math.min(1, Math.max(0, value));
  const overdue = expectedMs !== undefined && elapsed >= expectedMs;
  const remaining = etaMs !== undefined ? Math.max(0, etaMs - sinceSample) : expectedMs !== undefined && !overdue ? expectedMs - elapsed : undefined;
  const eta = overdue ? 'Taking longer than recent loads' : remaining !== undefined && remaining > 0 ? `About ${waitTime(remaining)} left` : 'Estimating remaining time';
  const elapsedText = elapsed < 1000 ? 'Starting' : `${waitTime(Math.floor(elapsed / 1000) * 1000)} elapsed`;
  const valueText = `${fraction === undefined ? 'In progress' : `${Math.floor(fraction * 100)} percent`}. ${elapsedText}. ${eta}.`;
  return <div className={`progress-meter ${compact ? 'compact' : ''}`} aria-live="off">
    <div className={`progress-rail ${fraction === undefined ? 'indeterminate' : ''}`} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === undefined ? undefined : Math.floor(fraction * 100)} aria-valuetext={valueText}>
      <svg className="progress-graduations" viewBox="0 0 300 10" preserveAspectRatio="none" aria-hidden="true">{Array.from({ length: 31 }, (_, i) => <path key={i} d={`M${i * 10} 0v${i % 5 ? 3 : 6}`} />)}</svg>
      <span className="progress-baseline" />
      <span className="progress-fill" style={fraction === undefined ? undefined : { transform: `scaleX(${fraction})` }} />
    </div>
    <div className="progress-meta"><span>{elapsedText}</span>
      <span title={expectedMs !== undefined ? 'Estimate based on recent successful loads of this document' : undefined}>{eta}</span></div>
  </div>;
}
