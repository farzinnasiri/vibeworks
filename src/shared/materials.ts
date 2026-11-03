/**
 * Engineering materials with a believable look and a real density. Density turns exact volume into mass;
 * the look drives the viewport, renders and colored exports. Values are typical, not certified.
 */
export interface Material {
  id: string; name: string; category: 'Metal' | 'Plastic' | 'Elastomer' | 'Composite' | 'Other';
  /** Base color, sRGB hex. */
  color: string;
  metalness: number; roughness: number;
  /** Lacquer or gloss coat, 0–1. */
  clearcoat?: number;
  /** Light passing through (glass, clear plastics), 0–1. */
  transmission?: number;
  densityGcm3: number;
  /** Default visible surface, shared by preview, Studio and material exports. */
  detail?: SurfaceDetail;
}

/** Neutral unstyled body, also used when an exporter requires an explicit color. */
export const NEUTRAL_COLOR = '#c4cbd1';

export const MATERIALS = [
  { id: 'steel', name: 'Steel', category: 'Metal', color: '#7c8792', metalness: 1, roughness: 0.46, densityGcm3: 7.85 },
  { id: 'stainless_steel', name: 'Stainless steel', category: 'Metal', color: '#c3c8cc', metalness: 1, roughness: 0.22, densityGcm3: 8.0 },
  { id: 'aluminum', name: 'Aluminium 6061', category: 'Metal', color: '#d9dcdf', metalness: 1, roughness: 0.27, densityGcm3: 2.7 },
  { id: 'anodized_black', name: 'Anodised aluminium, black', category: 'Metal', color: '#2a2c30', metalness: 0.85, roughness: 0.42, densityGcm3: 2.7 },
  { id: 'anodized_blue', name: 'Anodised aluminium, blue', category: 'Metal', color: '#2f5fa8', metalness: 0.85, roughness: 0.4, densityGcm3: 2.7 },
  { id: 'anodized_red', name: 'Anodised aluminium, red', category: 'Metal', color: '#b3262e', metalness: 0.85, roughness: 0.4, densityGcm3: 2.7 },
  { id: 'titanium', name: 'Titanium Ti-6Al-4V', category: 'Metal', color: '#a7a39b', metalness: 1, roughness: 0.4, densityGcm3: 4.43 },
  { id: 'brass', name: 'Brass', category: 'Metal', color: '#c9a65a', metalness: 1, roughness: 0.28, densityGcm3: 8.5 },
  { id: 'copper', name: 'Copper', category: 'Metal', color: '#c27a52', metalness: 1, roughness: 0.3, densityGcm3: 8.96 },
  { id: 'cast_iron', name: 'Cast iron', category: 'Metal', color: '#5d6064', metalness: 0.9, roughness: 0.75, densityGcm3: 7.2 },
  { id: 'chrome', name: 'Chrome plated', category: 'Metal', color: '#eef1f3', metalness: 1, roughness: 0.05, densityGcm3: 7.85 },
  { id: 'gold', name: 'Gold plated', category: 'Metal', color: '#e0b84c', metalness: 1, roughness: 0.18, densityGcm3: 7.85 },
  { id: 'abs', name: 'ABS', category: 'Plastic', color: '#e9e7e2', metalness: 0, roughness: 0.55, densityGcm3: 1.04 },
  { id: 'pla', name: 'PLA', category: 'Plastic', color: '#f2f0ea', metalness: 0, roughness: 0.45, densityGcm3: 1.24 },
  { id: 'petg', name: 'PETG', category: 'Plastic', color: '#dfe7ea', metalness: 0, roughness: 0.3, clearcoat: 0.3, densityGcm3: 1.27 },
  { id: 'nylon', name: 'Nylon PA12', category: 'Plastic', color: '#d9d6cf', metalness: 0, roughness: 0.7, densityGcm3: 1.01 },
  { id: 'pom', name: 'Acetal (POM)', category: 'Plastic', color: '#f4f3ef', metalness: 0, roughness: 0.35, densityGcm3: 1.41 },
  { id: 'polycarbonate', name: 'Polycarbonate, clear', category: 'Plastic', color: '#eef4f7', metalness: 0, roughness: 0.05, transmission: 0.85, densityGcm3: 1.2 },
  { id: 'acrylic', name: 'Acrylic (PMMA), clear', category: 'Plastic', color: '#f3f8fa', metalness: 0, roughness: 0.02, transmission: 0.9, densityGcm3: 1.18 },
  { id: 'tpu', name: 'TPU', category: 'Elastomer', color: '#2b2b2d', metalness: 0, roughness: 0.9, densityGcm3: 1.21, detail: 'rubber' },
  // Representative filled SBR, not a certified tire compound. Actual rubber density varies with formulation.
  { id: 'rubber', name: 'Rubber, black (SBR)', category: 'Elastomer', color: '#242628', metalness: 0, roughness: 0.86, clearcoat: 0, densityGcm3: 1.35, detail: 'rubber' },
  { id: 'epoxy', name: 'Epoxy resin', category: 'Plastic', color: '#c99a4a', metalness: 0, roughness: 0.12, clearcoat: 1, transmission: 0.35, densityGcm3: 1.15 },
  { id: 'carbon_fiber', name: 'Carbon fibre', category: 'Composite', color: '#1f2124', metalness: 0, roughness: 0.35, clearcoat: 1, densityGcm3: 1.55, detail: 'carbon' },
  { id: 'fiberglass', name: 'Glass fibre (G10)', category: 'Composite', color: '#cfd8b6', metalness: 0, roughness: 0.4, clearcoat: 0.4, densityGcm3: 1.85 },
  { id: 'glass', name: 'Glass', category: 'Other', color: '#e8f2f4', metalness: 0, roughness: 0.02, transmission: 0.95, densityGcm3: 2.5 },
  { id: 'oak', name: 'Oak', category: 'Other', color: '#a77b4f', metalness: 0, roughness: 0.65, densityGcm3: 0.75, detail: 'wood' },
  { id: 'ceramic', name: 'Ceramic (alumina)', category: 'Other', color: '#f6f4ee', metalness: 0, roughness: 0.25, clearcoat: 0.5, densityGcm3: 3.9 },
] as const satisfies readonly Material[];

