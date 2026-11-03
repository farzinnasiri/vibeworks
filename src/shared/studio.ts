import type { MaterialLook, Presentation } from './protocol';
import { FINISH_ROUGHNESS, materialById, type Coat, type Finish, type StudioFloor, type SurfaceDetail } from './materials';

export interface FloorType {
  name: string; group: 'Studio' | 'Industrial' | 'Architectural';
  color: string; roughness: number;
  /** Real-world size of one pattern repeat, mm. Undefined for untextured floors. */
  scale?: number;
  metalness?: number; clearcoat?: number;
  /** Bundled photographic maps, or a pattern generated in code. */
  source?: 'image' | 'procedural';
}

/** Floors grouped by use. Patterned floors keep a real-world size around large models and shrink with small ones. */
export const STUDIO_FLOORS: Record<StudioFloor, FloorType> = {
  matte: { name: 'Matte', group: 'Studio', color: '#8f9396', roughness: 0.85 },
  gloss: { name: 'Gloss', group: 'Studio', color: '#6c7074', roughness: 0.16, clearcoat: 0.5 },
  grid: { name: 'Measuring grid', group: 'Studio', color: '#b9bcbd', roughness: 0.75, scale: 100, source: 'procedural' },
  concrete: { name: 'Concrete', group: 'Industrial', color: '#797d80', roughness: 0.38, scale: 1000, source: 'image' },
  polished_concrete: { name: 'Polished concrete', group: 'Industrial', color: '#7b7e80', roughness: 0.2, scale: 1000, source: 'image' },
  epoxy: { name: 'Epoxy coating', group: 'Industrial', color: '#5f666b', roughness: 0.22, scale: 600, clearcoat: 0.6, source: 'procedural' },
  plate: { name: 'Tread plate', group: 'Industrial', color: '#9aa0a5', roughness: 0.42, scale: 120, metalness: 0.9, source: 'procedural' },
  asphalt: { name: 'Asphalt', group: 'Industrial', color: '#4c4f52', roughness: 0.9, scale: 800, source: 'procedural' },
  tiles: { name: 'Stone tiles', group: 'Architectural', color: '#797d80', roughness: 0.38, scale: 1000, source: 'image' },
  wood: { name: 'Wood planks', group: 'Architectural', color: '#9b7654', roughness: 0.55, scale: 800, source: 'procedural' },
  checker: { name: 'Checker', group: 'Architectural', color: '#d6d4cf', roughness: 0.3, scale: 600, source: 'procedural' },
  none: { name: 'No floor', group: 'Studio', color: '#8f9396', roughness: 0.85 },
};

/** Patterned floors keep real size beside a car and scale down with a hand-sized part. */
export function floorPatternSize(settings: Presentation, modelRadiusMm: number): number | undefined {
  const type = STUDIO_FLOORS[settings.floor ?? 'matte'];
  if (!type.scale) return undefined;
  if (settings.floorScale) return settings.floorScale;
  const factor = Math.min(1, Math.max(0.05, modelRadiusMm / 1500));
  return Math.max(10, Math.round(type.scale * factor));
}

/** Defaults shared by the interactive and final-image renderers. Distances remain millimetres. */
export function studioSettings(p: Presentation = {}) {
  const floor = p.floor ?? 'matte', type = STUDIO_FLOORS[floor];
  const background = p.background ?? '#9a9d9f';
  return {
    preset: p.preset ?? 'studio',
    exposure: p.exposure ?? 1,
    environmentPreset: p.environmentPreset ?? 'studio',
    environment: p.environment ?? (p.preset === 'soft' ? 1 : p.preset === 'dramatic' ? 0.3 : 0.65),
    environmentRotation: p.environmentRotation ?? 0,
    keyIntensity: p.keyIntensity ?? (p.preset === 'soft' ? 1.2 : p.preset === 'dramatic' ? 3.5 : 2.2),
    keySize: p.keySize ?? 1,
    fillIntensity: p.fillIntensity ?? 1,
    lightRotation: p.lightRotation ?? -35,
    lightElevation: p.lightElevation ?? 55,
    lightColor: p.lightColor ?? '#ffffff',
    background,
    backgroundTop: p.backgroundTop ?? '#e4e6e7',
    backgroundMode: p.backgroundMode ?? 'color',
    shadows: p.shadows !== false,
    floor,
    floorColor: p.floorColor ?? type.color,
    floorRoughness: p.floorRoughness ?? type.roughness,
    floorScale: p.floorScale,
    floorHeight: p.floorHeight ?? 0,
    // Seamless by default: an open floor meets the background at a visible horizon.
    backdrop: p.backdrop ?? 'sweep',
    materials: materialLooks(p),
  };
}

