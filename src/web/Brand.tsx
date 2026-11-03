/** Every product surface uses the same exported geometry; modeling icons stay separate. */
export function Brand({ markOnly = false, className = '' }: { markOnly?: boolean; className?: string }) {
  const kind = markOnly ? 'mark' : 'logo';
  return <span className={`vibeworks-brand ${markOnly ? 'mark-only' : ''} ${className}`} role="img" aria-label="Vibeworks">
    <img className="brand-light" src={`/brand/vibeworks-${kind}.svg`} alt="" aria-hidden="true" />
    <img className="brand-dark" src={`/brand/vibeworks-${kind}-dark.svg`} alt="" aria-hidden="true" />
  </span>;
}
