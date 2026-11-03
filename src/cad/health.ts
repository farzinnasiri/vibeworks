import { countLabel } from '../shared/format';
import { isTargetCheck, type AnalysisReport, type CadDocument, type ModelHealth } from '../shared/protocol';
import { effectiveAppearance } from './document';
import type { Evaluation, GeometryAnalysis } from './types';

/** Display triangles stay in the worker/browser path, never in agent JSON receipts. */
export function publicAnalysis(report: GeometryAnalysis): AnalysisReport {
  const { interferenceMeshes: _meshes, ...facts } = report;
  return facts;
}

export function modelHealth(document: CadDocument, evaluation: Evaluation, checkedRevision: number | null): ModelHealth {
  const report = evaluation.analysis;
  const current = !evaluation.referenceError && report?.revision === document.revision && report.scope === 'document';
  const complete = current && report.coverage?.connectivity !== 'pending' && !report.skipped && !report.unknownPairs?.length && (!report.coverage || report.coverage.completedPairs===report.coverage.totalPairs && report.coverage.completedChecks===report.coverage.totalChecks) && report.checks.every(c=>c.ok!==null);
  const issues: ModelHealth['issues'] = {
    floating: complete ? report.floating.filter(f => !f.intendedBy?.length).map(f => f.featureId) : [],
    interferences: current ? report.interferences.filter(i => !i.intendedBy).map(({ a, b }) => ({ a, b })) : [],
    failedChecks: current ? report.checks.filter(c => c.ok===false).map(c => c.id) : [],
    partsWithoutAppearance: evaluation.visibleFeatureIds.filter(id => {
      if(evaluation.geometry.find(g=>g.featureId===id)?.resultKind==='sheet')return false;
      const complete = evaluation.geometry.find(info => info.featureId === id)?.appearanceComplete;
      if (complete !== undefined) return !complete;
      const meshes = evaluation.meshes.filter(mesh => mesh.featureId === id);
      const appearance = effectiveAppearance(document, id);
      return meshes.length ? meshes.some(mesh => !(mesh.appearance ?? appearance)?.material && !(mesh.appearance ?? appearance)?.color) : !appearance?.material && !appearance?.color;
    }),
  };
  const checked = complete ? document.revision : checkedRevision;
  const constructionSheets=evaluation.geometry.filter(g=>g.resultKind==='sheet'&&evaluation.visibleFeatureIds.includes(g.featureId)).map(g=>g.featureId);
  return {constructionSheets,
    validity:{valid:evaluation.geometry.every(g=>g.valid)&&(report?.leaves?.every(l=>l.valid)??true),leafBodies:report?.parts??0},fit:{complete:!!complete,unknown:report?.unknownPairs?.length??0},checks:{complete:!!complete,pending:report?.checks.filter(c=>c.ok===null).length??0},review:{humanApproved:false},
    ...(evaluation.references ? { references: evaluation.references } : {}),
    ...(evaluation.referencesChanged ? { referencesChanged: true } : {}),
    ...(evaluation.referenceError ? { referenceError: evaluation.referenceError,...(evaluation.referenceError.startsWith('Surface reference: ')?{appearance:{staleReferences:1}}:{}) } : {}),
    checkedRevision: checked, uncheckedChanges: document.revision - (checked ?? 0),
    analysis: complete ? 'current' : current ? 'incomplete' : 'unchecked',
    autoAnalysis: document.analysis?.auto ?? true,
    floating: complete ? issues.floating.length : null,
    pendingChecks:current?report.checks.filter(c=>c.ok===null).length:null,
    interferences: current ? issues.interferences.length : null,
    failedChecks: current ? issues.failedChecks.length : null,
    partsWithoutAppearance: issues.partsWithoutAppearance.length,
    ok: !constructionSheets.length && !!complete && evaluation.geometry.every(g=>g.valid) && (report?.leaves?.every(l=>l.valid)??true) && Object.values(issues).every(list => list.length === 0), issues,
  };
}

export function analysisStatus(health: ModelHealth): string {
  if (health.referenceError) return 'Assembly references need repair';
  if (health.analysis === 'current') return `Checked r${health.checkedRevision}${health.referencesChanged ? ' · new part revisions' : ''}`;
  return `${health.analysis === 'incomplete' ? 'Incomplete · ' : ''}${health.checkedRevision === null ? 'Not checked yet' : `Not checked since r${health.checkedRevision}`} (${countLabel(health.uncheckedChanges, 'change')})`;
}

/** A zero distance is not contact when OCCT found a common volume. */
export function floatingOverlap(floating: AnalysisReport['floating'][number], report: AnalysisReport): boolean {
  return !!floating.nearest && report.interferences.some(i =>
    (i.a === floating.featureId && i.b === floating.nearest) || (i.b === floating.featureId && i.a === floating.nearest));
}

