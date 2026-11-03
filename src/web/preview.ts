import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import type { Evaluation } from '../cad/types';
import { context } from '../cad/demo';
import { editSchema, type CadDocument, type CadResult, type Edit, type GeometryInfo } from '../shared/protocol';

/** What the viewport shows instead of the committed model while a form has an uncommitted change. */
export interface LivePreview { evaluation: Evaluation; focus: string[] }
export interface PreviewState { result?: CadResult; evaluation?: Evaluation; pending: boolean }

/**
 * Exact dry-run evaluation of a draft, recomputed as the draft changes.
 * One computation in flight at a time; only the latest draft is evaluated next, so dragging a value never queues a backlog.
 */
export function useLivePreview(runtime: RuntimeClient, base: CadDocument, edits: Edit[] | undefined): PreviewState {
  const valid = !!edits?.length && edits.every(edit => editSchema.safeParse(edit).success);
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const sources = snapshot.documents.filter(d => d.documentId !== base.documentId).map(d => `${d.documentId}:${d.revision}`).join(',');
  const key = valid && snapshot.phase === 'ready' ? `${base.documentId}:${base.revision}:${sources}:${JSON.stringify(edits)}` : '';
  const [state, setState] = useState<PreviewState & { key: string }>({ pending: false, key: '' });
  const latest = useRef({ key, base, edits });
  latest.current = { key, base, edits };
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!key) { setState({ pending: false, key: '' }); return; }
    const pump = async () => {
      if (running.current || !alive.current) return;
      const job = latest.current;
      if (!job.key || !job.edits) return;
      running.current = true;
      setState(current => current.key === job.key ? current : { ...current, pending: true });
      try {
        // Previews follow every keystroke and drag; physical analysis waits for the commit.
        const outcome = await runtime.preview({ type: 'apply_edits', params: { ...context(job.base), edits: job.edits, analyze: false } });
        let evaluation=outcome.evaluation;
        if(!evaluation&&outcome.result.status==='error'){
          const details=outcome.result.error?.details as any,candidate=details?.candidate;
          const lines:number[]=[...(details?.edges??[]).flatMap((e:any)=>e.previewLines??[]),...(details?.sections??[]).flatMap((s:any)=>s.outline??[])];
          const facePatches=details?.adjacentFaces?.patches??[];let offset=0;const faceVertices:number[]=[],faceTriangles:number[]=[];for(const patch of facePatches){faceVertices.push(...patch.vertices);faceTriangles.push(...patch.triangles.map((i:number)=>i+offset));offset+=patch.vertices.length/3;}
          const vertices:number[]=candidate?.vertices??faceVertices,triangles:number[]=candidate?.triangles??faceTriangles,normals=vertices.map(()=>0);
          for(let i=0;i<triangles.length;i+=3){const a=triangles[i]*3,b=triangles[i+1]*3,c=triangles[i+2]*3,x=vertices[b]-vertices[a],y=vertices[b+1]-vertices[a+1],z=vertices[b+2]-vertices[a+2],u=vertices[c]-vertices[a],v=vertices[c+1]-vertices[a+1],w=vertices[c+2]-vertices[a+2],n=[y*w-z*v,z*u-x*w,x*v-y*u];for(const k of [a,b,c])for(let j=0;j<3;j++)normals[k+j]+=n[j];}
          for(let i=0;i<normals.length;i+=3){const length=Math.hypot(...normals.slice(i,i+3))||1;for(let j=0;j<3;j++)normals[i+j]/=length;}
          if(vertices.length||lines.length){const committed=runtime.getSnapshot().evaluation;evaluation={...committed,meshes:[...committed.meshes,{featureId:'failed_candidate',vertices,normals,triangles,lines,appearance:{color:'#e34836'}}]};}
        }
        if (alive.current) setState({ result: outcome.result, evaluation, pending: latest.current.key !== job.key, key: job.key });
      } finally { running.current = false; }
      if (alive.current && latest.current.key && latest.current.key !== job.key) void pump();
    };
    const timer = setTimeout(() => { void pump(); }, 90);
    return () => clearTimeout(timer);
  }, [key, runtime]);
  // While the latest draft computes, keep the previous preview on screen but mark it as updating.
  if (!key) return { pending: false };
  return { result: state.result, evaluation: state.evaluation, pending: state.pending || state.key !== key };
}

export const totalVolume = (geometry: GeometryInfo[] = []) => geometry.reduce((sum, g) => sum + g.volumeMm3, 0);

/** Overall world-axis extents of a set of results. */
export function extentsOf(geometry: GeometryInfo[] = []): [number, number, number] | undefined {
  if (!geometry.length) return undefined;
  return [0, 1, 2].map(i => Math.max(...geometry.map(g => g.bounds.max[i])) - Math.min(...geometry.map(g => g.bounds.min[i]))) as [number, number, number];
}
