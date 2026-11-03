import { useState } from 'react';
import type { Feature, GeometryInfo, Vector3 } from '../shared/protocol';
import { NumberField, Segmented, plainField } from './FeatureFields';
import { fmt } from './modeling';

type Holes = Extract<Feature, { kind: 'drill_holes' }>;
type Mode = 'list' | 'circle' | 'grid';
const AXES = ['X', 'Y', 'Z'] as const;
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Hole centers on a circle of `count` holes, in the plane across the drilling axis. */
export function boltCircle(center: Vector3, axis: 0 | 1 | 2, radius: number, count: number, startDegrees: number): Vector3[] {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  return Array.from({ length: count }, (_, i) => {
    const angle = (startDegrees + i * 360 / count) * Math.PI / 180;
    const point = [...center] as Vector3;
    point[u] = round(center[u] + radius * Math.cos(angle)); point[v] = round(center[v] + radius * Math.sin(angle));
    return point;
  });
}

/** Hole centers on a rectangular grid starting at `corner`, across the drilling axis. */
export function holeGrid(corner: Vector3, axis: 0 | 1 | 2, counts: [number, number], pitch: [number, number]): Vector3[] {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const points: Vector3[] = [];
  for (let j = 0; j < counts[1]; j++) for (let i = 0; i < counts[0]; i++) {
    const point = [...corner] as Vector3;
    point[u] = round(corner[u] + i * pitch[0]); point[v] = round(corner[v] + j * pitch[1]);
    points.push(point);
  }
  return points;
}

/**
 * Generates hole centers live from a bolt circle or grid. The document stores only the resulting centers,
 * so agents and later edits see plain coordinates.
 */
export function HolePattern({ feature, geometry, onCenters }: { feature: Holes; geometry: GeometryInfo[]; onCenters: (centers: Vector3[]) => void }) {
  const axis = AXES.indexOf(feature.params.axis) as 0 | 1 | 2;
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const bounds = geometry.find(g => g.featureId === feature.params.target)?.bounds;
  const center = (bounds ? bounds.min.map((m, i) => round((m + bounds.max[i]) / 2)) : [0, 0, 0]) as Vector3;
  const size = bounds?.size ?? [40, 40, 40];
  const [mode, setMode] = useState<Mode>('list');
  const [circle, setCircle] = useState({ radius: round(Math.min(size[u], size[v]) * 0.35), count: 6, start: 0, cu: center[u], cv: center[v] });
  const inset = round(Math.min(10, Math.min(size[u], size[v]) / 4));
  const span: [number, number] = [round(size[u] - 2 * inset), round(size[v] - 2 * inset)];
  const [grid, setGrid] = useState({ nu: 2, nv: 2, pu: span[0], pv: span[1], su: round((bounds?.min[u] ?? 0) + inset), sv: round((bounds?.min[v] ?? 0) + inset) });
  // Changing a count re-spreads that direction across the inset span, so holes stay on the target.
  const fitPitch = (count: number, along: 0 | 1) => count > 1 ? round(span[along] / (count - 1)) : span[along];
  const emitCircle = (next: typeof circle) => {
    setCircle(next);
    if (!(next.radius > 0) || !Number.isInteger(next.count) || next.count < 1 || next.count > 32 || ![next.start, next.cu, next.cv].every(Number.isFinite)) return;
    const c = [...center] as Vector3; c[u] = next.cu; c[v] = next.cv;
    onCenters(boltCircle(c, axis, next.radius, next.count, next.start));
  };
  const emitGrid = (next: typeof grid) => {
    setGrid(next);
    if (![next.nu, next.nv].every(n => Number.isInteger(n) && n >= 1) || next.nu * next.nv > 32 || ![next.pu, next.pv, next.su, next.sv].every(Number.isFinite)) return;
    const c = [...center] as Vector3; c[u] = next.su; c[v] = next.sv;
    onCenters(holeGrid(c, axis, [next.nu, next.nv], [next.pu, next.pv]));
  };
  const choose = (next: Mode) => { setMode(next); if (next === 'circle') emitCircle(circle); if (next === 'grid') emitGrid(grid); };
  const [U, V] = [AXES[u], AXES[v]];
  return <div className="hole-pattern">
    <Segmented label="Layout" value={mode} options={['list', 'circle', 'grid'] as const} labels={{ list: 'Points', circle: 'Bolt circle', grid: 'Grid' }} onChange={choose} />
    {mode === 'circle' && <>
      <div className="field-pair"><NumberField label="Circle radius" min={0.01} field={plainField(circle.radius, radius => emitCircle({ ...circle, radius }))} /><NumberField label="Holes" unit="" integer min={1} max={32} field={plainField(circle.count, count => emitCircle({ ...circle, count: Math.round(count) }))} /></div>
      <div className="field-pair"><NumberField label={`Center ${U}`} field={plainField(circle.cu, cu => emitCircle({ ...circle, cu }))} /><NumberField label={`Center ${V}`} field={plainField(circle.cv, cv => emitCircle({ ...circle, cv }))} /></div>
      <NumberField label="Start angle" unit="°" field={plainField(circle.start, start => emitCircle({ ...circle, start }))} />
      <p className="field-hint">{circle.count} holes every {fmt(360 / Math.max(1, circle.count), 2)}° on a Ø{fmt(circle.radius * 2, 2)} circle across {feature.params.axis}. Starts at the target's center.</p>
    </>}
    {mode === 'grid' && <>
      <div className="field-pair"><NumberField label={`Columns along ${U}`} unit="" integer min={1} field={plainField(grid.nu, nu => emitGrid({ ...grid, nu: Math.round(nu), pu: fitPitch(Math.round(nu), 0) }))} /><NumberField label={`Rows along ${V}`} unit="" integer min={1} field={plainField(grid.nv, nv => emitGrid({ ...grid, nv: Math.round(nv), pv: fitPitch(Math.round(nv), 1) }))} /></div>
      <div className="field-pair"><NumberField label={`Pitch ${U}`} field={plainField(grid.pu, pu => emitGrid({ ...grid, pu }))} /><NumberField label={`Pitch ${V}`} field={plainField(grid.pv, pv => emitGrid({ ...grid, pv }))} /></div>
      <div className="field-pair"><NumberField label={`First ${U}`} field={plainField(grid.su, su => emitGrid({ ...grid, su }))} /><NumberField label={`First ${V}`} field={plainField(grid.sv, sv => emitGrid({ ...grid, sv }))} /></div>
      <p className="field-hint">{grid.nu * grid.nv} of 32 holes. Changing a count spreads holes across the target, {fmt(inset, 1)} mm in from its edges; pitch can then be set freely.</p>
    </>}
  </div>;
}
