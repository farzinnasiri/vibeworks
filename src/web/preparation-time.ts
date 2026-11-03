import { useEffect, useRef, useState } from 'react';

const KEY = 'vibeworks.preparation-times.v1';
interface Samples { id: string; times: number[] }
function samples(): Samples[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is Samples => v && typeof v.id === 'string' && v.id.length <= 100 && Array.isArray(v.times)
      && v.times.length > 0 && v.times.length <= 5 && v.times.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 100 && n <= 600000)).slice(0, 24);
  } catch { return []; }
}
export function preparationEstimate(documentId: string): number | undefined {
  const times = samples().find(v => v.id === documentId)?.times.slice().sort((a, b) => a - b);
  return times?.length ? times[Math.floor(times.length / 2)] : undefined;
}
export function recordPreparation(documentId: string, elapsedMs: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 100 || elapsedMs > 600000) return;
  const previous = samples(), times = [...(previous.find(v => v.id === documentId)?.times ?? []), Math.round(elapsedMs)].slice(-5);
  try { localStorage.setItem(KEY, JSON.stringify([{ id: documentId, times }, ...previous.filter(v => v.id !== documentId)].slice(0, 24))); } catch { /* The estimate is optional. */ }
}

/** Record only an observed successful load. Switching documents, cancelling and failures add no sample. */
export function usePreparationTime(documentId: string, loading: boolean, successful: boolean) {
  const run = useRef<{ id: string; startedAt: number; clock: number } | undefined>(undefined);
  const [timing, setTiming] = useState<{ startedAt: number; expectedMs?: number }>();
  useEffect(() => {
    if (loading) {
      if (run.current?.id !== documentId) {
        run.current = { id: documentId, startedAt: Date.now(), clock: performance.now() };
        setTiming({ startedAt: run.current.startedAt, expectedMs: preparationEstimate(documentId) });
      }
    } else if (run.current) {
      if (run.current.id === documentId && successful) recordPreparation(documentId, performance.now() - run.current.clock);
      run.current = undefined; setTiming(undefined);
    }
  }, [documentId, loading, successful]);
  return timing;
}
