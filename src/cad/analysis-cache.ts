import type { GeometryInfo } from '../shared/protocol';
import type { DisplayMesh } from './types';
import { sameFingerprint, type Fingerprint } from './result-cache';

export interface AnalysisPart {
  key: number;
  fingerprint: Fingerprint;
  bounds: GeometryInfo['bounds'];
  volumeMm3: number;
}
export interface PairMeasurement {
  gap: number;
  // Absent when distance ruled out contact at the requested tolerance.
  common?: { overlap: number; mesh?: Pick<DisplayMesh, 'vertices' | 'normals' | 'triangles'> };
}
export interface AnalysisCheckpoint {
  parts: AnalysisPart[];
  pairs: { a: number; b: number; value: PairMeasurement }[];
  nextKey: number;
  /** The slowest exact pair measured so far; a slice reserves this much before its deadline. */
  slowestPairMs?: number;
}

/** Numeric facts only: no native shapes, semantic IDs, tolerance, ground or intent. */
export class AnalysisCache {
  private parts = new Map<number, AnalysisPart>();
  private buckets = new Map<string, Set<AnalysisPart>>();
  private pairs = new Map<string, { a: number; b: number; value: PairMeasurement; bytes: number }>();
  private nextKey = 0;
  meshBytes = 0;
  evictions = 0;
  slowestPairMs = 0;
  constructor(private limits = { parts: 500, pairs: 32_000, meshBytes: 32 * 1024 * 1024 }) {}

  part(fingerprint: Fingerprint, geometry: GeometryInfo): { part: AnalysisPart; hit: boolean } {
    let part = [...(this.buckets.get(fingerprint.hash) ?? [])].find(p => sameFingerprint(p.fingerprint, fingerprint));
    const hit = !!part;
    if (!part) {
      part = { key: this.nextKey++, fingerprint, bounds: structuredClone(geometry.bounds), volumeMm3: geometry.volumeMm3 };
      let bucket = this.buckets.get(fingerprint.hash);
      if (!bucket) this.buckets.set(fingerprint.hash, bucket = new Set());
      bucket.add(part);
    }
    this.parts.delete(part.key); this.parts.set(part.key, part);
    while (this.parts.size > this.limits.parts) {
      const oldest = this.parts.values().next().value!;
      this.parts.delete(oldest.key);
      this.evictions++;
      const bucket = this.buckets.get(oldest.fingerprint.hash)!;
      bucket.delete(oldest);
      if (!bucket.size) this.buckets.delete(oldest.fingerprint.hash);
      for (const [key, pair] of this.pairs) if (pair.a === oldest.key || pair.b === oldest.key) this.removePair(key);
    }
    return { part, hit };
  }
  private key(a: AnalysisPart, b: AnalysisPart): string { return a.key <= b.key ? `${a.key}:${b.key}` : `${b.key}:${a.key}`; }
  get(a: AnalysisPart, b: AnalysisPart): PairMeasurement | undefined {
    const key = this.key(a, b), entry = this.pairs.get(key);
    if (entry) { this.pairs.delete(key); this.pairs.set(key, entry); }
    return entry?.value;
  }
  set(a: AnalysisPart, b: AnalysisPart, value: PairMeasurement): void {
    const key = this.key(a, b), mesh = value.common?.mesh;
    const bytes = mesh ? (mesh.vertices.length + mesh.normals.length + mesh.triangles.length) * 8 : 0;
    if (this.pairs.has(key)) this.removePair(key, false);
    if (bytes > this.limits.meshBytes) return;
    this.pairs.set(key, { a: a.key, b: b.key, value, bytes }); this.meshBytes += bytes;
    while (this.pairs.size > this.limits.pairs || this.meshBytes > this.limits.meshBytes) this.removePair(this.pairs.keys().next().value!);
  }
  private removePair(key: string, eviction = true): void {
    this.meshBytes -= this.pairs.get(key)!.bytes; this.pairs.delete(key);
    if (eviction) this.evictions++;
  }
  stats() { return { partEntries: this.parts.size, pairEntries: this.pairs.size, meshBytes: this.meshBytes }; }
  checkpoint(): AnalysisCheckpoint {
    return {parts:[...this.parts.values()],pairs:[...this.pairs.values()].map(({a,b,value})=>({a,b,value})),nextKey:this.nextKey,slowestPairMs:this.slowestPairMs};
  }
  restore(checkpoint: AnalysisCheckpoint): void {
    this.dispose();
    this.nextKey=checkpoint.nextKey;
    this.slowestPairMs=checkpoint.slowestPairMs??0;
    for(const part of checkpoint.parts.slice(-this.limits.parts)) {
      this.parts.set(part.key,part);
      let bucket=this.buckets.get(part.fingerprint.hash);
      if(!bucket)this.buckets.set(part.fingerprint.hash,bucket=new Set());
      bucket.add(part);
    }
    for(const pair of checkpoint.pairs.slice(-this.limits.pairs)) {
      const a=this.parts.get(pair.a),b=this.parts.get(pair.b);
      if(a&&b)this.set(a,b,pair.value);
    }
  }
  dispose(): void { this.parts.clear(); this.buckets.clear(); this.pairs.clear(); this.meshBytes = 0; }
}
