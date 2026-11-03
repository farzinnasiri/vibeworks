import {authoredWire} from './loft-correspondence';
import { coloredSTEP } from './step-export';
import { stepRegions } from './step-regions';
import { guidedLoft } from './guided-loft';
import {fillSheet,joinSheets,resolveEdge} from './sheets';
import {ENGINE_VERSION as importEngineVersion} from '../shared/protocol';
import {checkRoot, type CheckTarget, type AnalysisLeaf} from '../shared/protocol';
import {fullDescriptor,pairDescriptor,matchesLeaf,type AnalysisControl,type AnalysisEvent} from './analysis-plan';
import { inheritStyles, inheritRegions } from './derived-paint';
import { hydrateGraphics } from '../shared/graphic-assets';
import { regionMeshes } from './regions';
import { ShapeHistory } from './history';
import { frameAxes } from './frames';
import { resolveFaces } from './surface-reference';
import { resolveAppearance, resolveLook, resolveGraphicEdits, type AppearanceLayer } from '../shared/appearance-resolver';
import { indexedShapes, topologyLineage, topologyTable, topologyMesh } from './topology';
import { identityMatrix, multiplyMatrix, placementMatrix, displayValueCount, displayBytes } from '../shared/display';
import type { DisplayRequest } from '../shared/protocol';
import { profileSketch, pathWire, extrusionFrame, splineWire } from './profiles';
import { attachmentPlacement, derivedMounts, findMount, placeFrame, type Placement } from './frames';
import { countLabel } from '../shared/format';
import {
  cast,
  assembleWire,
  Edge,
  makeFace,
  makeCylinder,
  makeVertex,
  drawText,
  getFont,
  loadFont,
  measureDistanceBetween,
  type Shape3D,
} from 'replicad';
import { NEUTRAL_COLOR, materialById } from '../shared/materials';
import type { OpenCascadeInstance, TopAbs_ShapeEnum } from 'replicad-opencascadejs';
import { MAX_ASSEMBLY_FEATURES } from '../shared/protocol';
import type { Appearance, CadDocument, Feature, GeometryInfo, SectionMeasure, Vector3 } from '../shared/protocol';
import { CadError, effectiveAppearance, references, visibleFeatures } from './document';
import type { DisplayMesh, Evaluation, GeometryAnalysis } from './types';
import { replayPlan,replayDefinitions } from './replay';
import { assemblyGraph } from './assemblies';
import {
  ResultCache,
  fingerprint,
  compareFingerprints,
  type CachedResult,
  type CacheLimits,
} from './result-cache';
import { AnalysisCache, type AnalysisPart } from './analysis-cache';

const MESH_OPTIONS = { tolerance: 0.05, angularTolerance: 0.15 };
type MeshOptions = typeof MESH_OPTIONS;
const meshKey = (options: MeshOptions) => JSON.stringify(options);
const meshValues = (mesh: DisplayMesh) => mesh.vertices.length + mesh.normals.length + mesh.triangles.length + mesh.lines.length + (mesh.faceRanges?.length??0) + (mesh.edgeRanges?.length??0);
// Size-derived tolerances snap down to fixed steps, so a small change in model size keeps every cached mesh.
const TOLERANCE_STEPS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100];
const snapTolerance = (mm: number) => [...TOLERANCE_STEPS].reverse().find(step => step <= mm) ?? TOLERANCE_STEPS[0];
// Leave room for the semantic result, exact analysis and protocol envelope in the 32 MiB response.
const DISPLAY_BYTES = 24 * 1024 * 1024;
/** The bundled font family for text features (IBM Plex Sans Bold, SIL OFL 1.1). */
const TEXT_FONT = 'plex';
let fontLoaded = false;
const getFontLoaded = () => fontLoaded;
/** Load the text font once per kernel instance: a URL in the browser worker, bytes in Node. */
export async function loadTextFont(source: string | ArrayBuffer): Promise<void> {
  if (fontLoaded) return;
  await loadFont(source, TEXT_FONT);
  fontLoaded = !!getFont(TEXT_FONT);
}
const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value);
/** What usually causes each kind of kernel failure, so a person or agent can choose a correction. */
const GEOMETRY_HINTS: Record<Feature['kind'], string> = {
  instance: 'Choose a nonempty visible result in an existing part document.',
  box: 'Check that every size is positive.',
  rod: 'Check that endpoint distance is 0.01–10000 mm and radius is positive.',
  cylinder: 'Check that radius and height are positive.',
  extrude: 'Use a simple closed profile with distinct endpoints, noncollinear arc points and no self intersections.',
  fill:'Use connected semantic boundary edges and measured tolerances.',
  join:'Replace explicit faces with construction sheets at a bounded sewing tolerance.',
  loft: 'Use ordered, separated sections with compatible simple profiles. Reduce twist or section changes; try ruled surfaces to locate the failing interval.',
  sweep: 'Use an open continuous path and a profile smaller than the tightest bend. Avoid self intersections, sharp path corners and points paths that double back; with endScale, keep the profile valid at every scale.',
  shell: 'Use one solid, unambiguous planar openings and a thickness smaller than the tightest wall or curvature.',
  revolve:
    'The radial profile must be simple and must not cross the axis (radius below 0) or overlap itself when revolved.',
  subtract:
    'Booleans usually fail on exactly coincident faces or edges: extend tools 0.01 mm or more past the target faces, or offset them slightly.',
  union:
    'Booleans usually fail on exactly coincident faces or edges: overlap the solids slightly instead of touching face to face.',
  intersect:
    'Booleans usually fail on exactly coincident faces or edges; an empty overlap also fails. Check that the inputs overlap with some volume.',
  fillet:
    'The radius is probably too large for an adjacent face or edge ' +
    '(keep it below half the thinnest wall or shortest edge it touches), ' +
    'or the selected edges meet at a corner the kernel cannot blend. Try a smaller radius or edges vertical.',
  chamfer:
    'The distance is probably too large for an adjacent face or edge (keep it below half the thinnest wall or shortest edge it touches). Try a smaller distance or edges vertical.',
  transform: 'Check that scale is positive and the rotation axis is nonzero.',
  mirror: 'Check the plane origin.',
  drill_holes: 'Check that the diameter is smaller than the material around each center.',
  pattern: 'Check the direction or axis is nonzero and the count and spacing are sensible.',
  text: 'Engraving and embossing need origin on the target face for that plane (XY top, XZ front, YZ right); check the depth is less than the material and the size fits the face.',
};
const NORMALS = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] } as const;
const MAX_MESH_VALUES = 6_000_000;
const AXES = ['X', 'Y', 'Z'] as const;
/** The part of v perpendicular to n, normalized; a v along n is a usage error. */
function perpendicular(v: Vector3, direction: Vector3): Vector3 {
  const scale = Math.hypot(...direction), n = direction.map(value => value / scale);
  const dot = v.reduce((sum, value, i) => sum + value * n[i], 0);
  const u = v.map((value, i) => value - dot * n[i]) as Vector3, length = Math.hypot(...u);
  if (length < 1e-6) throw new CadError('INVALID_PATH', 'profileX must not be parallel to the path where it starts.');
  return u.map(value => value / length) as Vector3;
}
/** In-plane width and height axes of a section across each world axis. */
const SECTION_AXES = { X: [1, 2], Y: [0, 2], Z: [0, 1] } as const;
// A failed blend tries each selected edge alone, within these bounds, to say which edges to separate.
const BLEND_TRIAL_EDGES = 16, BLEND_TRIAL_MS = 4000;

interface Piece {
  shape: Shape3D;
  result: CachedResult;
  appearance?: Appearance;
  layers?: AppearanceLayer[];
  surfaceStyles?: Array<NonNullable<Feature['surfaceStyles']>[number]&{from?:AppearanceLayer['from'];fieldOrigins?:Record<string,AppearanceLayer['from']>}>;
  paintRegions?: Array<NonNullable<Feature['paintRegions']>[number]&{from?:AppearanceLayer['from'];fieldOrigins?:Record<string,AppearanceLayer['from']>}>;
  volumeMm3: number;
  placements: Placement[];
  name: string;
  occurrence: string[];
  source: { documentId: string; revision: number; featureId: string };
}

/** All B-reps stay in the worker. Only validated metrics and display arrays leave it. */
/**
 * replicad hands STEP colours to OCCT as linear RGB, and OCCT writes them sRGB-encoded,
 * so an sRGB hex would come out lighter. Linearize first so the file carries the colour the user picked.
 */
