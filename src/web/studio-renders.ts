import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { presentationSchema, type Presentation } from '../shared/protocol';

/** Everything needed to explain or recompose a finished image. */
export interface StudioShot {
  projection: 'perspective' | 'orthographic';
  position: [number, number, number]; target: [number, number, number]; up: [number, number, number];
  /** Perspective vertical field of view, degrees, or orthographic zoom. */
  fov: number; zoom: number;
  focalLengthMm?: number;
}
export interface StudioRender {
  id: string; documentId: string; documentName?: string; revision: number; createdAt: number;
  url: string; blob: Blob; width: number; height: number;
  thumbnail?: Blob; thumbnailUrl?: string;
  samples: number; quality: string; elapsedMs: number; hiddenMs: number;
  shot: StudioShot; settings: Presentation;
  /** Renderer and version, so images can be compared after an upgrade. */
  renderer: string;
  label?: string;
  views?: string[];
  setId?: string;
}

/**
 * Personal Studio gallery. Blobs persist in this browser's IndexedDB, never in the CAD document or SQLite.
 * The bound is generous; when it is reached the oldest images are removed and the user is told.
 */
export const GALLERY_LIMITS = { images: 300, bytes: 512 * 1024 * 1024 };
let renders: StudioRender[] = [];
const listeners = new Set<() => void>();
let storageError = '', notice = '', persistence: 'unknown' | 'persistent' | 'best-effort' = 'unknown';
let hydration: Promise<void> | undefined, writes = Promise.resolve();
const removed = new Set<string>();
const unsaved = new Set<string>();
const emit = () => { for (const listener of listeners) listener(); };
const release = (render: StudioRender) => { URL.revokeObjectURL(render.url); if (render.thumbnailUrl) URL.revokeObjectURL(render.thumbnailUrl); };
const bytesOf = (render: { blob: Blob; thumbnail?: Blob }) => render.blob.size + (render.thumbnail?.size ?? 0);
/** Newest first; returns the ids beyond the gallery bound. */
function overflow(rows: { id: string; createdAt: number; size: number }[]) {
  let count = 0, bytes = 0; const out: string[] = [];
  for (const row of [...rows].sort((a, b) => b.createdAt - a.createdAt)) {
    if (count < GALLERY_LIMITS.images && bytes + row.size <= GALLERY_LIMITS.bytes) { count++; bytes += row.size; } else out.push(row.id);
  }
  return out;
}
function reportEvicted(count: number) {
  if (count) notice = `The gallery is full, so the ${count === 1 ? 'oldest image was' : `${count} oldest images were`} removed. Delete images you no longer need to keep more.`;
}

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const storedSchema = z.object({ id: z.string().min(1), documentId: z.string().min(1), documentName: z.string().max(240).optional(), revision: z.number().int().nonnegative(), createdAt: z.number().finite(),
  blob: z.instanceof(Blob), thumbnail: z.instanceof(Blob).optional(), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  samples: z.number().nonnegative(), quality: z.string(), elapsedMs: z.number().nonnegative(), hiddenMs: z.number().nonnegative(),
  shot: z.object({ projection: z.enum(['perspective','orthographic']), position: vector, target: vector, up: vector, fov: z.number().positive(), zoom: z.number().positive(), focalLengthMm: z.number().positive().optional() }),
  settings: presentationSchema, renderer: z.string(), label: z.string().optional(), views: z.array(z.string()).max(16).optional(), setId: z.string().optional(),
});
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vibeworks.studio.history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
/** Ask once that the browser keep the gallery when disk space runs low. Browsers may decline. */
function requestPersistence() {
  if (persistence !== 'unknown' || typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  persistence = 'best-effort';
  void navigator.storage.persisted().then(already => already || navigator.storage.persist())
    .then(granted => { persistence = granted ? 'persistent' : 'best-effort'; emit(); }).catch(() => {});
}
/** Incremental writes: new images, deletions, then the bound. Another tab's finished images are kept. */
function persist() {
  const snapshot = renders.filter(render => unsaved.has(render.id)).map(({ url: _url, thumbnailUrl: _thumbnailUrl, ...stored }) => stored);
  const deleted = [...removed];
  writes = writes.then(async () => {
    const db = await database();
    try {
      const evicted = await new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction('images', 'readwrite'), store = transaction.objectStore('images');
        for (const render of snapshot) store.put(render);
        for (const id of deleted) store.delete(id);
        const rows: { id: string; createdAt: number; size: number }[] = [];
        let out: string[] = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (at) {
            const parsed = storedSchema.safeParse(at.value);
            if (parsed.success) rows.push({ id: parsed.data.id, createdAt: parsed.data.createdAt, size: bytesOf(parsed.data) }); else at.delete();
            at.continue(); return;
          }
          out = overflow(rows); for (const id of out) store.delete(id);
        };
        transaction.oncomplete = () => resolve(out); transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
      for (const render of snapshot) unsaved.delete(render.id);
      const gone = renders.filter(render => evicted.includes(render.id));
      if (gone.length) { gone.forEach(release); renders = renders.filter(render => !evicted.includes(render.id)); reportEvicted(gone.length); }
      storageError = '';
    } finally { db.close(); }
  }).catch(() => { storageError = 'The gallery could not be saved in this browser. Save PNG to keep these images.'; }).then(emit);
  return writes;
}
export function loadRenderHistory(): Promise<void> {
  return hydration ??= (async () => {
    try {
      const db = await database();
      let saved: unknown[];
      try { saved = await new Promise((resolve, reject) => {
        const request = db.transaction('images').objectStore('images').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }); } finally { db.close(); }
      const live = new Set(renders.map(r => r.id));
      for (const value of saved) {
        const parsed = storedSchema.safeParse(value);
        if (!parsed.success || live.has(parsed.data.id) || removed.has(parsed.data.id)) continue;
        const stored = parsed.data;
        renders.push({ ...stored, url: URL.createObjectURL(stored.blob), ...(stored.thumbnail ? { thumbnailUrl: URL.createObjectURL(stored.thumbnail) } : {}) });
      }
      renders = [...renders].sort((a,b) => b.createdAt-a.createdAt);
      trim(); emit(); if (unsaved.size) await persist();
    } catch { storageError = 'The gallery is unavailable in this browser. Save PNG to keep your images.'; emit(); }
  })();
}

