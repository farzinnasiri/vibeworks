import { LIMITS, unknownHealth, commandError, type CadCommand, type CadDocument, type CadResult, type GeometryInfo } from '../shared/protocol.ts';
import { references } from '../cad/document.ts';
import { saveArtifact } from './artifacts.ts';
import { decodeBase64 } from './validation.ts';
import { rm } from 'node:fs/promises';

const SAFE_BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;

export interface Delivery {
  /** What the agent reads: a compact receipt, or the full detail for inspect_model and errors. */
  result: Record<string, unknown>;
  isError: boolean;
  /** Verified PNG for render_views, also saved beneath artifacts/ (see result.image.path). */
  png?: string;
  pngs?: string[];
  /** Saved export for export_model, still base64 for adapters that embed it. */
  resource?: { uri: string; mimeType: string; blob: string };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const summarize = (g: GeometryInfo) => ({ featureId: g.featureId, valid: g.valid, solids: g.solidCount, volumeMm3: round(g.volumeMm3), size: g.bounds.size.map(round) });

/** Ids changed by an edit plus every feature that depends on them, in document order. */
function downstream(document: CadDocument, ids: string[]): Set<string> {
  const affected = new Set(ids);
  for (const feature of document.features) if (references(feature).some(id => affected.has(id))) affected.add(feature.id);
  return affected;
}

/**
 * A short, decision-ready answer for routine calls. The full document and per-feature metrics
 * stay one inspect_model call away instead of riding on every edit, render and export.
 */
export function receipt(command: CadCommand, result: CadResult): Record<string, unknown> {
  const { document, geometry = [], visibleFeatureIds = [], image: _image, artifact: _artifact, analysis, documents, projects, health = unknownHealth(), ...rest } = result;
  const changed = [...result.created, ...result.updated];
  let affected: GeometryInfo[];
  if (command.type === 'document_action' || result.dryRun || !document) affected = changed.length || result.dryRun ? geometry : [];
  else {
    const touched = downstream(document, changed);
    affected = geometry.filter(g => touched.has(g.featureId));
  }
  let scopedDocuments=documents,scopedProjects=projects;
  if(command.type==='documents'&&command.params.action!=='list'){
    const action=command.params.action;
    const projectId=result.duplication?.projectId??result.createdProjectId??command.params.projectId;
    const target=result.createdDocumentId??command.params.documentId??result.documentId;
    scopedDocuments=action==='duplicate_project'?documents?.filter(d=>d.projectId===projectId)
      : action.includes('project')||action==='set_main_assembly'?[]:documents?.filter(d=>d.documentId===target);
    const projectIds=new Set([projectId,...(scopedDocuments??[]).map(d=>d.projectId)].filter(Boolean));
    scopedProjects=projects?.filter(p=>projectIds.has(p.projectId));
    if(action.includes('project')&&action!=='duplicate_project'||action==='set_main_assembly'){
      return {operation:result.operation,status:result.status,documentId:result.documentId,revision:result.revision,
        requestId:result.requestId,createdProjectId:result.createdProjectId,created:result.created,updated:result.updated,
        warnings:result.warnings,projects:scopedProjects,documents:scopedDocuments,health:unknownHealth(),
        ...(result.timings?{timings:result.timings}:{}),...(result.authority?{authority:result.authority}:{}),
        ...(result.replayed?{replayed:true}:{})};
    }
  }
  return {
    ...rest,
    ...(command.type === 'documents' ? { documents:scopedDocuments, projects:scopedProjects } : {}),
    health: { ...health, issues: Object.fromEntries(Object.entries(health.issues).map(([key, values]) => [key, values.slice(0, 4)])) },
    ...(affected.length ? { results: affected.map(summarize) } : {}),
    ...(document ? { summary: { features: document.features.length, visibleResults: visibleFeatureIds.length, parameters: document.parameters?.length ?? 0, selected: document.selectedFeatureIds } } : {}),
    ...(analysis ? { analysis: { scope: analysis.scope, coverage: analysis.coverage, revision: analysis.revision, parts: analysis.parts, ground: analysis.ground, contacts: analysis.contacts.length, intendedOverlaps: analysis.interferences.filter(i => i.intendedBy).length, intendedFloating: analysis.floating.filter(f => f.intendedBy?.length).length, ...(analysis.skipped ? { skipped: analysis.skipped } : {}) } } : {}),
    detail: 'Compact receipt. Call inspect_model for the full document, bindings and exact metrics.',
  };
}

/**
 * Verify binary kernel/renderer outputs, write images and exports under artifacts/, and shape the answer.
 * Shared by every adapter (MCP, CLI) so they deliver identical, checked results.
 */
export async function deliver(command: CadCommand, result: CadResult): Promise<Delivery> {
  result = { ...result, health: result.health ?? unknownHealth() };
  const { image, artifact } = result;
  if (result.status === 'error') { const { image: _i, artifact: _a, ...metadata } = result; return { result: metadata, isError: true }; }
  if (command.type === 'activity' || command.type === 'agent_session'||command.type==='describe') return {result:result as unknown as Record<string,unknown>,isError:false};
  if (command.type === 'inspect_model') { const { image: _i, artifact: _a, documents: _documents, projects: _projects, ...full } = result; return { result: { ...full, limits: LIMITS }, isError: false }; }
  if (command.type === 'analyze_model') {
    const { operation, status, documentId, revision, warnings, analysisJob, analysis, health, nextSteps, instances, evaluationStats, durationMs, timings, requestId, provenance, authority, replayed, actor } = result;
    return { result: { operation, status, documentId, revision, warnings, analysisJob, analysis, health, nextSteps, instances, evaluationStats, durationMs, timings, requestId, provenance, authority, replayed, actor }, isError: false };
  }
  const output:Record<string,unknown> = {...receipt(command, result),...(result.actor?{actor:result.actor}:{}),...(result.removedChecks?{removedChecks:result.removedChecks}:{})};
  const written:string[]=[];
  try {
    if (command.type === 'render_views' || command.type === 'render_image' && command.params.action === 'result' && result.renderJob?.state === 'complete' || command.type==='apply_edits'&&image) {
      if (!image) throw new Error('Runtime returned no PNG. Inspect the model before retrying render_views.');
      const {panels=[],base64,...info}=image;
      const buffers=[image,...panels].map(asset=>{
        const bytes=decodeBase64(asset.base64);
        if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==asset.width||bytes.readUInt32BE(20)!==asset.height)
          throw new Error('Runtime image is not a PNG matching its reported dimensions.');
        return bytes;
      });
      const saved=await saveArtifact(buffers[0],`${command.type==='render_image'?'studio':'views'}-r${result.revision??'x'}.png`,'image/png');written.push(saved.path);
      const outputs:Record<string,unknown>[]=[];
      for(const [index,panel]of panels.entries()){
        const artifact=await saveArtifact(buffers[index+1],`${panel.kind}-${index+1}-r${result.revision??'x'}.png`,'image/png');written.push(artifact.path);
        const {base64:_,...metadata}=panel;outputs.push({...metadata,...artifact});
      }
      output.image={...info,path:saved.path,...(outputs.length?{panels:outputs}:{})};
      return {result:output,isError:false,png:base64,pngs:panels.filter(p=>p.kind!=='view').map(p=>p.base64)};
    }
    if(command.type==='documents'&&command.params.action==='asset'&&artifact){const bytes=decodeBase64(artifact.base64);const saved=await saveArtifact(bytes,artifact.filename,artifact.mimeType);output.artifact=saved;return {result:output,isError:false,resource:{uri:saved.uri,mimeType:saved.mimeType,blob:artifact.base64}};}
    if (command.type === 'export_model') {
      if (!artifact) throw new Error('Runtime returned no export bytes.');
      const bytes = decodeBase64(artifact.base64);
      if (bytes.length !== artifact.byteLength) throw new Error('Runtime export byteLength does not match its bytes.');
      const suffix = command.params.format;
      // Without a requested name, keep the browser's part-name-and-revision name when it is a safe basename.
      const requested = command.params.filename ?? (SAFE_BASENAME.test(artifact.filename) ? artifact.filename : `model.${suffix}`);
      const filename = requested.toLowerCase().endsWith(`.${suffix}`) ? requested : `${requested}.${suffix}`;
      const saved = await saveArtifact(bytes, filename, artifact.mimeType);
      output.artifact = saved;
      return { result: output, isError: false, resource: { uri: saved.uri, mimeType: saved.mimeType, blob: artifact.base64 } };
    }
  } catch (error) {
    await Promise.all(written.map(path=>rm(path,{force:true}).catch(()=>{})));
    const storageFailure = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '');
    const failed = commandError(command.type, command.type === 'export_model' ? 'EXPORT_DELIVERY_FAILED' : 'IMAGE_DELIVERY_FAILED', error instanceof Error ? error.message : 'Cannot deliver browser output.', { documentId: result.documentId, revision: result.revision, nextStep: 'Inspect the model and retry this read-only export or render after correcting the reported problem.' }, storageFailure ? { reason: 'Artifact storage is not writable or is full.', steps: ["Check free disk space and write access to this checkout's artifacts directory."] } : undefined);
    if(command.type==='apply_edits')return {result:{...output,reviewFailure:{code:'IMAGE_DELIVERY_FAILED',message:failed.error!.message,committed:true},
      warnings:[...result.warnings,'Edit committed; inspection image delivery failed. Retry render_views, not apply_edits.']},isError:false};
    failed.health = result.health; failed.nextSteps = result.nextSteps;
    return { result: failed as unknown as Record<string, unknown>, isError: true };
  }
  return { result: output, isError: false };
}
