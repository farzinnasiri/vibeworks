import { renderedTileSchema,reviewEvidenceSchema,renderedPNGSchema,workspaceViewResultSchema, studioRenderJobSchema, projectDuplicationSchema, agentSchema, agentSessionSchema, participantSchema, activityOperationSchema, graphSnapshotSchema } from '../shared/protocol';
import {ASSET_ENCODING,decodeAssets,displayValueCount} from '../shared/display';
import { z } from 'zod';
import { replaySchema, MAX_ASSEMBLY_FEATURES, displayMeshSchema, resolvedMountSchema, documentSummarySchema, projectSchema, revisionSummarySchema, MAX_FEATURES, MAX_REFERENCED_DOCUMENTS, appearanceSchema, commandFailureSchema, commandSchemas, documentSchema, featureIdSchema, MAX_RENDER_VIEWS, TARGET_EXPECTATIONS, type CadResult } from '../shared/protocol.ts';

export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const commandName = z.enum(Object.keys(commandSchemas) as [keyof typeof commandSchemas, ...Array<keyof typeof commandSchemas>]);
const finite = z.number().finite();
// Output bounds include the origin plus dimensions/radius and OCCT tolerance.
// The input-coordinate limits therefore cannot also constrain these results.
const boundsPoint = z.tuple([finite, finite, finite]);
const boundsSize = z.tuple([finite.nonnegative(), finite.nonnegative(), finite.nonnegative()]);
// A result can name every feature of a full document, so its lists follow the document limit.
const ids = z.array(featureIdSchema).max(MAX_FEATURES);

