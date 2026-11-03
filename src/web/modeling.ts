import { bodySections, xyFrame } from '../cad/modeling-presets';
import { countLabel } from '../shared/format';
import { effectiveAppearance } from '../cad/document';
import type { MaterialId } from '../shared/materials';
import { Quaternion, Vector3 as ThreeVector } from 'three';
import {
  featureSchema,
  type CadCommand,
  type CadDocument,
  type Feature,
  type GeometryInfo,
  type Vector3,
} from '../shared/protocol';
import { context } from '../cad/demo';
import type { IconName } from './icons';

export type Tool =
  | 'instance'
  | 'fill' | 'join'
  | 'box'
  | 'cylinder'
  | 'rod'
  | 'extrude'
  | 'revolve'
  | 'loft'
  | 'sweep'
  | 'shell'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'duplicate'
  | 'mirror'
  | 'pattern'
  | 'text'
  | 'drill_holes'
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'fillet'
  | 'chamfer'
  | 'delete';
type ToolGroup = 'create' | 'place' | 'shape' | 'combine' | 'manage';
export interface ToolSpec {
  tool: Tool;
  label: string;
  icon: IconName;
  group: ToolGroup;
  shortcut?: string;
  hint: string;
  needs: 'none' | 'one' | 'two' | 'some';
}

export const tools: ToolSpec[] = [
  {tool:'fill',label:'Fill sheet',icon:'extrude',group:'shape',needs:'one',hint:'Construct an exact sheet from captured boundary edges'},
  {tool:'join',label:'Join sheets',icon:'union',group:'shape',needs:'one',hint:'Replace explicit faces and sew sheets into a solid'},
  { tool: 'loft', label: 'Loft', icon: 'extrude', group: 'create', needs: 'none', hint: 'Smooth solid through profiles on local planes' },
  { tool: 'sweep', label: 'Sweep', icon: 'revolve', group: 'create', needs: 'none', hint: 'Carry a profile along an exact curved path' },
  { tool: 'shell', label: 'Shell', icon: 'box', group: 'shape', needs: 'one', hint: 'Hollow one solid inward through selected planar openings' },
  {
    tool: 'instance',
    label: 'Insert part',
    icon: 'layers',
    group: 'create',
    needs: 'none',
    hint: 'Place a part document, following its latest committed revision',
  },
  {
    tool: 'box',
    label: 'Box',
    icon: 'box',
    group: 'create',
    shortcut: 'B',
    needs: 'none',
    hint: 'Block from a minimum corner and X/Y/Z size',
  },
  {
    tool: 'rod',
    label: 'Rod',
    icon: 'cylinder',
    group: 'create',
    needs: 'none',
    hint: 'Round bar between two endpoint centers',
  },
  {
    tool: 'cylinder',
    label: 'Cylinder',
    icon: 'cylinder',
    group: 'create',
    shortcut: 'C',
    needs: 'none',
    hint: 'Round bar standing on +Z',
  },
  {
    tool: 'extrude',
    label: 'Extrude',
    icon: 'extrude',
    group: 'create',
    shortcut: 'X',
    needs: 'none',
    hint: 'Plate or profile: rectangle, circle or polygon pushed along a plane normal',
  },
  {
    tool: 'revolve',
    label: 'Revolve',
    icon: 'revolve',
    group: 'create',
    shortcut: 'V',
    needs: 'none',
    hint: 'Shafts, spacers and flanges turned about Z',
  },
  {
    tool: 'move',
    label: 'Move',
    icon: 'move',
    group: 'place',
    shortcut: 'W',
    needs: 'one',
    hint: 'Translate with handles or exact offsets',
  },
  {
    tool: 'rotate',
    label: 'Rotate',
    icon: 'rotate',
    group: 'place',
    shortcut: 'E',
    needs: 'one',
    hint: 'Turn about an axis through a pivot',
  },
  {
    tool: 'scale',
    label: 'Scale',
    icon: 'scale',
    group: 'place',
    shortcut: 'R',
    needs: 'one',
    hint: 'Uniform scale about a pivot',
  },
  {
    tool: 'duplicate',
    label: 'Duplicate',
    icon: 'duplicate',
    group: 'place',
    shortcut: 'D',
    needs: 'one',
    hint: 'Linked copy that follows its source',
  },
  {
    tool: 'mirror',
    label: 'Mirror',
    icon: 'mirror',
    group: 'place',
    shortcut: 'M',
    needs: 'one',
    hint: 'Reflect through XY, XZ or YZ',
  },
  {
    tool: 'pattern',
    label: 'Pattern',
    icon: 'pattern',
    group: 'place',
    shortcut: 'P',
    needs: 'one',
    hint: 'Repeat along a line or around an axis as one feature',
  },
  {
    tool: 'text',
    label: 'Engrave',
    icon: 'text',
    group: 'shape',
    shortcut: 'T',
    needs: 'one',
    hint: 'Engrave or emboss text on a face of the selected part',
  },
  {
    tool: 'drill_holes',
    label: 'Hole',
    icon: 'hole',
    group: 'shape',
    shortcut: 'H',
    needs: 'one',
    hint: 'Through-holes along X, Y or Z. Click faces to place them',
  },
  {
    tool: 'fillet',
    label: 'Fillet',
    icon: 'fillet',
    group: 'shape',
    shortcut: 'L',
    needs: 'one',
    hint: 'Round vertical or all edges',
  },
  {
    tool: 'chamfer',
    label: 'Chamfer',
    icon: 'chamfer',
    group: 'shape',
    shortcut: 'K',
    needs: 'one',
    hint: 'Bevel vertical or all edges',
  },
  {
    tool: 'union',
    label: 'Union',
    icon: 'union',
    group: 'combine',
    shortcut: 'U',
    needs: 'two',
    hint: 'Fuse the selected solids',
  },
  {
    tool: 'subtract',
    label: 'Cut',
    icon: 'subtract',
    group: 'combine',
    shortcut: 'J',
    needs: 'two',
    hint: 'Remove later selections from the first',
  },
  {
    tool: 'intersect',
    label: 'Intersect',
    icon: 'intersect',
    group: 'combine',
    shortcut: 'I',
    needs: 'two',
    hint: 'Keep only the shared volume',
  },
  {
    tool: 'delete',
    label: 'Delete',
    icon: 'delete',
    group: 'manage',
    shortcut: '⌫',
    needs: 'some',
    hint: 'Remove features, with an explicit choice about dependents',
  },
];
export const toolSpec = (tool: Tool): ToolSpec => tools.find((spec) => spec.tool === tool)!;