export function floatingDescription(floating: AnalysisReport['floating'][number], report: AnalysisReport, name: (id: string) => string = id => id): string {
  if (!floating.nearest) return 'not connected through contact';
  if (floatingOverlap(floating, report)) return `passes through '${name(floating.nearest)}' (overlap, not contact)`;
  return `${floating.gapMm ?? 0} mm from '${name(floating.nearest)}'`;
}

export function floatingAdvice(report: AnalysisReport): string {
  return report.floating.some(f => !f.intendedBy?.length && floatingOverlap(f, report))
    ? 'For an overlap, union it if it is one physical part, make it touch without overlap, or declare an overlap check with a note. For an intended gap, declare a clearance check with a note.'
    : 'Move into contact, or declare a clearance check with a note if the gap is intended.';
}

/** Count each repeated length once per feature; exclude coordinates, angles and copy counts. */
function repeatedDimension(document: CadDocument): { value: number; ids: string[] } | undefined {
  if (document.parameters?.length) return;
  const values = new Map<number, string[]>();
  const lengthPaths = /^(size\.[012]|radius|height|diameter|distance|depth|profile\.(width|height|radius)|layout\.spacing)$/;
  for (const feature of document.features) {
    const lengths = new Set<number>();
    const visit = (node: unknown, path = '') => {
      if (typeof node === 'number' && node > 0 && lengthPaths.test(path) && !feature.bindings?.[path]) lengths.add(node);
      else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) visit(value, path ? `${path}.${key}` : key);
    };
    visit(feature.params);
    for (const value of lengths) values.set(value, [...(values.get(value) ?? []), feature.id]);
  }
  return [...values].filter(([, ids]) => ids.length >= 3)
    .sort(([a, aa], [b, bb]) => bb.length - aa.length || a - b)
    .map(([value, ids]) => ({ value, ids }))[0];
}

export function healthHints(health: ModelHealth, report?: AnalysisReport, document?: CadDocument): string[] {
  const hints: string[] = [];
  if(health.constructionSheets?.length)hints.push(`Unconsumed construction sheets: ${health.constructionSheets.join(', ')}. These are displayable helpers, not physical solids.`);
  if (health.referenceError) hints.push(health.referenceError + '. Repair the instance reference, then run analyze_model.');
  else if (health.referencesChanged) hints.push('Assembly re-evaluated against new part revisions; see health.references. The assembly revision is unchanged.');
  if (health.autoAnalysis === false) hints.push(`Analysis is off: ${analysisStatus(health)}. Later edits can leave gaps and collisions unchecked. Use set_analysis auto:true; ${health.analysis === 'current' ? 'keep checking after edits.' : 'run whole-document analyze_model before finishing.'}`);
  else if (health.analysis !== 'current') hints.push(`${analysisStatus(health)}. Run analyze_model for the whole document; a subset cannot certify completion.`);
  if(health.pendingChecks)hints.push(`${health.pendingChecks} checks are pending. Call analyze_model again to continue exact analysis; do not change geometry to repair unevaluated checks.`);
  if (health.failedChecks) hints.push(`Fix ${countLabel(health.failedChecks, 'failed check')}: ${health.issues.failedChecks.slice(0, 3).join(', ')}. Read analyze_model checks for the measured gaps, volumes or sizes.`);
  if (health.interferences) {
    const pair = health.issues.interferences[0];
    hints.push(`${countLabel(health.interferences, 'unintended overlap')}${pair ? `, including '${pair.a}' / '${pair.b}'` : ''}: union if these form one physical part; otherwise reposition or declare a justified overlap check with a note.`);
  }
  if (health.floating) hints.push(`${countLabel(health.floating, 'part')} unconnected to '${report?.ground ?? 'ground'}'${report ? ': ' + report.floating.filter(f => !f.intendedBy?.length).slice(0, 3).map(f => `${f.featureId} ${floatingDescription(f, report)}`).join('; ') : ''}. ${report ? floatingAdvice(report) : 'Set ground or connect them; declare intent only for a justified overlap or gap.'}`);
  if (health.partsWithoutAppearance) hints.push(`Assign appearance.material or appearance.color now to ${countLabel(health.partsWithoutAppearance, 'visible result')}: ${health.issues.partsWithoutAppearance.slice(0, 3).join(', ')}. Base-part appearance is inherited.`);
  // Green health proves physical validity, not the intended shape; the moment it turns green is when targets matter.
  if (health.ok && document?.features.length && !document.analysis?.checks?.some(isTargetCheck))
    hints.push('Physically valid, but no design targets are declared. Add set_check size, within or section targets for the dimensions your brief or references fix (overall size, key sections), so analysis confirms the shape.');
  const repeated = document && repeatedDimension(document);
  if (repeated) hints.push(`No parameters; ${repeated.value} mm repeats in ${repeated.ids.length} features (${repeated.ids.slice(0, 3).join(', ')}). If it is a shared design dimension, use set_parameter and bindings.`);
  return hints.slice(0, 5);
}