// The shared module owns the wire types. These checks reject malformed runtime
// output at the trust boundary without defining another command contract.
export const resultSchema: z.ZodType<CadResult> = z.object({
  evaluationProvenance:z.object({authoredEngine:z.string(),evaluatedWith:z.string(),originalEvidence:z.literal(false)}).strict().optional(),
  meta:z.object({replyBytes:z.number().int().nonnegative()}).strict().optional(),
  review:reviewEvidenceSchema.optional(),
  reviewFailure:z.object({code:z.string(),message:z.string(),committed:z.boolean()}).strict().optional(),
  workspaceView:workspaceViewResultSchema.optional(),
  dependentWarnings:z.array(z.object({documentId:z.string().uuid(),code:z.string(),message:z.string(),details:z.unknown().optional()}).strict()).max(64).optional(),
  topologyQuery:z.object({feature:featureIdSchema,path:z.array(featureIdSchema).optional(),faceIndices:z.array(z.number().int().nonnegative()).optional(),edgeIndices:z.array(z.number().int().nonnegative()).optional()}).strict().optional(),
  inspection:z.record(z.string(),z.unknown()).optional(),
  actor:z.object({agentId:z.string().uuid(),sessionId:z.string().uuid(),clientInstanceId:z.string().uuid().optional()}).strict().optional(),
  help:z.object({tool:z.string(),kind:z.string().optional(),schema:z.record(z.string(),z.unknown()),example:z.record(z.string(),z.unknown()),notes:z.array(z.string())}).strict().optional(),removedChecks:ids.optional(),
  replay: replaySchema.optional(), renderJob: studioRenderJobSchema.optional(),
  agent:agentSchema.optional(),session:agentSessionSchema.optional(),sessions:z.array(agentSessionSchema).max(100).optional(),participants:z.array(participantSchema).max(1000).optional(),operations:z.array(activityOperationSchema).max(100).optional(),cursor:z.number().int().nonnegative().optional(),snapshot:graphSnapshotSchema.optional(),
  operation: commandName,
  status: z.enum(['success', 'error']),
  documentId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
  storageVersion: z.number().int().positive().optional(),
  projects: z.array(projectSchema).optional(),
  createdProjectId: z.string().uuid().optional(),
  duplication: projectDuplicationSchema.optional(),
  revisions: z.array(revisionSummarySchema).max(40).optional(),
  created: ids, updated: ids, deleted: ids.optional(), warnings: z.array(z.string()).max(100),
  document: documentSchema.optional(),
  geometry: z.array(z.object({
    resultKind:z.enum(['solid','sheet']).optional(),diagnostics:z.record(z.string(),z.unknown()).optional(),
    mounts: z.array(resolvedMountSchema).max(256).optional(),
    appearance: appearanceSchema.optional(),
    appearanceComplete: z.boolean().optional(),
    featureId: featureIdSchema, valid: z.boolean(), validationMethod: z.string().min(1),
    solidCount: z.number().int().nonnegative(), volumeMm3: finite.nonnegative(),
    surfaceAreaMm2: finite.nonnegative().optional(),
    bounds: z.object({ min: boundsPoint, max: boundsPoint, size: boundsSize }).strict(),
    faceCount: z.number().int().nonnegative().optional(), edgeCount: z.number().int().nonnegative().optional(),
    watertight: z.boolean().nullable().optional(),
    material: z.string().max(64).optional(), massG: finite.nonnegative().optional(),
  }).strict()).max(MAX_FEATURES).optional(),
  visibleFeatureIds: ids.optional(),
  history: z.object({ canUndo: z.boolean(), canRedo: z.boolean() }).strict().optional(),
  error: commandFailureSchema.optional(),
  image: z.object({ mimeType: z.literal('image/png'), base64: z.string().max(MAX_RESPONSE_BYTES), width: z.number().int().positive().max(5376), height: z.number().int().positive().max(5376), tiles: z.array(renderedTileSchema).min(1).max(MAX_RENDER_VIEWS),panels:z.array(renderedPNGSchema).max(32).optional() }).strict().optional(),
  sections: z.array(z.object({ axis: z.enum(['X', 'Y', 'Z']), offset: finite, featureId: featureIdSchema.optional(), empty: z.boolean(), widthMm: finite.nonnegative().optional(), heightMm: finite.nonnegative().optional(), min: boundsPoint.optional(), max: boundsPoint.optional(), results: z.array(featureIdSchema).max(64) }).strict()).max(16).optional(),
  artifact: z.object({ filename: z.string().min(1).max(200), mimeType: z.string().min(1).max(120), base64: z.string().max(MAX_RESPONSE_BYTES), byteLength: z.number().int().positive().max(MAX_ARTIFACT_BYTES) }).strict().optional(),
  durationMs: finite.nonnegative().optional(),
  requestId: z.string().uuid().optional(),
  createdDocumentId: z.string().uuid().optional(),
  replayed: z.boolean().optional(),
  timings: z.object({ queueWaitMs: finite.nonnegative(), geometryEvaluationMs: finite.nonnegative(), analysisMs: finite.nonnegative(), dependentRefreshMs: finite.nonnegative(), renderExportMs: finite.nonnegative(), runtimeOtherMs: finite.nonnegative(), transportMs: finite.nonnegative().optional() }).strict().optional(),
  authority: z.object({ kind: z.literal('node'), kernel: z.string(), workerSlot: z.number().int().nonnegative().max(3) }).strict().optional(),
  provenance: z.object({ documentId: z.string().uuid(), revision: finite.int().nonnegative(), sources: z.array(z.object({ documentId: z.string().uuid(), revision: finite.int().nonnegative() }).strict()).max(MAX_REFERENCED_DOCUMENTS) }).strict().optional(),
  dryRun: z.boolean().optional(),
  instances: z.array(z.object({ featureId: featureIdSchema, documentId: z.string().uuid(), name: z.string().max(120), revision: finite.int().nonnegative(), sourceFeatureIds: ids }).strict()).max(MAX_FEATURES).optional(),
  extraction:z.object({operationId:z.string().uuid(),planToken:z.string(),plan:z.record(z.string(),z.unknown()),equivalence:z.record(z.string(),z.unknown()).optional(),retainedDocumentId:z.string().uuid().optional()}).strict().optional(),
  analysisJob:z.custom<NonNullable<CadResult['analysisJob']>>(v=>!!v&&typeof v==='object'&&['queued','running','complete','cancelled','superseded','error'].includes((v as any).state)).optional(),
  health: z.object({
    constructionSheets:ids.optional(),
    validity:z.object({valid:z.boolean(),leafBodies:finite.int().nonnegative()}).strict().optional(),fit:z.object({complete:z.boolean(),unknown:finite.int().nonnegative()}).strict().optional(),checks:z.object({complete:z.boolean(),pending:finite.int().nonnegative()}).strict().optional(),pending:z.object({jobId:z.string().uuid().optional(),state:z.string().optional()}).strict().optional(),review:z.object({humanApproved:z.literal(false)}).strict().optional(),
    appearance:z.object({staleReferences:z.number().int().nonnegative()}).optional(),
    references: z.array(z.object({ documentId: z.string().uuid(), revision: finite.int().nonnegative() }).strict()).max(MAX_REFERENCED_DOCUMENTS).optional(),
    referencesChanged: z.boolean().optional(), referenceError: z.string().optional(),
    checkedRevision: z.number().int().nonnegative().nullable(), uncheckedChanges: z.number().int().nonnegative(),
    analysis: z.enum(['current', 'unchecked', 'incomplete', 'unavailable']), autoAnalysis: z.boolean().nullable(),
    floating: finite.int().nonnegative().nullable(), interferences: finite.int().nonnegative().nullable(), failedChecks: finite.int().nonnegative().nullable(),pendingChecks:finite.int().nonnegative().nullable().optional(), partsWithoutAppearance: finite.int().nonnegative().nullable(), ok: z.boolean(),
    issues: z.object({ floating: z.array(z.string().max(2048)).max(MAX_ASSEMBLY_FEATURES), interferences: z.array(z.object({ a: z.string().max(2048), b: z.string().max(2048) }).strict()).max(MAX_FEATURES * (MAX_FEATURES - 1) / 2), failedChecks: ids, partsWithoutAppearance: ids }).strict(),
  }).strict().optional(),
  nextSteps: z.array(z.string().max(2000)).max(8).optional(),
  evaluationStats: z.object({
    display: z.object({requested:z.enum(['auto','fine','coarse']),toleranceMm:finite.positive(),angularTolerance:finite.positive(),reduced:z.boolean(),values:finite.int().nonnegative(),expandedValues:finite.int().nonnegative(),meshes:finite.int().nonnegative()}).strict().optional(),
    analysis: z.object({
    broadPhase:z.object({durationMs:finite.nonnegative(),ruledOut:finite.int().nonnegative(),candidates:finite.int().nonnegative()}).strict().optional(),
      durationMs: finite.nonnegative(), partHits: finite.int().nonnegative(), partMisses: finite.int().nonnegative(),
      pairHits: finite.int().nonnegative(), pairMisses: finite.int().nonnegative(), partEntries: finite.int().nonnegative(),
      pairEntries: finite.int().nonnegative(), meshBytes: finite.int().nonnegative(), evictions: finite.int().nonnegative(),
    }).strict().optional(),
    referencedDocuments: z.array(z.object({ documentId: z.string().uuid(), features: finite.int().nonnegative(), rebuilt: ids }).strict()).max(MAX_REFERENCED_DOCUMENTS).optional(),
    durationMs: finite.nonnegative(),
    cache: z.object({
      hits: finite.int().nonnegative(), misses: finite.int().nonnegative(), rebuilt: ids,
      evictions: finite.int().nonnegative(), entries: finite.int().nonnegative(), liveShapes: finite.int().nonnegative(),
      meshBytes: finite.int().nonnegative(), wasmHeapBytes: finite.int().nonnegative(),
    }).strict(),
  }).strict().optional(),
  analysis: z.object({
    broadPhase:z.object({durationMs:finite.nonnegative(),ruledOut:finite.int().nonnegative(),candidates:finite.int().nonnegative()}).strict().optional(),
    leaves:z.array(z.object({id:z.string(),feature:featureIdSchema,path:z.array(featureIdSchema),source:z.object({documentId:z.string().uuid(),featureId:featureIdSchema}).strict(),solidIndex:finite.int().nonnegative(),valid:z.boolean(),bounds:z.object({min:boundsPoint,max:boundsPoint,size:boundsSize}).strict(),volumeMm3:finite.nonnegative(),faceCount:finite.int().nonnegative().optional()}).strict()).max(MAX_ASSEMBLY_FEATURES).optional(),unknownPairs:z.array(z.object({a:z.string(),b:z.string(),reason:z.string()}).strict()).optional(),
    coverage:z.object({totalPairs:finite.int().nonnegative(),completedPairs:finite.int().nonnegative(),totalChecks:finite.int().nonnegative(),completedChecks:finite.int().nonnegative(),connectivity:z.enum(['pending','complete']).optional()}).strict().optional(),
    revision: z.number().int().nonnegative(), scope: z.enum(['document', 'subset']),
    parts: z.number().int().nonnegative(), ground: z.string().max(2048).optional(), toleranceMm: finite.positive(),
    contacts: z.array(z.object({ a: z.string().max(2048), b: z.string().max(2048), overlapMm3: finite.nonnegative() }).strict()).max(MAX_FEATURES * (MAX_FEATURES - 1) / 2),
    interferences: z.array(z.object({ a: z.string().max(2048), b: z.string().max(2048), overlapMm3: finite.nonnegative(), intendedBy: z.string().max(2048).optional() }).strict()).max(MAX_FEATURES * (MAX_FEATURES - 1) / 2),
    floating: z.array(z.object({ featureId: z.string().max(2048), nearest: z.string().max(2048).optional(), gapMm: finite.nonnegative().optional(), intendedBy: ids.optional() }).strict()).max(MAX_ASSEMBLY_FEATURES),
    checks: z.array(z.object({ id: z.string().max(2048), ok: z.boolean().nullable(),status:z.enum(['pass','fail','pending','error']).optional(), expect: z.enum(['contact', 'clearance', 'no_interference', 'overlap', ...TARGET_EXPECTATIONS]), a: z.string().max(2048).optional(), b: z.string().max(2048).optional(), gapMm: finite.nonnegative().optional(), overlapMm3: finite.nonnegative().optional(), measuredMm: finite.nonnegative().optional(), min: boundsPoint.optional(), max: boundsPoint.optional(), widthMm: finite.nonnegative().optional(), heightMm: finite.nonnegative().optional(), message: z.string().max(1000) }).strict()).max(MAX_ASSEMBLY_FEATURES),
    durationMs: finite.nonnegative(), skipped: z.string().max(1000).optional(),
  }).strict().optional(),
  documents: z.array(documentSummarySchema).max(1000).optional(),
}).strict().superRefine((result, ctx) => {
  if (result.status === 'error' && !result.error) ctx.addIssue({ code: 'custom', message: 'An error result must include an error code and message.' });
  const emptyWorkspace = result.operation === 'inspect_model' && result.inspection?.emptyWorkspace===true || result.operation === 'inspect_model' && result.documents?.length === 0 && result.projects !== undefined && !result.document && !result.geometry;
  if (result.status === 'success' && (result.error || (!emptyWorkspace && !['documents','analyze_model','agent_session','activity','describe','workspace_view'].includes(result.operation) && (!result.documentId || result.revision === undefined)))) ctx.addIssue({ code: 'custom', message: 'A successful result must include documentId and revision and no error.' });
  if (result.document && (result.document.documentId !== result.documentId || result.document.revision !== result.revision)) ctx.addIssue({ code: 'custom', message: 'Returned document must match the result documentId and revision.' });
});