/** Material looks with the legacy carbonFinish:'coated' option read as a carbon look. */
export function materialLooks(p: Presentation): Partial<Record<string, MaterialLook>> {
  const looks = { ...p.materials };
  if (p.carbonFinish === 'coated' && !looks.carbon_fiber) looks.carbon_fiber = { coat: 'clear', detail: 'carbon' };
  return looks;
}

/** What a part shows after its material's Studio look. Unset look fields keep the authored value. */
export interface AuthoredSurface { materialKey: string; finish?: Finish; detail?: SurfaceDetail; detailScale?:number }
export function resolveSurface(authored: AuthoredSurface, looks: Partial<Record<string, MaterialLook>>) {
  const look = looks[authored.materialKey] ?? {};
  const material = materialById(authored.materialKey);
  const detail: SurfaceDetail = look.detail ?? authored.detail ?? material?.detail ?? 'plain';
  return {
    changed: Object.keys(look).length > 0,
    roughness: look.finish ? FINISH_ROUGHNESS[look.finish] : undefined,
    clearcoat: look.coat ? (look.coat === 'clear' ? 1 : 0) : undefined,
    detail, detailChanged: look.detail !== undefined || look.detailScale !== undefined,
    detailScale: look.detailScale ?? authored.detailScale ?? 1,
  };
}

export const COAT_LABELS: Record<Coat, string> = { none: 'None', clear: 'Clear coat' };
export const DETAIL_LABELS: Record<SurfaceDetail, string> = { plain: 'Plain', carbon: 'Carbon weave', rubber: 'Rubber grain', brushed: 'Brushed', wood: 'Wood grain' };

export const STUDIO_ENVIRONMENTS = {
  studio: { name: 'Photo studio', file: 'studio_small_08.hdr', source: 'https://polyhaven.com/a/studio_small_08' },
  dark_studio: { name: 'Dark studio', file: '', source: '' },
  warehouse: { name: 'Warehouse', file: 'empty_warehouse_01.hdr', source: 'https://polyhaven.com/a/empty_warehouse_01' },
  outdoor: { name: 'Outdoor', file: 'kloofendal_48d_partly_cloudy.hdr', source: 'https://polyhaven.com/a/kloofendal_48d_partly_cloudy' },
} as const;

/** Image output is a per-browser preference, not model data. */
export const IMAGE_SIZES = {
  viewport: { label: 'Viewport', width: 0, height: 0 },
  hd: { label: 'HD 16:9', width: 1920, height: 1080 },
  qhd: { label: '2.5K 16:9', width: 2560, height: 1440 },
  uhd: { label: '4K 16:9', width: 3840, height: 2160 },
  square: { label: 'Square', width: 2048, height: 2048 },
  portrait: { label: 'Portrait 4:5', width: 1600, height: 2000 },
} as const;
export type ImageSize = keyof typeof IMAGE_SIZES;
/** Guided denoising reaches a clean image with fewer rays. Raw output keeps the larger sample budgets. */
export const IMAGE_QUALITIES = {
  draft: { label: 'Draft', samples: 24, rawSamples: 48, bounces: 4 },
  standard: { label: 'Standard', samples: 64, rawSamples: 160, bounces: 6 },
  high: { label: 'High', samples: 160, rawSamples: 512, bounces: 8 },
} as const;
export type ImageQuality = keyof typeof IMAGE_QUALITIES;
export interface ImageOutput { size: ImageSize; quality: ImageQuality; denoise: boolean }
export function imageQuality(output: Pick<ImageOutput, 'quality' | 'denoise'>) {
  const quality = IMAGE_QUALITIES[output.quality];
  return { ...quality, samples: output.denoise ? quality.samples : quality.rawSamples };
}
export const DEFAULT_IMAGE_OUTPUT: ImageOutput = { size: 'hd', quality: 'standard', denoise: true };
/** Largest long edge for a viewport-sized image, matching the largest preset. */
export const MAX_IMAGE_EDGE = 3840;

/** Pixel size of an image. Viewport images follow the canvas at up to 2x density. */
export function imagePixels(output: ImageOutput, viewport: { width: number; height: number }, density = 1) {
  const preset = IMAGE_SIZES[output.size];
  if (preset.width) return { width: preset.width, height: preset.height };
  const w = Math.max(1, viewport.width), h = Math.max(1, viewport.height);
  const scale = Math.min(Math.max(1, Math.min(density, 2)), MAX_IMAGE_EDGE / Math.max(w, h));
  return { width: Math.max(16, Math.round(w * scale)), height: Math.max(16, Math.round(h * scale)) };
}

/** The largest centered rectangle of the image's aspect inside the viewport, in viewport pixels. */
export function imageFrame(viewport: { width: number; height: number }, image: { width: number; height: number }) {
  const W = Math.max(1, viewport.width), H = Math.max(1, viewport.height), aspect = image.width / image.height;
  const width = W / H > aspect ? H * aspect : W, height = W / H > aspect ? H : W / aspect;
  return { x: (W - width) / 2, y: (H - height) / 2, width, height };
}