/** Why a tool cannot run for the current selection, or undefined when it can. */
export function unavailableReason(spec: ToolSpec, selectedCount: number): string | undefined {
  if (spec.needs === 'one' && selectedCount !== 1)
    return selectedCount ? 'Select exactly one object' : 'Select an object first';
  if (spec.needs === 'two' && selectedCount < 2) return 'Select two or more objects; the first is the target';
  if (spec.needs === 'some' && !selectedCount) return 'Select an object first';
  return undefined;
}

export const kindLabels: Record<Feature['kind'], string> = {
  instance: 'Instance',
  box: 'Box',
  cylinder: 'Cylinder',
  rod: 'Rod',
  extrude: 'Extrude',
  fill:'Fill sheet',join:'Join sheets',
  loft: 'Loft', sweep: 'Sweep', shell: 'Shell',
  revolve: 'Revolve',
  subtract: 'Cut',
  union: 'Union',
  intersect: 'Intersect',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  transform: 'Transform',
  mirror: 'Mirror',
  drill_holes: 'Holes',
  pattern: 'Pattern',
  text: 'Text',
};
export const kindIcons: Record<Feature['kind'], IconName> = {
  instance: 'layers',
  box: 'box',
  cylinder: 'cylinder',
  rod: 'cylinder',
  extrude: 'extrude',
  fill:'extrude',join:'union',
  loft: 'extrude', sweep: 'revolve', shell: 'box',
  revolve: 'revolve',
  subtract: 'subtract',
  union: 'union',
  intersect: 'intersect',
  fillet: 'fillet',
  chamfer: 'chamfer',
  transform: 'move',
  mirror: 'mirror',
  drill_holes: 'hole',
  pattern: 'pattern',
  text: 'text',
};

export const fmt = (value: number, digits = 3) =>
  new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(Math.abs(value) < 0.0005 ? 0 : value);
export const featureName = (feature?: Feature) => (feature ? feature.label || feature.id : '');

