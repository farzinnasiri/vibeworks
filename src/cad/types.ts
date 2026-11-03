import type { CadDocument, DisplayEvaluation as Evaluation } from '../shared/protocol';
export type { DisplayMesh, GeometryAnalysis, DisplayEvaluation as Evaluation } from '../shared/protocol';

/** Exact cuts of one result (or every visible result) after evaluation. */
export interface SectionRequest { featureId?: string; planes: { axis: 'X' | 'Y' | 'Z'; offset: number }[] }
export type WorkerTask =
  | { type: 'initialize' }
  | {type:'extract_validate';before:CadDocument[];after:CadDocument[];affected:string[]}
  | { type: 'evaluate'; topologyQuery?:NonNullable<import('../shared/protocol').InspectionSelect['topology']>; projection?: boolean; meshes?: false; document: CadDocument; documents?: CadDocument[]; replay?: { step: number; key: string }; display?: import('../shared/protocol').DisplayRequest; analyze?: { featureIds?: string[]; control?:import('./analysis-plan').AnalysisControl }; sections?: SectionRequest }
  | { type: 'export'; format: 'step' | 'stl'; featureIds: string[]; document: CadDocument; documents?: CadDocument[] };
/** budgetMs is the caller's remaining time; the worker ends optional work (analysis) before it. */
export type WorkerRequest = WorkerTask & { id: number; budgetMs?: number; analysisSeed?: import('./analysis-cache').AnalysisCheckpoint };
export type WorkerReply = { id: number; recycle?: boolean; analysisCheckpoint?: import('./analysis-cache').AnalysisCheckpoint } & (
  | { ok: true; value: Evaluation | { ready: true } | {equivalence:{method:string;documents:number;occurrences:number}} | { bytes: ArrayBuffer; mimeType: string; warnings?: string[] } }
  | { ok: false; error: { code: string; message: string; details?: unknown } }
);

/** A bridge-owned cache of successfully checked display evaluations, keyed by the complete semantic graph. */
export interface PreparedDisplayStore {
  get(document: CadDocument, documents: CadDocument[]): Evaluation | undefined;
  put(document: CadDocument, documents: CadDocument[], evaluation: Evaluation): void;
}
