import { CadError } from './document';
import type { Feature, TopologyTable } from '../shared/protocol';
export function resolveFaces(table: TopologyTable, target: NonNullable<Feature['surfaceStyles']>[number]['target']): number[] {
  if ('all' in target.select) return table.faces.map((_, i) => i);
  const selected: number[] = [];

  for (const name of target.select.faces) {
    const candidates = table.faces.flatMap((face, index) => face.lineage.includes(name) ? [{ ...face, index }] : []);
    const details = {
      reference: target,
      candidates: (candidates.length ? candidates : table.faces.map((face, index) => ({ ...face, index }))).slice(0, 8),
    };
    if (!candidates.length) {
      throw new CadError(
        table.faces.every(face => !face.lineage.length) ? 'REFERENCE_UNSUPPORTED' : 'REFERENCE_MISSING',
        `Surface '${name}' is unavailable. Select a supported candidate explicitly.`,
        details,
      );
    }
    if (candidates.length > 1 && target.select.fragments === 'one') {
      throw new CadError('REFERENCE_AMBIGUOUS', `Surface '${name}' has ${candidates.length} fragments.`, details);
    }

    const signature = target.signature;
    if (signature && signature.surface !== 'PLANE' && !signature.shapeSamples) {
      throw new CadError(
        'REFERENCE_SIGNATURE_REQUIRED',
        'Curved references require exact support samples from inspect_model. Inspect and explicitly repair this older reference.',
        details,
      );
    }
    if (signature?.shapeSamples && candidates.length > 1) {
      throw new CadError(
        'REFERENCE_CHANGED',
        'The curved support split into fragments. Inspect and explicitly repair the support rather than redirecting its region.',
        details,
      );
    }
    if (signature?.shapeSamples && candidates.length === 1 && candidates[0].shapeSamples) {
      const points = candidates[0].shapeSamples;
      const extent = Math.max(0.1, Math.sqrt(signature.areaMm2) * 0.05);
      if (points.some((point, i) => Math.hypot(...point.map((value, k) => value - signature.shapeSamples![i][k])) > extent)) {
        throw new CadError(
          'REFERENCE_CHANGED',
          'The exact support samples changed beyond the captured shape tolerance. Inspect and explicitly repair.',
          details,
        );
      }
    }
    if (signature && (
      Math.abs(candidates.reduce((area, face) => area + face.areaMm2, 0) - signature.areaMm2) > signature.areaMm2 * 0.5 ||
      candidates.some(face => face.surface !== signature.surface ||
        signature.normal && face.normal && face.normal.reduce((dot, value, i) => dot + value * signature.normal![i], 0) < 0.95)
    )) {
      throw new CadError(
        'REFERENCE_CHANGED',
        'The surface type, area or direction changed beyond the captured reference policy. Inspect and explicitly repair the reference.',
        details,
      );
    }
    selected.push(...candidates.map(face => face.index));
  }
  return [...new Set(selected)];
}
