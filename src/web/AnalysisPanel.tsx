import { countLabel } from '../shared/format';
import { analysisStatus, floatingDescription, floatingOverlap } from '../cad/health';
import { useState,useEffect } from 'react';
import type {AnalysisJob,CadResult} from '../shared/protocol';
import type { RuntimeClient, RuntimeState } from '../cad/runtime';
import { context } from '../cad/demo';
import { Icon } from './icons';
import { featureName, fmt } from './modeling';
import { track } from './activity';

/** Parts the last analysis flagged, for the viewport's warning outline. */
export function flaggedParts(state: RuntimeState): string[] {
  const report = state.evaluation.analysis;
  if (!report) return [];
  const root=(id:string)=>report.leaves?.find(l=>l.id===id)?.feature??id;
  return [...new Set([...(report.skipped?[]:report.floating).filter(f => !f.intendedBy?.length).map(f => f.featureId), ...report.interferences.filter(i => !i.intendedBy).flatMap(i => [i.a, i.b])].map(root))];
}

/**
 * Physical relationships between visible parts: what floats, what interpenetrates and which declared checks fail.
 * The same findings agents receive; the toggle is the document's shared setting.
 */
export function AnalysisPanel({ runtime, state, disabled, onSelect, geometry }: { runtime: RuntimeClient; state: RuntimeState; disabled: boolean; onSelect: (ids: string[]) => void; geometry?: { tone: 'valid' | 'pending' | 'invalid'; text: string } }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const doc = state.document;
  const [jobResult,setJobResult]=useState<CadResult>();
  const [job,setJob]=useState<AnalysisJob>();
  useEffect(()=>{let closed=false;setJob(undefined);setJobResult(undefined);void runtime.execute({type:'analyze_model',params:{documentId:doc.documentId,action:'status'}}).then(result=>{if(!closed&&result.status==='success'){setJob(result.analysisJob);setJobResult(result);}});return()=>{closed=true;};},[doc.documentId,doc.revision,state.storageVersion,JSON.stringify(state.evaluation.references)]);
  useEffect(()=>{if(!job||!['queued','running'].includes(job.state))return;let closed=false;const timer=setInterval(()=>{void runtime.execute({type:'analyze_model',params:{documentId:doc.documentId,jobId:job.id,action:'status'}}).then((result)=>{if(!closed&&result.status==='success'){setJob(result.analysisJob);setJobResult(result);}});},500);return()=>{closed=true;clearInterval(timer);};},[job?.id,job?.state,doc.documentId]);
  const report = jobResult?.analysis ?? state.evaluation.analysis;
  const auto = doc.analysis?.auto ?? true;
  const name = (id: string) => featureName(doc.features.find(f => f.id === id)) || id;
  const chip = (id: string) => <button key={id} type="button" className="ref-chip" disabled={disabled} onClick={() => onSelect([report?.leaves?.find(l=>l.id===id)?.feature??id])}>{report?.leaves?.find(l=>l.id===id)?`${name(report.leaves.find(l=>l.id===id)!.feature)} / ${report.leaves.find(l=>l.id===id)!.path.join('/')} / solid ${report.leaves.find(l=>l.id===id)!.solidIndex+1}`:name(id)}</button>;
  const run = async () => {
    setRunning(true);
    setError('');
    try { const result = await track('analyze_model', () => runtime.execute({ type: 'analyze_model', params: {documentId:doc.documentId,action:'run'} })); if (result.status === 'error') setError(result.error!.message);else{setJob(result.analysisJob);setJobResult(result);} } catch (error) { setError(String(error)); }
    finally { setRunning(false); }
  };
  const more=async()=>{
    if(!job?.nextCursor)return;
    const result=await runtime.execute({type:'analyze_model',params:{jobId:job.id,action:'result',page:{cursor:job.nextCursor,limit:1000}}});
    if(result.status==='error'){setError(result.error!.message);return;}
    setJob(result.analysisJob);setJobResult(prior=>{
      if(!prior?.analysis||!result.analysis)return result;
      const analysis={...result.analysis};
      for(const key of ['leaves','checks','unknownPairs','contacts','interferences','floating']as const)(analysis[key]as unknown[])=[...(prior.analysis[key]??[]),...(result.analysis[key]??[])];
      return {...result,analysis};
    });
  };
  const toggle = () => void track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(doc), edits: [{ op: 'set_analysis', auto: !auto }], analyze: false } }));
  const failed = report?.checks.filter(c => c.ok===false) ?? [];
  // Declared intent (a running fit, a jaw gap) is not a problem; it is listed apart from findings.
  const floating = report && !report.skipped ? report.floating.filter(f => !f.intendedBy?.length) : [];
  const interferences = report ? report.interferences.filter(i => !i.intendedBy) : [];
  const intended = report ? [
    ...(report.skipped ? [] : report.floating.filter(f => f.intendedBy?.length).map(f => ({ key: f.featureId, chips: [f.featureId], note: `${f.intendedBy!.join(', ')}${f.nearest ? ` · ${floatingDescription(f, report, name)}` : ''}` }))),
    ...report.interferences.filter(i => i.intendedBy).map(i => ({ key: `${i.a}|${i.b}`, chips: [i.a, i.b], note: `${i.intendedBy} · ${fmt(i.overlapMm3, 1)} mm³ overlap` })),
  ] : [];
  const health = jobResult?.health ?? state.health;
  const problems = (health.floating ?? 0) + (health.interferences ?? 0) + (health.failedChecks ?? 0) + (health.partsWithoutAppearance ?? 0);
  const severe = (health.interferences ?? 0) + (health.failedChecks ?? 0) > 0 || !!health.referenceError;
  const tone = health.analysis !== 'current' ? (problems ? 'warn' : 'unknown') : severe ? 'invalid' : problems ? 'warn' : 'valid';
  const coverage = report?.coverage;
  const status = health.analysis === 'current' ? problems ? `${problems} to review` : 'Checked'
    : health.analysis === 'incomplete' ? 'Incomplete' : 'Not checked';
  return <section id="physical-analysis" tabIndex={-1} className="analysis-panel" aria-label="Model health">
    <h3 className="section-title">Design checks</h3>
    <div className="health-summary" role="status">
      {geometry && <div className={`health-state ${geometry.tone}`} title={geometry.text}><Icon name={geometry.tone === 'valid' ? 'check' : geometry.tone === 'pending' ? 'rotate' : 'warning'} size={16} /><span>Geometry<small>{geometry.text}</small></span></div>}
      <div className={`health-state ${tone}`} title={analysisStatus(health)}><Icon name={tone === 'valid' ? 'check' : tone === 'unknown' ? 'help' : 'warning'} size={16} /><span>Physical checks<small>{status}{health.analysis === 'current' ? ` · r${health.checkedRevision}` : ''}</small></span></div>
    </div>
    {health.analysis === 'incomplete' && coverage && <div className="coverage-readout"><progress value={coverage.completedPairs} max={Math.max(coverage.totalPairs, 1)} aria-label="Evaluated part relationships" /><span>{coverage.completedPairs}/{coverage.totalPairs} pairs</span></div>}
    {health.analysis!=='current'&&<p className="field-hint checks-explanation">{!doc.features.length?'Add geometry to run physical checks.':health.analysis==='incomplete'?'The background job continues automatically. You can cancel it below.':'Run checks for contacts, overlaps and your design targets.'}</p>}
    {job&&<div role="status" className="coverage-readout"><progress value={job.progress.done} max={Math.max(1,job.progress.candidatePairs)} aria-label="Leaf pair progress"/><span>{job.current?'Current design':'Historical design'} · {report?.scope??'document'} · {job.state} · {job.progress.leafBodies} leaf solids · {job.progress.done}/{job.progress.candidatePairs} pairs · {job.progress.unknown} unknown</span></div>}
    {job&&!job.current&&<p className="field-error">These findings belong to an older source graph. Run checks on the current design.</p>}
    {job?.error&&<p className="field-error" role="alert">{job.error}</p>}
    {job&&['queued','running'].includes(job.state)&&<button className="ghost-button small" onClick={()=>void runtime.execute({type:'analyze_model',params:{jobId:job.id,action:'cancel'}}).then(r=>{setJob(r.analysisJob);setJobResult(r);})}>Cancel checks</button>}
    {!!job?.expensive.length&&<details><summary>Expensive pairs · {job.expensive.length}</summary>{job.expensive.map(p=><p key={p.key}>{p.a} / {p.b} · {p.attempts} attempts · {Math.round(p.elapsedMs)} ms · {p.error}</p>)}</details>}
    <div className="analysis-actions">
      <label className="check-row" title="Check physical relationships after each committed change"><input type="checkbox" checked={auto} disabled={disabled} onChange={toggle} /><span>Auto-check</span></label>
      <button type="button" className="ghost-button small" disabled={disabled || running || !!job&&['queued','running'].includes(job.state) || !doc.features.length} onClick={() => void run()}>{running ? 'Checking…' : health.analysis === 'incomplete' ? job?.state==='cancelled'?'Resume checks':'Run checks' : health.analysis === 'current' ? 'Recheck' : 'Run checks'}</button>
    </div>
    {job?.nextCursor&&<button className="ghost-button small" onClick={()=>void more()}>More findings</button>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <details className="health-details method">
      <summary>Findings{problems ? ` · ${problems}` : ''}{health.pendingChecks ? ` · ${health.pendingChecks} pending` : ''}</summary>
      {health.analysis !== 'current' && <p className="field-hint">{health.analysis === 'incomplete' ? 'Checks are incomplete. Continue to evaluate the remaining relationships.' : 'Run physical checks to evaluate contacts, overlaps and design targets.'}</p>}
      {report && <div className="health-counts"><span>{countLabel(report.parts, 'part')}</span><span>{countLabel(report.contacts.length, 'contact')}</span></div>}
      {floating.length > 0 && <div className="finding"><span>Disconnected</span><ul>{floating.map(f => <li key={f.featureId}>{chip(f.featureId)}{f.nearest && <small className="mono-small">{floatingDescription(f, report!, name)}{floatingOverlap(f, report!) && '. Union it, make contact, or declare the intended overlap.'}</small>}</li>)}</ul></div>}
      {interferences.length > 0 && <div className="finding"><span>Overlaps</span><ul>{interferences.map(i => <li key={`${i.a}|${i.b}`}>{chip(i.a)}{chip(i.b)}<small className="mono-small">{fmt(i.overlapMm3, 1)} mm³</small></li>)}</ul></div>}
      {failed.length > 0 && <div className="finding"><span>Failed targets</span><ul>{failed.map(c => <li key={c.id}><small>{c.message}</small></li>)}</ul></div>}
      {!!health.partsWithoutAppearance && <div className="finding"><span>Missing appearance</span><ul>{health.issues.partsWithoutAppearance.map(id => <li key={id}>{chip(id)}</li>)}</ul></div>}
      {intended.length > 0 && <details className="method intended"><summary>Intended relationships · {intended.length}</summary><ul>{intended.map(item => <li key={item.key}>{item.chips.map(chip)}<small>{item.note}</small></li>)}</ul></details>}
      {health.analysis === 'current' && !problems && <p className="field-hint">No issues in the checked relationships.</p>}
      <details className="method"><summary>Analysis details</summary>
        <p className="field-hint">{analysisStatus(health)}</p>
        {coverage && <p className="field-hint">{coverage.completedPairs}/{coverage.totalPairs} pairs · {coverage.completedChecks}/{coverage.totalChecks} targets · Connectivity {coverage.connectivity ?? 'unknown'}</p>}
        {report?.skipped && <p className="field-hint">{report.skipped}</p>}
        {report && <p className="field-hint">Exact distances and overlap volumes · {(report.durationMs / 1000).toFixed(1)} s. Red marks show overlap; pink marks show disconnected parts.</p>}
      </details>
    </details>
  </section>;
}
