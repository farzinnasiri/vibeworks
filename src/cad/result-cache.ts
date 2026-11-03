import type { Shape3D } from 'replicad';
import type { Feature, GeometryInfo } from '../shared/protocol';
import type { DisplayMesh } from './types';

// Bump when build/measure semantics, mesh tolerances, kernel or bundled font change.
const VERSION = 'geometry-v5-guided-surfaces-native-lineage/replicad-1.1.0/occt-1.1.0/mesh-0.05-0.15/plex-bold-v1';
export interface Fingerprint { hash: string; descriptor: string; inputs: Fingerprint[] }
export interface CachedResult {
  fingerprint: Fingerprint;
  shape: Shape3D;
  geometry: GeometryInfo;
  topology?: import('../shared/protocol').TopologyTable;
  topologyFeature?: Feature;
  mesh: DisplayMesh;
  meshBytes: number;
  meshQuality?: string;
  /** Display value counts per tessellation quality already computed, so auto detail can rule a quality out without re-meshing. */
  meshValues?: Record<string, number>;
}
export interface CacheLimits { maxEntries: number; maxMeshBytes: number }
const DEFAULT_CACHE_LIMITS: CacheLimits = { maxEntries: 500, maxMeshBytes: 96 * 1024 * 1024 };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export function fingerprint(feature: Feature, inputs: Fingerprint[]): Fingerprint {
  const params: Record<string, unknown> = { ...feature.params };
  // References are positional geometric inputs, not semantic names. Copy only changes visibility.
  delete params.attachment; delete params.document; delete params.featureId; delete params.target; delete params.tools; delete params.copy;
  const descriptor = JSON.stringify([VERSION, feature.kind, canonical(params)]);
  const content = JSON.stringify([descriptor, inputs.map(input => input.hash)]);
  // A hash only selects a bucket. Exact DAG comparison below makes collisions harmless.
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  return { hash: (hash >>> 0).toString(16), descriptor, inputs };
}
export function sameFingerprint(a: Fingerprint, b: Fingerprint, checked = new Map<Fingerprint, Set<Fingerprint>>()): boolean {
  if (a === b || checked.get(a)?.has(b)) return true;
  if (a.hash !== b.hash || a.descriptor !== b.descriptor || a.inputs.length !== b.inputs.length) return false;
  if (!a.inputs.every((input, i) => sameFingerprint(input, b.inputs[i], checked))) return false;
  let matches = checked.get(a);
  if (!matches) checked.set(a, matches = new Set());
  matches.add(b);
  return true;
}

/** Stable operand order also makes cached Boolean display tessellation independent of semantic IDs. */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): number {
  if (a === b) return 0;
  for (const field of ['hash', 'descriptor'] as const) if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  if (a.inputs.length !== b.inputs.length) return a.inputs.length - b.inputs.length;
  for (let i = 0; i < a.inputs.length; i++) { const order = compareFingerprints(a.inputs[i], b.inputs[i]); if (order) return order; }
  return 0;
}

/** Owns each shape exactly once. Current results are pinned; older entries are evicted oldest first. */
export class ResultCache {
  private buckets = new Map<string, Set<CachedResult>>();
  private lru = new Set<CachedResult>();
  meshBytes = 0;
  constructor(private limits: CacheLimits = DEFAULT_CACHE_LIMITS) {}
  get size(): number { return this.lru.size; }
  find(key: Fingerprint): CachedResult | undefined {
    return [...(this.buckets.get(key.hash) ?? [])].find(entry => sameFingerprint(entry.fingerprint, key));
  }
  touch(entry: CachedResult): void { this.lru.delete(entry); this.lru.add(entry); }
  add(entry: CachedResult): void {
    let bucket = this.buckets.get(entry.fingerprint.hash);
    if (!bucket) this.buckets.set(entry.fingerprint.hash, bucket = new Set());
    bucket.add(entry); this.lru.add(entry); this.meshBytes += entry.meshBytes;
  }
  setMesh(entry: CachedResult, mesh: DisplayMesh, quality: string): void {
    const bytes = (mesh.vertices.length + mesh.normals.length + mesh.triangles.length + mesh.lines.length) * 8;
    if (this.lru.has(entry)) this.meshBytes += bytes - entry.meshBytes;
    entry.mesh = mesh; entry.meshBytes = bytes; entry.meshQuality = quality;
  }
  trim(pinned: Set<CachedResult>): number {
    let evicted = 0;
    for (const entry of this.lru) {
      if (this.size <= this.limits.maxEntries && this.meshBytes <= this.limits.maxMeshBytes) break;
      if (pinned.has(entry)) continue;
      this.remove(entry); evicted++;
    }
    return evicted;
  }
  private remove(entry: CachedResult): void {
    this.lru.delete(entry);
    const bucket = this.buckets.get(entry.fingerprint.hash)!;
    bucket.delete(entry);
    if (!bucket.size) this.buckets.delete(entry.fingerprint.hash);
    this.meshBytes -= entry.meshBytes;
    entry.shape.delete();
  }
  dispose(): void { for (const entry of this.lru) this.remove(entry); }
}