export function decodeBase64(value: string, maxBytes = MAX_ARTIFACT_BYTES): Buffer {
  // Avoid a quantified regex group across the payload: V8 can overflow its
  // regexp stack on legitimate multi-megabyte STEP/STL data.
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('Runtime returned invalid or oversized base64 data.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('Runtime returned invalid, empty or oversized base64 data.');
  return bytes;
}

// Private display delivery contains the same validated result plus Node tessellation.
// Its numeric geometry/analysis fields pass the public result validator as well.

/**
 * The same constraints as displayMeshSchema. Shared asset arrays (one per repeated instance) are checked once with a
 * plain loop; zod over millions of numbers per instance dominated display delivery.
 */
const meshMetadataSchema = displayMeshSchema.pick({ resultKind:true,featureId: true, transform: true, appearance: true, regionReport:true,graphicBounds:true,appearanceOrigins:true, occurrencePath: true, source: true, topology: true, faceRanges: true, edgeRanges: true }).strict();
const MAX_MESH_ARRAY = 8_000_000;
function validValues(values: unknown, indices: boolean): boolean {
  if (!Array.isArray(values) || values.length > MAX_MESH_ARRAY) return false;
  for (const v of values) if (typeof v !== 'number' || !Number.isFinite(v) || (indices && (v < 0 || !Number.isInteger(v)))) return false;
  return true;
}
function validMeshes(meshes: unknown, limit: number, pair = false): boolean {
  if (!Array.isArray(meshes) || meshes.length > limit) return false;
  const checked = new Set<unknown>();
  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== 'object') return false;
    const { vertices, normals, triangles, lines, a, b, ...metadata } = mesh as Record<string, unknown>;
    if (pair ? !featureIdSchema.safeParse(a).success || !featureIdSchema.safeParse(b).success : a !== undefined || b !== undefined) return false;
    if (!meshMetadataSchema.safeParse(metadata).success) return false;
    const m = mesh as import('../shared/protocol').DisplayMesh;
    if (m.triangles.length % 3 || m.vertices.length % 3 || m.normals.length !== m.vertices.length || m.lines.length % 6 || m.triangles.some(i => i >= m.vertices.length / 3)) return false;
    for (const [ranges, stride, max, count] of [[m.faceRanges, 4, m.triangles.length / 3, m.topology?.faces.length], [m.edgeRanges, 3, m.lines.length / 6, m.topology?.edges.length]] as const) {
      if (!ranges) continue;
      if (count === undefined || ranges.length % stride) return false;
      let end = 0;
      for (let i = 0; i < ranges.length; i += stride) {
        if (ranges[i] < end || !ranges[i + 1] || ranges[i] + ranges[i + 1] > max || ranges[i + 2] >= count || (stride === 4 && ranges[i + 3] !== 0)) return false;
        end = ranges[i] + ranges[i + 1];
      }
    }
    for (const [values, indices] of [[vertices, false], [normals, false], [triangles, true], [lines, false]] as const) {
      if (checked.has(values)) continue;
      if (!validValues(values, indices)) return false;
      checked.add(values);
    }
  }
  return true;
}
const displayEvaluationSchema = z.custom<import('../cad/types').Evaluation>((value: any) => {
  if (!value || typeof value !== 'object') return false;
  const { meshes, analysis, stats, references, referencesChanged, referenceError, displayError, displayKey, ...fields } = value;
  return (displayKey === undefined || typeof displayKey === 'string' && /^[a-f0-9]{64}$/.test(displayKey)) && validMeshes(meshes, MAX_ASSEMBLY_FEATURES) &&
    displayValueCount(meshes) <= 6_000_000 &&
    (analysis?.interferenceMeshes === undefined || validMeshes(analysis.interferenceMeshes, 32000, true)) &&
    (references === undefined || z.array(z.object({documentId:z.string().uuid(),revision:z.number().int().nonnegative()}).strict()).max(MAX_REFERENCED_DOCUMENTS).safeParse(references).success) &&
    (referencesChanged === undefined || typeof referencesChanged === 'boolean') && (referenceError === undefined || typeof referenceError === 'string') && (displayError === undefined || (typeof displayError === 'string' && displayError.length <= 2000)) &&
    resultSchema.safeParse({ operation:'inspect_model', status:'success', documentId:'00000000-0000-4000-8000-000000000000', revision:0, created:[], updated:[], warnings:[], ...fields,
      ...(stats ? {evaluationStats:stats} : {}), ...(analysis ? {analysis: Object.fromEntries(Object.entries(analysis).filter(([key]) => key !== 'interferenceMeshes'))} : {}) }).success;
});
const unpackDisplay = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || !('evaluation' in value)) return value;
  const delivery = value as any, evaluation = delivery.evaluation;
  if (!evaluation || typeof evaluation !== 'object' || !('assets' in evaluation)) return value;
  if (evaluation.assetEncoding !== ASSET_ENCODING || !Array.isArray(evaluation.assets) || evaluation.assets.length > MAX_ASSEMBLY_FEATURES) return null;
  const assets = decodeAssets(evaluation.assets);
  const records = z.array(z.object({...displayMeshSchema.pick({resultKind:true,regionReport:true,graphicBounds:true,appearanceOrigins:true,occurrencePath:true,source:true,topology:true,faceRanges:true,edgeRanges:true}).shape,asset:z.number().int().nonnegative(),featureId:featureIdSchema,appearance:appearanceSchema.optional(),transform:z.array(finite).length(16).optional()}).strict()).max(MAX_ASSEMBLY_FEATURES).safeParse(evaluation.meshes);
  if (!assets || !records.success || displayValueCount(assets.map((a)=>({...a,featureId:'asset'}))) > 6_000_000) return null;
  if (records.data.some(m=>m.asset>=assets.length)) return null;
  const {assets:_,assetEncoding:__,...rest} = evaluation;
  return {...delivery,evaluation:{...rest,meshes:records.data.map(({asset:id,...metadata})=>({...assets[id],...metadata}))}};
};
export const displayDeliverySchema = z.preprocess(unpackDisplay, z.object({ result: resultSchema, evaluation: displayEvaluationSchema.optional() }).strict().superRefine((delivery, ctx) => {
  if ((delivery.result.replay || delivery.evaluation?.replay) &&
      (delivery.result.status !== 'success' || !delivery.evaluation || JSON.stringify(delivery.result.replay) !== JSON.stringify(delivery.evaluation.replay)))
    ctx.addIssue({ code: 'custom', message: 'Replay result and display must identify the same successful frame.' });
}));