export type MaterialId = typeof MATERIALS[number]['id'];
export const MATERIAL_IDS = MATERIALS.map(m => m.id) as [MaterialId, ...MaterialId[]];
export const FINISHES = ['matte', 'satin', 'gloss', 'mirror'] as const;
export type Finish = typeof FINISHES[number];
export const materialById = (id: string | undefined): Material | undefined => MATERIALS.find(m => m.id === id);

/** A finish changes roughness. A polished bare metal does not acquire a lacquer. */
export function finishLook(finish: Finish | undefined): { roughness?: number } {
  return finish ? { roughness: FINISH_ROUGHNESS[finish] } : {};
}

/** Repeating surface texture, independent of material and finish. */
export const SURFACE_DETAILS = ['plain', 'carbon', 'rubber', 'brushed', 'wood'] as const;
export type SurfaceDetail = typeof SURFACE_DETAILS[number];
/** A clear lacquer over the base finish. */
export const COATS = ['none', 'clear'] as const;
export type Coat = typeof COATS[number];
/** Base roughness of each finish, without implying a coat. */
export const FINISH_ROUGHNESS: Record<Finish, number> = { matte: 0.85, satin: 0.45, gloss: 0.12, mirror: 0.02 };

/** Display-only floor surfaces for Studio and material renders. Legacy ids stay valid. */
export const STUDIO_FLOOR_IDS = ['matte', 'gloss', 'grid', 'concrete', 'polished_concrete', 'epoxy', 'plate', 'asphalt', 'tiles', 'wood', 'checker', 'none'] as const;
export type StudioFloor = typeof STUDIO_FLOOR_IDS[number];
