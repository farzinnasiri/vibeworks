import { resolveLook } from '../shared/appearance-resolver';
import { normalizeGraphicAssets } from '../shared/graphic-assets';
import { identifyDisplay } from './display-identity';
import { appearanceOnly, restylePart } from './appearance';
import { countLabel } from '../shared/format';
import { assemblyGraph } from './assemblies';
import { reviewTotals,comparisonShots } from './review';
import { type Project, type StoredDocument, MAX_REFERENCED_DOCUMENTS } from '../shared/protocol';
import { modelHealth, healthHints, publicAnalysis, floatingDescription, floatingAdvice } from './health';
import {
  commandError,
  commandSchemas,
  parseCommand,
  COMMAND_TIMEOUT_MS,
  type ModelHealth,
  type AnalysisReport,
  type CadCommand,
  type CadDocument,
  type CadResult,
  type CommandName,
  type DocumentSummary,
  type CommandTimings,
} from '../shared/protocol';
import {
  CadError,
  checkContext,
  copyDocument,
  emptyDocument,
  nextRevision,
  validateDocument,
} from './document';
import { applyEdits, type EditOutcome } from './edits';
import { resolveBindings } from './parameters';
import { GeometryWorker, type GeometryClient } from './worker-client';
import { DEFAULT_NAME, MemoryStore, copyName, summarize, type DocumentStore } from './store';
import type { PreparedDisplayStore } from './types';
import type { Evaluation } from './types';

const HISTORY_LIMIT = 40;
const referenceFailure = (error: unknown) =>
  error instanceof CadError &&
  [
    'REFERENCE_MISSING','REFERENCE_CHANGED','REFERENCE_AMBIGUOUS','REFERENCE_UNSUPPORTED','REFERENCE_SIGNATURE_REQUIRED',
    'DOCUMENT_NOT_FOUND',
    'INSTANCE_RESULT_NOT_VISIBLE',
    'MOUNT_NOT_FOUND',
    'MOUNT_SOURCE_RESULT',
    'INSTANCE_CYCLE',
    'INSTANCE_DEPTH',
    'ASSEMBLY_LIMIT',
  ].includes(error.code);
const EMPTY: Evaluation = { geometry: [], meshes: [], visibleFeatureIds: [] };
/** Built without display meshes (an agent command); a viewer read adds them from the warm result cache. */
const displayMissing = (evaluation: Evaluation) =>
  !!evaluation.stats && !evaluation.stats.display && !evaluation.displayError && !evaluation.referenceError && !evaluation.replay && evaluation.visibleFeatureIds.length > 0;
type History = 'append' | 'undo' | 'redo';
export type Outcome = import('../shared/protocol').RuntimeDelivery;
export interface RuntimeState {
  workspaceView?: import('../shared/protocol').WorkspaceViewRequest;
  phase: 'initializing' | 'ready' | 'error';
  /** Browser project picker. No document geometry is requested until the user opens one. */
  workspaceHome?: boolean;
  /** A saved workspace can be connected while its first model display is pending or failed. */
  displayStatus?: 'loading' | 'failed';
  busy: boolean;
  activity: string;
  document: CadDocument;
  evaluation: Evaluation;
  health: ModelHealth;
  canUndo: boolean;
  canRedo: boolean;
  error?: string;
  persistence: string;
  lastResult?: CadResult;
  /** Every document in the workspace; `active` marks the one shown here. */
  documents: DocumentSummary[];
  projects: Project[];
  storageVersion?: number;
}
/** One open document: its committed state, exact evaluation and its own undo/redo history. */
interface Session {
  storageVersion: number;
  sourceVersions: Record<string, number>;
  needsRefresh?: boolean;
  checkedRevision: number | null;
  document: CadDocument;
  evaluation: Evaluation;
  undo: CadDocument[];
  redo: CadDocument[];
  used: number;
}
/** Open documents kept evaluated besides the active one; others reload from the store on demand. */
const OPEN_LIMIT = 6;
/** Display-mesh exports with materials (GLB), produced where a 3D library is available. */
/** budgetMs is what remains of the command deadline; outputs never outlive their command. */
export type MeshExporter = (
  evaluation: Evaluation,
  document: CadDocument,
  featureIds: string[],
  budgetMs?: number
) => Promise<{ bytes: ArrayBuffer; mimeType: string }>;
export type ContactSheetRenderer = (
  evaluation: Evaluation,
  command: Extract<CadCommand, { type: 'render_views' }>,
  document: CadDocument,
  health: ModelHealth,
  budgetMs?: number,
  comparisonBounds?: import('../shared/protocol').Bounds
) => Promise<NonNullable<CadResult['image']>>;

/** Findings as sentences, so an agent that only reads warnings still learns what is physically wrong. */
export function analysisWarnings(report?: AnalysisReport): string[] {
  if (!report) return [];
  const warnings: string[] = [];
  const floating = (report.skipped?[]:report.floating).filter((f) => !f.intendedBy?.length);
  if (floating.length) {
    const parts = floating
      .slice(0, 8)
      .map((part) => `${part.featureId} ${floatingDescription(part, report!)}`)
      .join('; ');
    const subject = countLabel(floating.length, 'part is', 'parts are');
    const more = floating.length > 8 ? '; …' : '';
    warnings.push(
      `${subject} not connected through contact to '${report.ground}': ${parts}${more}. ${floatingAdvice(report)}`
    );
  }
  const interferences = report.interferences.filter((pair) => !pair.intendedBy);
  if (interferences.length) {
    const pairs = interferences
      .slice(0, 8)
      .map((pair) => `${pair.a} ∩ ${pair.b} ${pair.overlapMm3} mm³`)
      .join(', ');
    const more = interferences.length > 8 ? ', …' : '';
    warnings.push(
      `${countLabel(interferences.length, 'interference')}: ${pairs}${more}. ` +
        'Parts interpenetrate; union them if they should be one part.'
    );
  }
  for (const check of report.checks.filter((c) => c.ok===false).slice(0, 8))
    warnings.push(`Check '${check.id}' failed: ${check.message}`);
  if (report.skipped) warnings.push(`Analysis incomplete: ${report.skipped}`);
  return warnings;
}

