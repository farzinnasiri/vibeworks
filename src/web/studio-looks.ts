import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { presentationSchema, type Presentation } from '../shared/protocol';
import { studioSettings } from '../shared/studio';
import type { StudioShot } from './studio-renders';

/**
 * A look is a complete scene without material choices: lighting, surroundings, floor and background.
 * Applying one replaces every scene field and keeps the model's Studio material looks.
 */
export interface StudioLook { id: string; name: string; caption?: string; scene: Presentation; createdAt?: number }

/** Scene fields a look owns. Material looks and the legacy carbon option stay with the model. */
export function sceneOf(p: Presentation): Presentation {
  const { materials: _materials, carbonFinish: _carbon, ...scene } = p;
  return scene;
}
export function applyLook(current: Presentation, look: StudioLook): Presentation {
  const { materials, carbonFinish } = current;
  return { ...look.scene, ...(materials ? { materials } : {}), ...(carbonFinish ? { carbonFinish } : {}) };
}
/** Equal after defaults: a look that leaves a field unset matches a scene using its default. */
const canonical = (p: Presentation) => { const { materials: _m, ...scene } = studioSettings(sceneOf(p)); return JSON.stringify(scene); };
export const sameScene = (a: Presentation, b: Presentation) => canonical(a) === canonical(b);

export const BUILT_IN_LOOKS: StudioLook[] = [
  { id: 'clean-white', name: 'Clean white', caption: 'Bright seamless backdrop',
    scene: { preset: 'soft', environmentPreset: 'studio', exposure: 1.1, backdrop: 'sweep', floor: 'matte', floorColor: '#e6e7e8', background: '#f1f2f3', backgroundMode: 'color' } },
  { id: 'studio-gray', name: 'Studio gray', caption: 'Neutral, balanced light',
    scene: { preset: 'studio', environmentPreset: 'studio', backdrop: 'sweep', floor: 'matte', background: '#9a9d9f', backgroundMode: 'color' } },
  { id: 'dark-product', name: 'Dark product', caption: 'Shaped highlights on black',
    scene: { preset: 'dramatic', environmentPreset: 'dark_studio', backdrop: 'sweep', floor: 'matte', floorColor: '#2b2d2f', floorRoughness: 0.4, background: '#151617', backgroundMode: 'color' } },
  { id: 'daylight', name: 'Daylight', caption: 'Sky light, warm floor',
    scene: { preset: 'soft', environmentPreset: 'outdoor', backdrop: 'sweep', floor: 'matte', floorColor: '#d8d3c9', background: '#e3e1dc', backgroundMode: 'color' } },
  { id: 'workshop', name: 'Workshop', caption: 'Concrete floor, hall light',
    scene: { preset: 'studio', environmentPreset: 'warehouse', environment: 0.8, backdrop: 'sweep', floor: 'polished_concrete', background: '#6f7275', backgroundMode: 'color' } },
  { id: 'cutout', name: 'Cut-out', caption: 'Transparent PNG, no floor',
    scene: { preset: 'studio', environmentPreset: 'studio', floor: 'none', backgroundMode: 'transparent' } },
];

const LOOKS_KEY = 'vibeworks.studio.looks';
export const MAX_SAVED_LOOKS = 24;
const savedSchema = z.array(z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(60), scene: presentationSchema, createdAt: z.number().finite() }));
let saved: StudioLook[] | undefined;
const listeners = new Set<() => void>();
function readSaved(): StudioLook[] {
  if (saved) return saved;
  try { const parsed = savedSchema.safeParse(JSON.parse(localStorage.getItem(LOOKS_KEY) ?? '[]')); saved = parsed.success ? parsed.data : []; }
  catch { saved = []; }
  return saved;
}
function writeSaved(next: StudioLook[]) {
  saved = next;
  try { localStorage.setItem(LOOKS_KEY, JSON.stringify(next)); } catch { /* Kept for this page only. */ }
  for (const listener of listeners) listener();
}
/** Personal looks, shared by every model in this browser. */
export function useSavedLooks(): StudioLook[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readSaved);
}
export function saveLook(name: string, scene: Presentation): StudioLook {
  const look = { id: crypto.randomUUID(), name: name.trim().slice(0, 60) || 'My look', scene: sceneOf(scene), createdAt: Date.now() };
  writeSaved([look, ...readSaved()].slice(0, MAX_SAVED_LOOKS));
  return look;
}
export function deleteLook(id: string) { writeSaved(readSaved().filter(look => look.id !== id)); }

/**
 * Unsaved scene edits and the last camera survive leaving Studio. They stay in this browser until
 * saved to the model or reverted. A model update keeps both.
 */
const draftKey = (documentId: string) => `vibeworks.studio.draft.${documentId}`;
const cameraKey = (documentId: string) => `vibeworks.studio.camera.${documentId}`;
export function readSceneDraft(documentId: string): Presentation | undefined {
  try { const parsed = presentationSchema.safeParse(JSON.parse(localStorage.getItem(draftKey(documentId)) ?? 'null')); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
export function writeSceneDraft(documentId: string, draft: Presentation | undefined) {
  try { if (draft) localStorage.setItem(draftKey(documentId), JSON.stringify(draft)); else localStorage.removeItem(draftKey(documentId)); } catch { /* Page-local fallback. */ }
}
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const shotSchema = z.object({ projection: z.enum(['perspective', 'orthographic']), position: vector, target: vector, up: vector, fov: z.number().positive(), zoom: z.number().positive(), focalLengthMm: z.number().positive().optional() });
export function readStudioCamera(documentId: string): StudioShot | undefined {
  try { const parsed = shotSchema.safeParse(JSON.parse(localStorage.getItem(cameraKey(documentId)) ?? 'null')); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
export function writeStudioCamera(documentId: string, shot: StudioShot) {
  try { localStorage.setItem(cameraKey(documentId), JSON.stringify(shot)); } catch { /* Page-local fallback. */ }
}

/** Personal Studio choices that are not scene data. */
export interface StudioPreferences {
  panel: 'looks' | 'light' | 'backdrop' | 'materials' | 'output';
  rendering: 'fast' | 'quality'; scope: 'current' | 'views';
  views: string[]; layout: 'sheet' | 'separate'; labels: boolean; focalLengthMm: number;
}
const PREFERENCES_KEY = 'vibeworks.studio.preferences';
const preferencesSchema = z.object({
  panel: z.enum(['looks', 'light', 'backdrop', 'materials', 'output']), rendering: z.enum(['fast', 'quality']), scope: z.enum(['current', 'views']),
  views: z.array(z.string().max(32)).max(16), layout: z.enum(['sheet', 'separate']), labels: z.boolean(), focalLengthMm: z.number().min(10).max(300),
}).partial();
export function readStudioPreferences(): Partial<StudioPreferences> {
  try { const parsed = preferencesSchema.safeParse(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')); return parsed.success ? parsed.data : {}; }
  catch { return {}; }
}
export function writeStudioPreferences(preferences: StudioPreferences) {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Page-local fallback. */ }
}
