/** Offline evidence only. Production commands still compute geometry in the browser. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { z } from 'zod';
import { GeometryEngine, loadTextFont } from '../../src/cad/geometry';
import { validateDocument } from '../../src/cad/document';
import { resolveBindings, expressionNames } from '../../src/cad/parameters';
import { modelHealth, healthHints, publicAnalysis } from '../../src/cad/health';
import { AGENT_TOOLS } from '../../src/shared/protocol';
import { assemblyGraph } from '../../src/cad/assemblies';

export interface TranscriptRecord { type: string; tool?: string; callId?: string; input?: unknown; output?: unknown; [key: string]: unknown }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Prefer structuredContent over its duplicate text rendition. Never execute transcript input. */
function cadResults(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') {
    try { return cadResults(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(cadResults);
  if (!object(value)) return [];
  if (typeof value.operation === 'string' && (AGENT_TOOLS as readonly string[]).includes(value.operation) && ['success', 'error'].includes(String(value.status))) return [value];
  if (object(value.structuredContent)) return cadResults(value.structuredContent);
  return Object.entries(value).filter(([key]) => !['input', 'arguments', 'document', 'inputSchema', 'data', 'blob'].includes(key)).flatMap(([, v]) => cadResults(v));
}
export function transcriptMetrics(value: unknown) {
  if (!object(value) || value.format !== 'conversation-and-tools-v1' || !Array.isArray(value.records)) throw new Error('Transcript must use conversation-and-tools-v1 with records.');
  const records = value.records as TranscriptRecord[];
  const calls = records.filter(r => r.type === 'tool_call');
  const byTool: Record<string, number> = {}, byCode: Record<string, number> = {};
  for (const call of calls) byTool[call.tool ?? 'unknown'] = (byTool[call.tool ?? 'unknown'] ?? 0) + 1;
  const results = records.filter(r => r.type === 'tool_result').flatMap(r => cadResults(r.output));
  for (const result of results) if (result.status === 'error') {
    const code = object(result.error) && typeof result.error.code === 'string' ? result.error.code : 'UNKNOWN';
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const errors = Object.values(byCode).reduce((a, b) => a + b, 0);
  const cadCalls = calls.filter(r => typeof r.tool === 'string' && (AGENT_TOOLS as readonly string[]).includes(r.tool.replace(/^.*__/, '')));
  const resultIds = new Set(records.filter(r => r.type === 'tool_result').map(r => r.callId));
  return {
    toolCalls: calls.length, byTool, directCadToolCalls: cadCalls.length,
    unansweredCadCalls: cadCalls.filter(c => !resultIds.has(c.callId)).length,
    observedCadResults: results.length, errors,
    errorRate: results.length ? errors / results.length : null,
    errorsByCode: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => [code, { count, rate: count / results.length }])),
    observedDocumentRevisions: [...new Map(results.filter(r => typeof r.documentId === 'string' && typeof r.revision === 'number').map(r => [`${r.documentId}:${r.revision}`, { documentId: r.documentId, revision: r.revision }])).values()],
    analysisResults: results.filter(r => r.operation === 'analyze_model').length,
    coverage: calls.some(c => c.tool === 'exec') ? 'Wrapped exec calls: CAD result counts are recovered from complete JSON outputs; truncated or unprinted results are unknown. toolCalls counts recorded outer calls, not nested execution.' : 'Direct recorded calls. Missing responses are unknown, not successes.',
  };
}

const criterionSchema = z.object({
  path: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().optional(), max: z.number().optional(),
}).strict().refine(v => v.equals !== undefined || v.min !== undefined || v.max !== undefined, 'Criterion needs equals, min or max.');
export const taskSchema = z.object({
  id: z.string(), prompt: z.string(), requiresFeatureKinds: z.array(z.string()).default([]),
  expectations: z.array(criterionSchema), humanReview: z.array(z.string()),
}).strict();
export type TaskSpec = z.infer<typeof taskSchema>;
export function checkExpectations(score: unknown, task: TaskSpec) {
  return task.expectations.map(expectation => {
    let actual: unknown = score;
    for (const key of expectation.path.split('.')) actual = actual && typeof actual === 'object' && Object.hasOwn(actual, key) ? (actual as Record<string, unknown>)[key] : undefined;
    const passed = actual !== undefined &&
      (expectation.equals === undefined || actual === expectation.equals) &&
      (expectation.min === undefined || typeof actual === 'number' && actual >= expectation.min) &&
      (expectation.max === undefined || typeof actual === 'number' && actual <= expectation.max);
    return { ...expectation, actual: actual ?? null, passed };
  });
}

let kernel: Promise<Awaited<ReturnType<typeof initOpenCascade>>> | undefined;
export const workspaceCaptureSchema = z.object({
  format: z.literal('vibeworks-workspace-v1'),
  activeDocumentId: z.string().uuid(),
  documents: z.array(z.unknown()).min(1),
}).strict();

export async function scoreDocument(value: unknown, transcript?: unknown, analysisBudgetMs = 20_000, documentId?: string) {
  if (!Number.isFinite(analysisBudgetMs) || analysisBudgetMs < 0) throw new Error('analysisBudgetMs must be finite and nonnegative.');
  const capture = object(value) && value.format === 'vibeworks-workspace-v1' ? workspaceCaptureSchema.parse(value) : undefined;
  const documents = (capture?.documents ?? [value]).map(value => {
    const document = validateDocument(value);
    resolveBindings(document);
    return document;
  });
  if (new Set(documents.map(d => d.documentId)).size !== documents.length) throw new Error('Workspace contains duplicate document IDs.');
  const target = documentId ?? capture?.activeDocumentId ?? documents[0].documentId;
  const document = documents.find(d => d.documentId === target);
  if (!document) throw new Error(`Workspace does not contain target document '${target}'.`);
  const graph = assemblyGraph(document, documents);
  const oc = await (kernel ??= readFile(new URL('../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
    .then(wasmBinary => initOpenCascade({ wasmBinary, print: () => {}, printErr: () => {} }))); setOC(oc);
  const engine = new GeometryEngine(oc);
  try {
    if (graph.some(doc => doc.features.some(f => f.kind === 'text'))) {
      const font = await readFile(new URL('../../src/cad/fonts/IBMPlexSans-Bold.ttf', import.meta.url));
      await loadTextFont(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength));
    }
    const evaluation = engine.evaluate(document, documents);
    const analysis = engine.analyze(document, evaluation.geometry, undefined, analysisBudgetMs);
    const health = modelHealth(document, { ...evaluation, analysis }, null);
    const byKind: Record<string, number> = {};
    const bindingEntries = document.features.flatMap(f => Object.entries(f.bindings ?? {}));
    const usedNames = [...new Set(bindingEntries.flatMap(([, expression]) => expressionNames(expression)))].sort();
    for (const f of document.features) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    const checks = document.analysis?.checks ?? [];
    const visible = evaluation.geometry.filter(g => evaluation.visibleFeatureIds.includes(g.featureId));
    const transcriptScore = transcript === undefined ? null : transcriptMetrics(transcript);
    const min = [0, 1, 2].map(i => Math.min(...visible.map(g => g.bounds.min[i])));
    const max = [0, 1, 2].map(i => Math.max(...visible.map(g => g.bounds.max[i])));
    return {
      geometry: { bounds: visible.length ? { min, max, size: max.map((v, i) => v - min[i]) } : null, summedVolumeMm3: visible.reduce((n, g) => n + g.volumeMm3, 0) },
      format: 'vibeworks-eval-v1', documentId: document.documentId, revision: document.revision,
      workspace: { capturedDocuments: documents.length, resolvedDocuments: graph.map(d => ({ documentId: d.documentId, revision: d.revision })) },
      instances: evaluation.instances ?? [],
      evidence: 'Fresh real OCCT replay and whole-document analysis in Node. This does not establish what the original agent checked or what a browser displayed.',
      savedAnalysis: { auto: document.analysis?.auto ?? true, settingPresent: document.analysis?.auto !== undefined, evidencePersisted: false },
      counts: { features: document.features.length, results: visible.length, solids: visible.reduce((n, g) => n + g.solidCount, 0), invalidResults: visible.filter(g => !g.valid).length, byKind },
      parameters: { defined: document.parameters?.length ?? 0, values: Object.fromEntries((document.parameters ?? []).map(p => [p.name, p.value])), used: usedNames.length, namesUsed: usedNames, bindings: bindingEntries.length, boundFeatures: document.features.filter(f => Object.keys(f.bindings ?? {}).length).length },
      modeling: { unions: byKind.union ?? 0, checks: checks.length,
        intentDeclarations: checks.filter(c => ['overlap', 'clearance'].includes(c.expect) && c.note?.trim()).length,
        passedIntentChecks: checks.filter(c => ['overlap', 'clearance'].includes(c.expect) && c.note?.trim() && analysis.checks.some(r => r.id === c.id && r.ok)).length },
      health, nextSteps: healthHints(health, analysis, document), analysis: publicAnalysis(analysis),
      transcript: transcriptScore,
      transcriptSnapshot: transcriptScore ? { revisionObserved: transcriptScore.observedDocumentRevisions.some(r => r.documentId === document.documentId && r.revision === document.revision), note: 'Transcript behavior and saved geometry are separate evidence; a matching revision alone does not establish the exact same content.' } : null,
      timing: { evaluationMs: Math.round(evaluation.stats!.durationMs), analysisMs: analysis.durationMs, analysisBudgetMs },
    };
  } finally { engine.dispose(); }
}

async function main(args: string[]) {
  const [file, ...flags] = args;
  if (!file || flags.length % 2 || flags.some((f, i) => i % 2 === 0 && !['--transcript', '--task', '--analysis-budget-ms', '--document-id'].includes(f))) throw new Error('Usage: tsx scripts/evals/score.ts DOCUMENT_OR_WORKSPACE.json [--document-id UUID] [--transcript TRANSCRIPT.json] [--task TASK.json] [--analysis-budget-ms 20000]');
  const options = Object.fromEntries(Array.from({ length: flags.length / 2 }, (_, i) => [flags[i * 2], flags[i * 2 + 1]]));
  const readJSON = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const score = await scoreDocument(await readJSON(file), options['--transcript'] ? await readJSON(options['--transcript']) : undefined, options['--analysis-budget-ms'] === undefined ? undefined : Number(options['--analysis-budget-ms']), options['--document-id']);
  const task = options['--task'] ? taskSchema.parse(await readJSON(options['--task'])) : undefined;
  const expectations = task ? checkExpectations(score, task) : undefined;
  console.log(JSON.stringify({ ...score, ...(task ? { task: task.id, expectations, passed: expectations!.every(e => e.passed), humanReview: task.humanReview } : {}) }, null, 2));
  // Defective geometry is a valid score. Nonzero means a task gate failed or input/replay failed.
  if (expectations?.some(e => !e.passed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ status: 'error', code: error.code ?? 'EVAL_FAILED', message: error instanceof Error ? error.message : String(error) })); process.exitCode = 2;
});