/** Leave a second for the receipt after an output finishes. */
const outputBudget = (deadline: number) => Math.max(0, deadline - performance.now() - 1_000);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class CadRuntime {
  private worker: GeometryClient;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private sessions = new Map<string, Session>();
  private activeId = '';
  private clock = 0;
  private summaries: Omit<DocumentSummary, 'active'>[] = [];
  private initializing?: Promise<void>;
  private headless=false;
  private analysisProvider?: (id:string)=>Promise<AnalysisReport|undefined>;
  setAnalysisProvider(provider:(id:string)=>Promise<AnalysisReport|undefined>){this.analysisProvider=provider;}
  private renderer?: ContactSheetRenderer;
  private timings?: CommandTimings;
  /** Whether the current command's caller shows the model. Agent commands skip display tessellation. */
  private wantsDisplay = true;
  private refreshing = false;
  private changeCursor = 0;
  private storageRefresh?: Promise<void>;
  private referenceVersions: Record<string, number> = {};
  private projects: Project[] = [];
  private state: RuntimeState = {
    phase: 'initializing',
    busy: false,
    activity: 'Loading exact geometry kernel',
    document: emptyDocument(),
    evaluation: EMPTY,
    health: modelHealth(emptyDocument(), EMPTY, null),
    canUndo: false,
    canRedo: false,
    persistence: 'Not saved yet',
    documents: [],
    projects: [],
  };
  /** The browser uses authenticated bridge-owned SQLite; tests can use MemoryStore. */
  constructor(private store: DocumentStore = new MemoryStore(), worker: GeometryClient = new GeometryWorker(), private preparedDisplay?: PreparedDisplayStore) { this.worker = worker; }
  close(): void { this.worker.stop(); }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): RuntimeState => this.state;
  setRenderer(renderer: ContactSheetRenderer): void {
    this.renderer = renderer;
  }
  private meshExporter?: MeshExporter;
  setMeshExporter(exporter: MeshExporter): void {
    this.meshExporter = exporter;
  }
  /** State is a projection of the active session plus the workspace listing. */
  private publish(patch: Partial<RuntimeState> = {}): void {
    const active = this.sessions.get(this.activeId);
    this.state = {
      ...this.state,
      ...patch,
      ...(active
        ? {
            document: active.document,
            storageVersion: active.storageVersion,
            evaluation: active.evaluation,
            health: modelHealth(active.document, active.evaluation, active.checkedRevision),
            canUndo: active.undo.length > 0,
            canRedo: active.redo.length > 0,
          }
        : {}),
      projects: this.projects,
      documents: this.summaries.map((summary) => ({
        ...summary,
        active: summary.documentId === this.activeId,
      })),
    };
    this.listeners.forEach((listener) => listener());
  }

  private async selection(document: CadDocument): Promise<string[]> {
    try {
      const ids: unknown = JSON.parse(await this.store.getPreference(`selection:${document.documentId}`) ?? '[]');
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && document.features.some(f => f.id === id)) : [];
    } catch { return []; }
  }

  initialize(headless=false): Promise<void> {
    this.headless=headless;
    return (this.initializing ??= (async () => {
      let document = emptyDocument();
      let persistence = 'Local SQLite ready';
      let stored = false;
      let record: StoredDocument | undefined;
      let preferred: string | undefined;
      try {
        this.summaries = await this.store.list();
        this.projects = (await this.store.operation({ action: 'projects' })).projects!;
        preferred = await this.store.getPreference('activeDocumentId');
        const id =
          this.summaries.find((s) => s.documentId === preferred)?.documentId ?? this.summaries[0]?.documentId;
        if (id) {
          record = await this.store.read(id);
          document = validateDocument(record?.document);
          persistence = 'Restored from local SQLite';
          stored = true;
        }
      } catch (error) {
        this.publish({ phase: 'error', persistence: 'Storage unavailable', error: `Saved documents could not be read: ${error instanceof Error ? error.message : String(error)}. Start the bridge and reload.` });
        return;
      }
      document.projectId ??= this.projects[0]?.projectId;
      document.selectedFeatureIds = await this.selection(document);
      this.activeId = document.documentId;
      this.sessions.set(document.documentId, {
        storageVersion: record?.version ?? 0,
        sourceVersions: {},
        checkedRevision: null,
        document,
        evaluation: EMPTY,
        undo: record?.history.undo ?? [],
        redo: record?.history.redo ?? [],
        used: ++this.clock,
      });
      try {
        const opened = this.sessions.get(document.documentId)!;
        this.referenceVersions = {};
        const references = await this.referencedDocuments(document);
        opened.sourceVersions = { ...this.referenceVersions };
        opened.evaluation = await this.worker.initialize(headless?emptyDocument():document,headless?[]:references);
        opened.needsRefresh=headless&&document.features.length>0;
        // A restored document is checked on load when automatic analysis is on, so health is current after a reload.
        if (!headless && document.features.length && (document.analysis?.auto ?? true)) {
          const analyzed = await this.worker
            .evaluate(document, undefined, {}, references)
            .catch(() => undefined);
          if (analyzed) {
            opened.evaluation = analyzed;
            if (analyzed.analysis && !analyzed.analysis.skipped) opened.checkedRevision = document.revision;
          }
        }
        // A brand-new workspace gets its first document stored; an unreadable one is never overwritten.
        if (!stored && document.projectId && !persistence.startsWith('Saved documents could not')) {
          document.name = DEFAULT_NAME;
          opened.storageVersion = await this.store.put(document, null);
          this.summaries = await this.store.list();
        }
        // Pin the human's view, so a reload does not jump to whichever part an agent edited last.
        if (preferred !== document.documentId)
          await this.store.setPreference('activeDocumentId', document.documentId).catch(() => {});
        this.publish({ phase: 'ready', activity: 'Ready', persistence, error: undefined });
      } catch (error) {
        // Keep the saved JSON available for recovery; do not overwrite it with an empty model.
        if (referenceFailure(error) || (error instanceof CadError && error.code === 'MODEL_TOO_COMPLEX')) {
          const capacity = !referenceFailure(error);
          this.sessions.get(document.documentId)!.needsRefresh = capacity;
          this.sessions.get(document.documentId)!.evaluation = {
            ...EMPTY,
            ...(!capacity ? { referenceError: (error as Error).message } : {}),
          };
          this.publish({
            phase: 'ready',
            activity: capacity ? 'Display unavailable; saved model and undo are available' : 'Assembly references need repair',
            persistence,
            error: (error as Error).message,
          });
        } else
          this.publish({
            phase: 'error',
            activity: 'Kernel initialization failed',
            persistence,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })());
  }

  async retryInitialization(): Promise<void> {
    this.worker.stop();
    this.initializing = undefined;
    this.sessions.clear();
    this.publish({ phase: 'initializing', error: undefined });
    await this.initialize(this.headless);
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action, action);
    this.queue = task.catch(() => {});
    return task;
  }

  /** The one entry point for every operator: parse, check context, compute exactly, commit or roll back. */
  execute(value: unknown): Promise<CadResult> {
    const received = performance.now();
    return this.enqueue(async () => (await this.run(value, received)).result);
  }
  /** Private display delivery uses the same command queue and transaction boundary. */
  executeDelivery(value: unknown, received = performance.now(), display = true): Promise<Outcome> {
    return this.enqueue(async () => {
      const outcome = await this.run(value, received, display);
      if (outcome.result.status === 'error') return { result: outcome.result };
      // Selection never changes geometry; the viewer restyles what it already shows.
      if (!display || (typeof value === 'object' && value !== null && (value as CadCommand).type === 'select_features')) return { result: outcome.result };
      const session = outcome.result.documentId && this.sessions.get(outcome.result.documentId);
      if (typeof value === 'object' && value !== null && (value as CadCommand).type === 'inspect_model' && (value as any).params?.definitionsOnly) return outcome;
      return { ...outcome, evaluation: outcome.evaluation ?? (session ? session.evaluation : undefined) };
    });
  }
  replay(command: Extract<CadCommand, { type: 'inspect_model' }>): Promise<Outcome> {
    return this.executeDelivery(command);
  }

  /**
   * Dry-run edits for display: the exact candidate evaluation, including display meshes.
   * Never changes the committed document, history, persistence or last-command status.
   */
  preview(command: Extract<CadCommand, { type: 'apply_edits' }>): Promise<Outcome> {
    const received = performance.now();
    return this.enqueue(() =>
      this.run({ ...command, params: { ...command.params, dryRun: true } }, received)
    );
  }

  /** Load (and evaluate) a stored document into an open session, keeping only a few open besides the active one. */
  private async session(documentId: string, deadline: number, evaluateCurrent = true, skipAnalysis = false, meshes = this.wantsDisplay, reuseDisplay = false): Promise<Session> {
    let session = this.sessions.get(documentId);
    if (!session) {
      const record = await this.store.read(documentId);
      if (!record) throw new CadError('DOCUMENT_NOT_FOUND', `Document '${documentId}' is not in this workspace. Call documents with action list.`, { documentId });
      const document = validateDocument(record.document);
      document.selectedFeatureIds = await this.selection(document);
      session = {
        storageVersion: record.version, sourceVersions: {}, checkedRevision: null,
        document, evaluation: EMPTY, undo: record.history.undo, redo: record.history.redo,
        used: 0, needsRefresh: true,
      };
      // Saved definitions and history remain accessible even when their current geometry cannot evaluate.
      this.sessions.set(documentId, session);
      const idle = [...this.sessions.entries()].filter(([id]) => id !== this.activeId && id !== documentId).sort((a, b) => a[1].used - b[1].used);
      for (const [id] of idle.slice(0, Math.max(0, idle.length - (OPEN_LIMIT - 1)))) this.sessions.delete(id);
    }
    if (evaluateCurrent && session.needsRefresh) await this.refreshSession(session, deadline, skipAnalysis, meshes, reuseDisplay);
    session.used = ++this.clock;
    return session;
  }

  /** Read committed sessions first; unopened parts come from storage. No session/UI switching. */
  private async referencedDocuments(root: CadDocument, replacement?: CadDocument): Promise<CadDocument[]> {
    const found = new Map<string, CadDocument>([[root.documentId, root]]);
    const collect = async (doc: CadDocument): Promise<void> => {
      for (const feature of doc.features)
        if (feature.kind === 'instance' && !found.has(feature.params.document)) {
          const id = feature.params.document;
          const record = id === replacement?.documentId ? undefined : await this.store.body(id);
          const raw = id === replacement?.documentId ? replacement : record?.document;
          if (record) this.referenceVersions[id] = record.version;
          if (!raw)
            throw new CadError(
              'DOCUMENT_NOT_FOUND',
              `Instance '${feature.id}' references missing document '${id}'.`
            );
          const part = validateDocument(raw);
          found.set(id, part);
          if (found.size > MAX_REFERENCED_DOCUMENTS + 1)
            throw new CadError(
              'ASSEMBLY_LIMIT',
              `At most ${MAX_REFERENCED_DOCUMENTS} referenced documents are supported.`
            );
          await collect(part);
        }
    };
    await collect(root);
    return assemblyGraph(root, [...found.values()]).filter((doc) => doc.documentId !== root.documentId);
  }

  /** A source commit is final even if it invalidates an assembly's selected result. */
  private async refreshAssemblies(source: CadDocument, deadline: number): Promise<string[]> {
    const started = performance.now();
    const warnings: string[] = [];
    for (const session of this.sessions.values()) {
      if (
        session.document.documentId === source.documentId ||
        !session.document.features.some((f) => f.kind === 'instance')
      )
        continue;
      let affected = session.evaluation.references?.some((ref) => ref.documentId === source.documentId) ?? false;
      try {
        // A successful evaluation already records every transitive dependency.
        if (!session.evaluation.references || session.evaluation.referenceError) {
          const documents = await this.referencedDocuments(session.document);
          affected ||= documents.some((doc) => doc.documentId === source.documentId);
        }
        if (!affected) continue;
        session.needsRefresh = true;
        session.evaluation={...session.evaluation,analysis:undefined};session.checkedRevision=null;
        // Keep the human's view current. Other sessions refresh on their next command,
        // so a source edit does not analyze assemblies that nobody is currently using.
        if (session.document.documentId === this.activeId && !this.headless) {
          this.refreshing = true;
          try {
            const warning = await this.refreshSession(session, deadline);
            if (warning) warnings.push(warning);
          } finally { this.refreshing = false; }
        } else warnings.push(`Assembly '${session.document.name ?? session.document.documentId}' will refresh from the latest source revisions on its next command.`);
      } catch (error) {
        if (
          referenceFailure(error) && !affected &&
          !session.document.features.some(
            (f) => f.kind === 'instance' && f.params.document === source.documentId
          )
        )
          continue;
        const message = `Assembly '${session.document.name ?? session.document.documentId}' could not refresh: ${error instanceof Error ? error.message : String(error)}`;
        // The source is already committed. Transient refresh failures warn here and retry on use.
        session.needsRefresh = !referenceFailure(error);
        if (referenceFailure(error)) {
          session.evaluation = {
            ...session.evaluation,
            analysis: undefined,
            referencesChanged: true,
            referenceError: message,
          };
          session.checkedRevision = null;
        }
        warnings.push(message);
      }
    }
    if (this.timings) this.timings.dependentRefreshMs += performance.now() - started;
    this.publish();
    return warnings;
  }

  private async refreshSession(session: Session, deadline: number, skipAnalysis = false, meshes = this.wantsDisplay, reuseDisplay = false): Promise<string | undefined> {
    const prior = session.evaluation;
    session.needsRefresh = true;
    try {
      const refreshed = await this.evaluate(session.document, deadline, skipAnalysis || !!this.analysisProvider || session.document.analysis?.auto === false ? undefined : {}, undefined, undefined, meshes, undefined, reuseDisplay);
      const referencesChanged = prior.referencesChanged || JSON.stringify(prior.references) !== JSON.stringify(refreshed.references);
      session.sourceVersions = { ...this.referenceVersions };
      session.evaluation = { ...refreshed, ...(referencesChanged ? { referencesChanged: true } : {}) };
      session.checkedRevision = refreshed.analysis && !refreshed.analysis.skipped ? session.document.revision : null;
      session.needsRefresh = false;
    } catch (error) {
      // Keep the committed evaluation and source versions intact so a plain retry can recover.
      if (!referenceFailure(error)) {
        session.evaluation = { ...prior, analysis: undefined };
        session.checkedRevision = null;
        throw error;
      }
      const surfaceFailure=error instanceof CadError&&error.code.startsWith('REFERENCE_');
      const message = `${surfaceFailure?'Surface reference: ':''}Assembly '${session.document.name ?? session.document.documentId}' could not refresh: ${error instanceof Error ? error.message : String(error)}`;
      let display=prior;
      if(surfaceFailure&&deadline-performance.now()>1000){
        const bare=copyDocument(session.document);
        for(const feature of bare.features)if(feature.kind==='instance'){delete feature.surfaceStyles;delete feature.paintRegions;delete feature.graphicEdits;}
        try{display=await this.evaluate(bare,deadline,undefined,undefined,undefined,meshes);session.sourceVersions={...this.referenceVersions};}
        catch{/* Keep the previous delivery when exact geometry itself cannot be refreshed. */}
      }
      session.evaluation = { ...display, analysis: undefined, referencesChanged: true, referenceError: message };
      session.checkedRevision = null;
      session.needsRefresh = false;
      return message;
    }
  }

  /** Prevent a part edit from making a previously valid ancestor graph cyclic or too deep. */
  private async validateAncestors(candidate: CadDocument): Promise<void> {
    // Stored bodies were validated on write and are only scanned for instance references here.
    const known = new Set(this.summaries.map((summary) => summary.documentId));
    const documents = (await this.store.bodies())
      .filter((doc) => known.has(doc.documentId))
      .map((doc) => this.sessions.get(doc.documentId)?.document ?? doc);
    const ancestors = new Set([candidate.documentId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const doc of documents)
        if (
          !ancestors.has(doc.documentId) &&
          doc.features.some((f) => f.kind === 'instance' && ancestors.has(f.params.document))
        ) {
          ancestors.add(doc.documentId);
          changed = true;
        }
    }
    for (const doc of documents) {
      if (doc.documentId === candidate.documentId || !ancestors.has(doc.documentId)) continue;
      // Missing/empty results can be repaired separately; edits cannot introduce invalid ancestor graphs.
      try {
        await this.referencedDocuments(doc, candidate);
      } catch (error) {
        if (
          error instanceof CadError &&
          ['INSTANCE_CYCLE', 'INSTANCE_DEPTH', 'ASSEMBLY_LIMIT'].includes(error.code)
        )
          throw error;
      }
    }
  }

  private refreshSummary(document: CadDocument): void {
    this.summaries = [
      summarize(document, undefined, this.sessions.get(document.documentId)?.storageVersion),
      ...this.summaries.filter((s) => s.documentId !== document.documentId),
    ];
  }

  private async persist(session: Session, candidate = session.document, history = { undo: session.undo, redo: session.redo }, references?: Record<string, number>): Promise<undefined> {
    let version: number;
    try { version = await this.store.put(copyDocument(candidate), session.storageVersion, history, references); }
    catch (error) {
      this.worker.stop();
      if (error instanceof CadError) throw error;
      throw new CadError('PERSISTENCE_FAILED', `The model transaction failed: ${String(error)}. Committed model and history are unchanged.`);
    }
    session.storageVersion = version;
    session.document = candidate;
    session.undo = history.undo;
    session.redo = history.redo;
    this.refreshSummary(candidate);
    this.publish({ persistence: 'Saved in local SQLite' });
    return undefined;
  }

  private result(
    operation: CommandName,
    session: Session,
    document = session.document,
    evaluation = session.evaluation
  ): CadResult {
    const health = modelHealth(document, session.needsRefresh && evaluation === session.evaluation ? { ...evaluation, analysis: undefined } : evaluation, session.checkedRevision);
    return {
      health,
      nextSteps: healthHints(health, evaluation.analysis, document),
      operation,
      status: 'success',
      documentId: document.documentId,
      revision: document.revision,
      storageVersion: session.storageVersion,
      created: [],
      updated: [],
      warnings: [],
      document: copyDocument(document),
      ...(evaluation.stats ? { evaluationStats: evaluation.stats } : {}),
      ...(evaluation.instances ? { instances: evaluation.instances } : {}),
      provenance: { documentId: document.documentId, revision: document.revision, sources: [...(evaluation.references ?? [])] },
      geometry: evaluation.geometry.filter((info) => evaluation.visibleFeatureIds.includes(info.featureId)),
      visibleFeatureIds: [...evaluation.visibleFeatureIds],
      history: { canUndo: !!session.undo.length, canRedo: !!session.redo.length },
    };
  }

  /** Exact evaluation of a candidate within the command deadline. Never changes committed state. */
  private async evaluate(
    candidate: CadDocument,
    deadline: number,
    analyze?: { featureIds?: string[] },
    replay?: { step: number; key?: string; storageVersion: number },
    display?: import('../shared/protocol').DisplayRequest,
    meshes = this.wantsDisplay,
    sections?: import('./types').SectionRequest,
    reuseDisplay = false
  ): Promise<Evaluation> {
    validateDocument(candidate);
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new CadError(
        'COMMAND_EXPIRED',
        'This command expired before evaluation. The committed model is unchanged.'
      );
    this.referenceVersions = {};
    const documents = await this.referencedDocuments(candidate);
    const started = performance.now();
    let evaluation: Evaluation;
    let cacheMs = 0;
    try {
      const key = JSON.stringify([candidate.documentId, replay?.storageVersion, Object.entries(this.referenceVersions).sort(([a],[b]) => a.localeCompare(b))]);
      if (replay?.key && replay.key !== key) throw new CadError('REPLAY_STALE', 'The assembly or a source changed. Exit to latest and restart component replay.');
      const prepared = reuseDisplay && meshes && !analyze && !replay && !display && !sections;
      const lookupStarted = performance.now();
      const cached = prepared ? this.preparedDisplay?.get(candidate, documents) : undefined;
      cacheMs += performance.now() - lookupStarted;
      evaluation = cached ?? await this.worker.evaluate(candidate, Math.max(1, deadline - performance.now()), analyze, documents, replay ? { step: replay.step, key } : undefined, display, undefined, { meshes: meshes || !!replay || !!display, ...(sections ? { sections } : {}) });
      if (!cached||!evaluation.displayKey) await identifyDisplay(evaluation, candidate, documents);
      const cacheStarted = performance.now();
      if (prepared && !cached) this.preparedDisplay?.put(candidate, documents, evaluation);
      cacheMs += performance.now() - cacheStarted;
    } catch (error) {
      if (this.timings && !this.refreshing) this.timings.geometryEvaluationMs += performance.now() - started;
      throw error;
    }
    if (this.timings && !this.refreshing) {
      const elapsed = performance.now() - started;
      const analysisMs = Math.min(elapsed, evaluation.stats?.analysis?.durationMs ?? evaluation.analysis?.durationMs ?? 0);
      this.timings.analysisMs += analysisMs;
      this.timings.geometryEvaluationMs += Math.max(0, elapsed - analysisMs - cacheMs);
    }
    if (performance.now() >= deadline) {
      this.worker.stop();
      throw new CadError(
        'COMMAND_EXPIRED',
        'Evaluation finished after its deadline. The worker was discarded and the committed model is unchanged.'
      );
    }
    return evaluation;
  }

  private async commit(session: Session, candidate: CadDocument, evaluation: Evaluation, action: History): Promise<undefined> {
    const previous = copyDocument(session.document);
    const undo = [...session.undo], redo = [...session.redo];
    if (action === 'undo') { undo.pop(); redo.push(previous); }
    else if (action === 'redo') { redo.pop(); undo.push(previous); }
    else { undo.push(previous); redo.length = 0; }
    // Persist first. A conflict/failure cannot change committed runtime state or its history.
    await this.persist(session, candidate, { undo: undo.slice(-HISTORY_LIMIT), redo: redo.slice(-HISTORY_LIMIT) }, this.referenceVersions);
    session.sourceVersions = { ...this.referenceVersions };
    session.evaluation = evaluation;
    session.needsRefresh = false;
    if (evaluation.analysis?.scope === 'document' && !evaluation.analysis.skipped) session.checkedRevision = candidate.revision;
    await this.store.setPreference(`selection:${candidate.documentId}`, JSON.stringify(candidate.selectedFeatureIds)).catch(() => {});
    this.publish();
    return undefined;
  }

  private requireFeature(session: Session, id: string): void {
    if (!session.document.features.some((feature) => feature.id === id))
      throw new CadError(
        'FEATURE_NOT_FOUND',
        `Feature '${id}' does not exist in '${session.document.name ?? session.document.documentId}'.`
      );
  }

  /** The candidate document a changing command would commit. Feature edits go through the pure edit module. */
  private plan(session: Session, command: CadCommand): EditOutcome & { history: History } {
    const current = session.document;
    if (command.type === 'document_action') {
      const { action, document } = command.params;
      if (action !== 'load' && document)
        throw new CadError('INVALID_ARGUMENT', 'A document is only accepted with the load action.');
      const candidate = copyDocument(current);
      let history: History = 'append';
      if (action === 'reset') {
        candidate.features = [];
        candidate.selectedFeatureIds = [];
        delete candidate.parameters;
        delete candidate.analysis;
        delete candidate.presentation;
      } else if (action === 'load') {
        if (!document)
          throw new CadError('INVALID_ARGUMENT', 'The load action requires a schema-version-1 document.');
        const loaded = validateDocument(document);
        // Loading replaces content in the target document; its identity, name and revision clock remain stable.
        candidate.schemaVersion=loaded.schemaVersion;
        candidate.graphicAssets=loaded.graphicAssets;
        candidate.kind = loaded.kind;
        candidate.features = loaded.features;
        candidate.selectedFeatureIds = loaded.selectedFeatureIds;
        if (loaded.parameters) candidate.parameters = loaded.parameters;
        else delete candidate.parameters;
        if (loaded.analysis) candidate.analysis = loaded.analysis;
        else delete candidate.analysis;
        if (loaded.presentation) candidate.presentation = loaded.presentation;
        else delete candidate.presentation;
        resolveBindings(candidate);
      } else {
        const snapshot = action === 'undo' ? session.undo.at(-1) : session.redo.at(-1);
        if (!snapshot) throw new CadError('HISTORY_EMPTY', `There is no edit to ${action}.`);
        candidate.schemaVersion=snapshot.schemaVersion;
        candidate.graphicAssets=snapshot.graphicAssets;
        candidate.kind = snapshot.kind;
        candidate.features = copyDocument(snapshot).features;
        if (snapshot.parameters) candidate.parameters = structuredClone(snapshot.parameters);
        else delete candidate.parameters;
        if (snapshot.analysis) candidate.analysis = structuredClone(snapshot.analysis);
        else delete candidate.analysis;
        if (snapshot.presentation) candidate.presentation = structuredClone(snapshot.presentation);
        else delete candidate.presentation;
        candidate.selectedFeatureIds = [...snapshot.selectedFeatureIds];
        history = action === 'undo' ? 'undo' : 'redo';
      }
      return {
        document: candidate,
        created: [],
        updated: candidate.features.map((f) => f.id),
        deleted: [],
        warnings: [],
        history,
      };
    }
    if (command.type !== 'apply_edits') {
      throw new CadError('UNSUPPORTED_COMMAND', `'${command.type}' does not change features.`);
    }
    const inherited=new Map(session.evaluation.geometry.map(g=>[g.featureId,g.appearance??{}]));
    for(const mesh of session.evaluation.meshes){const previous=inherited.get(mesh.featureId)??{},graphics=new Map([...(previous.graphics??[]),...(mesh.appearance?.graphics??[])].map(g=>[g.id,g]));inherited.set(mesh.featureId,{...previous,...mesh.appearance,graphics:[...graphics.values()]});}
    const outcome = applyEdits(current, command.params.edits,inherited);
    if (command.params.select) {
      outcome.document.selectedFeatureIds = [...new Set(command.params.select)];
      validateDocument(outcome.document);
    }
    return { ...outcome, history: 'append' };
  }

  /** Workspace management: list, create, duplicate, rename, delete and open part documents. */
  private async manage(
    command: Extract<CadCommand, { type: 'documents' }>,
    deadline: number
  ): Promise<CadResult> {
    const { action, documentId, name, expectedRevision, kind, requestId, projectId, expectedStorageVersion } = command.params;
    const warnings: string[] = [];
    this.summaries = await this.store.list();
    this.projects = (await this.store.operation({ action: 'projects' })).projects!;
    if (action === 'duplicate_project') {
      const copied = await this.store.operation({ action, projectId: projectId!, requestId: requestId ?? crypto.randomUUID(),
        expectedVersion: expectedStorageVersion!, documentVersions: command.params.documentVersions!, ...(name ? { name } : {}) });
      this.projects = (await this.store.operation({ action: 'projects' })).projects!;
      this.summaries = await this.store.list(); this.publish();
      const active = this.sessions.get(this.activeId);
      return { ...(active ? this.result('documents', active) : { operation: 'documents' as const, status: 'success' as const, created: [], updated: [], warnings: [] }),
        requestId: copied.duplication!.projectId, duplication: copied.duplication, ...(copied.replayed ? { replayed: true } : {}),
        projects: this.projects, documents: this.state.documents,
        warnings: copied.duplication!.externalDocumentIds.length ? ['References outside the source project remain shared. Edits to those sources affect both projects.'] : [] };
    }
    if (['create_project','rename_project','delete_project','set_main_assembly'].includes(action)) {
      const id = projectId ?? requestId ?? crypto.randomUUID();
      const project = this.projects.find(p => p.projectId === id);
      if (action === 'delete_project') await this.store.operation({ action: 'remove_project', projectId: id, expectedVersion: expectedStorageVersion!, documentVersions: command.params.documentVersions });
      else {
        if (action !== 'create_project' && !project) throw new CadError('PROJECT_NOT_FOUND', 'Project does not exist.');
        await this.store.operation({ action: 'project', project: action === 'create_project' ? { projectId: id, name: name!, version: 1 } : { ...project!, ...(action === 'rename_project' ? { name: name! } : { mainAssemblyId: documentId! }) }, expectedVersion: action === 'create_project' ? null : expectedStorageVersion! });
      }
      await this.syncStorage(true);
      this.projects = (await this.store.operation({ action: 'projects' })).projects!;
      this.summaries = await this.store.list();
      this.publish();
      const active = this.sessions.get(this.activeId);
      return { ...(active ? this.result('documents', active) : { operation: 'documents' as const, status: 'success' as const, created: [], updated: [], warnings: [] }),
        ...(action==='create_project'?{createdProjectId:id,requestId:requestId??id}:{}), projects: this.projects, documents: this.state.documents };
    }
    if (action === 'history') return { ...this.result('documents', await this.session(documentId!, deadline, false)), revisions: (await this.store.operation({ action: 'history', documentId: documentId! })).revisions }; 
    if (kind && action !== 'create')
      throw new CadError('INVALID_ARGUMENT', 'kind is only accepted when creating a document.');
    const need = <T>(value: T | undefined, field: string): T => {
      if (value === undefined)
        throw new CadError('INVALID_ARGUMENT', `documents ${action} requires ${field}.`);
      return value;
    };
    let target = this.activeId;
    if (action === 'create' || action === 'duplicate') {
      const creation = requestId ? { requestId, action, ...(documentId ? { documentId } : {}), ...(name ? { name } : {}), ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), ...(expectedStorageVersion ? { expectedStorageVersion } : {}) } : undefined;
      // The request UUID is also the document UUID. The document and its original
      // creation arguments persist atomically, including across bridge cache eviction.
      const prior = requestId ? await this.store.get(requestId) : undefined;
      if (prior) {
        const existing = validateDocument(prior);
        if (JSON.stringify(existing.creation) !== JSON.stringify(creation))
          throw new CadError('REQUEST_ID_CONFLICT', 'This requestId belongs to a different creation. Use documents list with requestId to recover it; keep the original arguments.');
        this.publish();
        return { ...this.creationResult(existing, requestId, action === 'duplicate'), replayed: true };
      }
      const sourceSession = action === 'duplicate' ? await this.session(need(documentId, 'documentId'), deadline, false) : undefined;
      if (sourceSession && expectedStorageVersion !== undefined && expectedStorageVersion !== sourceSession.storageVersion)
        throw new CadError('STORAGE_CONFLICT', 'Source changed. Read its current storageVersion before duplicating.');
      const source = sourceSession?.document;
      const created: CadDocument = source
        ? {
            ...copyDocument(source),
            documentId: crypto.randomUUID(),
            revision: 0,
            name: name ?? copyName(source.name ?? DEFAULT_NAME),
          }
        : {
            ...emptyDocument(),
            kind: kind ?? 'part',
            name: name ?? (kind === 'assembly' ? 'Untitled assembly' : DEFAULT_NAME),
          };
      created.projectId = projectId ?? source?.projectId ?? this.sessions.get(this.activeId)?.document.projectId;
      if (!created.projectId || !this.projects.some(p=>p.projectId===created.projectId)) throw new CadError('PROJECT_REQUIRED','Choose or create a project before creating a part or assembly.');
      if (creation) { created.documentId = requestId!; created.creation = creation; }
      else delete created.creation;
      const version = await this.store.put(created, null, undefined, sourceSession ? { [sourceSession.document.documentId]: sourceSession.storageVersion } : undefined);
      this.refreshSummary(created);
      this.summaries = this.summaries.map(s => s.documentId === created.documentId ? { ...s, storageVersion: version } : s);
      this.publish();
      // Creation receipts need no geometry/analysis. Inspection loads the new session on demand.
      return this.creationResult(created, requestId, action === 'duplicate');
    } else if (action === 'rename' || action === 'move') {
      const session = await this.session(need(documentId, 'documentId'), deadline, false);
      if (expectedStorageVersion !== session.storageVersion) throw new CadError('STORAGE_CONFLICT', 'Metadata changed. Read storageVersion again before editing.');
      const candidate = { ...session.document, ...(action === 'rename' ? { name: need(name, 'name') } : { projectId: need(projectId, 'projectId') }) };
      await this.persist(session, candidate);
      warnings.push(...await this.refreshAssemblies(session.document, deadline));
      target = session.document.documentId;
    } else if (action === 'delete') {
      const session = await this.session(need(documentId, 'documentId'), deadline, false);
      checkContext(session.document, {
        documentId: session.document.documentId,
        expectedRevision: need(expectedRevision, 'expectedRevision'),
      });
      if (this.summaries.length <= 1)
        throw new CadError(
          'LAST_DOCUMENT',
          'The workspace needs at least one document. Create another before deleting this one.'
        );
      const referencing: { documentId: string; name: string; featureIds: string[] }[] = [];
      const known = new Set(this.summaries.map((summary) => summary.documentId));
      for (const stored of await this.store.bodies()) {
        if (!known.has(stored.documentId)) continue;
        const doc = this.sessions.get(stored.documentId)?.document ?? stored;
        const featureIds = doc.features
          .filter((f) => f.kind === 'instance' && f.params.document === session.document.documentId)
          .map((f) => f.id);
        if (featureIds.length)
          referencing.push({ documentId: doc.documentId, name: doc.name ?? DEFAULT_NAME, featureIds });
      }
      if (referencing.length)
        throw new CadError(
          'DOCUMENT_IN_USE',
          'Remove the referencing instances explicitly before deleting this document.',
          { referencingDocuments: referencing }
        );
      if (expectedStorageVersion !== undefined && expectedStorageVersion !== session.storageVersion) throw new CadError('STORAGE_CONFLICT', 'Document metadata changed. Read before deleting.');
      await this.store.remove(session.document.documentId, session.storageVersion);
      this.sessions.delete(session.document.documentId);
      this.summaries = this.summaries.filter((s) => s.documentId !== session.document.documentId);
      if (session.document.documentId === this.activeId)
        await this.open(this.summaries[0].documentId, deadline);
    } else if (action === 'open') {
      await this.open(need(documentId, 'documentId'), deadline);
      target = this.activeId;
    }
    this.publish();
    // An empty workspace is valid after its last project is deleted. Listing it needs no active document.
    if(action==='list'&&!this.summaries.length)return{operation:'documents',status:'success',created:[],updated:[],warnings,documents:[],projects:this.projects};
    const shown = await this.session(
      this.sessions.has(target) || this.summaries.some((s) => s.documentId === target)
        ? target
        : this.activeId,
      deadline, false
    );
    const result = this.result('documents', shown);
    result.warnings.push(...warnings);
    delete result.document;
    delete result.geometry;
    delete result.visibleFeatureIds;
    result.documents = this.state.documents.filter(d => !projectId || d.projectId === projectId);
    result.projects = this.projects;
    if (action === 'list' && (name || requestId)) {
      const matches: DocumentSummary[] = [];
      for (const summary of result.documents) {
        if (name && summary.name !== name) continue;
        if (requestId) {
          const raw = this.sessions.get(summary.documentId)?.document ?? await this.store.get(summary.documentId);
          if (!raw || validateDocument(raw).creation?.requestId !== requestId) continue;
        }
        matches.push(summary);
      }
      result.documents = matches;
    }
    return result;
  }

  private creationResult(document: CadDocument, requestId?: string, duplicated = false): CadResult {
    return {
      operation: 'documents', status: 'success', documentId: document.documentId, revision: document.revision,
      createdDocumentId: document.documentId, ...(requestId ? { requestId } : {}),
      created: [], updated: [], warnings: duplicated && document.features.some(f => f.kind === 'instance') ? ['This document copy retains its source references. Duplicate the project to copy its parts too.'] : [], documents: this.state.documents, storageVersion: this.summaries.find(s => s.documentId === document.documentId)?.storageVersion, projects: this.projects,
      health: modelHealth(document, EMPTY, null),
    };
  }

  /**
   * Agent commands commit without display meshes. The first viewer read adds them; with the result cache warm
   * this only tessellates. If a source changed since, the session refreshes instead.
   */
  private async ensureDisplay(session: Session, deadline: number): Promise<void> {
    if (!displayMissing(session.evaluation)) return;
    let shown = await this.evaluate(session.document, deadline, undefined, undefined, undefined, true);
    const versions = (record: Record<string, number>) => JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
    if (versions(this.referenceVersions) !== versions(session.sourceVersions)) {
      await this.refreshSession(session, deadline);
      if (!displayMissing(session.evaluation)) return;
      shown = await this.evaluate(session.document, deadline, undefined, undefined, undefined, true);
    }
    const current = session.evaluation;
    session.evaluation = {
      ...shown,
      ...(current.analysis ? { analysis: current.analysis } : {}),
      ...(current.referencesChanged ? { referencesChanged: true } : {}),
    };
    this.publish();
  }

  /** Output is a review boundary. A one-off analysis does not change the document's auto setting. */
  private async checkOutput(session: Session, skip: boolean | undefined, deadline: number): Promise<void> {
    if (session.evaluation.referenceError)
      throw new CadError('ASSEMBLY_STALE', session.evaluation.referenceError);
    if (
      skip ||
      modelHealth(session.document, session.evaluation, session.checkedRevision).analysis === 'current'
    )
      return;
    const saved=this.analysisProvider?await this.analysisProvider(session.document.documentId):undefined;
    if(this.analysisProvider&&!saved)throw new CadError('ANALYSIS_INCOMPLETE','Durable whole-document analysis is pending or unknown. Run analyze_model and wait for completion, or explicitly use skipAnalysis:true for intermediate output.');
    const analyzed = saved?{...session.evaluation,analysis:saved}:await this.evaluate(copyDocument(session.document), deadline, {});
    session.sourceVersions = { ...this.referenceVersions };
    session.evaluation = { ...analyzed, referencesChanged: session.evaluation.referencesChanged };
    session.needsRefresh = false;
    if (analyzed.analysis && !analyzed.analysis.skipped) session.checkedRevision = session.document.revision;
    this.publish();
    if (!analyzed.analysis || analyzed.analysis.skipped)
      throw new CadError(
        'ANALYSIS_INCOMPLETE',
        'Output was not produced because whole-document analysis is incomplete. Run analyze_model, simplify the model, or explicitly pass skipAnalysis:true.',
        { reason: analyzed.analysis?.skipped }
      );
  }

  private async open(documentId: string, deadline: number): Promise<void> {
    const opened = await this.session(documentId, deadline, false);
    try { await this.session(documentId, deadline); }
    catch (error) {
      if (!(error instanceof CadError) || error.code !== 'MODEL_TOO_COMPLEX') throw error;
      opened.evaluation = { ...EMPTY };
      opened.checkedRevision = null;
      this.publish({ error: `${error.message} Saved definitions and undo remain available.` });
    }
    this.activeId = documentId;
    await this.store.setPreference('activeDocumentId', documentId).catch(() => {});
    this.publish();
  }

  private async reviewOutput(session:Session,evaluation:Evaluation,params:Extract<CadCommand,{type:'render_views'}>['params'],deadline:number) {
    if(!this.renderer)throw new CadError('RENDERER_UNAVAILABLE','The managed renderer is unavailable.');
    await this.assertObserved(session);
    const graph=(await this.store.operation({action:'snapshot',documentId:session.document.documentId,snapshot:{}})).graph!;
    if(graph.snapshot.storageVersion!==session.storageVersion||graph.snapshot.sources.some(s=>session.sourceVersions[s.documentId]!==s.storageVersion))
      throw new CadError('STORAGE_CONFLICT','The model or a source changed before its review snapshot was captured.');
    const totals=reviewTotals(evaluation,params.featureId);
    const review:NonNullable<CadResult['review']>={snapshot:graph.snapshot,totals,notes:[
      'Solid validity, physical checks and visual/reference fidelity are separate judgments.',
      'No tangent/curvature-continuity certification or automatic reference similarity score was computed.',
      'Visible volumes are summed per result; overlapping independent results may count volume more than once.',
    ]};
    let sections:CadResult['sections'];
    if(params.review?.sections){
      const measured=await this.evaluate(session.document,deadline,undefined,undefined,undefined,false,
        {featureId:params.featureId,planes:params.review.sections});sections=measured.sections;
    }
    let draw={...params},before:Evaluation|undefined,beforeDocument:CadDocument|undefined;
    let comparisonBounds:import('../shared/protocol').Bounds|undefined;
    if(params.review?.compareTo){
      const baseline=(await this.store.operation({action:'snapshot',documentId:session.document.documentId,snapshot:{id:params.review.compareTo}})).graph!;
      if(baseline.document.documentId!==session.document.documentId)throw new CadError('SNAPSHOT_DOCUMENT_MISMATCH','Comparison baseline belongs to another document.');
      if(params.featureId&&!baseline.document.features.some(f=>f.id===params.featureId))
        throw new CadError('FEATURE_NOT_FOUND','The selected result did not exist in this baseline. Compare whole documents instead.');
      const started=performance.now();
      try{before=await this.worker.evaluate(baseline.document,Math.max(1,deadline-performance.now()),undefined,baseline.documents,undefined,
        params.featureId?{expectedRevision:baseline.document.revision,expectedStorageVersion:baseline.snapshot.storageVersion,featureIds:[params.featureId]}:undefined,
        undefined,{meshes:true});}
      finally{if(this.timings)this.timings.geometryEvaluationMs+=performance.now()-started;}
      beforeDocument={...baseline.document,presentation:session.document.presentation};
      const prior=reviewTotals(before,params.featureId);
      review.comparison={snapshotId:baseline.snapshot.snapshotId,revision:baseline.document.revision,before:prior,
        sizeDeltaMm:totals.size.map((n,i)=>n-prior.size[i]) as import('../shared/protocol').Vector3,
        visibleVolumeDeltaMm3:totals.sumVisibleVolumesMm3-prior.sumVisibleVolumesMm3,
        visibleAdded:evaluation.visibleFeatureIds.filter(id=>!before!.visibleFeatureIds.includes(id)),
        visibleRemoved:before.visibleFeatureIds.filter(id=>!evaluation.visibleFeatureIds.includes(id))};
      const min=prior.min.map((n,i)=>Math.min(n,totals.min[i])) as import('../shared/protocol').Vector3;
      const max=prior.max.map((n,i)=>Math.max(n,totals.max[i])) as import('../shared/protocol').Vector3;
      comparisonBounds={min,max,size:max.map((n,i)=>n-min[i]) as import('../shared/protocol').Vector3};
      draw={...draw,views:undefined,shots:comparisonShots(params.shots??(params.views??['front','right','top','isometric']).map(view=>({view})),prior,totals,[before,evaluation])};
      review.notes.push('Before and after use matching framing and scene settings. The baseline image has no current-analysis certificate.');
    }
    const render:ContactSheetRenderer=async(...args)=>{
      const started=performance.now();try{return await this.renderer!(...args);}
      finally{if(this.timings)this.timings.renderExportMs+=performance.now()-started;}
    };
    const image=await render(evaluation,{type:'render_views',params:draw},session.document,
      modelHealth(session.document,session.evaluation,session.checkedRevision),outputBudget(deadline),comparisonBounds);
    if(before&&beforeDocument){
      const baseline=await render(before,{type:'render_views',params:{...draw,review:undefined,outputs:'sheet'}},beforeDocument,
        modelHealth(beforeDocument,before,null),outputBudget(deadline),comparisonBounds);
      (image.panels??=[]).push({kind:'baseline',label:`Baseline r${beforeDocument.revision}`,mimeType:'image/png',
        base64:baseline.base64,width:baseline.width,height:baseline.height,tiles:baseline.tiles});
    }
    if(image.base64.length+(image.panels??[]).reduce((n,p)=>n+p.base64.length,0)>16*1024*1024)
      throw new CadError('REVIEW_TOO_LARGE','Inspection images exceed the 16 MiB encoded bundle budget. Reduce tileSize or the number of shots/profiles.');
    await this.assertObserved(session);
    return {image,review,...(sections?{sections}:{})};
  }

  private async run(value: unknown, received: number, display = true): Promise<Outcome> {
    this.wantsDisplay = display;
    const timings: CommandTimings = { queueWaitMs: performance.now() - received, geometryEvaluationMs: 0, analysisMs: 0, dependentRefreshMs: 0, renderExportMs: 0, runtimeOtherMs: 0 };
    this.timings = timings;
    const finish = (result: CadResult) => {
      const duration = performance.now() - received;
      timings.runtimeOtherMs = Math.max(0, duration - Object.values(timings).reduce((sum, value) => sum + value, 0));
      result.durationMs = Math.round(duration * 10) / 10;
      result.timings = Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.round(value * 10) / 10])) as unknown as CommandTimings;
      this.timings = undefined;
      this.refreshing = false;
    };
    let operation: CommandName =
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      typeof value.type === 'string' &&
      Object.hasOwn(commandSchemas, value.type)
        ? (value.type as CommandName)
        : 'inspect_model';
    // Dry runs never change committed state, so they neither show busy nor report as the last command.
    let quiet = false;
    let result: CadResult;
    let evaluation: Evaluation | undefined;
    let session: Session | undefined;
    try {
      const command = parseCommand(value);
      operation = command.type;
      quiet = (command.type === 'apply_edits' && !!command.params.dryRun) || (command.type === 'inspect_model' && (!!command.params.replay || !!command.params.display));
      if (this.state.phase !== 'ready')
        throw new CadError(
          'RUNTIME_NOT_READY',
          this.state.error ??
            'The exact geometry kernel is still initializing. Wait for Ready before sending commands.'
        );
      // Leave time for the bridge response. Commands waiting behind another edit can expire without executing.
      const deadline = received + COMMAND_TIMEOUT_MS - 3_000;
      if (performance.now() >= deadline)
        throw new CadError(
          'COMMAND_EXPIRED',
          'This command expired in the execution queue and was not executed.'
        );
      if (!quiet) this.publish({ busy: true, activity: command.type, error: undefined });
      await this.syncStorage(true);
      if (command.type === 'documents') {
        result = await this.manage(command, deadline);
        finish(result);
        if (!quiet) this.publish({ busy: false, activity: 'Ready', lastResult: result });
        return { result };
      }
      // Commands address a document by id; reads without one use the document the human has open.
      session = await this.session(
        ('documentId' in command.params && command.params.documentId) || this.activeId,
        deadline, false
      );
      const definitionsOnly = command.type === 'inspect_model' && command.params.definitionsOnly;
      const projectionOnly = command.type === 'inspect_model' && !!(command.params.replay || command.params.display);
      const requiresCurrent = command.type !== 'select_features' && !this.changesModel(command) && !definitionsOnly && !projectionOnly && command.type !== 'analyze_model' && !(command.type === 'export_model' && command.params.format === 'json');
      if (requiresCurrent) await this.session(session.document.documentId, deadline, true, command.type === 'inspect_model' || (command.type === 'render_views' || command.type === 'export_model') && command.params.skipAnalysis === true, command.type === 'render_views' || (command.type === 'export_model' && command.params.format === 'glb') || this.wantsDisplay, command.type === 'inspect_model');
      const current = session.document;
      if ('expectedStorageVersion' in command.params && command.params.expectedStorageVersion !== undefined && command.params.expectedStorageVersion !== session.storageVersion) throw new CadError('STORAGE_CONFLICT', 'Document storage version changed. Read before editing.');
      if ('expectedRevision' in command.params)
        checkContext(current, command.params as { documentId: string; expectedRevision: number });
      result = this.result(operation, session);
      if (command.type === 'inspect_model') {
        if (command.params.display) {
          checkContext(current,{documentId:current.documentId,expectedRevision:command.params.display.expectedRevision});
          if(command.params.display.expectedStorageVersion !== session.storageVersion) throw new CadError('STORAGE_CONFLICT','Display context changed. Read the model again.');
          evaluation = await this.evaluate(current,deadline,undefined,undefined,command.params.display);
          result = this.result(operation,session,current,evaluation);
          result.warnings.push('View-only display projection. Exact geometry is unchanged; final physical analysis is not repeated.');
        }
        if (command.params.replay) {
          checkContext(current, { documentId: current.documentId, expectedRevision: command.params.replay.expectedRevision });
          if (command.params.replay.expectedStorageVersion !== session.storageVersion) throw new CadError('REPLAY_STALE', 'The document changed. Exit to latest and restart component replay.');
          evaluation = await this.evaluate(current, deadline, undefined, { ...command.params.replay, storageVersion: session.storageVersion });
          result = { ...this.result(operation, session, current, evaluation), replay: evaluation.replay };
          result.warnings.push('View-only current construction. Frame geometry is exact; final-model analysis and original edit chronology are not replayed.');
          result.nextSteps = ['Exit replay to inspect or edit the latest committed model.'];
        }
        if (command.params.select?.topology) {
          const target = command.params.select.topology.target.feature;
          this.requireFeature(session, target);
          evaluation = await this.evaluate(current,deadline,undefined,undefined,{expectedRevision:current.revision,expectedStorageVersion:session.storageVersion,featureIds:[target]});
        }
        if (command.params.featureId) {
          this.requireFeature(session, command.params.featureId);
          evaluation = await this.evaluate(current,deadline,undefined,undefined,{expectedRevision:current.revision,expectedStorageVersion:session.storageVersion,featureIds:[command.params.featureId]});
          result.geometry = session.evaluation.geometry.filter(
            (g) => g.featureId === command.params.featureId
          );
        }
        if (command.params.sections) {
          // Exact cuts come from the worker's B-reps; no display meshes are needed for them.
          const measured = await this.evaluate(current, deadline, undefined, undefined, undefined, false, { featureId: command.params.featureId, planes: command.params.sections });
          result.sections = measured.sections;
        }
        if (definitionsOnly) { result.geometry = []; result.visibleFeatureIds = []; result.warnings.push('Saved definitions only. Geometry and analysis have not been evaluated for this read.'); }
        if (!definitionsOnly && !projectionOnly && session.evaluation.analysis) result.analysis = publicAnalysis(session.evaluation.analysis);
        result.documents = this.state.documents;
        result.projects = this.projects;
      } else if (command.type === 'analyze_model') {
        command.params.featureIds?.forEach((id) => this.requireFeature(session!, id));
        // Analysis rebuilds the current graph itself; do not spend the deadline refreshing it first.
        // Display tessellation is incidental here. Exact bounds, distance and common volume are unchanged.
        const evaluated = await this.evaluate(copyDocument(current), deadline, {
          featureIds: command.params.featureIds,
        });
        const analyzed = { ...evaluated, referencesChanged: session.evaluation.referencesChanged || JSON.stringify(session.evaluation.references) !== JSON.stringify(evaluated.references) };
        result = {
          ...this.result(operation, session, current, analyzed),
          analysis: analyzed.analysis && publicAnalysis(analyzed.analysis),
        };
        result.warnings.push(...analysisWarnings(analyzed.analysis));
        // Reuse this current geometry and its findings for subsequent reads.
        if (!command.params.featureIds) {
          session.sourceVersions = { ...this.referenceVersions };
          session.evaluation = analyzed;
          session.needsRefresh = false;
          session.checkedRevision = analyzed.analysis && !analyzed.analysis.skipped ? current.revision : null;
          this.publish();
        }
      } else if (command.type === 'select_features') {
        command.params.featureIds.forEach((id) => this.requireFeature(session!, id));
        const ids = [...new Set(command.params.featureIds)];
        // Selection belongs to this client view and never writes shared model data.
        if (JSON.stringify(ids) !== JSON.stringify(current.selectedFeatureIds)) {
          await this.store.setPreference(`selection:${current.documentId}`, JSON.stringify(ids));
          session.document = { ...copyDocument(current), selectedFeatureIds: ids };
          const warning = undefined;
          result = this.result(operation, session);
          if (warning) result.warnings.push(warning);
        }
      } else if (command.type === 'render_views') {
        await this.checkOutput(session, command.params.skipAnalysis, deadline);
        result = this.result(operation, session);
        if (command.params.featureId) this.requireFeature(session, command.params.featureId);
        if (!this.renderer)
          throw new CadError('RENDERER_UNAVAILABLE', 'The managed renderer is unavailable.');
        if (!command.params.featureId) await this.ensureDisplay(session, deadline);
        const outputEvaluation = command.params.featureId ? await this.evaluate(current,deadline,undefined,undefined,{expectedRevision:current.revision,expectedStorageVersion:session.storageVersion,featureIds:[command.params.featureId]}) : session.evaluation;
        if(command.params.review)Object.assign(result,await this.reviewOutput(session,outputEvaluation,command.params,deadline));
        else{
          const started=performance.now();
          try{result.image=await this.renderer(outputEvaluation,command,current,result.health!,outputBudget(deadline));}
          finally{timings.renderExportMs+=performance.now()-started;}
        }
      } else if (command.type === 'export_model') {
        if (!(command.params.format === 'json' && command.params.skipAnalysis))
          await this.checkOutput(session, command.params.skipAnalysis, deadline);
        result = this.result(operation, session);
        if (command.params.featureId) this.requireFeature(session, command.params.featureId);
        const { format, filename } = command.params;
        if(command.params.look&&format!=='glb')throw new CadError('EXPORT_LOOK_UNSUPPORTED','The look option applies to GLB display export only.');
        const requestedIds = command.params.featureId
          ? [command.params.featureId]
          : session.evaluation.visibleFeatureIds;
        const sheets=requestedIds.filter(id=>session!.evaluation.geometry.find(g=>g.featureId===id)?.resultKind==='sheet');
        const ids=format==='json'?requestedIds:requestedIds.filter(id=>!sheets.includes(id));
        if(sheets.length&&format!=='json')result.warnings.push(`CONSTRUCTION_SHEETS_OMITTED: ${sheets.join(', ')}; ${format.toUpperCase()} includes physical solids only. JSON preserves construction history.`);
        if (!ids.length && format !== 'json')
          throw new CadError('EMPTY_MODEL', 'Create a solid before exporting.');
        let exported: { bytes: ArrayBuffer; mimeType: string; warnings?: string[] };
        const started = performance.now();
        try {
        if (format === 'json')
          exported = {
            bytes: new TextEncoder().encode(JSON.stringify(current, null, 2)).buffer as ArrayBuffer,
            mimeType: 'application/json',
          };
        else if (format === 'glb') {
          if (!this.meshExporter)
            throw new CadError(
              'EXPORT_UNAVAILABLE',
              'The GLB mesh exporter is unavailable. Wait for the human recovery steps, then retry the export.'
            );
          if (!command.params.featureId) await this.ensureDisplay(session, deadline);
          const outputEvaluation = command.params.featureId ? await this.evaluate(current,deadline,undefined,undefined,{expectedRevision:current.revision,expectedStorageVersion:session.storageVersion,featureIds:[command.params.featureId]}) : session.evaluation;
          const exportEvaluation=command.params.look==='studio'?{...outputEvaluation,meshes:outputEvaluation.meshes.map(mesh=>{const look=resolveLook(mesh.appearance,current.presentation,'studio');return{...mesh,appearance:{...mesh.appearance,roughness:look.roughness,coat:look.clearcoat?'clear' as const:'none' as const,detail:look.detail,detailScale:look.detailScale}};})}:outputEvaluation;
          if(command.params.look==='studio')result.warnings.push('Studio material looks applied to this GLB display export only. Physical material and exact geometry are unchanged.');
          exported = await this.meshExporter(exportEvaluation, current, ids, outputBudget(deadline));
        } else
          exported = await this.worker.export(format, ids, current, await this.referencedDocuments(current));
        result.warnings.push(...(exported.warnings??[]));
        const suffix = `.${format}`;
        const stem =
          filename ??
          `${(current.name ?? 'vibeworks').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'vibeworks'}-r${current.revision}`;
        result.artifact = {
          filename: stem.toLowerCase().endsWith(suffix) ? stem : `${stem}${suffix}`,
          mimeType: exported.mimeType,
          byteLength: exported.bytes.byteLength,
          base64: bytesToBase64(new Uint8Array(exported.bytes)),
        };
        } finally { timings.renderExportMs += performance.now() - started; }
      } else if (command.type === 'document_action' && command.params.action === 'save') {
        if (command.params.document)
          throw new CadError('INVALID_ARGUMENT', 'A document is only accepted with the load action.');
        const warning = await this.persist(session);
        if (warning) throw new CadError('PERSISTENCE_FAILED', warning);
      } else {
        if(command.type==='apply_edits'&&command.params.edits.some(e=>e.op==='appearance'&&e.graphics&&current.features.some(f=>f.id===e.target.feature&&f.kind==='instance')))await this.ensureDisplay(session,deadline);
        const change = this.plan(session, command);
        try { await normalizeGraphicAssets(change.document); } catch(error) { throw new CadError((error as {code?:string}).code??'ASSET_INVALID',error instanceof Error?error.message:String(error)); }
        await this.validateAncestors(change.document);
        // Per-call override first, then the document's setting; analysis is on unless turned off.
        const override =
          command.type === 'apply_edits' || command.type === 'document_action'
            ? command.params.analyze
            : undefined;
        const analyze = !this.analysisProvider && (override ?? change.document.analysis?.auto ?? true) ? {} : undefined;
        const presentationOnly = override !== true && !session.needsRefresh && !session.evaluation.referenceError &&
          session.evaluation.geometry.length === current.features.length && appearanceOnly(current, change.document);
        const committedSession = session;
        const evaluateChange = async () => {
          if (presentationOnly && !current.features.some(feature => feature.kind === 'instance')) {
            this.referenceVersions = { ...committedSession.sourceVersions };
            const restyled = restylePart(change.document, committedSession.evaluation, current.revision);
            await identifyDisplay(restyled, change.document, []);
            return restyled;
          }
          const next = await this.evaluate(change.document, deadline, presentationOnly ? undefined : analyze);
          if (presentationOnly && committedSession.evaluation.analysis?.revision === current.revision &&
              JSON.stringify(committedSession.sourceVersions) === JSON.stringify(this.referenceVersions))
            next.analysis = { ...committedSession.evaluation.analysis, revision: change.document.revision };
          return next;
        };
        if (quiet) {
          change.document.revision = current.revision;
          evaluation = await evaluateChange();
          result = this.result(operation, session, change.document, evaluation);
          delete result.document;
          result.dryRun = true;
          result.warnings.push(
            'Dry run: nothing was committed. Send the same edits without dryRun at this revision to apply them.'
          );
        } else {
          change.document.revision = nextRevision(current);
          evaluation = await evaluateChange();
          const warning = await this.commit(session, change.document, evaluation, change.history);
          result = this.result(operation, session);
          if (warning) result.warnings.push(warning);
          result.warnings.push(...(await this.refreshAssemblies(change.document, deadline)));
        }
        result.created = change.created;
        result.updated = change.updated;
        result.warnings.push(...change.warnings);
        if (change.deleted.length) result.deleted = change.deleted;
        if('removedChecks' in change&&change.removedChecks?.length)result.removedChecks=change.removedChecks;
        if (evaluation.analysis) {
          result.analysis = publicAnalysis(evaluation.analysis);
          result.warnings.push(...analysisWarnings(evaluation.analysis));
        }
      }
      if (!quiet) {
        result.health = modelHealth(session.document, session.evaluation, session.checkedRevision);
        result.nextSteps = healthHints(result.health, session.evaluation.analysis, session.document);
      }
      if(command.type==='apply_edits'&&command.params.review&&!quiet){
        try{
          await this.ensureDisplay(session,deadline);
          const options=command.params.review;
          Object.assign(result,await this.reviewOutput(session,session.evaluation,{documentId:session.document.documentId,
            shots:options.shots,tileSize:options.tileSize,appearance:options.appearance,outputs:'both',
            review:{compareTo:options.compareTo,sections:options.sections,profiles:options.profiles}},deadline));
        }catch(error){
          result.reviewFailure={code:error instanceof CadError?error.code:'REVIEW_FAILED',message:error instanceof Error?error.message:String(error),committed:true};
          result.warnings.push('Edit committed successfully; its inspection output failed. Use render_views at this revision. Do not repeat the edit.');
        }
      }
      if (result.evaluationStats?.display?.reduced) result.warnings.push(`Display tessellation reduced to ${result.evaluationStats.display.toleranceMm} mm for this view; exact geometry and STEP are unchanged.`);
      if (result.health?.analysis !== 'current')
        result.warnings.push(...(result.nextSteps?.slice(0, 1) ?? []));
      if (display && session && !quiet && !definitionsOnly && command.type !== 'select_features') {
        if (!this.changesModel(command)) await this.ensureDisplay(session, deadline);
        if (session.evaluation.displayError) result.warnings.push(`Display unavailable: ${session.evaluation.displayError} The exact model is ${this.changesModel(command) ? 'committed' : 'unchanged'}.`);
      }
      if (session && command.type !== 'select_features' && !this.changesModel(command) && !definitionsOnly && !(command.type === 'export_model' && command.params.format === 'json')) await this.assertObserved(quiet ? { ...session, evaluation: evaluation!, sourceVersions: { ...this.referenceVersions } } : session);
      finish(result);
      if (!quiet) this.publish({ busy: false, activity: 'Ready', lastResult: result });
    } catch (error) {
      const code =
        error instanceof CadError
          ? error.code
          : error instanceof Error && error.name === 'ZodError'
            ? 'INVALID_ARGUMENT'
            : 'RUNTIME_ERROR';
      const requestedId = typeof value === 'object' && value !== null && 'params' in value ? (value as CadCommand).params : undefined;
      const where = session ?? this.sessions.get(requestedId && 'documentId' in requestedId && requestedId.documentId || this.activeId);
      result = {
        ...commandError(
          operation,
          code,
          error instanceof Error ? error.message : String(error),
          error instanceof CadError ? error.details : undefined
        ),
        ...(where
          ? {
              documentId: where.document.documentId,
              revision: where.document.revision,
              ...(where.evaluation.instances ? { instances: where.evaluation.instances } : {}),
              health: modelHealth(where.document, where.evaluation, where.checkedRevision),
              nextSteps: healthHints(
                modelHealth(where.document, where.evaluation, where.checkedRevision),
                where.evaluation.analysis,
                where.document
              ),
              history: { canUndo: !!where.undo.length, canRedo: !!where.redo.length },
            }
          : {}),
        durationMs: Math.round(performance.now() - received),
      };
      if (['STORAGE_CONFLICT','PERSISTENCE_FAILED','STORAGE_OUTCOME_UNKNOWN'].includes(code)) this.worker.stop();
      if (code === 'STORAGE_OUTCOME_UNKNOWN') result.error!.outcomeUnknown = true;
      if (where) result.storageVersion = where.storageVersion;
      finish(result);
      if (!quiet)
        this.publish({ busy: false, activity: 'Ready', error: result.error!.message, lastResult: result });
      evaluation = undefined;
    }
    return { result, evaluation };
  }

  private changesModel(command: CadCommand): boolean {
    return (command.type === 'apply_edits' && !command.params.dryRun) || command.type === 'document_action';
  }
  /** Reads/outputs have a linearization point after computation; writes use SQLite's atomic source CAS. */
  private async assertObserved(session: Session): Promise<void> {
    const records = await this.store.list();
    const versions = new Map(records.map(r => [r.documentId, r.storageVersion]));
    if (versions.get(session.document.documentId) !== session.storageVersion ||
        (!session.evaluation.referenceError && Object.entries(session.sourceVersions).some(([id, version]) => versions.get(id) !== version))) {
      session.needsRefresh = true;
      throw new CadError('STORAGE_CONFLICT', 'A document or source changed during geometry/output. No output was delivered. Inspect and retry against current versions.');
    }
  }

  /** Poll is bounded to 500 feed events. SQLite retains sequences across bridge restarts. */
  refreshStorage(): Promise<void> {
    return this.storageRefresh ??= this.enqueue(() => { this.wantsDisplay = true; return this.syncStorage(false); }).finally(() => { this.storageRefresh = undefined; });
  }
  private async syncStorage(required: boolean): Promise<void> {
    if (this.state.phase !== 'ready') return;
    try {
      const feed = await this.store.operation({ action: 'changes', after: this.changeCursor });
      const reset = feed.cursor! < this.changeCursor;
      if (!feed.changes!.length && !reset) return;
      const summaries = await this.store.list();
      const versions = new Map(summaries.map(summary => [summary.documentId, summary.storageVersion]));
      const invalidate: string[] = [];
      for (const [id, session] of this.sessions) {
        const summary = summaries.find(d => d.documentId === id);
        if (reset || !summary || summary.storageVersion !== session.storageVersion) invalidate.push(id);
        else if (Object.entries(session.sourceVersions).some(([source, version]) => versions.get(source) !== version)) session.needsRefresh = true;
      }
      // Preserve current runtime state if a replacement cannot be evaluated/read.
      const previous = new Map(this.sessions);
      const previousId = this.activeId;
      try {
        for (const id of invalidate) this.sessions.delete(id);
        if (!summaries.some(d => d.documentId === this.activeId)) this.activeId = summaries[0]?.documentId ?? '';
        // Command dispatch synchronizes definitions only; it evaluates the requested document later.
        if (this.activeId) await this.session(this.activeId, performance.now() + COMMAND_TIMEOUT_MS - 3000, !required);
      } catch (error) { this.sessions = previous; this.activeId = previousId; throw error; }
      this.summaries = summaries;
      this.projects = (await this.store.operation({ action: 'projects' })).projects!;
      this.changeCursor = feed.cursor!;
      this.publish({ persistence: 'Local SQLite connected' });
    } catch (error) {
      this.publish({ persistence: `Storage refresh unavailable: ${error instanceof Error ? error.message : String(error)}. Mutations are never retried automatically.` });
      if (required) throw error;
    }
  }

  async select(featureIds: string[]): Promise<void> {
    // Capture context now, just as a manual tool or an MCP client does.
    const { documentId, revision: expectedRevision } = this.state.document;
    await this.execute({ type: 'select_features', params: { documentId, expectedRevision, featureIds } });
  }

  /** Show another document here. Agents keep working on any document regardless of which one is shown. */
  openDocument(documentId: string): Promise<CadResult> {
    return this.execute({ type: 'documents', params: { action: 'open', documentId } });
  }
}

/** UI dependency is deliberately limited to client commands and projected display state. */
export type RuntimeClient = Pick<CadRuntime, 'subscribe' | 'getSnapshot' | 'initialize' | 'retryInitialization' | 'execute' | 'preview' | 'replay' | 'refreshStorage' | 'select' | 'openDocument'> & {
  manualHistoryTarget?:(action:'undo'|'redo')=>{documentId:string;name:string;revision:number;storageVersion:number;label:string}|undefined;
  manualHistoryAction?:(action:'undo'|'redo')=>Promise<CadResult>;
  acknowledgeWorkspaceView?: (requestId:string,error?:string)=>Promise<void>;
  dismissWorkspaceView?: ()=>void;
  reportWorkspaceMode?: (mode:'modeling'|'studio')=>void;
};
