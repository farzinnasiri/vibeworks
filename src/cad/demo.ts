import type { CadCommand, CadDocument, CadResult, Edit, Feature, Parameter } from '../shared/protocol';
import type { CadRuntime } from './runtime';

export const context = (doc: CadDocument) => ({ documentId: doc.documentId, expectedRevision: doc.revision });

/** Design values for the acceptance plate. Changing one re-resolves every bound field. */
export function demoParameters(): Parameter[] {
  return [
    { name: 'width', value: 100, description: 'Plate length along X' },
    { name: 'depth', value: 60, description: 'Plate length along Y' },
    { name: 'thickness', value: 5, description: 'Plate thickness along Z' },
    { name: 'corner_r', value: 3, description: 'Plan-view corner radius' },
    { name: 'hole_d', value: 5, description: 'Through-hole diameter' },
    { name: 'hole_inset', value: 10, description: 'Hole center distance from the nearest edges' },
  ];
}

/** The acceptance plate: 100 x 60 x 5, R3 corners, four Ø5 through holes 10 mm from the edges, all driven by parameters. */
export function demoFeatures(): Feature[] {
  const corners = [['hole_inset', 'hole_inset'], ['width - hole_inset', 'hole_inset'], ['hole_inset', 'depth - hole_inset'], ['width - hole_inset', 'depth - hole_inset']] as const;
  const values = [[10, 10], [90, 10], [10, 50], [90, 50]] as const;
  return [
    { id: 'plate', label: 'Plate', kind: 'box', params: { origin: [0, 0, 0], size: [100, 60, 5] }, bindings: { 'size.0': 'width', 'size.1': 'depth', 'size.2': 'thickness' } },
    { id: 'rounded_plate', label: 'Corner rounds', kind: 'fillet', params: { target: 'plate', radius: 3, edges: 'vertical' }, bindings: { radius: 'corner_r' } },
    ...values.map(([x, y], index): Feature => ({
      id: `hole_${index + 1}`, label: `Hole ${index + 1} cutter`, kind: 'cylinder', params: { origin: [x, y, -10], radius: 2.5, height: 25 },
      // Cutters always pass through the plate, whatever its thickness.
      bindings: { 'origin.0': corners[index][0], 'origin.1': corners[index][1], radius: 'hole_d / 2', height: 'thickness + 20' },
    })),
    { id: 'finished_plate', label: 'Mounting plate', kind: 'subtract', params: { target: 'rounded_plate', tools: ['hole_1', 'hole_2', 'hole_3', 'hole_4'] } },
  ];
}

/** One atomic edit replaces the document content with the demo plate: one revision, one undo step. */
export function demoCommand(doc: CadDocument): Extract<CadCommand, { type: 'apply_edits' }> {
  const existing = doc.features.map(feature => feature.id);
  const edits: Edit[] = [
    ...(existing.length ? [{ op: 'delete' as const, featureIds: existing, cascade: true }] : []),
    ...(doc.parameters ?? []).map(p => ({ op: 'delete_parameter' as const, name: p.name })),
    ...demoParameters().map(p => ({ op: 'set_parameter' as const, ...p })),
    ...demoFeatures().map(feature => ({ op: 'add' as const, feature })),
  ];
  return { type: 'apply_edits', params: { ...context(doc), edits, select: ['finished_plate'] } };
}

/** Uses the revision the caller observed, so an interleaved edit makes the demo fail instead of overwriting it. */
export async function buildDemo(runtime: CadRuntime, document = runtime.getSnapshot().document): Promise<CadResult> {
  const result = await runtime.execute(demoCommand(document));
  if (result.status === 'error') throw new Error(result.error!.message);
  return result;
}
