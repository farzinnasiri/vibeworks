import { hydrateGraphics } from '../shared/graphic-assets';
import type { CadDocument } from '../shared/protocol';
import { materialById } from '../shared/materials';
import { effectiveAppearance } from './document';
import type { Evaluation } from './types';

/** Appearance can change density, but never the exact shape or declared geometric checks. */
export function appearanceOnly(before: CadDocument, after: CadDocument): boolean {
  if(before.features.some(f=>f.surfaceStyles?.length||f.paintRegions?.length)||after.features.some(f=>f.surfaceStyles?.length||f.paintRegions?.length))return false;
  const shape = (document: CadDocument) => ({ ...document, presentation: undefined, revision: 0, selectedFeatureIds: [],
    features: document.features.map(({ appearance: _appearance, ...feature }) => feature) });
  return JSON.stringify(shape(before)) === JSON.stringify(shape(after));
}

/** Plain parts have one effective appearance per result. Instances retain per-piece source metadata in the worker. */
export function restylePart(document: CadDocument, evaluation: Evaluation, previousRevision: number): Evaluation {
  return { ...evaluation,
    geometry: evaluation.geometry.map(info => {
      const { appearance: _appearance, material: _material, massG: _mass, ...shape } = info;
      const appearance = effectiveAppearance(document, info.featureId);
      const material = materialById(appearance?.material);
      return { ...shape, appearanceComplete: !!(appearance?.material || appearance?.color), ...(appearance ? { appearance } : {}),
        ...(material ? { material: material.id, massG: info.volumeMm3 * material.densityGcm3 / 1000 } : {}) };
    }),
    meshes: evaluation.meshes.map(mesh => ({ ...mesh, appearance: hydrateGraphics(effectiveAppearance(document, mesh.featureId),document) })),
    analysis: evaluation.analysis ? { ...evaluation.analysis, revision: evaluation.analysis.revision === previousRevision ? document.revision : evaluation.analysis.revision } : undefined,
    stats: undefined,
  };
}
