import { agentColor, agentVisualSeed } from './participants';

/** Independent shape and color seeds distinguish agents without changing as their work changes. */
export function mechanicalMark(id: string) {
  const seed = agentVisualSeed(id, 'shape');
  return { shape: seed % 6, holes: 1 + (seed >>> 5) % 3, slot: (seed >>> 9) % 4, flip: !!(seed & 8192) };
}
const outlines = [
  'M8 3H24L29 8V24L24 29H3V8Z',
  'M9 3H23L29 10V22L22 29H10L3 22V10Z',
  'M6 3H26V10H29V25L25 29H7L3 25V10H6Z',
  'M10 3H22L29 8V26H22V29H10V26H3V8Z',
  'M3 7H10V3H22V7H29V25L25 29H7L3 25Z',
  'M8 3H24L29 12V20L24 29H8L3 20V12Z',
];
export function AgentMark({ id, name, size = 24, human = false }: { id: string; name?: string; size?: number; human?: boolean }) {
  const mark = mechanicalMark(id);
  return <svg className={`agent-mark ${human ? 'human' : ''}`} width={size} height={size} viewBox="0 0 32 32" role={name ? 'img' : undefined} aria-label={name} aria-hidden={name ? undefined : true} style={{ color: human ? 'var(--ink-3)' : `color-mix(in srgb, ${agentColor(id)}, var(--ink) 20%)` }}>
    <g transform={mark.flip ? 'translate(32 0) scale(-1 1)' : undefined}>
      <path d={outlines[mark.shape]} fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      {Array.from({ length: mark.holes }, (_, i) => <circle key={i} cx={mark.holes === 1 ? 16 : mark.holes === 2 ? 12 + i * 8 : 10 + i * 6} cy="11" r="2" fill="currentColor" />)}
      {mark.slot === 0 ? <path d="M9 19h14v4H9Z" fill="currentColor" />
        : mark.slot === 1 ? <path d="M9 18h5v6H9Zm10 0h4v6h-4Z" fill="currentColor" />
        : mark.slot === 2 ? <path d="M10 23v-5h12v5M16 18v5" fill="none" stroke="currentColor" strokeWidth="2" />
        : <path d="m10 19 6 5 6-5" fill="none" stroke="currentColor" strokeWidth="2.5" />}
    </g>
  </svg>;
}