/** Short description of a fillet or chamfer edge selection. */
function edgesLabel(edges: Extract<Feature, { kind: 'fillet' }>['params']['edges']): string {
  if (typeof edges === 'string') return `${edges} edges`;
  const keys = Object.keys(edges).filter((key) => key !== 'toleranceMm');
  if (edges.near && keys.length === 1) return `${countLabel(edges.near.length, 'picked edge')}`;
  const parts = [
    edges.parallel && `∥ ${edges.parallel}`,
    edges.on && `on ${edges.on.axis} = ${fmt(edges.on.value, 2)}`,
    edges.near && `near ${countLabel(edges.near.length, 'point')}`,
    edges.curve && edges.curve !== 'any' && `${edges.curve}s`,
    edges.minLengthMm !== undefined && `≥ ${fmt(edges.minLengthMm, 2)} mm`,
    edges.maxLengthMm !== undefined && `≤ ${fmt(edges.maxLengthMm, 2)} mm`,
  ].filter(Boolean);
  return `edges ${parts.join(', ')}`;
}

/** One-line parameter summary for the build log, read from the document. */
export function featureSummary(feature: Feature, names: (id: string) => string = (id) => id): string {
  const p = feature.params as Record<string, unknown>;
  switch (feature.kind) {
    case 'instance':
      if (feature.params.attachment) return `${feature.params.attachment.mode} · ${feature.params.attachment.source.name} → ${'featureId' in feature.params.attachment.target ? feature.params.attachment.target.name : 'frame'}`;
      return `${feature.params.featureId ?? 'all visible results'} · move ${feature.params.translation.map((v) => fmt(v, 1)).join(', ')} · ${fmt(feature.params.angleDegrees, 1)}°`;
    case 'box':
      return feature.params.size.map((v) => fmt(v, 2)).join(' × ');
    case 'rod':
      return `Ø${fmt(feature.params.radius * 2, 2)} × ${fmt(Math.hypot(...feature.params.to.map((v, i) => v - feature.params.from[i])), 2)}`;
    case 'cylinder':
      return `Ø${fmt(feature.params.radius * 2, 2)} × ${fmt(feature.params.height, 2)}`;
    case 'extrude': {
      const profile = feature.params.profile;
      const shape =
        profile.type === 'rectangle'
          ? `${fmt(profile.width, 2)} × ${fmt(profile.height, 2)}`
          : profile.type === 'circle'
            ? `Ø${fmt(profile.radius * 2, 2)}`
            : profile.type === 'ellipse' ? `ellipse ${fmt(profile.radiusX * 2)} × ${fmt(profile.radiusY * 2)}`
            : profile.type === 'path' ? `${profile.segments.length} curve segments` : `${profile.points.length}-point profile`;
      return `${shape} · ${typeof feature.params.plane === 'string' ? feature.params.plane : 'local plane'} · ${fmt(feature.params.distance, 2)} deep`;
    }
    case 'loft': return `${feature.params.sections.length} sections · ${feature.params.ruled ? 'ruled' : 'smooth'}`;
    case 'sweep': return `${'points' in feature.params.path ? `${feature.params.path.points.length}-point 3D path` : `${feature.params.path.segments.length} path segments`} · ${feature.params.profile.type} profile${feature.params.endScale !== undefined ? ` · ${fmt(feature.params.endScale, 2)}× at end` : ''}`;
    case 'shell': return `${fmt(feature.params.thickness)} mm inward · ${feature.params.removeFaces.length} opening queries · ${names(feature.params.target)}`;
    case 'revolve':
      return `${feature.params.points.length} points · ${fmt(feature.params.angleDegrees, 1)}°`;
    case 'drill_holes':
      return `${feature.params.centers.length} × Ø${fmt(feature.params.diameter, 2)} along ${feature.params.axis} · ${names(feature.params.target)}`;
    case 'fillet':
      return `R${typeof feature.params.radius==='number'?fmt(feature.params.radius, 2):'variable'} · ${edgesLabel(feature.params.edges)} · ${names(feature.params.target)}`;
    case 'chamfer':
      return `${fmt(feature.params.distance, 2)} · ${edgesLabel(feature.params.edges)} · ${names(feature.params.target)}`;
    case 'union':
    case 'subtract':
    case 'intersect':
      return `${names(feature.params.target)} ${feature.kind === 'union' ? '+' : feature.kind === 'subtract' ? '−' : '∩'} ${feature.params.tools.map(names).join(', ')}`;
    case 'text':
      const placement = feature.params.target
        ? `${feature.params.mode === 'emboss' ? 'embossed on' : 'engraved in'} ${names(feature.params.target)}`
        : 'raised letters';
      return `“${feature.params.text}” · ${placement} · ${fmt(feature.params.size, 1)} mm`;
    case 'pattern': {
      const layout = feature.params.layout;
      return `${layout.count} × ${names(feature.params.target)} · ${layout.type === 'linear' ? `every ${fmt(layout.spacing, 2)} mm` : `${fmt(layout.angleDegrees, 1)}° around axis`}`;
    }
    case 'mirror':
      return `${names(feature.params.target)} · ${feature.params.plane}${feature.params.copy ? ' · keeps source' : ''}`;
    case 'transform': {
      const t = feature.params,
        parts: string[] = [];
      if (t.translation.some((v) => v !== 0))
        parts.push(`move ${t.translation.map((v) => fmt(v, 1)).join(', ')}`);
      if (t.angleDegrees !== 0) parts.push(`rotate ${fmt(t.angleDegrees, 1)}°`);
      if (t.scale !== 1) parts.push(`scale ×${fmt(t.scale, 3)}`);
      return `${t.copy ? 'copy of ' : ''}${names(t.target)}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
    }
  }
  return JSON.stringify(p);
}

export function nextFeatureId(doc: CadDocument, prefix: string): string {
  let i = 1;
  while (doc.features.some((f) => f.id === `${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}
function centerOf(info?: GeometryInfo): Vector3 {
  return info ? (info.bounds.min.map((v, i) => (v + info.bounds.max[i]) / 2) as Vector3) : [0, 0, 0];
}
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Starting parameters for a tool. Placement uses the selection's exact bounds. */
export function toolFeature(
  tool: Tool,
  doc: CadDocument,
  geometry: GeometryInfo[],
  material: MaterialId | null = 'aluminum'
): Feature | undefined {
  if (tool === 'delete') return undefined;
  const selected = doc.features.find((f) => f.id === doc.selectedFeatureIds[0]);
  if (selected?.kind === 'instance' && (tool === 'move' || tool === 'rotate'))
    return structuredClone(selected);
  const kind =
    tool === 'move' || tool === 'rotate' || tool === 'scale' || tool === 'duplicate' ? 'transform' : tool;
  const target = selected?.id ?? '';
  const info = geometry.find((g) => g.featureId === target);
  const center = centerOf(info).map(round) as Vector3;
  const offset = info ? round(info.bounds.size[0] + 10) : 0;
  const params = {
    instance: {
      document: '',
      translation: [0, 0, 0],
      rotationAxis: [0, 0, 1],
      angleDegrees: 0,
      origin: [0, 0, 0],
    },
    box: { origin: [0, 0, 0], size: [40, 30, 5] },
    rod: { from: [0, 0, 0], to: [20, 0, 20], radius: 2 },
    cylinder: { origin: [0, 0, 0], radius: 5, height: 20 },
    extrude: {
      profile: { type: 'rectangle', width: 80, height: 50 },
      plane: 'XY',
      origin: [0, 0, 0],
      distance: 5,
    },
    fill:{boundary:[{edge:{feature:target,name:'inspect-edge',signature:{center:[0,0,0],lengthMm:1}},continuity:'G0'}],tolerances:{g0Mm:0.01,g1Deg:0.5}},
    join:{target,replaceFaces:{feature:target,select:{faces:['+Z'],fragments:'one'},signature:{surface:'PLANE',areaMm2:1}},surfaces:['sheet'],toleranceMm:0.001},
    loft: { sections: bodySections(), ruled: false },
    sweep: { profile: { type: 'circle', radius: 3 }, path: { frame: xyFrame(), start: [30, 0], segments: [{ type: 'arc', via: [21.2132034356, 21.2132034356], to: [0, 30] }] } },
    shell: { target, thickness: 1, removeFaces: [{ point: info ? [center[0], center[1], info.bounds.max[2]] : [0, 0, 5], normal: [0, 0, 1], toleranceMm: 0.001, expectedCount: 1 }] },
    revolve: {
      points: [
        [0, 0],
        [10, 0],
        [10, 5],
        [5, 5],
        [5, 20],
        [0, 20],
      ],
      origin: [0, 0, 0],
      angleDegrees: 360,
    },
    transform: {
      target,
      translation: [tool === 'duplicate' ? offset : 0, 0, 0],
      rotationAxis: [0, 0, 1],
      angleDegrees: tool === 'rotate' ? 90 : 0,
      origin: center,
      scale: 1,
      copy: tool === 'duplicate',
    },
    text: {
      text: 'VIBEWORKS',
      plane: 'XY',
      origin: info ? [center[0], center[1], round(info.bounds.max[2])] : [0, 0, 0],
      size: info ? round(Math.max(2, Math.min(info.bounds.size[0], info.bounds.size[1]) / 5)) : 10,
      depth: info ? round(Math.max(0.2, Math.min(1, info.bounds.size[2] / 4))) : 1,
      ...(target ? { target, mode: 'engrave' } : {}),
    },
    pattern: {
      target,
      layout: {
        type: 'linear',
        direction: [1, 0, 0],
        spacing: info ? round(info.bounds.size[0] + 5) : 20,
        count: 3,
      },
    },
    mirror: { target, plane: 'YZ', origin: [info ? round(info.bounds.min[0]) : 0, 0, 0], copy: true },
    drill_holes: { target, centers: [center], diameter: 5, axis: 'Z' },
    union: { target, tools: doc.selectedFeatureIds.slice(1) },
    subtract: { target, tools: doc.selectedFeatureIds.slice(1) },
    intersect: { target, tools: doc.selectedFeatureIds.slice(1) },
    fillet: { target, edges: 'vertical', radius: 2 },
    chamfer: { target, edges: 'vertical', distance: 1 },
  }[kind];
  const derived = 'target' in params && !!params.target;
  // Derived features inherit dynamically; primitives start with the session material.
  const appearance = kind === 'instance' || derived || !material ? undefined : { material };
  return { id: nextFeatureId(doc, kind), kind, params, ...(appearance ? { appearance } : {}) } as Feature;
}
/** Show the target's effective appearance without freezing inheritance on a derived draft. */
export function draftAppearance(feature: Feature, document: CadDocument, geometry: GeometryInfo[]) {
  const target = 'target' in feature.params ? feature.params.target : undefined;
  const inherited = target
    ? (geometry.find((g) => g.featureId === target)?.appearance ?? effectiveAppearance(document, target))
    : undefined;
  return { ...inherited, ...feature.appearance };
}
export function featureCommand(
  doc: CadDocument,
  feature: Feature,
  edit = false
): Extract<CadCommand, { type: 'apply_edits' }> {
  return {
    type: 'apply_edits',
    params: {
      ...context(doc),
      edits: [{ op: edit ? 'update' : 'add', feature: featureSchema.parse(feature) }],
    },
  };
}

/** Compose a world-space handle gesture with a part's existing rigid placement. */
export function moveInstance(
  feature: Extract<Feature, { kind: 'instance' }>,
  delta: { translation: Vector3; rotationAxis: Vector3; angleDegrees: number; origin: Vector3 }
): Feature {
  const p = feature.params;
  if (p.attachment) throw new Error('This instance is attached. Edit its target-local offset or twist in Parameters.');
  const rotation = new Quaternion().setFromAxisAngle(
    new ThreeVector(...p.rotationAxis).normalize(),
    (p.angleDegrees * Math.PI) / 180
  );
  const turn = new Quaternion().setFromAxisAngle(
    new ThreeVector(...delta.rotationAxis).normalize(),
    (delta.angleDegrees * Math.PI) / 180
  );
  const offset = new ThreeVector(...p.origin)
    .sub(new ThreeVector(...p.origin).applyQuaternion(rotation))
    .add(new ThreeVector(...p.translation));
  offset
    .sub(new ThreeVector(...delta.origin))
    .applyQuaternion(turn)
    .add(new ThreeVector(...delta.origin))
    .add(new ThreeVector(...delta.translation));
  const combined = turn.multiply(rotation).normalize();
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, combined.w))),
    sin = Math.sin(angle / 2);
  const axis: Vector3 =
    Math.abs(sin) < 1e-8 ? [0, 0, 1] : [combined.x / sin, combined.y / sin, combined.z / sin];
  // Placement bindings cannot describe a composed handle gesture; other bindings remain intact.
  const bindings = Object.fromEntries(
    Object.entries(feature.bindings ?? {}).filter(
      ([path]) =>
        !['translation', 'origin', 'rotationAxis', 'angleDegrees'].some(
          (key) => path === key || path.startsWith(key + '.')
        )
    )
  );
  return {
    ...feature,
    bindings,
    params: {
      ...p,
      translation: offset.toArray() as Vector3,
      origin: [0, 0, 0],
      rotationAxis: axis,
      angleDegrees: (angle * 180) / Math.PI,
    },
  };
}
