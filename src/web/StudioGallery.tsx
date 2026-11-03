import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { downloadRender, downloadRenderSet, GALLERY_LIMITS, removeRenders, useAllStudioRenders, useGalleryUsage, type StudioRender } from './studio-renders';

const megabytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(bytes ? 0.1 : 0, bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
const when = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Every finished image kept in this browser, with its size against the gallery bound. */
export function StudioGallery({ documentId, documentName, revision, onOpen, onClose }: {
  documentId: string; documentName: string; revision: number; onOpen: (render: StudioRender) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const all = useAllStudioRenders(), usage = useGalleryUsage();
  const [scope, setScope] = useState<'model' | 'all'>('model');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const shown = useMemo(() => scope === 'model' ? all.filter(r => r.documentId === documentId) : all, [all, scope, documentId]);
  const chosen = shown.filter(r => selected.has(r.id));
  useEffect(() => { const dialog = ref.current!; const previous = globalThis.document.activeElement as HTMLElement | null; dialog.showModal(); return () => { dialog.close(); previous?.focus(); }; }, []);
  useEffect(() => setSelected(current => new Set([...current].filter(id => all.some(r => r.id === id)))), [all]);
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const share = Math.min(1, usage.bytes / GALLERY_LIMITS.bytes);
  return <dialog ref={ref} className="studio-gallery" aria-label="Gallery" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2>Gallery</h2>
        <div className="studio-gallery-scope" role="group" aria-label="Show images from">
          <button type="button" aria-pressed={scope === 'model'} onClick={() => setScope('model')}>This model</button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All models</button>
        </div>
      </div>
      <button type="button" className="icon-button quiet" aria-label="Close gallery" autoFocus onClick={onClose}><Icon name="close" size={16} /></button>
    </header>
    <section className="studio-gallery-usage" aria-label="Gallery storage">
      <div className="studio-gallery-meter" role="meter" aria-label="Gallery space used" aria-valuemin={0} aria-valuemax={GALLERY_LIMITS.bytes} aria-valuenow={usage.bytes} aria-valuetext={`${megabytes(usage.bytes)} of ${megabytes(GALLERY_LIMITS.bytes)}`}><span style={{ width: `${share * 100}%` }} /></div>
      <p><strong>{usage.images} {usage.images === 1 ? 'image' : 'images'} · {megabytes(usage.bytes)}</strong> of {megabytes(GALLERY_LIMITS.bytes)} or {GALLERY_LIMITS.images} images.
        {' '}Stored in this browser only, not in the model. {usage.persistent ? 'The browser keeps them until you delete them.' : usage.persistent === false ? 'The browser may clear them if the disk is nearly full; save PNGs you need.' : ''}
        {' '}When full, the oldest images make room.</p>
    </section>
    {shown.length ? <ul className="studio-gallery-grid">
      {shown.map(render => <li key={render.id} className={selected.has(render.id) ? 'selected' : ''}>
        <button type="button" className="studio-gallery-image" aria-label={`Open ${render.label ?? 'image'} from ${when(render.createdAt)}`} onClick={() => onOpen(render)}><img src={render.thumbnailUrl ?? render.url} alt="" loading="lazy" /></button>
        <label className="studio-gallery-pick"><input type="checkbox" checked={selected.has(render.id)} onChange={() => toggle(render.id)} aria-label={`Select image from ${when(render.createdAt)}`} /></label>
        <div className="studio-gallery-meta">
          {scope === 'all' && <strong title={render.documentName}>{render.documentId === documentId ? documentName : render.documentName ?? 'Another model'}</strong>}
          <span>{render.width} × {render.height} · {render.quality}</span>
          <span>{when(render.createdAt)} · r{render.revision}{render.documentId === documentId && render.revision !== revision ? ' (older)' : ''} · {megabytes(render.blob.size)}</span>
        </div>
      </li>)}
    </ul> : <p className="studio-gallery-empty">{scope === 'model' ? 'No images of this model yet. Render one and it appears here.' : 'The gallery is empty.'}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <footer>
      <span role="status">{chosen.length ? `${chosen.length} selected · ${megabytes(chosen.reduce((n, r) => n + r.blob.size, 0))}` : 'Select images to save or delete several at once.'}</span>
      <button type="button" className="link-button" disabled={!shown.length} onClick={() => setSelected(chosen.length === shown.length ? new Set() : new Set(shown.map(r => r.id)))}>{chosen.length === shown.length && shown.length ? 'Clear selection' : 'Select all'}</button>
      <button type="button" className="ghost-button small" disabled={!chosen.length} onClick={() => {
        setError('');
        if (chosen.length === 1) downloadRender(chosen[0], chosen[0].documentName ?? documentName);
        else void downloadRenderSet(chosen, documentName).catch(e => setError(e instanceof Error ? e.message : String(e)));
      }}><Icon name="export" size={14} />{chosen.length > 1 ? 'Save as ZIP' : 'Save PNG'}</button>
      <button type="button" className="ghost-button small studio-danger" disabled={!chosen.length} onClick={() => { if (window.confirm(`Delete ${chosen.length} ${chosen.length === 1 ? 'image' : 'images'} from this browser? This cannot be undone.`)) void removeRenders(chosen.map(r => r.id)).then(() => setSelected(new Set())); }}><Icon name="delete" size={14} />Delete</button>
    </footer>
  </dialog>;
}