function stepColor(hex: string): string {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return (
    '#' +
    (hex.slice(1).match(/../g) ?? [])
      .map((h) =>
        Math.round(linear(parseInt(h, 16) / 255) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

export class GeometryEngine {
  private history: ShapeHistory;
  private replayPlans = new Map<string, ReturnType<typeof replayPlan>>();
  private constructionPlan(document: CadDocument, graph: CadDocument[]) {
    const key = JSON.stringify(graph);
    let plan = this.replayPlans.get(key);
    if (!plan) {
      plan = replayPlan(document, graph);
      if (this.replayPlans.size >= 4) this.replayPlans.delete(this.replayPlans.keys().next().value!);
      this.replayPlans.set(key, plan);
    }
    return plan;
  }
  private diagnostics=new WeakMap<Shape3D,Record<string,unknown>>();
  private shapes = new Map<string, Shape3D>();
  private cache: ResultCache;
  private pieces = new Map<string, Piece[]>();
  private analysisCache = new AnalysisCache();
  analysisCheckpoint() { return this.analysisCache.checkpoint(); }
  restoreAnalysis(checkpoint: import('./analysis-cache').AnalysisCheckpoint) { this.analysisCache.restore(checkpoint); }
  private activeResults = new Map<string, CachedResult>();
  private inputLineage(entry: CachedResult): string[][] {
    let names = this.history.get(entry.shape);
    if (!names) {
      names = entry.topology?.faces.map(face => face.lineage) ?? topologyLineage(this.oc, entry.shape, entry.topologyFeature!);
      this.history.set(entry.shape, names);
    }
    return names;
  }
  private lastStats?: Evaluation['stats'];
  constructor(
    private oc: OpenCascadeInstance,
    limits?: CacheLimits,
    private displayBudget = MAX_MESH_VALUES
  ) {
    this.cache = new ResultCache(limits);
    this.history = new ShapeHistory(oc);
  }

  cacheStats(): { entries: number; liveShapes: number; meshBytes: number; wasmHeapBytes: number } {
    return {
      entries: this.cache.size,
      liveShapes: this.cache.size,
      meshBytes: this.cache.meshBytes,
      wasmHeapBytes: this.oc.wasmMemory.buffer.byteLength,
    };
  }

  // Own the transformation builder: replicad 1.1 leaves this builder and the raw
  // returned TopoDS handle unfreed. Always copy geometry to isolate cached inputs.
  private transformShape(
    shape: Shape3D,
    configure: (
      trsf: import('replicad-opencascadejs').gp_Trsf,
      own: <T extends { delete(): void }>(value: T) => T
    ) => void,
    consume = true
  ): Shape3D {
    const temporaries: Array<{ delete(): void }> = [];
    const own = <T extends { delete(): void }>(value: T): T => {
      temporaries.push(value);
      return value;
    };
    try {
      const trsf = own(new this.oc.gp_Trsf());
      configure(trsf, own);
      const builder = own(new this.oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false));
      const raw = own(builder.Shape());
      const result = this.count(shape,this.oc.TopAbs_ShapeEnum.TopAbs_SOLID)?this.solid(raw):cast(raw) as unknown as Shape3D;
      const diagnostics=this.diagnostics.get(shape);if(diagnostics)this.diagnostics.set(result,diagnostics);
      this.history.capture(result, builder, [shape]);
      return result;
    } finally {
      for (const value of temporaries.reverse()) value.delete();
      if (consume) shape.delete();
    }
  }

  private copyShape(shape: Shape3D): Shape3D {
    return this.transformShape(shape, () => {}, false);
  }

  private translate(shape: Shape3D, vector: Vector3): Shape3D {
    return this.transformShape(shape, (trsf, own) => trsf.SetTranslation(own(new this.oc.gp_Vec(...vector))));
  }
  private rotate(shape: Shape3D, angle: number, origin: Vector3, direction: Vector3): Shape3D {
    return this.transformShape(shape, (trsf, own) => {
      const point = own(new this.oc.gp_Pnt(...origin)),
        axis = own(new this.oc.gp_Dir(...direction));
      trsf.SetRotation(own(new this.oc.gp_Ax1(point, axis)), (angle * Math.PI) / 180);
    });
  }
  private scale(shape: Shape3D, scale: number, origin: Vector3): Shape3D {
    return this.transformShape(shape, (trsf, own) =>
      trsf.SetScale(own(new this.oc.gp_Pnt(...origin)), scale)
    );
  }
  private mirror(shape: Shape3D, plane: keyof typeof NORMALS, origin: Vector3): Shape3D {
    return this.transformShape(shape, (trsf, own) => {
      const point = own(new this.oc.gp_Pnt(...origin)),
        normal = own(new this.oc.gp_Dir(NORMALS[plane][0], NORMALS[plane][1], NORMALS[plane][2]));
      trsf.SetMirror(own(new this.oc.gp_Ax2(point, normal)));
    });
  }
  private compound(shapes: Shape3D[]): Shape3D {
    const builder = new this.oc.TopoDS_Builder(),
      raw = new this.oc.TopoDS_Compound();
    try {
      builder.MakeCompound(raw);
      for (const shape of shapes) builder.Add(raw, shape.wrapped);
      const result=this.solid(raw), faces=indexedShapes(this.oc,raw,'FACE'),names=faces.map(()=>[] as string[]);
      try { const buckets=new Map<number,number[]>();faces.forEach((f,i)=>{const h=this.oc.ReplicadShapeHasher.HashCode(f,2147483647),b=buckets.get(h)??[];b.push(i);buckets.set(h,b);});for(const input of shapes){const src=indexedShapes(this.oc,input.wrapped,'FACE');try{const labels=this.history.get(input);src.forEach((s,j)=>{if(!labels?.[j]?.length)return;for(const i of buckets.get(this.oc.ReplicadShapeHasher.HashCode(s,2147483647))??[])if(faces[i].IsSame(s))names[i].push(...labels[j]);});}finally{src.forEach(s=>s.delete());}}this.history.set(result,names); }finally{faces.forEach(s=>s.delete());}
      return result;
    } finally {
      raw.delete();
      builder.delete();
    }
  }
  /** The faces of a solid as one compound, for distances to its surface rather than its volume. */
  private boundary(shape: Shape3D) {
    const builder = new this.oc.TopoDS_Builder(),
      raw = new this.oc.TopoDS_Compound();
    const explorer = new this.oc.TopExp_Explorer(shape.wrapped, this.oc.TopAbs_ShapeEnum.TopAbs_FACE, this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
      builder.MakeCompound(raw);
      for (; explorer.More(); explorer.Next()) {
        const face = explorer.Current();
        builder.Add(raw, face);
        face.delete();
      }
      const faces = cast(raw);
      const box = shape.boundingBox;
      return { faces, box, dispose: () => { faces.delete(); box.delete(); } };
    } finally {
      explorer.delete();
      raw.delete();
      builder.delete();
    }
  }
  private solid(raw: import('replicad-opencascadejs').TopoDS_Shape): Shape3D {
    const shape = cast(raw);
    try {
      return shape.asShape3D();
    } catch (error) {
      shape.delete();
      throw error;
    }
  }

  // replicad's Boolean builders are finalizer-managed. Own these high-volume
  // temporaries explicitly so eviction can release their retained input/output shapes.
  private boolean(kind: 'subtract' | 'union' | 'intersect', target: Shape3D, tool: Shape3D): Shape3D {
    const Builder =
      kind === 'subtract'
        ? this.oc.BRepAlgoAPI_Cut
        : kind === 'union'
          ? this.oc.BRepAlgoAPI_Fuse
          : this.oc.BRepAlgoAPI_Common;
    const builder = new Builder(target.wrapped, tool.wrapped);
    try {
      // The two-shape constructor performs the Boolean operation.
      if (kind !== 'intersect') builder.SimplifyResult(true, true, 0.001);
      const raw = builder.Shape();
      try {
        const result = this.solid(raw);
        this.history.capture(result, builder, [target, tool]);
        return result;
      } finally {
        raw.delete();
      }
    } finally {
      builder.delete();
    }
  }

  /**
   * Letters from the bundled font, centered on origin in the plane, extruded along the plane normal.
   * Engraving starts depth inside the face and pokes slightly out so the cut is clean; embossing starts
   * just inside so the union fuses. Without a target the letters stand on origin.
   */
  private text(feature: Extract<Feature, { kind: 'text' }>, shapes: Map<string, Shape3D>): Shape3D {
    const { text, plane, origin, size, depth, target, mode } = feature.params;
    if (!getFontLoaded())
      throw new CadError('FONT_UNAVAILABLE', 'The text font has not loaded in this geometry worker.');
    let drawing = drawText(text, { fontSize: size, fontFamily: TEXT_FONT });
    const box = drawing.boundingBox;
    try {
      drawing = drawing.translate(-box.center[0], -box.center[1]);
    } finally {
      box.delete();
    }
    const normal = NORMALS[plane];
    const along = (distance: number) => origin.map((v, i) => v + normal[i] * distance) as Vector3;
    const engrave = !!target && mode !== 'emboss';
    const start = !target ? 0 : engrave ? -depth : -0.05;
    const length = !target ? depth : engrave ? depth + 0.5 : depth + 0.05;
    const sketch = drawing.sketchOnPlane(plane, along(start));
    let letters: Shape3D;
    try {
      letters = sketch.extrude(length).asShape3D();
    } finally {
      if ('delete' in sketch && typeof sketch.delete === 'function') sketch.delete();
    }
    if (!target) return letters;
    let base: Shape3D | undefined;
    try {
      base = this.copyShape(shapes.get(target)!);
      const before = this.measure(target, base).volumeMm3;
      const result = this.boolean(engrave ? 'subtract' : 'union', base, letters);
      try {
        const after = this.measure(feature.id, result).volumeMm3;
        if (Math.abs(after - before) <= Math.max(1e-6, before * 1e-9))
          throw new CadError(
            'TEXT_MISSES_TARGET',
            `The text does not touch '${target}'. Put origin on its ${plane === 'XY' ? 'top (+Z)' : plane === 'XZ' ? 'front (-Y)' : 'right (+X)'} face.`,
            { origin, plane }
          );
        return result;
      } catch (error) {
        result.delete();
        throw error;
      }
    } finally {
      base?.delete();
      letters.delete();
    }
  }

  /** A predicate for 'all', 'vertical' or an edge query; dispose releases the probe vertices it allocated. */
  private edgeMatcher(edges: Extract<Feature, { kind: 'fillet' }>['params']['edges'], shapes: Map<string, Shape3D>): {
    matches: (edge: import('replicad').Edge) => boolean;
    dispose: () => void;
  } {
    const AXIS = { X: 0, Y: 1, Z: 2 } as const;
    const parallelTo = (edge: import('replicad').Edge, axis: 0 | 1 | 2) => {
      if (edge.geomType !== 'LINE') return false;
      const tangent = edge.tangentAt(0.5);
      try {
        const t = tangent.toTuple();
        return [0, 1, 2].every((i) =>
          i === axis ? Math.abs(Math.abs(t[i]) - 1) < 1e-7 : Math.abs(t[i]) < 1e-7
        );
      } finally {
        tangent.delete();
      }
    };
    if (edges === 'all') return { matches: () => true, dispose: () => {} };
    if (edges === 'vertical') return { matches: (edge) => parallelTo(edge, 2), dispose: () => {} };
    if(edges.refs){
      if(Object.keys(edges).some(k=>k!=='refs'))throw new CadError('INVALID_REFERENCE','Explicit edge refs cannot be combined with query criteria.');
      const selected=edges.refs.map(ref=>{const shape=shapes.get(ref.feature);if(!shape)throw new CadError('REFERENCE_MISSING','Edge source is missing.');return resolveEdge(this.oc,shape,ref,this.history);});
      return {matches:edge=>selected.some(e=>e.wrapped.IsSame(edge.wrapped)),dispose:()=>selected.forEach(e=>e.delete())};
    }
    const query = edges;
    const probes = query.near?.map((point) => makeVertex(point)) ?? [];
    const nearTolerance = query.toleranceMm ?? 0.5,
      planeTolerance = query.toleranceMm ?? 1e-3,
      seamTolerance = query.toleranceMm ?? 0.01;
    // A seam edge lies on the surfaces of both joined inputs. Distances go to their faces, not their
    // solids, because a point inside a solid is at distance zero from it.
    const seams = (query.between ?? []).map((id) => this.boundary(shapes.get(id)!));
    const onSeam = (edge: import('replicad').Edge) => {
      const box = edge.boundingBox;
      try {
        if (!seams.every((seam) => box.isOut(seam.box) === false)) return false;
      } finally {
        box.delete();
      }
      return [0.2, 0.5, 0.8].every((t) => {
        const point = edge.pointAt(t);
        const vertex = makeVertex(point.toTuple());
        point.delete();
        try {
          return seams.every((seam) => measureDistanceBetween(vertex, seam.faces) <= seamTolerance);
        } finally {
          vertex.delete();
        }
      });
    };
    return {
      dispose: () => {
        for (const probe of probes) probe.delete();
        for (const seam of seams) seam.dispose();
      },
      matches: (edge) => {
        if (seams.length && !onSeam(edge)) return false;
        if (
          query.curve &&
          query.curve !== 'any' &&
          edge.geomType !== (query.curve === 'line' ? 'LINE' : 'CIRCLE')
        )
          return false;
        if (query.parallel && !parallelTo(edge, AXIS[query.parallel])) return false;
        if (query.minLengthMm !== undefined || query.maxLengthMm !== undefined) {
          const length = edge.length;
          if (query.minLengthMm !== undefined && length < query.minLengthMm) return false;
          if (query.maxLengthMm !== undefined && length > query.maxLengthMm) return false;
        }
        if (query.on) {
          const box = edge.boundingBox;
          try {
            const [min, max] = box.bounds,
              i = AXIS[query.on.axis];
            if (
              Math.abs(min[i] - query.on.value) > planeTolerance ||
              Math.abs(max[i] - query.on.value) > planeTolerance
            )
              return false;
          } finally {
            box.delete();
          }
        }
        if (probes.length && !probes.some((probe) => measureDistanceBetween(edge, probe) <= nearTolerance))
          return false;
        return true;
      },
    };
  }

  /** OCCT failures reach JS as WebAssembly exceptions; decode their type and message instead of '[object WebAssembly.Exception]'. */
  private kernelMessage(error: unknown): string {
    try {
      if (
        typeof WebAssembly !== 'undefined' &&
        'Exception' in WebAssembly &&
        error instanceof (WebAssembly as unknown as { Exception: new (...args: never[]) => object }).Exception
      ) {
        const [type, message] = (
          this.oc as unknown as { getExceptionMessage: (e: unknown) => [string, string] }
        ).getExceptionMessage(error);
        return [type, message].filter(Boolean).join(': ');
      }
    } catch {
      /* fall through to the plain text */
    }
    if (error instanceof Error) return error.message;
    const text = String(error);
    return text === '[object WebAssembly.Exception]' ? '' : text;
  }

  dispose(): void {
    this.shapes.clear();
    this.pieces.clear();
    this.activeResults.clear();
    this.sectionCache = new WeakMap();
    this.analysisCache.dispose();
    this.lastStats = undefined;
    this.cache.dispose();
  }

  private count(shape: Shape3D, kind: TopAbs_ShapeEnum): number {
    const explorer = new this.oc.TopExp_Explorer(shape.wrapped, kind, this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
      let count = 0;
      for (; explorer.More(); explorer.Next()) count++;
      return count;
    } finally {
      explorer.delete();
    }
  }

  /** The validity half of measure: a nonempty solid that passes BRepCheck. */
  private validSolid(shape: Shape3D): boolean {
    if (shape.isNull || this.count(shape, this.oc.TopAbs_ShapeEnum.TopAbs_SOLID) === 0) return false;
    const analyzer = new this.oc.BRepCheck_Analyzer(shape.wrapped, true, false, true);
    try { return analyzer.IsValid(); } finally { analyzer.delete(); }
  }

  measure(featureId: string, shape: Shape3D, translatedBounds?: GeometryInfo['bounds']): GeometryInfo {
    const oc = this.oc;
    const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, true);
    const volume = new oc.GProp_GProps();
    const area = new oc.GProp_GProps();
    const box = new oc.Bnd_Box();
    try {
      const sheet=this.count(shape,oc.TopAbs_ShapeEnum.TopAbs_SOLID)===0;
      const valid = !shape.isNull && analyzer.IsValid();
      const solidCount = this.count(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
      if (!valid || solidCount === 0 && !this.diagnostics.has(shape))
        throw new CadError(
          'INVALID_SOLID',
          `Feature '${featureId}' did not produce a valid nonempty solid.`,
          { featureId, valid, solidCount }
        );
      if(!sheet)oc.BRepGProp.VolumeProperties(shape.wrapped, volume, true, false, false);
      oc.BRepGProp.SurfaceProperties(shape.wrapped, area, false, false);
      // No tessellation and no tessellation-derived bounds or mass estimates.
      let min: Vector3, max: Vector3;
      if (translatedBounds) {
        min = [...translatedBounds.min]; max = [...translatedBounds.max];
      } else {
        oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
        const pMin = box.CornerMin(), pMax = box.CornerMax();
        try {
          min = [pMin.X(), pMin.Y(), pMin.Z()];
          max = [pMax.X(), pMax.Y(), pMax.Z()];
        } finally { pMin.delete(); pMax.delete(); }
      }
      const volumeMm3 = volume.Mass();
      if (!Number.isFinite(volumeMm3) || !sheet && volumeMm3 <= 0 || ![...min, ...max].every(Number.isFinite))
        throw new CadError('INVALID_SOLID', `Feature '${featureId}' has invalid mass properties or bounds.`);
      return {
        featureId,resultKind:sheet?'sheet':'solid',...(this.diagnostics.has(shape)?{diagnostics:JSON.parse(JSON.stringify(this.diagnostics.get(shape)))}:{}),
        valid,
        solidCount,
        volumeMm3,
        surfaceAreaMm2: area.Mass(),
        validationMethod:
          'OCCT BRepCheck_Analyzer, geometric controls and exact method; BRepGProp exact surfaces; ' +
          (translatedBounds ? 'translated union of source BRepBndLib.AddOptimal bounds without triangulation' : 'BRepBndLib.AddOptimal without triangulation'),
        bounds: { min, max, size: max.map((value, i) => value - min[i]) as Vector3 },
        faceCount: this.count(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE),
        edgeCount: this.uniqueEdges(shape),
        watertight: null,
      };
    } finally {
      analyzer.delete();
      volume.delete();
      area.delete();
      box.delete();
    }
  }

  /** Translation preserves exact extrema. Union the already measured source bounds; rotations still use OCCT. */
  private translatedBounds(inputs: CachedResult[], placement: Placement): GeometryInfo['bounds'] | undefined {
    if (placement.angleDegrees !== 0) return undefined;
    const min: Vector3 = [Infinity, Infinity, Infinity], max: Vector3 = [-Infinity, -Infinity, -Infinity];
    for (const input of inputs) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], input.geometry.bounds.min[i] + placement.translation[i]);
      max[i] = Math.max(max[i], input.geometry.bounds.max[i] + placement.translation[i]);
    }
    return { min, max, size: max.map((value, i) => value - min[i]) as Vector3 };
  }

  private *edges(shape: Shape3D): Generator<import('replicad').Edge> {
    const oc = this.oc;
    const seen = new Map<number, import('replicad-opencascadejs').TopoDS_Shape[]>();
    const explorer = new oc.TopExp_Explorer(
      shape.wrapped,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    );
    try {
      for (; explorer.More(); explorer.Next()) {
        const raw = explorer.Current();
        // Hash only narrows the search. IsSame still decides identity, including collisions and locations.
        const hash = oc.ReplicadShapeHasher.HashCode(raw, 2147483647);
        const bucket = seen.get(hash);
        if (bucket?.some((previous) => previous.IsSame(raw))) {
          raw.delete();
          continue;
        }
        if (bucket) bucket.push(raw); else seen.set(hash, [raw]);
        const edge = cast(raw) as import('replicad').Edge;
        try {
          yield edge;
        } finally {
          edge.delete();
        }
      }
    } finally {
      explorer.delete();
      for (const bucket of seen.values()) for (const raw of bucket) raw.delete();
    }
  }

  private uniqueEdges(shape: Shape3D): number {
    let count = 0;
    for (const _edge of this.edges(shape)) count++;
    return count;
  }

  private blend(
    shape: Shape3D,
    kind: 'fillet' | 'chamfer',
    select: (edge: import('replicad').Edge, index: number) => number | {stations:number[][]} | null
  ): Shape3D {
    const builder =
      kind === 'fillet'
        ? new this.oc.BRepFilletAPI_MakeFillet(shape.wrapped, this.oc.ChFi3d_FilletShape.ChFi3d_Rational)
        : new this.oc.BRepFilletAPI_MakeChamfer(shape.wrapped);
    try {
      let selected = false, index = 0;
      for (const edge of this.edges(shape)) {
        const amount = select(edge, index++);
        if (amount !== null) {
          if(typeof amount==='number')builder.Add(amount, edge.wrapped);
          else {
            const array=new this.oc.NCollection_Array1_gp_Pnt2d(1,amount.stations.length);
            try{amount.stations.forEach(([t,r],i)=>{const point=new this.oc.gp_Pnt2d(t,r);try{array.SetValue(i+1,point);}finally{point.delete();}});const fillet=builder as import('replicad-opencascadejs').BRepFilletAPI_MakeFillet;fillet.Add(array,edge.wrapped);
              const contour=fillet.Contour(edge.wrapped);
              if(!contour||fillet.NbEdges(contour)!==1)throw new CadError('BLEND_LAW_SCOPE','Variable laws currently require a single-edge native tangent contour; split/select explicitly.',{contourEdges:contour?fillet.NbEdges(contour):0});
              if(fillet.Closed(contour)&&Math.abs(amount.stations[0][1]-amount.stations.at(-1)![1])>1e-7)throw new CadError('BLEND_LAW_SCOPE','A closed edge requires equal endpoint radii.');}finally{array.delete();}
          }
          selected = true;
        }
      }
      if (!selected) throw new Error('No edge was selected');
      const raw = builder.Shape();
      try {
        const result = this.solid(raw);
        this.history.capture(result, builder, [shape], true);
        return result;
      } finally {
        raw.delete();
      }
    } finally {
      builder.delete();
    }
  }

  /** Matched replicad operations with builder/raw-handle cleanup on success and failure. */
  private loft(feature: Extract<Feature, { kind: 'loft' }>): Shape3D {
    if(feature.params.guides?.length){const result=guidedLoft(this.oc,feature,this.history);this.diagnostics.set(result.shape,result.diagnostics);return result.shape;}
    const sketches: import('replicad').Sketch[] = [];
    const builder = new this.oc.BRepOffsetAPI_ThruSections(true, feature.params.ruled, feature.params.toleranceMm??1e-6);
    try {
      const authored=feature.params.correspondence==='authored',reports:ReturnType<typeof authoredWire>[]=[],owned:import('replicad').Wire[]=[];
      if(!authored&&feature.params.sections.some(s=>s.seam!==undefined||s.splitAt||s.reverse||s.mapping))throw new CadError('LOFT_CORRESPONDENCE','seam, splitAt, reverse and mapping require correspondence authored.');
      if(authored)builder.CheckCompatibility(false);
      if(feature.params.smoothing!==undefined)builder.SetSmoothing(feature.params.smoothing);
      if(feature.params.continuity)builder.SetContinuity(this.oc.GeomAbs_Shape[feature.params.continuity==='C1'?'GeomAbs_C1':'GeomAbs_C2']);
      if(feature.params.maxDegree)builder.SetMaxDegree(feature.params.maxDegree);
      try{
       for (const section of feature.params.sections) {
        const sketch = profileSketch(section.profile, section.frame); sketches.push(sketch);
        if(authored){const report=authoredWire(sketch.wire,section);reports.push(report);owned.push(report.wire);}else {const report=authoredWire(sketch.wire,section);reports.push(report);report.wire.delete();owned.push(sketch.wire);}
       }
       const sections=reports.map(({wire,...report},i)=>({...report,section:i,seamTwistDeg:i?Math.acos(Math.max(-1,Math.min(1,feature.params.sections[i-1].frame.xDirection.reduce((n,v,k)=>n+v*feature.params.sections[i].frame.xDirection[k],0)/(Math.hypot(...feature.params.sections[i-1].frame.xDirection)*Math.hypot(...feature.params.sections[i].frame.xDirection)))))*180/Math.PI:0,largestDisplacementMm:i?Math.max(...report.vertices.map((p,j)=>Math.hypot(...p.map((v,k)=>v-(reports[i-1].vertices[j]?.[k]??v))))):0}));
       if(authored&&reports.some(r=>r.names.length!==reports[0].names.length))throw new CadError('LOFT_CORRESPONDENCE','Authored sections require equal edge counts. Split existing curves explicitly; no automatic compatibility changes were made.',{sections,suggestedSplitAt:reports.map(r=>[...new Set(reports.flatMap(s=>s.positions))].filter(t=>!r.positions.some(p=>Math.abs(p-t)<1e-9)).sort((a,b)=>a-b)),intervals:reports.flatMap((r,i)=>i&&r.names.length!==reports[i-1].names.length?[[i-1,i]]:[])});
       for(const wire of owned)builder.AddWire(wire.wrapped);
      builder.Build();
      if (!builder.IsDone()) {if(authored)throw new CadError('LOFT_CORRESPONDENCE','OCCT rejected these explicitly paired section intervals.',{sections,intervals:sections.slice(1).map((_,i)=>[i,i+1])});throw new Error('OCCT could not build the loft');}
      const raw = builder.Shape();
      try {
        const result = this.solid(raw), wires = builder.Wires(), first = wires.First();
        try { const p=feature.params.sections[0].profile;this.history.authored(result,builder,first,authored?reports[0].names:p.type==='path'?p.segments.map((s,i)=>s.id??String(i)):p.type==='polygon'?p.segmentIds:undefined,true); } finally { first.delete(); wires.delete(); }
        this.diagnostics.set(result,{correspondence:authored?'authored':'automatic',sections,internalContinuity:feature.params.continuity??'kernel default'});
        return result;
      } finally { raw.delete(); }
      }finally{if(authored)owned.forEach(w=>w.delete());}
    } finally { builder.delete(); for (const sketch of sketches) sketch.delete(); }
  }

  private sweep(feature: Extract<Feature, { kind: 'sweep' }>): Shape3D {
    const { path, endScale } = feature.params;
    let wire = 'points' in path ? splineWire(path.points) : pathWire(path, path.frame);
    const advanced=!!feature.params.sections||!!feature.params.guide;
    let guide:import('replicad').Wire|undefined;
    const sectionSketches:import('replicad').Sketch[]=[];
    const locations:import('replicad').Vertex[]=[];
    if(advanced){
      if(endScale!==undefined&&endScale!==1){wire.delete();throw new CadError('SWEEP_CONFIGURATION','endScale cannot be combined with guide or sections. Supply explicit sections.');}
      const sections=feature.params.sections;
      if(sections&&(sections[0].at!==0||sections.at(-1)!.at!==1||sections.some((s,i)=>i&&s.at<=sections[i-1].at))){wire.delete();throw new CadError('SWEEP_SECTIONS','Sections must increase from 0 to 1.');}
    }
    let profile: import('replicad').Sketch | undefined;
    let builder: InstanceType<OpenCascadeInstance['BRepOffsetAPI_MakePipeShell']> | undefined;
    let law: InstanceType<OpenCascadeInstance['Law_Linear']> | undefined;
    try {
      const start = wire.startPoint, tangent = wire.tangentAt(0);
      try {
        const normal = tangent.toTuple();
        profile = profileSketch(feature.params.profile, { origin: start.toTuple(), normal,
          xDirection: perpendicular(feature.params.profileX ?? ('points' in path ? (Math.abs(normal[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1]) : path.frame.normal), normal) });
      } finally { start.delete(); tangent.delete(); }
      builder = new this.oc.BRepOffsetAPI_MakePipeShell(wire.wrapped);
      builder.SetMode(false); // corrected Frenet, no artificial stepped sections
      if(advanced){
        const edges=indexedShapes(this.oc,wire.wrapped,'EDGE');
        try{if(edges.length!==1)throw new CadError('SWEEP_CONFIGURATION','Guided/section sweeps currently require a single exact path edge. Use one arc, Bezier or points spline.');
         if(feature.params.sections){
          const original=new Edge(this.oc.TopoDS.Edge(edges[0])),curve=this.oc.BRep_Tool.Curve(original.wrapped),segments:import('replicad').Edge[]=[];
          try{for(let i=0;i<feature.params.sections.length-1;i++){
           const a=feature.params.sections[i].at,b=feature.params.sections[i+1].at,maker=new this.oc.BRepBuilderAPI_MakeEdge(curve.returnValue,curve.First+a*(curve.Last-curve.First),curve.First+b*(curve.Last-curve.First));
           try{segments.push(new Edge(maker.Edge()));}finally{maker.delete();}
          }
          const split=assembleWire(segments);builder.delete();builder=new this.oc.BRepOffsetAPI_MakePipeShell(split.wrapped);builder.SetMode(false);wire.delete();wire=split;
          }finally{original.delete();curve.returnValue.delete();segments.forEach(e=>e.delete());}
         }
        }finally{edges.forEach(e=>e.delete());}
        if(feature.params.guide){
         const g=feature.params.guide;
         if(g.contact!=='none'||!g.curvilinear)throw new CadError('SWEEP_GUIDE_UNSUPPORTED','Supported guide mode is curvilinear:true, contact:none. Contact/border modes are not certified.');
         guide='points'in g.path?splineWire(g.path.points):pathWire(g.path,g.path.frame);
         for(let i=0;i<=32;i++){const a=wire.pointAt(i/32),b=guide.pointAt(i/32);try{if(Math.hypot(...a.toTuple().map((v,k)=>v-b.toTuple()[k]))<0.01)throw new CadError('SWEEP_GUIDE_CONFLICT','Guide intersects or approaches the spine within 0.01 mm.',{at:i/32,point:a.toTuple()});}finally{a.delete();b.delete();}}
         builder.SetMode(guide.wrapped,true,this.oc.BRepFill_TypeOfContact.BRepFill_NoContact);
        }
        builder.SetTolerance(feature.params.toleranceMm??1e-5,1e-5,1e-4);
      }
      builder.SetTransitionMode(this.oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
      if(feature.params.sections){
       for(const section of feature.params.sections){
        const point=wire.pointAt(section.at),tangent=wire.tangentAt(section.at);
        try{
         const normal=tangent.toTuple(),x=perpendicular(feature.params.profileX??('points'in path?(Math.abs(normal[2])>0.999?[1,0,0]:[0,0,1]):path.frame.normal),normal),angle=(section.rotationDegrees??0)*Math.PI/180;
         const cross=[normal[1]*x[2]-normal[2]*x[1],normal[2]*x[0]-normal[0]*x[2],normal[0]*x[1]-normal[1]*x[0]],rotated=x.map((v,i)=>v*Math.cos(angle)+cross[i]*Math.sin(angle)) as Vector3;
         const sketch=profileSketch(section.profile,{origin:point.toTuple(),normal,xDirection:rotated});sectionSketches.push(sketch);
         const location=makeVertex(point.toTuple());locations.push(location);builder.Add(sketch.wire.wrapped,location.wrapped,false,false);
        }finally{point.delete();tangent.delete();}
       }
      }else if (endScale !== undefined && endScale !== 1) {
        // OCCT maps the law's range onto the whole path, so 0..1 means start..end.
        law = new this.oc.Law_Linear();
        law.Set(0, 1, 1, endScale);
        builder.SetLaw(profile.wire.wrapped, law, false, true);
      } else builder.Add(profile.wire.wrapped, false, true);
      builder.Build();
      if (!builder.IsDone() || !builder.MakeSolid()) throw new Error('OCCT could not build a solid sweep');
      const raw = builder.Shape();
      try { const result = this.solid(raw); if(advanced){
        const boundary=this.boundary(result);const sectionResiduals:{section:number;samples:number;maxDistanceMm:number;failingPoint:Vector3}[]=[];
        try{for(const [section,sketch] of (sectionSketches.length?sectionSketches:[profile]).entries()){
          let maxDistanceMm=0,samples=0,failingPoint:Vector3=[0,0,0];
          for(const edge of sketch.wire.edges)try{for(let i=0;i<=16;i++){const point=edge.pointAt(i/16),v=makeVertex(point.toTuple());try{const d=measureDistanceBetween(v,boundary.faces);samples++;if(d>=maxDistanceMm){maxDistanceMm=d;failingPoint=point.toTuple();}}finally{point.delete();v.delete();}}}finally{edge.delete();}
          sectionResiduals.push({section,samples,maxDistanceMm,failingPoint});
        }}finally{boundary.dispose();}
        if(sectionResiduals.some(r=>!Number.isFinite(r.maxDistanceMm)||r.maxDistanceMm>(feature.params.toleranceMm??0.001))){result.delete();throw new CadError('SWEEP_ACCURACY','Result misses the requested section at independently sampled perimeter points.',{sectionResiduals,errorOnSurfaceMm:builder.ErrorOnSurface()});}
        this.diagnostics.set(result,{sectionResiduals,measurement:'17 uniform native edge-parameter samples per authored section edge to exact result boundary; sampled only',method:'OCCT MakePipeShell',errorOnSurfaceMm:builder.ErrorOnSurface(),sections:feature.params.sections?.map(s=>({at:s.at,rotationDegrees:s.rotationDegrees??0})),parameter:'normalized native path parameter; not arclength',guide:feature.params.guide?{curvilinear:true,contact:'none'}:undefined});} const p=feature.params.sections?.[0].profile??feature.params.profile;this.history.authored(result,builder,(sectionSketches[0]??profile).wire.wrapped,p.type==='path'?p.segments.map((s,i)=>s.id??String(i)):p.type==='polygon'?p.segmentIds:undefined); return result; } finally { raw.delete(); }
    } finally { builder?.delete(); law?.delete(); profile?.delete(); guide?.delete();sectionSketches.forEach(s=>s.delete());locations.forEach(v=>v.delete());wire.delete(); }
  }

  private shell(shape: Shape3D, p: Extract<Feature, { kind: 'shell' }>['params']): Shape3D {
    if (this.count(shape, this.oc.TopAbs_ShapeEnum.TopAbs_SOLID) !== 1)
      throw new CadError('SHELL_REQUIRES_SINGLE_SOLID', 'Shell requires exactly one solid.');
    const faces: import('replicad').Face[] = [];
    const explorer = new this.oc.TopExp_Explorer(shape.wrapped, this.oc.TopAbs_ShapeEnum.TopAbs_FACE, this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const list = new this.oc.NCollection_List_TopoDS_Shape();
    const builder = new this.oc.BRepOffsetAPI_MakeThickSolid();
    try {
      for (; explorer.More(); explorer.Next()) {
        const raw = explorer.Current();
        try { faces.push(cast(raw) as import('replicad').Face); } finally { raw.delete(); }
      }
      const selected = new Set<import('replicad').Face>();
      for (const [index, query] of p.removeFaces.entries()) {
        const length = Math.hypot(...query.normal), normal = query.normal.map(v => v / length);
        const matches = faces.filter(face => {
          if (face.geomType !== 'PLANE') return false;
          const center = face.center, n = face.normalAt();
          try {
            const direction = n.toTuple(), point = center.toTuple();
            return Math.abs(Math.abs(direction.reduce((sum, v, i) => sum + v * normal[i], 0)) - 1) < 1e-7 &&
              Math.abs(point.reduce((sum, v, i) => sum + (v - query.point[i]) * normal[i], 0)) <= query.toleranceMm;
          } finally { center.delete(); n.delete(); }
        });
        if (matches.length !== query.expectedCount) throw new CadError('SHELL_FACE_SELECTION', `Shell opening ${index + 1} matched ${matches.length} planar faces; expected ${query.expectedCount}. Adjust its plane or expectedCount.`, { query: index, matchedCount: matches.length, expectedCount: query.expectedCount });
        for (const face of matches) {
          if (selected.has(face)) throw new CadError('SHELL_FACE_SELECTION', 'Shell opening queries overlap. Each face may be removed once.');
          selected.add(face); list.Append(face.wrapped);
        }
      }
      builder.MakeThickSolidByJoin(shape.wrapped, list, -p.thickness, 1e-6,
        this.oc.BRepOffset_Mode.BRepOffset_Skin, false, false, this.oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
      if (!builder.IsDone()) throw new Error('OCCT could not build the inward shell');
      const raw = builder.Shape();
      try { const result=this.solid(raw); this.history.capture(result,builder,[shape],false,true); return result; } finally { raw.delete(); }
    } finally { builder.delete(); list.delete(); explorer.delete(); for (const face of faces) face.delete(); }
  }

  private build(feature: Feature, shapes: Map<string, Shape3D>): Shape3D {
    if(feature.kind==='fill'){const {shape,diagnostics}=fillSheet(this.oc,feature.params,shapes,this.history);this.diagnostics.set(shape,diagnostics);this.history.set(shape,[['sheet']]);return shape;}
    if(feature.kind==='join'){const {shape,diagnostics}=joinSheets(this.oc,feature.params,shapes,this.history);this.diagnostics.set(shape,diagnostics);return shape;}
    if (feature.kind === 'instance')
      throw new CadError('INSTANCE_CONTEXT', 'Instances require referenced documents.');
    if (feature.kind === 'box') {
      const { origin, size } = feature.params;
      const start = new this.oc.gp_Pnt(...origin);
      const end = new this.oc.gp_Pnt(origin[0] + size[0], origin[1] + size[1], origin[2] + size[2]);
      let builder: InstanceType<OpenCascadeInstance['BRepPrimAPI_MakeBox']> | undefined;
      try {
        builder = new this.oc.BRepPrimAPI_MakeBox(start, end);
        const raw = builder.Shape();
        try {
          return this.solid(raw);
        } finally {
          raw.delete();
        }
      } finally {
        builder?.delete();
        start.delete();
        end.delete();
      }
    }
    if (feature.kind === 'rod') {
      const { from, to, radius } = feature.params;
      const direction = to.map((v, i) => v - from[i]) as Vector3;
      const point = new this.oc.gp_Pnt(...from),
        normal = new this.oc.gp_Dir(...direction);
      const axis = new this.oc.gp_Ax2(point, normal);
      let builder: InstanceType<OpenCascadeInstance['BRepPrimAPI_MakeCylinder']> | undefined;
      try {
        builder = new this.oc.BRepPrimAPI_MakeCylinder(axis, radius, Math.hypot(...direction));
        const raw = builder.Shape();
        try {
          return this.solid(raw);
        } finally {
          raw.delete();
        }
      } finally {
        builder?.delete();
        axis.delete();
        normal.delete();
        point.delete();
      }
    }
    if (feature.kind === 'cylinder') {
      const { radius, height, origin } = feature.params;
      return makeCylinder(radius, height, origin, [0, 0, 1]);
    }
    if (feature.kind === 'extrude' || feature.kind === 'revolve') {
      const frame = extrusionFrame(feature.kind === 'extrude' ? feature.params.plane : 'XZ', feature.params.origin);
      const sketch = profileSketch(feature.kind === 'extrude' ? feature.params.profile : { type:'polygon', points:feature.params.points }, frame);
      const face = makeFace(sketch.wire), owned: {delete():void}[] = [];
      const own = <T extends {delete():void}>(v:T) => { owned.push(v); return v; };
      try {
        const builder = feature.kind === 'extrude'
          ? own(new this.oc.BRepPrimAPI_MakePrism(face.wrapped, own(new this.oc.gp_Vec(...frameAxes(frame)[2].toArray().map(v=>v*feature.params.distance) as Vector3)), false, true))
          : own(new this.oc.BRepPrimAPI_MakeRevol(face.wrapped, own(new this.oc.gp_Ax1(own(new this.oc.gp_Pnt(...feature.params.origin)),own(new this.oc.gp_Dir(0,0,1)))), feature.params.angleDegrees*Math.PI/180, false));
        const raw = own(builder.Shape()), result = this.solid(raw);
        this.history.authored(result, builder, sketch.wire.wrapped,feature.kind==='extrude'?(feature.params.profile.type==='path'?feature.params.profile.segments.map((s,i)=>s.id??String(i)):feature.params.profile.type==='polygon'?feature.params.profile.segmentIds:undefined):undefined);
        if (feature.kind==='revolve') {
          const table=topologyTable(this.oc,result,feature,this.history.get(result));
          const points=feature.params.points;
          for(let i=0;i<points.length;i++){
            const a=points[i],b=points[(i+1)%points.length];
            if(Math.abs(a[1]-b[1])>1e-9)continue;
            const expected=Math.abs(b[0]*b[0]-a[0]*a[0])*Math.PI*feature.params.angleDegrees/360;
            const matching=table.faces.filter(f=>!f.lineage.length&&f.surface==='PLANE'&&Math.abs(f.center[2]-feature.params.origin[2]-a[1])<1e-7&&Math.abs(f.areaMm2-expected)<Math.max(1e-7,expected*1e-9));
            if(matching.length===1)matching[0].lineage=[`side.${i}`];
          }
          this.history.set(result,table.faces.map(f=>f.lineage));
        }
        return result;
      } finally { owned.reverse().forEach(v=>v.delete()); face.delete(); sketch.delete(); }
    }
    if (feature.kind === 'loft') return this.loft(feature);
    if (feature.kind === 'sweep') return this.sweep(feature);
    if (feature.kind === 'text') return this.text(feature, shapes);
    let target = this.copyShape(shapes.get(feature.params.target)!);
    if (feature.kind === 'shell') {
      try { return this.shell(target, feature.params); } finally { target.delete(); }
    }
    if (feature.kind === 'transform') {
      const p = feature.params;
      try {
        if (p.scale !== 1) target = this.scale(target, p.scale, p.origin);
        if (p.angleDegrees !== 0) target = this.rotate(target, p.angleDegrees, p.origin, p.rotationAxis);
        if (p.translation.some((v) => v !== 0)) target = this.translate(target, p.translation);
        return target;
      } catch (error) {
        target.delete();
        throw error;
      }
    }
    if (feature.kind === 'mirror') {
      try {
        return this.mirror(target, feature.params.plane, feature.params.origin);
      } catch (error) {
        target.delete();
        throw error;
      }
    }
    if (feature.kind === 'subtract' || feature.kind === 'union' || feature.kind === 'intersect') {
      try {
        for (const toolId of feature.params.tools) {
          const tool = this.copyShape(shapes.get(toolId)!);
          try {
            const next = this.boolean(feature.kind, target, tool);
            target.delete();
            target = next;
          } finally {
            tool.delete();
          }
        }
        return target;
      } catch (error) {
        target.delete();
        throw error;
      }
    }
    if (feature.kind === 'pattern') {
      // Copies are gathered into one compound without fusing: one feature and no booleans, however many copies.
      const layout = feature.params.layout;
      const copies: Shape3D[] = [target];
      this.history.set(target,(this.history.get(target)??[]).map(names=>names.map(n=>`copy0:${n}`)));
      try {
        for (let i = 1; i < layout.count; i++) {
          let copy = this.copyShape(target);
          this.history.set(copy,(this.history.get(copy)??[]).map(names=>names.map(n=>`copy${i}:${n.replace(/^copy0:/,'')}`)));
          copies.push(copy);
          if (layout.type === 'linear') {
            const length = Math.hypot(...layout.direction);
            copy = this.translate(
              copy,
              layout.direction.map((v) => (v / length) * layout.spacing * i) as Vector3
            );
          } else {
            const step =
              layout.angleDegrees >= 360 ? 360 / layout.count : layout.angleDegrees / (layout.count - 1);
            copy = this.rotate(copy, step * i, layout.origin, layout.axis);
          }
          copies[copies.length - 1] = copy;
        }
        const compound = this.compound(copies);
        for (const copy of copies) copy.delete();
        return compound;
      } catch (error) {
        for (const copy of copies) copy.delete();
        throw error;
      }
    }
    if (feature.kind === 'drill_holes') {
      const index = { X: 0, Y: 1, Z: 2 }[feature.params.axis];
      const direction: Vector3 = [0, 0, 0];
      direction[index] = 1;
      const margin = Math.max(1, feature.params.diameter);
      try {
        const bounds = this.measure(feature.params.target, target).bounds;
        for (const center of feature.params.centers) {
          const origin: Vector3 = [...center];
          origin[index] = bounds.min[index] - margin;
          const cutter = makeCylinder(
            feature.params.diameter / 2,
            bounds.size[index] + margin * 2,
            origin,
            direction
          );
          this.history.set(cutter, topologyLineage(this.oc, cutter, { id: 'hole', kind: 'cylinder', params: { origin, radius: feature.params.diameter / 2, height: bounds.size[index] + margin * 2 } }).map(names => names.includes('side') ? [`hole.${feature.params.centers.indexOf(center)}.wall`] : []));
          let next: Shape3D | undefined;
          try {
            const before = this.measure(feature.id, target).volumeMm3;
            next = this.boolean('subtract', target, cutter);
            const after = this.measure(feature.id, next).volumeMm3;
            if (before - after <= Math.max(1e-8, before * 1e-12))
              throw new CadError(
                'HOLE_MISSES_SOLID',
                `Hole ${feature.params.centers.indexOf(center) + 1} at ` +
                  `(${center.map(round).join(', ')}) removes no material: ` +
                  'it misses the target or lands inside an existing hole of the same size. ' +
                  'Move it or change the drilling axis.',
                { center, axis: feature.params.axis, holeIndex: feature.params.centers.indexOf(center) }
              );
            target.delete();
            target = next;
            next = undefined;
          } finally {
            next?.delete();
            cutter.delete();
          }
        }
        return target;
      } catch (error) {
        target.delete();
        throw error;
      }
    }
    // Resolve semantic edge selectors again on replay, never persisted edge indices.
    let disposeMatcher: (() => void) | undefined;
    const selectedNativeEdges:import('replicad-opencascadejs').TopoDS_Shape[]=[];
    try {
      const adjacentPreview=()=>{
        const rawFaces=indexedShapes(this.oc,target.wrapped,'FACE');
        try{const names=this.history.get(target)??topologyLineage(this.oc,target,feature),selected=new Set<number>();
          rawFaces.forEach((face,index)=>{
            const edges=indexedShapes(this.oc,face,'EDGE');
            try{if(edges.some(edge=>selectedNativeEdges.some(selected=>selected.IsSame(edge))))selected.add(index);}
            finally{edges.forEach(edge=>edge.delete());}
          });
          const patches:{names:string[];vertices:number[];triangles:number[]}[]=[];let values=0;
          for(const index of selected){const raw=this.oc.TopoDS.Face(rawFaces[index]),face=cast(raw) as import('replicad').Face;raw.delete();
            try{const mesh=face.mesh(MESH_OPTIONS);if(values+mesh.vertices.length+mesh.triangles.length>64000)continue;values+=mesh.vertices.length+mesh.triangles.length;patches.push({names:names[index]??[],vertices:mesh.vertices,triangles:mesh.triangles});}finally{face.delete();}}
          return {patches,selectedFaces:selected.size,omittedFaces:selected.size-patches.length,displayOnly:true};
        }catch(error){return{patches:[],selectedFaces:0,omittedFaces:0,displayOnly:true,error:this.kernelMessage(error)};}finally{rawFaces.forEach(f=>f.delete());selectedNativeEdges.splice(0).forEach(e=>e.delete());}
      };
      const picked: { index: number; midpoint: Vector3; lengthMm: number; curve: string;previewLines:number[] }[] = [];
      const amount = feature.kind === 'fillet' ? feature.params.radius : feature.params.distance;
      const take = (edge: import('replicad').Edge, index: number) => {
        let midpoint: Vector3 = [NaN, NaN, NaN], lengthMm = NaN;
        try {
          const point = edge.pointAt(0.5);
          midpoint = point.toTuple().map(round) as Vector3;
          point.delete();
          lengthMm = round(edge.length);
        } catch {
          /* positions are advisory */
        }
        const previewLines:number[]=[];for(let i=0;i<16;i++){const a=edge.pointAt(i/16),b=edge.pointAt((i+1)/16);try{previewLines.push(...a.toTuple(),...b.toTuple());}finally{a.delete();b.delete();}}
        selectedNativeEdges.push(edge.wrapped.Oriented(edge.wrapped.Orientation()));
        picked.push({ previewLines,index, midpoint, lengthMm, curve: edge.geomType.toLowerCase() });
        return amount;
      };
      if(typeof feature.params.edges!=='string'&&feature.params.edges.refs?.some(ref=>ref.feature!==feature.params.target))throw new CadError('REFERENCE_SCOPE','Blend EdgeRefs must belong to the target feature.');
      const matcherShapes=new Map(shapes);matcherShapes.set(feature.params.target,target);
      const matcher = this.edgeMatcher(feature.params.edges, matcherShapes);
      disposeMatcher = matcher.dispose;
      const selector = (edge: import('replicad').Edge, index: number) => (matcher.matches(edge) ? take(edge, index) : null);
      const seam = typeof feature.params.edges !== 'string' && feature.params.edges.between;
      const described =
        typeof feature.params.edges === 'string' ? `${feature.params.edges} edges` : seam ? 'seam edges' : 'queried edges';
      const emptySelectionMessage =
        `No ${described} found on '${feature.params.target}'.` +
        (typeof feature.params.edges === 'string'
          ? ''
          : seam
            ? ` No edge of '${feature.params.target}' lies on the surfaces of both '${seam[0]}' and '${seam[1]}' ` +
              'within toleranceMm (default 0.01). Name the inputs that were united, and remove other criteria to test the seam alone.'
            : ' Check the query against inspect_model bounds: near points must lie within toleranceMm ' +
              'of an edge, and on planes must match a face exactly.');
      let result: Shape3D;
      try {
        result = this.blend(target, feature.kind, selector);
      } catch (error) {
        if (!picked.length)
          throw new CadError('EMPTY_EDGE_SELECTION', emptySelectionMessage, { edges: feature.params.edges });
        if(error instanceof CadError&&error.code==='BLEND_LAW_SCOPE'){selectedNativeEdges.splice(0).forEach(e=>e.delete());throw error;}
        const failure=this.blendFailure(feature, target, picked, amount, described, this.kernelMessage(error));failure.details={...(failure.details as object),adjacentFaces:adjacentPreview()};throw failure;
      }
      // The kernel can finish a blend that is not a valid solid; diagnose it like a failed one.
      if (picked.length && !this.validSolid(result)) {
        result.delete();
        const failure=this.blendFailure(feature,target,picked,amount,described,'the blended solid is invalid');failure.details={...(failure.details as object),adjacentFaces:adjacentPreview()};throw failure;
      }
      if (!picked.length) {
        result.delete();
        throw new CadError('EMPTY_EDGE_SELECTION', emptySelectionMessage, { edges: feature.params.edges });
      }
      this.diagnostics.set(result,{adjacentFaces:adjacentPreview(),selectedEdges:picked.map(({index,...e})=>e),radius:amount,stationParameter:'normalized arclength on one native forward edge; tangent chains unsupported'});
      return result;
    } finally {
      selectedNativeEdges.splice(0).forEach(edge=>edge.delete());
      disposeMatcher?.();
      target.delete();
    }
  }

  /**
   * The kernel only says "not done". Measured sizes and a bounded trial of each selected edge alone turn that into a
   * concrete next edit: a smaller value, or which edges to blend separately.
   */
  private blendFailure(
    feature: Extract<Feature, { kind: 'fillet' | 'chamfer' }>,
    target: Shape3D,
    picked: { index: number; midpoint: Vector3; lengthMm: number; curve: string }[],
    amount: number | {stations:number[][]},
    described: string,
    kernelError: string
  ): CadError {
    const requested=amount;amount=typeof amount==='number'?amount:Math.max(...amount.stations.map(s=>s[1]));
    const started=performance.now();
    const shortest = Math.min(...picked.map((edge) => edge.lengthMm).filter(Number.isFinite));
    const thinnest = Math.min(...this.measure(feature.params.target, target).bounds.size);
    const limit = Math.min(shortest, thinnest) / 2;
    const word = feature.kind === 'fillet' ? 'radius' : 'distance';
    const trials: { midpoint: Vector3; lengthMm: number; curve: string; blendsAlone?: boolean }[] = picked.map(({ index: _index, ...edge }) => edge);
    if (picked.length > 1) {
      for (const [i, edge] of picked.slice(0, BLEND_TRIAL_EDGES).entries()) {
        if (performance.now() - started > BLEND_TRIAL_MS) break;
        try {
          // Blends alone only when the kernel builds it and the result passes the same validity check.
          const alone = this.blend(target, feature.kind, (_edge, index) => (index === edge.index ? amount : null));
          try { trials[i].blendsAlone = this.validSolid(alone); } finally { alone.delete(); }
        } catch {
          trials[i].blendsAlone = false;
        }
      }
    }
    const radiusObservations:{midpoint:Vector3;amountMm:number;valid:boolean}[]=[];
    for(const edge of picked.slice(0,BLEND_TRIAL_EDGES))for(const scale of [0.5,0.25,0.75]){
      if(performance.now()-started>=BLEND_TRIAL_MS)break;
      const value=Math.max(0.01,Math.min(amount*scale,limit*scale));let valid=false;
      try{const attempt=this.blend(target,feature.kind,(_e,i)=>i===edge.index?value:null);try{valid=this.validSolid(attempt);}finally{attempt.delete();}}catch{}
      radiusObservations.push({midpoint:edge.midpoint,amountMm:value,valid});
    }
    const points = (edges: typeof trials) => JSON.stringify(edges.map((edge) => edge.midpoint));
    const alone = trials.filter((edge) => edge.blendsAlone === true), failing = trials.filter((edge) => edge.blendsAlone === false);
    const seam = typeof feature.params.edges !== 'string' && feature.params.edges.between;
    let advice: string;
    if (failing.length && alone.length)
      advice = `Alone, ${countLabel(alone.length, 'edge')} blend and ${countLabel(failing.length, 'edge')} still fail. ` +
        `Blend the working ones with edges {near:${points(alone)}} and give the others near:${points(failing)} a smaller ${word} in a later feature.`;
    else if (alone.length && !failing.length && alone.length === trials.length)
      advice = 'Every edge blends alone but not together, usually where blends meet at a corner or run tangent. ' +
        `Blend them in separate features, each targeting the previous one: edges {near:[point]} with points ${points(alone)}.`;
    else if (failing.length && failing.length === trials.length)
      advice = `None of them blends even alone at ${amount} mm: the faces beside them are too narrow or already meet ` +
        `smoothly (tangent edges need no blend). Leave them out of the selection or use a smaller ${word}.`;
    else if (amount < limit)
      advice = `A ${word} of ${amount} mm is below the size limit of about ${round(limit)} mm, so the faces next to the edge are the likely cause` +
        (seam
          ? `: the ${word} must fit on both joined surfaces. Let '${seam[1]}' reach further into '${seam[0]}', or try a smaller ${word}.`
          : '. Select fewer edges, blend before later cuts, or try a smaller value.');
    else advice = `Try a ${word} below about ${round(limit)} mm` + (feature.params.edges === 'all' ? ', or edges vertical.' : '.');
    return new CadError(
      'GEOMETRY_FAILED',
      `Could not rebuild '${feature.id}' (${feature.kind}) with ${word} ${amount} mm on ${countLabel(picked.length, described.replace(/s$/, ''))}: ` +
        `${kernelError || 'the kernel could not blend them'}. The shortest selected edge is ${round(shortest)} mm ` +
        `and the target's thinnest extent is ${round(thinnest)} mm. ${advice}`,
      {
        featureId: feature.id,
        kind: feature.kind,
        requested,radiusObservations,diagnosticBudgetMs:BLEND_TRIAL_MS,note:'Observed individual trials only; no monotonicity assumption. Native calls finish or the worker deadline terminates the worker.',
        selectedEdges: picked.length,
        edges: trials.slice(0, BLEND_TRIAL_EDGES),
        shortestEdgeMm: round(shortest),
        thinnestExtentMm: round(thinnest),
        suggestedMaximumMm: round(limit),
        kernelError,
      }
    );
  }

  /** Rigid placement of a cached exact result; source geometry is never consumed. */
  private place(shape: Shape3D, p: Placement): Shape3D {
    let result = this.copyShape(shape);
    try {
      if (p.angleDegrees) result = this.rotate(result, p.angleDegrees, p.origin, p.rotationAxis);
      if (p.translation.some((v) => v !== 0)) result = this.translate(result, p.translation);
      return result;
    } catch (error) { result.delete(); throw error; }
  }

  private displayAssets = new Map<CachedResult, Evaluation['meshes'][number]>();
  private meshOptions = MESH_OPTIONS;
  private tessellate(entry: CachedResult, options: MeshOptions, valueLimit = this.displayBudget): DisplayMesh {
    if (!entry.topology && entry.topologyFeature) entry.topology = topologyTable(this.oc, entry.shape, entry.topologyFeature, this.history.get(entry.shape));
    const mesh = topologyMesh(this.oc, entry.shape, options, valueLimit);
    const edgeRanges: number[] = [];
    const lines = this.edgeLines(entry.shape, edgeRanges);
    return { featureId: entry.mesh.featureId, ...mesh, lines, edgeRanges, topology: entry.topology };
  }

  /**
   * Edge outlines as segment pairs, read from the polylines the face mesh already placed on each edge.
   * Rediscretizing every edge instead (replicad meshEdges) took minutes on fine meshes of Boolean B-spline seams.
   */
  private edgeLines(shape: Shape3D, ranges?: number[]): number[] {
    const oc = this.oc, lines: number[] = [];
    const rawEdges = indexedShapes(oc, shape.wrapped, 'EDGE');
    try { for (let edgeIndex = 0; edgeIndex < rawEdges.length; edgeIndex++) {
      const edge = { wrapped: oc.TopoDS.Edge(rawEdges[edgeIndex]) };
      const start = lines.length / 6;
      const location = new oc.TopLoc_Location();
      let found: { P?: InstanceType<OpenCascadeInstance['Poly_PolygonOnTriangulation']> | null; T?: InstanceType<OpenCascadeInstance['Poly_Triangulation']> | null } | undefined;
      try {
        found = oc.BRep_Tool.PolygonOnTriangulation(edge.wrapped as never, location);
        const polygon = found?.P, triangulation = found?.T;
        if (!polygon || !triangulation || (polygon as { IsNull?: () => boolean }).IsNull?.()) continue;
        const transform = location.Transformation();
        try {
          let previous: number[] | undefined;
          for (let i = 1; i <= polygon.NbNodes(); i++) {
            const node = triangulation.Node(polygon.Node(i));
            const placed = node.Transformed(transform);
            const point = [placed.X(), placed.Y(), placed.Z()].map(Math.fround); // float32, like mesh vertices
            node.delete(); placed.delete();
            if (previous) lines.push(...previous, ...point);
            previous = point;
          }
        } finally { transform.delete(); }
      } finally {
        found?.P?.delete?.(); found?.T?.delete?.();
        location.delete(); edge.wrapped.delete();
        if (lines.length / 6 > start) ranges?.push(start, lines.length / 6 - start, edgeIndex);
      }
    } } finally { rawEdges.forEach(e => e.delete()); }
    return lines;
  }
  private placedMesh(piece: Piece, featureId: string): Evaluation['meshes'] {
    let base = this.displayAssets.get(piece.result);
    if (!base) {
      const key = meshKey(this.meshOptions), entry = piece.result;
      if (entry.meshQuality !== key) this.cache.setMesh(entry, this.tessellate(entry, this.meshOptions), key);
      base = structuredClone(entry.mesh);
      this.displayAssets.set(entry, base);
    }
    const transform = piece.placements.reduce((m,p) => multiplyMatrix(placementMatrix(p),m),identityMatrix());
    const appearanceOrigins=Object.fromEntries(Object.entries(resolveAppearance(piece.layers??[]).fields).map(([k,v])=>[k,v.from]));
    const mesh:DisplayMesh = { ...base, appearanceOrigins, featureId, occurrencePath: piece.occurrence, source: piece.source,resultKind:piece.result.geometry.resultKind, ...(piece.appearance ? {appearance:piece.appearance} : {}),
      ...(piece.placements.length ? {transform} : {}) };
    if(!piece.surfaceStyles?.length&&!piece.paintRegions?.length)return [mesh];
    const byFace=new Map<number,Appearance>();
    const faceOrigins=new Map<number,NonNullable<DisplayMesh['appearanceOrigins']>>();
    for(const style of piece.surfaceStyles??[])for(const index of resolveFaces(base.topology!,style.target)){byFace.set(index,{...(byFace.get(index)??piece.appearance),...style.look});faceOrigins.set(index,{...(faceOrigins.get(index)??appearanceOrigins),...Object.fromEntries(Object.keys(style.look).map(k=>[k,style.fieldOrigins?.[k]??style.from??{documentId:piece.source.documentId,featureId:style.target.feature,layer:'face'}]))});}
    if(piece.paintRegions?.length)return regionMeshes(this.oc,piece.result.shape.wrapped,mesh,piece.paintRegions,byFace,faceOrigins,this.meshOptions.tolerance);
    const groups=new Map<string,{appearance:Appearance|undefined;appearanceOrigins:DisplayMesh['appearanceOrigins'];triangles:number[];faceRanges:number[]}>();
    for(let i=0;i<(base.faceRanges?.length??0);i+=4){
      const [start,count,faceIndex]=base.faceRanges!.slice(i,i+4),appearance=byFace.get(faceIndex)??piece.appearance,key=JSON.stringify([appearance,faceOrigins.get(faceIndex)??appearanceOrigins]);
      let group=groups.get(key);if(!group)groups.set(key,group={appearance,appearanceOrigins:faceOrigins.get(faceIndex)??appearanceOrigins,triangles:[],faceRanges:[]});
      group.faceRanges.push(group.triangles.length/3,count,faceIndex,0);
      for(let t=start*3;t<(start+count)*3;t++)group.triangles.push(base.triangles[t]);
    }
    return [...groups.values()].map((g,i)=>({...mesh,...g,lines:i?[]:mesh.lines,edgeRanges:i?[]:mesh.edgeRanges}));
  }

  /**
   * Auto detail starts at a size-relative tolerance, then fits the display budget. Explicit fine detail stays
   * available for close inspection. Each result remembers its value count per
   * quality, so a quality that did not fit is ruled out by arithmetic, and a trial stops as soon as it is over budget.
   * Only the accepted quality's meshes are kept.
   */
  private display(groups: Map<string, Piece[]>, detail: 'auto' | 'fine' | 'coarse', diagonal: number): Evaluation['meshes'] {
    const coarse = {tolerance: snapTolerance(Math.max(0.5, diagonal / 2000)), angularTolerance: 0.4};
    const tolerance = snapTolerance(Math.max(MESH_OPTIONS.tolerance, diagonal / 10000));
    // Large models use the angular detail that fits the car display budget directly, avoiding a discarded fine trial.
    // Explicit Fine retains the original tolerances; small parts retain the original Auto profile too.
    const automatic = { tolerance, angularTolerance: tolerance >= 0.2 ? 0.25 : MESH_OPTIONS.angularTolerance };
    const profiles = detail === 'fine' ? [MESH_OPTIONS] : detail === 'coarse' ? [coarse] :
      [automatic, {tolerance: snapTolerance(Math.max(0.2, diagonal / 10000)), angularTolerance:0.25}, coarse];
    const entries = [...new Set([...groups.values()].flatMap(pieces => pieces.map(piece => piece.result)))];
    const placements = [...groups.values()].reduce((n, pieces) => n + pieces.length, 0);
    let values = 0, bytes = 0;
    for (const options of profiles) {
      const key = meshKey(options), trial = new Map<CachedResult, DisplayMesh>();
      values = 0;
      for (const entry of entries) {
        let count = entry.meshQuality === key ? meshValues(entry.mesh) : entry.meshValues?.[key];
        if (count === undefined) {
          let mesh: DisplayMesh;
          try { mesh = this.tessellate(entry, options, this.displayBudget - values); }
          catch (error) {
            if (!(error instanceof CadError) || error.code !== 'MODEL_TOO_COMPLEX') throw error;
            values = this.displayBudget + 1;
            break;
          }
          trial.set(entry, mesh);
          (entry.meshValues ??= {})[key] = count = meshValues(mesh);
        }
        values += count;
        if (values > this.displayBudget) break;
      }
      bytes = values <= this.displayBudget ? displayBytes(values, placements) : Infinity;
      if (bytes > DISPLAY_BYTES) continue;
      for (const [entry, mesh] of trial) this.cache.setMesh(entry, mesh, key);
      this.meshOptions = options; this.displayAssets.clear();
      const output=[...groups].flatMap(([id, pieces]) => pieces.flatMap(piece => this.placedMesh(piece,id)));
      const assets=new Set<number[]>();let packedValues=0;
      for(const mesh of output)if(!assets.has(mesh.triangles)){assets.add(mesh.triangles);packedValues+=meshValues(mesh);}
      if(packedValues>this.displayBudget)throw new CadError('MODEL_TOO_COMPLEX','Styled display exceeds its packed asset budget. Inspect fewer results or use a coarser display.',{values:packedValues,limit:this.displayBudget});
      return output;
    }
    throw new CadError('MODEL_TOO_COMPLEX', 'Requested display exceeds the bounded output capacity. Saved definitions, JSON export and undo remain available. Request display detail coarse or inspect one part.', {values,limit:this.displayBudget,bytes:Number.isFinite(bytes)?bytes:undefined});
  }

  /**
   * Builds exact results and, unless `meshes` is false, display meshes. An explicit display request fails when its
   * display does not fit; an implicit one (a commit or refresh) keeps the exact result and reports displayError.
   */
  evaluate(value: CadDocument, documents: CadDocument[] = [], replay?: { step: number; key: string }, display?: Pick<DisplayRequest,'detail'|'step'|'featureIds'>, options: { meshes?: boolean } = {}): Evaluation {
    const started = performance.now();
    const fullGraph = assemblyGraph(value, documents);
    const document = fullGraph.at(-1)!;
    const plan = replay ? this.constructionPlan(document, fullGraph) : undefined;
    const replayEntry = replay ? plan![replay.step - 1] : undefined;
    if (replay && !replayEntry) throw new CadError('REPLAY_STEP', 'This construction step does not exist. Restart replay.');
    const stopAt = replayEntry?.step.rootStep ?? display?.step;
    if (stopAt !== undefined && stopAt > document.features.length) throw new CadError('REPLAY_STEP', 'The build step does not exist.');
    // Validate the complete frozen graph above, but evaluate only the requested root prefix and its sources.
    const progressive=replayEntry?replayDefinitions(document,fullGraph,replayEntry):undefined;
    const partialSources=progressive?.partial??new Set<string>();
    const rootPrefix={...document,features:document.features.slice(0,stopAt),selectedFeatureIds:[],analysis:undefined};
    const ordered=stopAt===undefined?fullGraph:assemblyGraph(rootPrefix,progressive?.documents??fullGraph);
    const staged = new ResultCache();
    const added: CachedResult[] = [],
      pinned = new Set<CachedResult>();
    const rebuilt: string[] = [];
    const evaluated = new Map<
      string,
      {
        document: CadDocument;
        results: Map<string, CachedResult>;
        pieces: Map<string, Piece[]>;
        evaluation: Evaluation;
        placements: Map<string, Placement>;
      }
    >();
    const referencedDocuments: NonNullable<NonNullable<Evaluation['stats']>['referencedDocuments']> = [];
    let hits = 0;
    try {
      for (const doc of ordered) {
        const candidate = new Map<string, Shape3D>(),
          results = new Map<string, CachedResult>(),
          pieces = new Map<string, Piece[]>(),
          placements = new Map<string, Placement>();
        const geometry: GeometryInfo[] = [],
          meshes: Evaluation['meshes'] = [],
          instances: NonNullable<Evaluation['instances']> = [],
          localRebuilt: string[] = [];
        let pieceCount = 0;
        for (const feature of doc.features) {
          const source = feature.kind === 'instance' ? evaluated.get(feature.params.document)! : undefined;
          const ids = source
            ? feature.kind === 'instance' && feature.params.featureId && !partialSources.has(feature.params.document)
              ? [feature.params.featureId]
              : source.evaluation.visibleFeatureIds
            : references(feature);
          if (source && (!ids.length || ids.some((id) => !source.evaluation.visibleFeatureIds.includes(id))))
            throw new CadError(
              'INSTANCE_RESULT_NOT_VISIBLE',
              `Instance '${feature.id}' must reference a nonempty visible result in '${source.document.name ?? source.document.documentId}'.`,
              { visibleFeatureIds: source.evaluation.visibleFeatureIds }
            );
          const inputs = ids.map((id) => (source?.results ?? results).get(id)!);
          if(feature.kind!=='fill'&&feature.kind!=='join'&&inputs.some(i=>i.geometry.resultKind==='sheet'))throw new CadError('CONSTRUCTION_INPUT','Only fill and join accept construction sheet inputs.');
          let placement: Placement | undefined;
          if (feature.kind === 'instance') {
            placement = feature.params;
            const attachment = feature.params.attachment;
            if (attachment) {
              if (!ids.includes(attachment.source.featureId)) throw new CadError('MOUNT_SOURCE_RESULT', 'The source mount must belong to an included visible source result.', { sourceFeatureIds: ids });
              const sourceFrame = findMount(source!.evaluation.geometry.find(g => g.featureId === attachment.source.featureId)?.mounts, attachment.source.name, attachment.source.featureId);
              const target = attachment.target;
              const targetFrame = 'frame' in target ? target.frame : findMount(geometry.find(g => g.featureId === target.featureId)?.mounts, target.name, target.featureId);
              placement = attachmentPlacement(sourceFrame, targetFrame, attachment);
            }
          }
          if (placement) placements.set(feature.id, placement);
          // Attachment names and metadata are resolved to their actual rigid transform before hashing.
          const geometricFeature = feature.kind === 'instance' ? { ...feature, params: { ...placement! } } as Feature : feature;
          const key = fingerprint(geometricFeature, inputs.map((entry) => entry.fingerprint));
          let entry = this.cache.find(key) ?? staged.find(key);
          if (entry) hits++;
          else {
            let shape: Shape3D | undefined;
            try {
              if (feature.kind === 'instance') {
                for (const input of inputs) this.inputLineage(input);
                const combined = this.compound(inputs.map((input) => input.shape));
                try {
                  shape = this.place(combined, placement!);
                } finally {
                  combined.delete();
                }
              } else {
                const local = new Map(candidate), copies: Shape3D[] = [];
                try {
                  ids.forEach((id, slot) => {
                    const input = results.get(id)!;
                    const names = this.inputLineage(input);
                    const copy = this.copyShape(input.shape); copies.push(copy);
                    this.history.set(copy, names.map(labels => labels.map(name => `in${slot}:${name}`)));
                    local.set(id,copy);
                  });
                  shape = this.build(feature, local);
                } finally { copies.forEach(s=>s.delete()); }
              }
              const info = this.measure(feature.id, shape, feature.kind === 'instance' ? this.translatedBounds(inputs, placement!) : undefined);
              if (feature.kind === 'shell') {
                const base = inputs[0].geometry;
                if (info.solidCount !== 1 || info.volumeMm3 >= base.volumeMm3 || info.bounds.min.some((v,i) => v < base.bounds.min[i] - 1e-5) || info.bounds.max.some((v,i) => v > base.bounds.max[i] + 1e-5))
                  throw new CadError('SHELL_THICKNESS', `Shell '${feature.id}' did not produce one inward hollow solid. Reduce thickness or change the openings.`);
              }
              entry = {
                fingerprint: key, shape, geometry: info, topologyFeature: feature,
                mesh: {featureId:feature.id,vertices:[],normals:[],triangles:[],lines:[]}, meshBytes:0,
              };
              staged.add(entry);
              added.push(entry);
              localRebuilt.push(feature.id);
              if (doc.documentId === document.documentId) rebuilt.push(feature.id);
            } catch (error) {
              shape?.delete();
              if (error instanceof CadError) throw error;
              const kernel = this.kernelMessage(error);
              throw new CadError(
                'GEOMETRY_FAILED',
                `Could not rebuild '${feature.id}' (${feature.kind})${kernel ? `: ${kernel}` : ''}. ${GEOMETRY_HINTS[feature.kind]}`,
                { featureId: feature.id, kind: feature.kind, kernelError: kernel || String(error) }
              );
            }
          }
          results.set(feature.id, entry);
          candidate.set(feature.id, entry.shape);
          pinned.add(entry);
          const info: GeometryInfo = {
            ...entry.geometry,
            ...(entry.geometry.diagnostics?{diagnostics:structuredClone(entry.geometry.diagnostics)}:{}),
            featureId: feature.id,
            bounds: structuredClone(entry.geometry.bounds),
          };
          let inheritedMounts = references(feature)[0] ? geometry.find(g => g.featureId === references(feature)[0])?.mounts : undefined;
          if (feature.kind === 'instance' && source) inheritedMounts = ids.flatMap(id =>
            (source.evaluation.geometry.find(g => g.featureId === id)?.mounts ?? []).map(m => ({ name: `${id}/${m.name}`, frame: placeFrame(m.frame, placement!) })));
          const mounts = derivedMounts(feature, inheritedMounts);
          if (mounts.length) info.mounts = mounts;
          let partPieces: Piece[];
          if (feature.kind === 'instance' && source) {
            const count = ids.reduce((sum, id) => sum + source.pieces.get(id)!.length, 0);
            if (pieceCount + count > MAX_ASSEMBLY_FEATURES)
              throw new CadError(
                'ASSEMBLY_LIMIT',
                `An evaluated document may contain at most ${MAX_ASSEMBLY_FEATURES} expanded result pieces.`
              );
            if(feature.graphicEdits){
              const available=new Set(ids.flatMap(id=>source.pieces.get(id)!.flatMap(p=>p.appearance?.graphics?.map(g=>g.id)??[])));
              for(const id of feature.graphicEdits.remove)if(!available.has(id))throw new CadError('REFERENCE_MISSING',`Source graphic '${id}' no longer exists on this occurrence.`,{reference:{feature:feature.id,graphic:id},candidates:[...available]});
            }
            partPieces = ids
              .flatMap((id) => source.pieces.get(id)!)
              .map((piece) => ({
                ...piece,
                layers:[...(piece.layers??[]),{value:feature.appearance,from:{documentId:doc.documentId,featureId:feature.id,layer:'occurrence'}}],
                appearance: hydrateGraphics(resolveGraphicEdits(resolveAppearance([{value:piece.appearance,from:{documentId:piece.source.documentId,featureId:piece.source.featureId,layer:'source'}},{value:hydrateGraphics(feature.appearance,doc),from:{documentId:doc.documentId,featureId:feature.id,layer:'occurrence'}}]).effective,feature.graphicEdits),doc),
                surfaceStyles:piece.surfaceStyles?.map(style=>({...style,fieldOrigins:{...style.fieldOrigins,...Object.fromEntries(Object.keys(feature.appearance??{}).filter(key=>!['material','graphics'].includes(key)).map(key=>[key,{documentId:doc.documentId,featureId:feature.id,layer:'occurrence'}]))},look:{...style.look,...Object.fromEntries(Object.entries(feature.appearance??{}).filter(([key])=>!['material','graphics'].includes(key)))}})),
                paintRegions:piece.paintRegions?.map(region=>({...region,fieldOrigins:{...region.fieldOrigins,...Object.fromEntries(Object.keys(feature.appearance??{}).filter(key=>!['material','graphics'].includes(key)).map(key=>[key,{documentId:doc.documentId,featureId:feature.id,layer:'occurrence'}]))},look:{...region.look,...Object.fromEntries(Object.entries(feature.appearance??{}).filter(([key])=>!['material','graphics'].includes(key)))}})),
                placements: [...piece.placements, placement!],
                name: `${feature.id}/${piece.name}`,
                occurrence: [feature.id, ...piece.occurrence],
              }));
            instances.push({
              featureId: feature.id,
              documentId: source.document.documentId,
              name: source.document.name ?? 'Untitled part',
              revision: source.document.revision,
              sourceFeatureIds: ids,
            });
          } else {
            const target = references(feature)[0];
            const inherited = target ? pieces.get(target)?.[0]?.appearance : undefined;

            const appearance = hydrateGraphics(effectiveAppearance(doc, feature.id),doc);
            const resolved = resolveAppearance([{value:inherited,from:{documentId:doc.documentId,featureId:target??feature.id,layer:'input'}},{value:appearance,from:{documentId:doc.documentId,featureId:feature.id,layer:'source'}}]).effective;
            partPieces = [
              {
                shape: entry.shape,
                result: entry,
                surfaceStyles: ids.flatMap((id,slot)=>(pieces.get(id)??[]).flatMap(p=>inheritStyles(feature,slot,p.surfaceStyles??[]))),
                paintRegions: ids.flatMap((id,slot)=>(pieces.get(id)??[]).flatMap(p=>inheritRegions(feature,slot,p.paintRegions??[]))),
                layers:[...(target?pieces.get(target)?.[0]?.layers??[]:[]),{value:feature.appearance,from:{documentId:doc.documentId,featureId:feature.id,layer:'source'}}],
                appearance: resolved,
                placements: [],
                volumeMm3: info.volumeMm3,
                name: feature.label ?? feature.id,
                occurrence: [feature.id],
                source: { documentId: doc.documentId, revision: doc.revision, featureId: feature.id },
              },
            ];
          }
          for (const region of feature.paintRegions??[]) {
            if (!partPieces.some(p=>JSON.stringify(region.target.path??[])===JSON.stringify(p.occurrence.slice(1)))) throw new CadError('REFERENCE_MISSING','Region occurrence path no longer exists.',{reference:region.target,candidates:partPieces.map(p=>({path:p.occurrence.slice(1)}))});
          }
          partPieces=partPieces.map(p=>({...p,paintRegions:[...(p.paintRegions??[]),...(feature.paintRegions??[]).filter(r=>JSON.stringify(r.target.path??[])===JSON.stringify(p.occurrence.slice(1))).map(r=>({...r,from:{documentId:doc.documentId,featureId:feature.id,path:r.target.path,layer:'region',styleId:r.id}}))]}));
          for(const style of feature.surfaceStyles??[])if(!partPieces.some(piece=>JSON.stringify(style.target.path??[])===JSON.stringify(piece.occurrence.slice(1))))throw new CadError('REFERENCE_MISSING','The painted occurrence path no longer exists.',{reference:style.target,candidates:partPieces.slice(0,8).map(p=>({path:p.occurrence.slice(1),source:p.source}))});
          if(feature.surfaceStyles?.length)partPieces=partPieces.map(piece=>{ 
            const own=feature.surfaceStyles!.filter(s=>JSON.stringify(s.target.path??[])===JSON.stringify(piece.occurrence.slice(1)));
            for(const style of own){if(!piece.result.topology)piece.result.topology=topologyTable(this.oc,piece.result.shape,piece.result.topologyFeature!,this.history.get(piece.result.shape));resolveFaces(piece.result.topology,style.target);}
            return {...piece,surfaceStyles:[...(piece.surfaceStyles??[]),...own.map(style=>({...style,from:{documentId:doc.documentId,featureId:feature.id,layer:'face',path:style.target.path}}))]};
          });
          for(const piece of partPieces)if((piece.appearance?.graphics?.length??0)>8)throw new CadError('GRAPHIC_LIMIT','An occurrence supports at most eight effective graphics.');
          pieceCount += partPieces.length;
          pieces.set(feature.id, partPieces);
          const appearances = partPieces.map((piece) => piece.appearance);
          info.appearanceComplete = appearances.every(appearance => !!(appearance?.material || appearance?.color));
          const common = Object.fromEntries(['material', 'color', 'finish', 'detail', 'graphics', 'coat', 'roughness', 'detailScale', 'visualMaterial'].flatMap(key => {
            const field = key as keyof Appearance;
            const value = appearances[0]?.[field];
            return value !== undefined && appearances.every(a => JSON.stringify(a?.[field]) === JSON.stringify(value)) ? [[key, value]] : [];
          }));
          if (Object.keys(common).length) info.appearance = common;
          const materials = partPieces.map((piece) => materialById(piece.appearance?.material));
          if (materials.every(Boolean)) {
            info.massG =
              partPieces.reduce((sum, piece, i) => sum + piece.volumeMm3 * materials[i]!.densityGcm3, 0) /
              1000;
            if (materials.every((material) => material!.id === materials[0]!.id))
              info.material = materials[0]!.id;
          }
          geometry.push(info);

        }
        const evaluation: Evaluation = {
          geometry,
          meshes,
          visibleFeatureIds: visibleFeatures(doc),
          ...(instances.length ? { instances } : {}),
        };
        evaluated.set(doc.documentId, { document: doc, results, pieces, evaluation, placements });
        if (doc.documentId !== document.documentId)
          referencedDocuments.push({
            documentId: doc.documentId,
            features: doc.features.length,
            rebuilt: localRebuilt,
          });
      }
    } catch (error) {
      staged.dispose();
      throw error;
    }
    const root = evaluated.get(document.documentId)!;
    const commitEvaluation = () => {
      for (const entry of added) this.cache.add(entry);
      for (const entry of pinned) this.cache.touch(entry);
      this.shapes = new Map([...root.results].map(([id,entry])=>[id,entry.shape]));
      this.activeResults = root.results; this.pieces = root.pieces;
      return this.cache.trim(pinned);
    };
    try {
    const result = root.evaluation;
    if (ordered.length > 1)
      result.references = ordered
        .slice(0, -1)
        .map((doc) => ({ documentId: doc.documentId, revision: doc.revision }));
    result.stats = {
      durationMs: performance.now() - started,
      cache: { hits, misses: added.length, rebuilt, evictions: 0, ...this.cacheStats() },
      ...(referencedDocuments.length ? { referencedDocuments } : {}),
    };
    this.lastStats = result.stats;
    if (replay) {
      const entry = replayEntry!;
      if (!entry) throw new CadError('REPLAY_STEP', 'This construction step does not exist. Restart replay.');
      const framePieces = (depth: number): Map<string, Piece[]> => {
        const node = entry.nodes[depth];
        const source = evaluated.get(node.document.documentId)!;
        const prefix = node.features.slice(0, node.features.indexOf(node.feature) + 1);
        // When only a copied/derived result is instanced, its retained source is construction,
        // even if copy:true deliberately keeps that source visible in the source document.
        const hiddenAncestors = new Set(node.resultIds ? prefix.flatMap(f => f.kind === 'instance' ? [] : references(f)).filter(id => !node.resultIds!.includes(id)) : []);
        const visible = visibleFeatures({ ...node.document, features: prefix }).filter(id => !hiddenAncestors.has(id));
        const groups = new Map(visible.map(id => [id, source.pieces.get(id)!]));
        if (depth + 1 < entry.nodes.length) {
          const children = [...framePieces(depth + 1).values()].flat();
          groups.set(node.feature.id, children.map(piece => ({ ...piece,
            appearance: { ...piece.appearance, ...Object.fromEntries(Object.entries(node.feature.appearance ?? {}).filter(([, v]) => v !== undefined)) },
            placements: [...piece.placements, source.placements.get(node.feature.id)!],
          })));
        }
        return groups;
      };
      const groups = framePieces(0);
      const meshes: Evaluation['meshes'] = [], geometry: GeometryInfo[] = [];
      let count = 0;
      for (const [id, pieces] of groups) {
        count += pieces.length;
        if (count > MAX_ASSEMBLY_FEATURES) throw new CadError('REPLAY_LIMIT', 'Replay exceeds the expanded piece limit. Use Assembly steps.');
        const unchanged = root.pieces.get(id);
        if (unchanged === pieces) {
          geometry.push(root.evaluation.geometry.find(info => info.featureId === id)!);
          continue;
        }
        const placed: Shape3D[] = [];
        try {
          for (const piece of pieces) {
            let shape = this.copyShape(piece.shape);
            try {
              for (const placement of piece.placements) {
                const next = this.place(shape, placement); shape.delete(); shape = next;
              }
              placed.push(shape);
            } catch (error) { shape.delete(); throw error; }

          }
          const shape = this.compound(placed);
          try { geometry.push(this.measure(id, shape)); } finally { shape.delete(); }
        } finally { placed.forEach(shape => shape.delete()); }
      }
      const diagonal = Math.hypot(...geometry.reduce((a,g)=>a.map((v,i)=>Math.max(v,g.bounds.size[i])),[0,0,0]));
      meshes.push(...this.display(groups, display?.detail ?? 'auto', diagonal));
      result.stats.display={requested:display?.detail??'auto',toleranceMm:this.meshOptions.tolerance,angularTolerance:this.meshOptions.angularTolerance,reduced:this.meshOptions.tolerance>MESH_OPTIONS.tolerance,values:displayValueCount(meshes),expandedValues:meshes.reduce((n,m)=>n+m.vertices.length+m.normals.length+m.triangles.length+m.lines.length,0),meshes:meshes.length};
      result.stats.cache={...result.stats.cache,evictions:commitEvaluation(),...this.cacheStats()};result.stats.durationMs=performance.now()-started;
      return { stats:result.stats,geometry, meshes, visibleFeatureIds: [...groups.keys()], references: result.references,
        replay: { key: replay.key, step: replay.step, steps: plan!.map(e => e.step) } };
    }
    const prefix = display?.step === undefined ? document : { ...document, features: document.features.slice(0,display.step) };
    if (display?.step !== undefined && display.step > document.features.length) throw new CadError('REPLAY_STEP','The build step does not exist.');
    const visible = visibleFeatures(prefix);
    for (const id of display?.featureIds ?? []) if (!root.pieces.has(id)) throw new CadError('FEATURE_NOT_FOUND', `Feature '${id}' does not exist.`);
    const ids = [...new Set([...visible,...(display?.featureIds ?? []),...document.selectedFeatureIds])];
    const groups = new Map(ids.map(id=>[id,root.pieces.get(id)!]));
    const diagonal = Math.hypot(...result.geometry.filter(g=>visible.includes(g.featureId)).reduce((a,g)=>a.map((v,i)=>Math.max(v,g.bounds.size[i])),[0,0,0]));
    result.visibleFeatureIds = visible;
    // Surface edits are validated even for headless commands which request no display.
    if (options.meshes === false && !display) {
      this.displayAssets.clear(); this.meshOptions=MESH_OPTIONS;
      for(const items of groups.values())for(const piece of items)if(piece.paintRegions?.length||piece.surfaceStyles?.length)this.placedMesh(piece,piece.occurrence[0]);
      this.displayAssets.clear();
    }
    if (options.meshes === false && !display) {
      result.stats!.cache = {...result.stats!.cache,evictions:commitEvaluation(),...this.cacheStats()};
      result.stats!.durationMs = performance.now() - started;
      return result;
    }
    try { result.meshes = this.display(groups, display?.detail ?? 'auto', diagonal); }
    catch (error) {
      if (display || !(error instanceof CadError) || error.code !== 'MODEL_TOO_COMPLEX') throw error;
      result.meshes = []; result.displayError = error.message;
      result.stats!.cache = {...result.stats!.cache,evictions:commitEvaluation(),...this.cacheStats()};
      result.stats!.durationMs = performance.now() - started;
      return result;
    }
    result.stats!.display = {requested:display?.detail ?? 'auto',toleranceMm:this.meshOptions.tolerance,angularTolerance:this.meshOptions.angularTolerance,
      reduced:this.meshOptions.tolerance > MESH_OPTIONS.tolerance,values:displayValueCount(result.meshes),
      expandedValues:result.meshes.reduce((n,m)=>n+m.vertices.length+m.normals.length+m.triangles.length+m.lines.length,0),meshes:result.meshes.length};
    result.stats!.cache = {...result.stats!.cache,evictions:commitEvaluation(),...this.cacheStats()};
    result.stats!.durationMs = performance.now() - started;
    return result;
    } catch (error) { staged.dispose(); throw error; }
  }

  /** Cuts per cached exact result, released with it. */
  private sectionCache = new WeakMap<CachedResult, Map<string, { min: Vector3; max: Vector3 } | null>>();
  /** Exact trimmed-face distance and the same edge matcher used by fillet/chamfer, in source coordinates. */
  queryTopology(query:NonNullable<import('../shared/protocol').InspectionSelect['topology']>):NonNullable<Evaluation['topologyQuery']>{
    const pieces=this.pieces.get(query.target.feature)?.filter(p=>!query.target.path||JSON.stringify(p.occurrence.slice(1))===JSON.stringify(query.target.path))??[];
    if(pieces.length!==1)throw new CadError('REFERENCE_AMBIGUOUS','Select one occurrence path for an exact topology query.',{candidates:pieces.map(p=>p.occurrence.slice(1))});
    const piece=pieces[0],response:NonNullable<Evaluation['topologyQuery']>={feature:query.target.feature,path:piece.occurrence.slice(1)};
    if(query.near){const point=makeVertex(query.near.point),faces=indexedShapes(this.oc,piece.result.shape.wrapped,'FACE');try{response.faceIndices=[];faces.forEach((raw,i)=>{const face=cast(raw);try{if(measureDistanceBetween(point,face)<=query.near!.toleranceMm)response.faceIndices!.push(i);}finally{face.delete();}});}finally{point.delete();faces.forEach(f=>f.delete());}}
    if(query.edges?.query){const q=query.edges.query;if(piece.occurrence.length>1&&typeof q!=='string'&&q.between)throw new CadError('INSPECTION_UNSUPPORTED','Inspect the source document for a between-input edge query.');const matcher=this.edgeMatcher(q,this.shapes);response.edgeIndices=[];try{let i=0;for(const edge of this.edges(piece.result.shape)){if(matcher.matches(edge))response.edgeIndices.push(i);i++;}}finally{matcher.dispose();}}
    return response;
  }

  /**
   * Exact planar sections of the last evaluation: where one result (or every visible result) crosses
   * axis = offset, with the in-plane extents of the cut. Results whose bounds miss the plane are skipped.
   */
  sections(document: CadDocument, featureId: string | undefined, planes: { axis: 'X' | 'Y' | 'Z'; offset: number }[]): SectionMeasure[] {
    const ids = featureId ? [featureId] : visibleFeatures(document).filter((id) => this.shapes.has(id));
    return planes.map(({ axis, offset }) => {
      const i = AXES.indexOf(axis), [u, v] = SECTION_AXES[axis];
      let min: Vector3 | undefined, max: Vector3 | undefined;
      const crossed: string[] = [];
      for (const id of ids) {
        const entry = this.activeResults.get(id);
        if (!entry) continue;
        const bounds = entry.geometry.bounds;
        if (offset < bounds.min[i] - 1e-6 || offset > bounds.max[i] + 1e-6) continue;
        let cuts = this.sectionCache.get(entry);
        if (!cuts) this.sectionCache.set(entry, cuts = new Map());
        let cut = cuts.get(`${axis}${offset}`);
        if (cut === undefined) {
          cut = this.section(entry.shape, i, offset);
          if (cuts.size >= 64) cuts.delete(cuts.keys().next().value!);
          cuts.set(`${axis}${offset}`, cut);
        }
        if (!cut) continue;
        crossed.push(id);
        min = min ? min.map((value, k) => Math.min(value, cut!.min[k])) as Vector3 : [...cut.min];
        max = max ? max.map((value, k) => Math.max(value, cut!.max[k])) as Vector3 : [...cut.max];
      }
      if (!min || !max) return { axis, offset, ...(featureId ? { featureId } : {}), empty: true, results: [] };
      return {
        axis, offset, ...(featureId ? { featureId } : {}), empty: false,
        widthMm: round(max[u] - min[u]), heightMm: round(max[v] - min[v]),
        min: min.map(round) as Vector3, max: max.map(round) as Vector3, results: crossed.slice(0, 64),
      };
    });
  }

  private section(shape: Shape3D, axis: number, offset: number): { min: Vector3; max: Vector3 } | null {
    const oc = this.oc;
    const point = new oc.gp_Pnt(axis === 0 ? offset : 0, axis === 1 ? offset : 0, axis === 2 ? offset : 0);
    const normal = new oc.gp_Dir(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const plane = new oc.gp_Pln(point, normal);
    const builder = new oc.BRepAlgoAPI_Section(shape.wrapped, plane, true);
    const box = new oc.Bnd_Box();
    try {
      const cut = builder.Shape();
      try {
        oc.BRepBndLib.AddOptimal(cut, box, false, false);
      } finally {
        cut.delete();
      }
      if (box.IsVoid()) return null;
      const pMin = box.CornerMin(), pMax = box.CornerMax();
      try {
        return { min: [pMin.X(), pMin.Y(), pMin.Z()], max: [pMax.X(), pMax.Y(), pMax.Z()] };
      } finally {
        pMin.delete();
        pMax.delete();
      }
    } finally {
      box.delete();
      builder.delete();
      plane.delete();
      normal.delete();
      point.delete();
    }
  }

  /** A design target: exact bounds or an exact section of one result, or of every visible result together. */
  private targetCheck(document: CadDocument, check: Exclude<NonNullable<NonNullable<CadDocument['analysis']>['checks']>[number], { b: CheckTarget }>, tolerance: number): GeometryAnalysis['checks'][number] {
    if(check.a && typeof check.a!=='string'){
      const leaves=this.analysisLeaves.filter(l=>matchesLeaf(l,check.a!));
      if(!leaves.length)return {id:check.id,expect:check.expect,ok:null,status:'error',message:'Occurrence target does not resolve.'};
      const alias='__analysis_target__',shape=this.compound(leaves.map(l=>this.shapes.get(l.id)!));
      this.shapes.set(alias,shape);this.activeResults.set(alias,{...this.activeResults.get(leaves[0].id)!,shape,geometry:this.measure(alias,shape)});
      try{const result=this.targetCheck(document,{...check,a:alias},tolerance);const target=check.a;const name=[target.feature,...(target.path??[])].join('/');return {...result,a:target.feature,message:result.message.replaceAll(alias,name)};}finally{this.shapes.delete(alias);this.activeResults.delete(alias);shape.delete();}
    }
    const subject = check.a ? `'${check.a}'` : 'the model';
    const base = { id: check.id, expect: check.expect, ...(check.a ? { a: check.a } : {}) };
    const fmt = (value: number) => `${round(value)} mm`;
    if (check.expect === 'section') {
      const [cut] = this.sections(document, check.a, [{ axis: check.axis, offset: check.offset }]);
      const where = `${check.axis} = ${check.offset}`;
      if (cut.empty) return { ...base, ok: false, status: 'fail', message: `${subject} has no material at ${where}, so its section cannot match the target (failed).` };
      const misses = (['widthMm', 'heightMm'] as const).filter(key => check[key] !== undefined && Math.abs(cut[key]! - check[key]!) > check.toleranceMm)
        .map(key => `${key === 'widthMm' ? 'width' : 'height'} ${fmt(cut[key]!)}, target ${fmt(check[key]!)} ± ${check.toleranceMm}`);
      const ok = !misses.length;
      return { ...base, ok, status: ok ? 'pass' : 'fail', widthMm: cut.widthMm, heightMm: cut.heightMm, min: cut.min, max: cut.max,
        message: ok ? `${subject} section at ${where} is ${fmt(cut.widthMm!)} wide and ${fmt(cut.heightMm!)} high, as targeted.` : `${subject} section at ${where}: ${misses.join('; ')} (failed).` };
    }
    const ids = check.a ? [check.a] : visibleFeatures(document);
    const boxes = ids.map(id => this.activeResults.get(id)?.geometry.bounds).filter((b): b is GeometryInfo['bounds'] => !!b);
    if (!boxes.length) return { ...base, ok: null, status: 'pending', message: `Pending: ${subject} has no evaluated geometry.` };
    const min = [0, 1, 2].map(i => Math.min(...boxes.map(b => b.min[i]))) as Vector3;
    const max = [0, 1, 2].map(i => Math.max(...boxes.map(b => b.max[i]))) as Vector3;
    if (check.expect === 'size') {
      const i = AXES.indexOf(check.axis), measured = max[i] - min[i], ok = Math.abs(measured - check.mm) <= check.toleranceMm;
      return { ...base, ok, status: ok ? 'pass' : 'fail', measuredMm: round(measured),
        message: `${subject} is ${fmt(measured)} along ${check.axis}; target ${fmt(check.mm)} ± ${check.toleranceMm}${ok ? '.' : ` (failed by ${fmt(Math.abs(measured - check.mm) - check.toleranceMm)}).`}` };
    }
    const outside = [0, 1, 2].flatMap(i => [
      ...(min[i] < check.min[i] - tolerance ? [`${AXES[i]} min ${round(min[i])} < ${check.min[i]}`] : []),
      ...(max[i] > check.max[i] + tolerance ? [`${AXES[i]} max ${round(max[i])} > ${check.max[i]}`] : []),
    ]);
    const ok = !outside.length;
    return { ...base, ok, status: ok ? 'pass' : 'fail', min: min.map(round) as Vector3, max: max.map(round) as Vector3,
      message: ok ? `${subject} stays within its envelope.` : `${subject} leaves its envelope: ${outside.join(', ')} (failed).` };
  }

  /**
   * Physical relationships between visible results of the last evaluation: exact gaps, overlap volumes,
   * connectivity to a ground part and declared checks. Bounding boxes only rule pairs out; every reported
   * contact, gap and overlap comes from exact kernel distance and boolean volume.
   */
  /** Construction, local look and world placement, with no hashes standing in for inputs. */
  extractionBodies(document:CadDocument) {
    const clean=(value:unknown):unknown=>{
      if(Array.isArray(value))return value.map(clean);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['from','fieldOrigins','feature','path'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,clean(v)]));return value;
    };
    const bodies:{manifest:string;look:string;painted:boolean;shape:Shape3D;geometry:GeometryInfo}[]=[];
    try{
      for(const id of visibleFeatures(document))for(const piece of this.pieces.get(id)??[]){
        let shape=this.copyShape(piece.shape);
        try{for(const placement of piece.placements){const next=this.place(shape,placement);shape.delete();shape=next;}
          const look=JSON.stringify(clean({appearance:piece.appearance,styles:piece.surfaceStyles,regions:piece.paintRegions}));
          const matrix=piece.placements.reduce((m,p)=>multiplyMatrix(placementMatrix(p),m),identityMatrix());
          bodies.push({manifest:JSON.stringify({engine:importEngineVersion,construction:fullDescriptor(piece.result.fingerprint),matrix,look,volume:piece.volumeMm3}),look,painted:!!(piece.surfaceStyles?.length||piece.paintRegions?.length),shape,geometry:this.measure(id,shape)});
        }catch(error){shape.delete();throw error;}
      }
      return bodies;
    }catch(error){bodies.forEach(b=>b.shape.delete());throw error;}
  }
  compareExtraction(before:ReturnType<GeometryEngine['extractionBodies']>,after:ReturnType<GeometryEngine['extractionBodies']>):'construction'|'measured'{
    if(before.length!==after.length)throw new CadError('EXTRACT_NOT_EQUIVALENT','Visible occurrence counts changed.');
    if(JSON.stringify(before.map(b=>b.manifest).sort())===JSON.stringify(after.map(b=>b.manifest).sort()))return 'construction';
    if(before.length>64)throw new CadError('EXTRACT_EQUIVALENCE_LIMIT','Measured fallback is limited to 64 result pieces. Construction-identical extraction remains available.');
    const remaining=new Set(after);
    const close=(a:number,b:number,relative:number,absolute=0)=>Math.abs(a-b)<=Math.max(absolute,relative*Math.max(Math.abs(a),Math.abs(b)));
    const volume=(shape:Shape3D)=>{const props=new this.oc.GProp_GProps();try{this.oc.BRepGProp.VolumeProperties(shape.wrapped,props,true,false,false);return Math.abs(props.Mass());}finally{props.delete();}};
    for(const a of before){
      let match:typeof a|undefined;
      for(const b of remaining){
        // A changed construction cannot certify named-face/region look correspondence from bounds alone.
        if(a.painted||b.painted||a.look!==b.look)continue;
        const A=a.geometry,B=b.geometry;
        if(!close(A.volumeMm3,B.volumeMm3,1e-9)||!close(A.surfaceAreaMm2??0,B.surfaceAreaMm2??0,1e-7)||!A.bounds.min.every((v,i)=>close(v,B.bounds.min[i],0,1e-6))||!A.bounds.max.every((v,i)=>close(v,B.bounds.max[i],0,1e-6)))continue;
        const ab=this.boolean('subtract',a.shape,b.shape);let ba:Shape3D|undefined;
        try{ba=this.boolean('subtract',b.shape,a.shape);const tolerance=1e-6*Math.max(A.volumeMm3,B.volumeMm3);if(volume(ab)<=tolerance&&volume(ba)<=tolerance){match=b;break;}}
        finally{ab.delete();ba?.delete();}
      }
      if(!match)throw new CadError('EXTRACT_NOT_EQUIVALENT','Exact two-way Boolean differences, measures or effective appearance did not establish equivalence. Painted changed constructions require explicit repair.');
      remaining.delete(match);
    }
    return 'measured';
  }
  private analysisLeaves: AnalysisLeaf[] = [];
  private leafDescriptors = new Map<string,{descriptor:string;matrix:number[]}>();
  analyze(document:CadDocument, geometry:GeometryInfo[], onlyIds?:string[], budgetMs=20_000, hardMs=budgetMs, control:AnalysisControl={}, emit?:(event:AnalysisEvent)=>void):GeometryAnalysis {
    const originalShapes=this.shapes, originalResults=this.activeResults;
    const shapes=new Map(originalShapes), results=new Map(originalResults), owned:Shape3D[]=[];
    this.analysisLeaves=[];this.leafDescriptors.clear();
    try {
      for(const feature of visibleFeatures(document))for(const piece of this.pieces.get(feature)??[]) {
        const explorer=new this.oc.TopExp_Explorer(piece.shape.wrapped,this.oc.TopAbs_ShapeEnum.TopAbs_SOLID,this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        let solidIndex=0;
        try{for(;explorer.More();explorer.Next(),solidIndex++){
          const raw=explorer.Current();let shape=cast(raw) as Shape3D;owned.push(shape);
          for(const placement of piece.placements){shape=this.place(shape,placement);owned.push(shape);}
          const path=piece.occurrence.slice(1), id=(this.pieces.get(feature)??[]).reduce((n,p)=>n+p.result.geometry.solidCount,0)!==1?`${feature}/${path.join('/')}${path.length?'/':''}solid:${solidIndex}`:feature;
          const measured=this.measure(id,shape);
          const descriptor=JSON.stringify([fullDescriptor(piece.result.fingerprint),solidIndex]);
          const matrix=piece.placements.reduce((m,p)=>multiplyMatrix(placementMatrix(p),m),identityMatrix());
          this.leafDescriptors.set(id,{descriptor,matrix});
          const text=JSON.stringify([descriptor,matrix]);
          const entry={...piece.result,shape,geometry:measured,fingerprint:{hash:text,descriptor:text,inputs:[]}};
          shapes.set(id,shape);results.set(id,entry);
          this.analysisLeaves.push({id,feature,path,source:{documentId:piece.source.documentId,featureId:piece.source.featureId},solidIndex,valid:measured.valid,bounds:measured.bounds,volumeMm3:measured.volumeMm3,faceCount:measured.faceCount});
          if(this.analysisLeaves.length>MAX_ASSEMBLY_FEATURES)throw new CadError('ANALYSIS_LIMIT','Leaf analysis exceeds the 2000 solid occurrence limit. Coverage is unknown.');
        }}finally{explorer.delete();}
      }
      this.shapes=shapes;this.activeResults=results;
      emit?.({type:'leaves',leaves:this.analysisLeaves});
      return {...this.analyzeLeaves(document,geometry,onlyIds,budgetMs,hardMs,control,emit),leaves:this.analysisLeaves};
    }finally{this.shapes=originalShapes;this.activeResults=originalResults;owned.forEach(shape=>shape.delete());}
  }
  private analyzeLeaves(
    document: CadDocument,
    _geometry: GeometryInfo[],
    onlyIds?: string[],
    budgetMs = 20_000,
    /** Time until the caller's deadline; no exact pair starts that could not finish before it. */
    hardMs = budgetMs, control:AnalysisControl={}, emit?:(event:AnalysisEvent)=>void
  ): GeometryAnalysis {
    const started = performance.now();
    const tolerance = document.analysis?.toleranceMm ?? 0.01;
    const visible = this.analysisLeaves.map(l=>l.id);
    const evictionsBefore = this.analysisCache.evictions;
    const stats = {
      durationMs: 0,
      partHits: 0,
      partMisses: 0,
      pairHits: 0,
      pairMisses: 0,
      partEntries: 0,
      pairEntries: 0,
      meshBytes: 0,
      evictions: 0,
    };
    const info = new Map<string, AnalysisPart>();
    for (const id of visible) {
      const entry = this.activeResults.get(id)!;
      const { part, hit } = this.analysisCache.part(entry.fingerprint, entry.geometry);
      stats[hit ? 'partHits' : 'partMisses']++;
      info.set(id, part);
    }
    // Hidden construction features are judged through the visible results built from them.
    const resultsOf = (target: CheckTarget): string[] => {
      const direct=this.analysisLeaves.filter(l=>matchesLeaf(l,target)).map(l=>l.id);
      if(direct.length)return direct;
      if(typeof target!=='string')return [];
      const id=target;
      if (visible.includes(id)) return [id];
      const lineage = new Set([id]);
      for (const feature of document.features)
        if (feature.kind !== 'instance' && references(feature).some((ref) => lineage.has(ref))) lineage.add(feature.id);
      return this.analysisLeaves.filter(l=>lineage.has(l.feature)).map(l=>l.id);
    };
    const parts = onlyIds ? [...new Set(onlyIds.flatMap(resultsOf))] : visible;
    const report: GeometryAnalysis = {
      revision: document.revision,
      scope: onlyIds ? 'subset' : 'document',
      interferenceMeshes: [],
      parts: parts.length,
      toleranceMm: tolerance,
      contacts: [],
      interferences: [],
      floating: [],
      checks: [],
      coverage:{totalPairs:parts.length*(parts.length-1)/2,completedPairs:0,totalChecks:document.analysis?.checks?.length??0,completedChecks:0},
      durationMs: 0,
    };
    const boxGap = (a: string, b: string) => {
      const A = info.get(a)!.bounds,
        B = info.get(b)!.bounds;
      return Math.hypot(...[0, 1, 2].map((i) => Math.max(0, A.min[i] - B.max[i], B.min[i] - A.max[i])));
    };
    const cache = new Map<string, { gap: number; overlap: number }>();
    // Remembered across slices and worker restarts: the next uncached pair may be as slow as the slowest seen.
    let slowestPairMs = this.analysisCache.slowestPairMs;
    // New exact pairs start while the slice budget lasts. One pair cannot be interrupted, so none starts unless the
    // slowest pair seen so far would still finish before the caller's deadline.
    const deferNew = () => {
      const elapsed = performance.now() - started;
      return elapsed > budgetMs || elapsed + slowestPairMs > hardMs;
    };
    let deferred = false;
    /** Uncached work is deferred to the next slice once the budget is spent. */
    const skip = (cached: boolean) => { if (cached || !deferNew()) return false; deferred = true; return true; };
    const cachedPair=(a:string,b:string)=>{const measured=this.analysisCache.get(info.get(a)!,info.get(b)!);return !!measured&&(measured.gap>tolerance||!!measured.common);};
    const durable=new Map((control.facts??[]).map(f=>[f.key,f.value]));
    const excluded=new Set(control.excluded??[]);
    let newPairs=0;
    const unknownPairs:NonNullable<GeometryAnalysis['unknownPairs']>=[];
    let meshValues = 0;
    const incomplete = (message: string) => {
      report.skipped ??= message;
    };
    const pair = (a: string, b: string) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let found = cache.get(key);
      if (!found) {
        const A = info.get(a)!,
          B = info.get(b)!;
        const factKey=pairDescriptor(this.leafDescriptors.get(a)!,this.leafDescriptors.get(b)!);
        let measured: import('./analysis-cache').PairMeasurement | undefined = durable.get(factKey) ?? this.analysisCache.get(A, B);
        if(excluded.has(factKey)){unknownPairs.push({a,b,reason:'timeout'});incomplete(`Exact pair ${a} / ${b} is unknown after timeout.`);return {gap:NaN,overlap:NaN};}
        if(!measured&&((control.retryKey&&control.retryKey!==factKey)||newPairs++ >= (control.pairLimit??Infinity))){deferred=true;return {gap:NaN,overlap:NaN};}
        const reusable = measured && (measured.gap > tolerance || measured.common);
        stats[reusable ? 'pairHits' : 'pairMisses']++;
        const [first, second] = compareFingerprints(A.fingerprint, B.fingerprint) <= 0 ? [a, b] : [b, a];
        const sa = this.shapes.get(first)!,
          sb = this.shapes.get(second)!;
        let complete = true;
        const pairStarted = performance.now();
        if(!reusable)emit?.({type:'pair',key:factKey,a,b});
        let gap = measured?.gap ?? NaN;
        try {
          if (!measured) gap = Math.max(0, measureDistanceBetween(sa, sb));
          if (!Number.isFinite(gap)) throw new Error('Nonfinite distance');
        } catch {
          incomplete(`Exact distance operation failed for '${a}' and '${b}'; their relationship is unknown.`);
          complete = false;
        }
        if (complete && !reusable && gap <= tolerance) {
          let common: Shape3D | undefined;
          const props = new this.oc.GProp_GProps();
          try {
            common = this.boolean('intersect', sa, sb);
            this.oc.BRepGProp.VolumeProperties(common.wrapped, props, true, false, false);
            const overlap = Math.max(0, props.Mass());
            if (!Number.isFinite(overlap)) throw new Error('Nonfinite volume');
            measured = { gap, common: { overlap } };
            if (overlap > INTERFERENCE_MM3) {
              // Finish this pair before yielding. Native common/meshing is atomic; the next
              // pair observes the deadline. A finished pair survives the next analysis slice.
              const { vertices, normals, triangles } = common.mesh(MESH_OPTIONS);
              measured.common!.mesh = { vertices, normals, triangles };
            }
          } catch {
            incomplete(`Exact common operation failed for '${a}' and '${b}'; their relationship is unknown.`);
            complete = false;
            measured = undefined;
          } finally {
            props.delete();
            common?.delete();
          }
        }
        measured ??= { gap };
        const mesh = measured.common?.mesh;
        if (mesh) {
          meshValues += mesh.vertices.length + mesh.normals.length + mesh.triangles.length;
          if (meshValues > MAX_MESH_VALUES) {
            incomplete('Overlap display mesh limit reached.');
            complete = false;
          } else
            report.interferenceMeshes!.push({
              featureId: this.analysisLeaves.find(l=>l.id===a)?.feature??a,
              a,
              b,
              vertices: [...mesh.vertices],
              normals: [...mesh.normals],
              triangles: [...mesh.triangles],
              lines: [],
            });
        }
        if (!reusable) this.analysisCache.slowestPairMs = slowestPairMs = Math.max(slowestPairMs, performance.now() - pairStarted);
        // Successful work may warm a partial report, but unfinished pairs never become clean facts.
        if (!complete) { unknownPairs.push({a,b,reason:'kernel error'}); emit?.({type:'failure',key:factKey,a,b,error:report.skipped??'Exact native operation failed.'}); }
        if (complete && !reusable) { this.analysisCache.set(A, B, measured); durable.set(factKey,measured);emit?.({type:'fact',fact:{key:factKey,value:{gap:measured.gap,...(measured.common?{common:{overlap:measured.common.overlap}}:{})}}}); }
        found = { gap, overlap: measured.common?.overlap ?? (complete ? 0 : NaN) };
        cache.set(key, found);
      }
      return found;
    };
    const INTERFERENCE_MM3 = 1e-3;
    if(control.retryPair&&parts.includes(control.retryPair.a)&&parts.includes(control.retryPair.b))pair(control.retryPair.a,control.retryPair.b);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // Bounds reject contact/interference only. Exact distance still owns nearest/clearance.
    const broadStarted=performance.now(), candidates:{a:string;b:string;cost:number}[]=[];
    for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){
      const a=parts[i],b=parts[j];
      if(boxGap(a,b)>tolerance){report.coverage!.completedPairs++;continue;}
      candidates.push({a,b,cost:(this.analysisLeaves.find(l=>l.id===a)?.faceCount??1)*(this.analysisLeaves.find(l=>l.id===b)?.faceCount??1)});
    }
    report.broadPhase={durationMs:performance.now()-broadStarted,ruledOut:report.coverage!.completedPairs,candidates:candidates.length};
    candidates.sort((a,b)=>a.cost-b.cost||a.a.localeCompare(b.a)||a.b.localeCompare(b.b));
    for(const {a,b}of candidates){
      if(skip(cachedPair(a,b)))continue;
      const {gap,overlap}=pair(a,b);
      if(Number.isFinite(gap)&&Number.isFinite(overlap))report.coverage!.completedPairs++;
      if(gap>tolerance)continue;
      if(overlap<=INTERFERENCE_MM3)report.contacts.push({a,b,overlapMm3:round(overlap)});
      if(overlap>INTERFERENCE_MM3)report.interferences.push({a,b,overlapMm3:round(overlap)});
    }
    // Connectivity can require exact distance work even after all broad-phase pairs completed.
    let connectivityComplete = report.coverage!.completedPairs === report.coverage!.totalPairs;
    // Connectivity to the ground part.
    if (parts.length > 1) {
      const groundSetting = document.analysis?.ground;
      const ground =
        (groundSetting ? resultsOf(groundSetting).find((id) => parts.includes(id)) : undefined) ??
        [...parts].sort((x, y) => info.get(y)!.volumeMm3 - info.get(x)!.volumeMm3)[0];
      report.ground = ground;
      const root = new Map(parts.map((p) => [p, p]));
      const find = (x: string): string => {
        while (root.get(x) !== x) x = root.get(x)!;
        return x;
      };
      for (const c of report.contacts) root.set(find(c.a), find(c.b));
      const connected = parts.filter((p) => find(p) === find(ground));
      for (const id of parts.filter((p) => !connected.includes(p))) {
        // Exact nearest connected part: a bounding-box lower bound can prune further candidates.
        const candidates = [...connected].sort((x, y) => boxGap(id, x) - boxGap(id, y));
        let nearest: string | undefined, gapMm: number | undefined;
        for (const other of candidates) {
          if (skip(cachedPair(id,other))) { connectivityComplete = false; continue; }
          if (gapMm !== undefined && boxGap(id, other) > gapMm) break;
          const { gap } = pair(id, other);
          if (!Number.isFinite(gap)) connectivityComplete = false;
          if (Number.isFinite(gap) && (gapMm === undefined || gap < gapMm)) {
            gapMm = gap;
            nearest = other;
          }
        }
        report.floating.push({ featureId: id, ...(nearest ? { nearest, gapMm: round(gapMm!) } : {}) });
      }
    }
    report.coverage!.connectivity = connectivityComplete ? 'complete' : 'pending';
    // Declared checks.
    for (const check of document.analysis?.checks ?? []) {
      if (!('b' in check)) {
        report.checks.push(this.targetCheck(document, check, tolerance));
        continue;
      }
      const A = resultsOf(check.a).filter((id) => parts.includes(id)),
        B = resultsOf(check.b).filter((id) => parts.includes(id));
      const base = { id: check.id, expect: check.expect, a: checkRoot(check.a), b: checkRoot(check.b) };
      if (!A.length || !B.length) {
        report.checks.push({
          ...base,
          ok: null,status:'pending',
          message: 'Pending: both parts must resolve inside the analysis scope.',
        });
        continue;
      }
      const shared = A.find((id) => B.includes(id));
      if (shared && A.length===1 && B.length===1) {
        const ok = check.expect === 'contact';
        report.checks.push({
          ...base,
          ok,status:ok?'pass':'fail',
          message: `${check.a} and ${check.b} are fused into the same result '${shared}'${ok ? ', so they are connected' : ''}.`,
        });
        continue;
      }
      if (skip(A.every(x=>B.every(y=>cachedPair(x,y))))) {
        report.checks.push({
          ...base,
          ok: null,status:'pending',
          message:
            'Pending: this analysis slice ended. The background job continues automatically.',
        });
        continue;
      }
      let gap = Infinity,
        overlap = 0;
      for (const x of A)
        for (const y of B) {
          if(x===y)continue;
          if (skip(cachedPair(x,y))) {
            gap = NaN;
            overlap = NaN;
            break;
          }
          const m = pair(x, y);
          gap = Math.min(gap, m.gap);
          overlap += m.overlap;
        }
      const minGap = check.minGapMm ?? tolerance;
      const ok =
        check.expect === 'contact'
          ? gap <= tolerance && overlap <= INTERFERENCE_MM3
          : check.expect === 'clearance'
            ? gap >= minGap && gap > tolerance
            : check.expect === 'overlap'
              ? overlap > INTERFERENCE_MM3
              : overlap <= INTERFERENCE_MM3;
      const facts = `gap ${round(gap)} mm${overlap > INTERFERENCE_MM3 ? `, overlap ${round(overlap)} mm³` : ''}`;
      const want =
        check.expect === 'contact'
          ? 'should touch'
          : check.expect === 'clearance'
            ? `should be at least ${minGap} mm apart`
            : check.expect === 'overlap'
              ? 'should intentionally overlap'
              : 'should not interpenetrate';
      report.checks.push({
        ...base,
        ok:Number.isFinite(gap)&&Number.isFinite(overlap)?ok:null,status:Number.isFinite(gap)&&Number.isFinite(overlap)?ok?'pass':'fail':'pending',
        ...(Number.isFinite(gap) ? { gapMm: round(gap) } : {}),
        ...(Number.isFinite(overlap) ? { overlapMm3: round(overlap) } : {}),
        message: Number.isFinite(gap)&&Number.isFinite(overlap)?`${check.a} ${want} ${check.b}: ${facts}${ok ? '' : ' (failed)'}.`:'Pending: exact computation is incomplete. Continue analyze_model; this is not a failed relationship.',
      });
    }
    // Intent never changes physical contact. A separate graph accepts only verified,
    // documented relationships to the ground, so an isolated declaration cannot hide a loose assembly.
    const accepted = new Map(parts.map((id) => [id, [] as { id: string; check?: string }[]]));
    const link = (a: string, b: string, check?: string) => {
      accepted.get(a)!.push({ id: b, check });
      accepted.get(b)!.push({ id: a, check });
    };
    for (const c of report.contacts) link(c.a, c.b);
    for (const check of document.analysis?.checks ?? []) {
      if (
        !('b' in check) ||
        !check.note?.trim() ||
        !['overlap', 'clearance'].includes(check.expect) ||
        !report.checks.find((c) => c.id === check.id)?.ok
      )
        continue;
      for (const a of resultsOf(check.a).filter((id) => parts.includes(id)))
        for (const b of resultsOf(check.b).filter((id) => parts.includes(id))) {
          if (a === b) continue;
          const measured = cache.get(a < b ? `${a}|${b}` : `${b}|${a}`);
          if (
            !measured ||
            (check.expect === 'overlap'
              ? !(measured.overlap > INTERFERENCE_MM3)
              : !(measured.gap >= (check.minGapMm ?? tolerance) && measured.gap > tolerance))
          )
            continue;
          link(a, b, check.id);
          if (check.expect === 'overlap')
            for (const i of report.interferences)
              if ((i.a === a && i.b === b) || (i.a === b && i.b === a)) i.intendedBy = check.id;
        }
    }
    if (report.ground) {
      const paths = new Map<string, string[]>([[report.ground, []]]);
      for (const [id, path] of paths)
        for (const edge of accepted.get(id) ?? [])
          if (!paths.has(edge.id)) paths.set(edge.id, edge.check ? [...path, edge.check] : path);
      for (const f of report.floating) {
        const path = paths.get(f.featureId);
        if (path?.length) f.intendedBy = [...new Set(path)];
      }
    }
    if (deferred)
      report.skipped = `Analysis slice ended after ${Math.round((performance.now() - started) / 100) / 10} s to stay within the command deadline. The background job continues automatically.`;
    report.coverage!.completedChecks=report.checks.filter(c=>c.ok!==null).length;
    if(report.coverage!.completedPairs<report.coverage!.totalPairs||report.coverage!.completedChecks<report.coverage!.totalChecks)report.skipped??='Some relationships remain pending. Call analyze_model to continue.';
    if(report.skipped)report.floating=[];
    report.durationMs = Math.round(performance.now() - started);
    Object.assign(stats, this.analysisCache.stats(), {
      durationMs: performance.now() - started,
      evictions: this.analysisCache.evictions - evictionsBefore,
    });
    if (this.lastStats) this.lastStats.analysis = stats;
    if(unknownPairs.length)report.unknownPairs=unknownPairs;
    return report;
  }

  /** STEP keeps each visible part as a named, colored shape; STL is one triangulated mesh. */
  async export(
    format: 'step' | 'stl',
    featureIds: string[],
    document?: CadDocument
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; warnings?: string[] }> {
    featureIds=featureIds.filter(id=>this.activeResults.get(id)?.geometry.resultKind!=='sheet');
    if (!featureIds.length) throw new CadError('EMPTY_MODEL', 'Create a solid before exporting.');
    const clones: Shape3D[] = [];
    const warnings = new Set<string>();
    let compound: Shape3D | undefined;
    try {
      for (const id of featureIds) {
        const shape = this.shapes.get(id);
        if (!shape) throw new CadError('FEATURE_NOT_FOUND', `Feature '${id}' does not exist.`);
        if (format !== 'step' || !document) clones.push(this.copyShape(shape));
      }
      let blob: Blob;
      if (format === 'step' && document) {
        const items = featureIds.flatMap((id) =>
          (this.pieces.get(id) ?? []).map((piece) => {
            let shape = this.copyShape(piece.shape);
            clones.push(shape);
            for (const placement of piece.placements) {
              const next = this.place(shape, placement);
              shape.delete();
              clones.pop();
              shape = next;
              clones.push(shape);
            }
            const appearance = piece.appearance;
            const color = stepColor(resolveLook(appearance).color);
            let faces = new Map<number, string>();
            if (piece.surfaceStyles?.length || piece.paintRegions?.length) {
              const table = piece.result.topology ??= topologyTable(this.oc, piece.shape, piece.result.topologyFeature!, this.history.get(piece.shape));
              for (const style of piece.surfaceStyles ?? []) {
                const color=resolveLook({...piece.appearance,...style.look}).color;
                for (const index of resolveFaces(table, style.target)) faces.set(index, color);
              }
              if (piece.paintRegions?.length) {
                const m = piece.placements.reduce((matrix,p)=>multiplyMatrix(placementMatrix(p),matrix),identityMatrix());
                const toWorld = (p:Vector3,direction=false):Vector3 => [0,1,2].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+(direction?0:m[i+12])) as Vector3;
                const toLocal = (p:Vector3):Vector3 => [0,1,2].map(i=>m[i*4]*(p[0]-m[12])+m[i*4+1]*(p[1]-m[13])+m[i*4+2]*(p[2]-m[14])) as Vector3;
                const split = stepRegions(this.oc,shape,piece.shape,table,piece.paintRegions.map(region=>({...region,look:{...region.look,color:resolveLook({...piece.appearance,...region.look}).color}})),faces,toWorld,toLocal);
                if(split.shape!==shape){shape.delete();clones.pop();shape=split.shape;clones.push(shape);}
                faces=split.colors;
                split.warnings.forEach(warning=>warnings.add(warning));
              }
            }
            return {
              shape,
              name:
                document.features.find((f) => f.id === id)?.kind === 'instance' &&
                this.pieces.get(id)!.length === 1
                  ? id
                  : piece.name,
              color,
              faces: new Map([...faces].map(([index,color])=>[index,stepColor(color)])),
            };
          })
        );
        blob = coloredSTEP(this.oc, items);
      } else {
        const shape = clones.length === 1 ? clones[0] : (compound = this.compound(clones));
        blob = format === 'step' ? shape.blobSTEP() : shape.blobSTL({ ...MESH_OPTIONS, binary: true });
      }
      const bytes = await blob.arrayBuffer();
      if (!bytes.byteLength) throw new CadError('EXPORT_FAILED', 'The kernel returned an empty export.');
      if (bytes.byteLength > 20 * 1024 * 1024)
        throw new CadError('EXPORT_TOO_LARGE', 'Export exceeds the 20 MiB prototype limit.');
      return { bytes, mimeType: format === 'step' ? 'application/step' : 'model/stl', ...(warnings.size?{warnings:[...warnings]}:{}) };
    } finally {
      compound?.delete();
      for (const clone of clones) clone.delete();
    }
  }
}