function trim() {
  const out = new Set(overflow(renders.map(r => ({ id: r.id, createdAt: r.createdAt, size: bytesOf(r) }))));
  if (!out.size) return;
  reportEvicted(renders.filter(r => out.has(r.id) && !unsaved.has(r.id)).length);
  renders = renders.filter(r => { if (!out.has(r.id)) return true; release(r); unsaved.delete(r.id); return false; });
  emit();
}

export async function addRender(render: StudioRender) {
  requestPersistence();
  unsaved.add(render.id); renders = [render, ...renders]; trim();
  // Merge prior durable history before the first write, including renders completed during hydration.
  await loadRenderHistory(); await persist();
}

export async function removeRenders(ids: string[]) {
  const doomed = renders.filter(r => ids.includes(r.id)); if (!doomed.length) return;
  for (const render of doomed) removed.add(render.id);
  await loadRenderHistory(); await persist();
  doomed.forEach(release);
  renders = renders.filter(r => !ids.includes(r.id)); notice = ''; emit();
}
export const removeRender = (id: string) => removeRenders([id]);

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Every image in this browser's gallery, newest first. */
export function useAllStudioRenders(): StudioRender[] {
  useEffect(() => { void loadRenderHistory(); }, []);
  return useSyncExternalStore(subscribe, () => renders);
}
let usage = { images: 0, bytes: 0, persistent: false as boolean | undefined, source: renders };
/** Gallery size against its bound, and whether the browser promised to keep it. */
export function useGalleryUsage() {
  return useSyncExternalStore(subscribe, () => {
    const persistent = persistence === 'unknown' ? undefined : persistence === 'persistent';
    if (usage.source !== renders || usage.persistent !== persistent) usage = { images: renders.length, bytes: renders.reduce((n, r) => n + bytesOf(r), 0), persistent, source: renders };
    return usage;
  });
}
export function useGalleryNotice() { return useSyncExternalStore(subscribe, () => notice); }
export function dismissGalleryNotice() { notice = ''; emit(); }

export function useStudioRenders(documentId: string): StudioRender[] {
  const all = useAllStudioRenders();
  return useMemo(() => all.filter(r => r.documentId === documentId), [all, documentId]);
}

export function useRenderHistoryError() {
  return useSyncExternalStore(subscribe, () => storageError);
}

export function downloadRender(render: StudioRender, name: string) {
  const link = document.createElement('a');
  const stamp = new Date(render.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  link.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'vibeworks'}-r${render.revision}-${render.label?.replace(/[^\w.-]+/g, '-') ?? render.id.slice(0,8)}-${stamp}.png`;
  link.href = render.url; link.click();
}

export async function downloadRenderSet(images: StudioRender[], name: string) {
  const { zipSync } = await import('three/addons/libs/fflate.module.js');
  if (images.reduce((n, image) => n + image.blob.size, 0) > 64 * 1024 * 1024) throw new Error('This image set is too large for one ZIP. Save the images separately.');
  const files: Record<string, Uint8Array> = {};
  for (const [i, image] of images.entries()) files[`${i + 1}-${(image.label ?? 'view').replace(/[^\w.-]+/g, '-')}.png`] = new Uint8Array(await image.blob.arrayBuffer());
  const bytes = zipSync(files, { level: 0 }), blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${name.replace(/[^\w.-]+/g, '-')}-views.zip`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
