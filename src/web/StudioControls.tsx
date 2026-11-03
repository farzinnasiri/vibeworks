import { useRef, type ReactNode } from 'react';
import { Icon } from './icons';

/** Longer explanations live behind a small info button, shown on hover or focus by the shared tooltip outlet. */
export function InfoTip({ about, text }: { about: string; text: string }) {
  return <button type="button" className="studio-info" aria-label={`About ${about}`} data-tooltip={text} onClick={event => event.preventDefault()}><Icon name="help" size={13} /></button>;
}
/** A labelled range with its value. A hint is one short line; anything longer belongs in `info`. */
export function Slider({ label, ariaLabel, hint, info, value, min, max, step = 1, unit = '', format, onChange }: {
  label: string; ariaLabel?: string; hint?: string; info?: string; value: number; min: number; max: number; step?: number; unit?: string;
  format?: (value: number) => string; onChange: (value: number) => void;
}) {
  return <div className="studio-slider"><span><span className="studio-label">{label}{info && <InfoTip about={ariaLabel ?? label} text={info} />}</span><output>{format ? format(value) : `${Number(value.toFixed(2))}${unit}`}</output></span>
    {hint && <small className="studio-hint">{hint}</small>}
    <input type="range" aria-label={ariaLabel ?? label} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
  </div>;
}
export function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="studio-color"><span>{label}</span><span><code>{value}</code><input aria-label={label} type="color" value={value} onChange={event => onChange(event.target.value)} /></span></label>;
}
/** A single choice among a few short options. */
export function Segmented<T extends string>({ label, hint, info, value, options, onChange }: { label: string; hint?: string; info?: string; value: T; options: readonly { id: T; label: string; title?: string }[]; onChange: (value: T) => void }) {
  return <div className="studio-field"><span className="studio-label">{label}{info && <InfoTip about={label} text={info} />}</span>{hint && <small className="studio-hint">{hint}</small>}
    <div className="studio-segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => <button key={option.id} type="button" role="radio" tabIndex={value === option.id ? 0 : -1} aria-checked={value === option.id} title={option.title} onClick={() => onChange(option.id)} onKeyDown={event => {
        const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (!delta && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + delta + options.length) % options.length;
        onChange(options[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}>{option.label}</button>)}
    </div>
  </div>;
}
/** A titled group inside a panel. Panels are short enough that groups do not collapse. */
export function Group({ title, hint, info, children, action }: { title: string; hint?: string; info?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="studio-group"><header><h2>{title}{info && <InfoTip about={title} text={info} />}</h2>{action}</header>{hint && <p className="studio-hint">{hint}</p>}{children}</section>;
}

const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;
/** Where the key light sits relative to the camera, in words. */
export function lightPlacement(lightDegrees: number, cameraDegrees: number) {
  const relative = wrap(lightDegrees - cameraDegrees);
  if (Math.abs(relative) <= 30) return 'from the front';
  if (Math.abs(relative) >= 150) return 'from behind';
  const side = relative > 0 ? 'right' : 'left';
  return Math.abs(relative) > 100 ? `from back ${side}` : `from the ${side}`;
}

/**
 * Top-down map of the lighting rig with the camera always at the bottom, so left on the dial is left in
 * the picture. Distance from the center is the light's height; its shadow falls on the opposite side.
 */
export function LightDial({ rotation, elevation, camera, fill, color, onChange }: {
  rotation: number; elevation: number; camera: number; fill: boolean; color: string;
  onChange: (patch: { lightRotation?: number; lightElevation?: number }) => void;
}) {
  const svg = useRef<SVGSVGElement>(null), size = 200, c = size / 2, R = 62;
  const toDial = (azimuth: number) => (azimuth - camera - 90) * Math.PI / 180;
  const at = (azimuth: number, height: number) => { const a = toDial(azimuth), r = R * (90 - height) / 90; return { x: c + r * Math.cos(a), y: c - r * Math.sin(a) }; };
  const key = at(rotation, elevation), fillAt = at(rotation + 126, Math.max(5, elevation - 11));
  const shadowLength = Math.min(R * 0.9, 14 / Math.tan(elevation * Math.PI / 180)), shadowAngle = toDial(rotation) + Math.PI;
  const drag = (event: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * size - c, y = c - (event.clientY - box.top) / box.height * size;
    const r = Math.min(R, Math.hypot(x, y)), dial = Math.atan2(y, x) * 180 / Math.PI;
    onChange({ lightRotation: Math.round(wrap(dial + camera + 90)), lightElevation: Math.round(Math.max(5, Math.min(85, 90 - r / R * 90))) });
  };
  const keydown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 15 : 5;
    const move: Record<string, () => void> = {
      ArrowLeft: () => onChange({ lightRotation: Math.round(wrap(rotation + step)) }), ArrowRight: () => onChange({ lightRotation: Math.round(wrap(rotation - step)) }),
      ArrowUp: () => onChange({ lightElevation: Math.min(85, elevation + step) }), ArrowDown: () => onChange({ lightElevation: Math.max(5, elevation - step) }),
    };
    if (!Object.hasOwn(move, event.key)) return;
    event.preventDefault(); move[event.key]();
  };
  return <div className="studio-light-dial">
    <svg ref={svg} viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="slider" tabIndex={0} aria-label="Key light position"
      aria-valuetext={`Light ${lightPlacement(rotation, camera)}, ${Math.round(elevation)} degrees high`} aria-valuenow={Math.round(elevation)} aria-valuemin={5} aria-valuemax={85}
      onKeyDown={keydown} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag(event); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) drag(event); }}>
      <circle className="dial-ground" cx={c} cy={c} r={R} />
      <circle className="dial-ring" cx={c} cy={c} r={R * 60 / 90} /><circle className="dial-ring" cx={c} cy={c} r={R * 30 / 90} />
      <ellipse className="dial-shadow" cx={c + Math.cos(shadowAngle) * shadowLength / 2} cy={c - Math.sin(shadowAngle) * shadowLength / 2} rx={shadowLength / 2 + 8} ry={8}
        transform={`rotate(${-shadowAngle * 180 / Math.PI} ${c + Math.cos(shadowAngle) * shadowLength / 2} ${c - Math.sin(shadowAngle) * shadowLength / 2})`} />
      <rect className="dial-model" x={c - 9} y={c - 9} width={18} height={18} rx={3} />
      <path className="dial-view" d={`M ${c} ${c + R} L ${c - 20} ${c + 13} M ${c} ${c + R} L ${c + 20} ${c + 13}`} />
      <text className="dial-word dial-you" x={c} y={size - 3} textAnchor="middle">You</text><text className="dial-word" x={c} y={10} textAnchor="middle">Back</text>
      <text className="dial-word" x={2} y={c + 3} textAnchor="start">Left</text><text className="dial-word" x={size - 2} y={c + 3} textAnchor="end">Right</text>
      {fill && <circle className="dial-fill" cx={fillAt.x} cy={fillAt.y} r={6} />}
      <line className="dial-beam" x1={key.x} y1={key.y} x2={c} y2={c} />
      <circle className="dial-key" cx={key.x} cy={key.y} r={11} style={{ fill: color }} />
    </svg>
    <p className="studio-light-readout"><span className="legend-key" style={{ background: color }} />Key light {lightPlacement(rotation, camera)}, {Math.round(elevation)}° high</p>
    <ul className="studio-light-legend">
      {fill && <li><span className="legend-fill" />Fill light</li>}
      <li><span className="legend-shadow" />Shadow</li>
    </ul>
  </div>;
}
