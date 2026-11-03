import { restoreSurface, selectSurface, useSurfaceSelection } from './surface-selection';
import { normalToSurface } from './normal-view';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {appearanceEvaluation,useAppearanceFeedback} from './appearance-feedback';
import { addSurfaceGraphics } from './surface-graphics';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Evaluation } from '../cad/types';
import type { Appearance, Bounds, Vector3, ViewName } from '../shared/protocol';
import { addInterferenceVolumes, applyMaterialLooks, configureRenderer, createGrid, createWorkbenchScene, disposeScene, fitCamera, modelBounds, studioEnvironment, WORKBENCH, type WorkbenchPart } from './scene';
import { advanceOrbit, prepareOrbit, orbitLoop, showOutline, onDemandFrame } from './presentation';
import { aimHeadlight, DEFAULT_WORKBENCH_EDGES, workbenchPixelRatio } from './workbench';
import { fmt } from './modeling';
import { configureStudioNavigation, studioNavigationHelp, studioWheelIntent, type StudioNavigation } from './studio-navigation';

export interface GizmoEdit {
  documentId: string; revision: number; target: string; origin: Vector3;
  translation: Vector3; rotationAxis: Vector3; angleDegrees: number; scale: number;
}
export interface HolePreview { target: string; /** Solids that accept placement clicks, e.g. the target and its exact preview. */ surfaces?: string[]; centers: Vector3[]; diameter: number; axis: 'X' | 'Y' | 'Z' }
type GizmoMode = 'move' | 'rotate' | 'scale';
/** Display-only clipping: keeps material on the low side of the plane (high side when flipped). */
export interface Section { axis: 0 | 1 | 2; offset: number; flip: boolean }
interface Props {
  preview?:boolean;
  studioLooks?:import('../shared/protocol').Presentation;
  /** Split panes fit their model after resizing while retaining the chosen camera direction. */
  fitOnResize?: boolean;
  navigationTool?: 'select' | 'pan' | 'orbit' | 'zoom';
  api?: RefObject<ViewportView | null>;
  compare?: { evaluation: Evaluation; appearances: Map<string, Appearance | undefined> }; comparePosition?: number;
  contribution?: { ids: string[]; color: string };
  navigation?: StudioNavigation; dark?: boolean; onInteraction?: () => void;
  history?: boolean;
  edges?: boolean; orbiting?: boolean; onStopOrbit?: () => void;
  evaluation: Evaluation; selected: string[]; ghosts: string[]; view: ViewName; fitKey: number;
  documentId: string; revision: number; storageVersion?: number; gizmoMode?: GizmoMode; snap: boolean;
  /** Hole placement: clicks on the target report a surface point instead of selecting. */
  pick?: HolePreview;
  section?: Section;
  /** Parts physical analysis flagged (floating or interpenetrating); outlined in the warning color. */
  flagged?: string[];
  /** Effective appearance per feature; parts with a material render physically based. */
  appearances?: Map<string, Appearance | undefined>;
  /** Measure mode: clicks place two surface points and report their distance. */
  measure?: boolean;
  /** Edge picking for fillets and chamfers: clicks snap to the nearest edge of target and report a point on it. */
  edgePick?: { target: string; points: Vector3[] };
  name: (id: string) => string;
  onSelect: (id?: string, additive?: boolean) => void; onTransform: (edit: GizmoEdit) => Promise<void>;
  /** Right-click without dragging (a drag pans). The id is the result under the pointer, if any. */
  onContextMenu?: (id: string | undefined, x: number, y: number) => void;
  onPick?: (point: Vector3, axis: 'X' | 'Y' | 'Z' | undefined) => void;
}
interface Engine {
  renderer: THREE.WebGLRenderer; camera: THREE.OrthographicCamera; controls: OrbitControls; transform: TransformControls;
  scene: THREE.Scene; parts: WorkbenchPart[]; render: () => void; fit: () => void; rebuild: () => void; annotate: () => void; cancel: () => void; firstModel: () => void;
  /** Restyle existing parts for selection, hover and flags without rebuilding GPU buffers. */
  repaint: () => void;
  compare: () => void;
  restore: (pose: CameraPose) => void;
  updateSection: () => void; clearMeasure: () => void; updateGizmo: () => void; updateSnap: () => void;
}
export interface CameraPose { position: Vector3; target: Vector3; up: Vector3; zoom: number; frustum: number[]; width: number; height: number }
export interface ViewportView { normalTo: () => void; capture: () => CameraPose; restore: (pose: CameraPose) => void; frame: () => void; fit: () => void }
const CAP_COLOR = 0xf2b394;
const AXES = ['X', 'Y', 'Z'] as const;
/** World axis of a surface normal when it is within about 8 degrees of one. */
function dominantAxis(normal: THREE.Vector3): 'X' | 'Y' | 'Z' | undefined {
  const values = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  const index = values.indexOf(Math.max(...values));
  return values[index] > 0.99 ? AXES[index] : undefined;
}

export function Viewport(props: Props) {
  const faceSelection=useSurfaceSelection();
  const [faceHover,setFaceHover]=useState<import('../shared/protocol').SurfacePick>();
  useEffect(()=>{if(!props.preview)restoreSurface(props.documentId,props.evaluation,props.revision,props.storageVersion);},[props.documentId,props.evaluation,props.revision,props.storageVersion,props.preview]);
  const appearanceFeedback=useAppearanceFeedback();
  const appearanceEditing=appearanceFeedback?.documentId===props.documentId;
  const appearanceMode=useRef(appearanceEditing);appearanceMode.current=appearanceEditing;
  const appearanceDisplay=useMemo(()=>appearanceEvaluation(props.evaluation,appearanceFeedback,props.documentId),[props.evaluation,appearanceFeedback,props.documentId]);
  props={...props,evaluation:appearanceDisplay};
  const { evaluation, selected, ghosts, view, fitKey, documentId, revision, gizmoMode, snap, pick } = props;
  const host = useRef<HTMLDivElement>(null);
  const triad = useRef<SVGSVGElement>(null);
  const dims = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const measureLabel = useRef<HTMLDivElement>(null);
  const stateRef = useRef(props); stateRef.current = props;
  const engine = useRef<Engine | null>(null);
  const pendingCamera = useRef<CameraPose | undefined>(undefined);
  const [error, setError] = useState('');
  const [normalPicking, setNormalPicking] = useState(false);
  const normalMode = useRef(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('WebGL is unavailable. Geometry commands and exports still work. Enable WebGL and reload to see the model.'); return; }
    configureRenderer(renderer); renderer.autoClear = false; renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
    renderer.domElement.setAttribute('aria-label', `Model viewport. ${studioNavigationHelp(stateRef.current.navigation ?? 'mouse')}`);
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.tabIndex = 0;
    element.prepend(renderer.domElement);
    const camera = new THREE.OrthographicCamera(); camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement); configureStudioNavigation(controls, 100);
    const transform = new TransformControls(camera, renderer.domElement); transform.setSize(0.85); transform.setSpace('world');
    const overlay = new THREE.Scene(); overlay.add(transform.getHelper());
    const annotations = new THREE.Group(); overlay.add(annotations);
    let pivot: THREE.Group | undefined;
    let gesture: { origin: Vector3; target: string; documentId: string; revision: number } | undefined;
    let usedHandle = false;
    let cancelled = false;
    let scaling = false;
    let pointerStart = { x: 0, y: 0 };
    let pointerNow = { x: 0, y: 0 };
    let hovered: string | undefined;
    let hoverFrame = 0;
    let dimBounds: Bounds | undefined;
    let hadModel = false;
    const sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    let environment: THREE.Texture | undefined;
    const buffers = new Map<number[], {solid: THREE.BufferGeometry; edges: THREE.BufferGeometry}>();
    const retired: THREE.Scene[] = [];
    let comparison: THREE.Scene | undefined;
    let compared: Props['compare'];
    const sectionFrame = new THREE.Group(); overlay.add(sectionFrame);
    const measureGroup = new THREE.Group(); overlay.add(measureGroup);
    let measurePoints: THREE.Vector3[] = [];

    const project = (point: THREE.Vector3) => {
      const v = point.clone().project(camera);
      return { x: (v.x + 1) / 2 * element.clientWidth, y: (1 - v.y) / 2 * element.clientHeight };
    };
    const drawOverlays = () => {
      // Axis triad follows the camera orientation.
      if (triad.current) {
        const inverse = camera.quaternion.clone().invert();
        for (const [i, axis] of AXES.entries()) {
          const v = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(inverse);
          const line = triad.current.querySelector<SVGLineElement>(`[data-axis="${axis}"] line`);
          const text = triad.current.querySelector<SVGTextElement>(`[data-axis="${axis}"] text`);
          const group = triad.current.querySelector<SVGGElement>(`[data-axis="${axis}"]`);
          line?.setAttribute('x2', String(30 + v.x * 20)); line?.setAttribute('y2', String(30 - v.y * 20));
          text?.setAttribute('x', String(30 + v.x * 26)); text?.setAttribute('y', String(30 - v.y * 26 + 3.5));
          group?.setAttribute('opacity', v.z < -0.2 ? '0.45' : '1');
        }
      }
      const label = measureLabel.current;
      if (label) {
        label.hidden = measurePoints.length === 0;
        if (measurePoints.length) {
          const at = project(measurePoints.length === 2 ? measurePoints[0].clone().add(measurePoints[1]).multiplyScalar(0.5) : measurePoints[0]);
          label.style.transform = `translate(${at.x}px, ${at.y - 18}px) translate(-50%, -100%)`;
        }
      }
      // Exact OCCT bounds of the single selected object, as dimension callouts.
      const box = dims.current;
      if (!box) return;
      if (!dimBounds || gesture) { box.hidden = true; return; }
      box.hidden = false;
      const [x0, y0, z0] = dimBounds.min, [x1, y1, z1] = dimBounds.max;
      const edges: [THREE.Vector3, THREE.Vector3, number][] = [
        [new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y0, z0), dimBounds.size[0]],
        [new THREE.Vector3(x1, y0, z0), new THREE.Vector3(x1, y1, z0), dimBounds.size[1]],
        [new THREE.Vector3(x1, y0, z0), new THREE.Vector3(x1, y0, z1), dimBounds.size[2]],
      ];
      // Labels sit just outside the projected box, away from its center, so small parts stay legible.
      const center = project(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
      edges.forEach(([a, b, size], i) => {
        const label = box.children[i] as HTMLElement;
        const pa = project(a), pb = project(b);
        const visible = Math.hypot(pa.x - pb.x, pa.y - pb.y) > 28;
        label.hidden = !visible;
        const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        const away = Math.hypot(mid.x - center.x, mid.y - center.y) || 1;
        const push = 22;
        label.style.transform = `translate(${mid.x + (mid.x - center.x) / away * push}px, ${mid.y + (mid.y - center.y) / away * push}px) translate(-50%, -50%)`;
        label.lastElementChild!.textContent = fmt(size, 2);
      });
    };
    const frames = onDemandFrame(() => {
      const current = engine.current; if (!current) return;
      aimHeadlight(current.scene, camera, controls.target); if (comparison) aimHeadlight(comparison, camera, controls.target);
      const size = renderer.getSize(new THREE.Vector2());
      if (comparison) {
        const split = Math.round(size.x * (stateRef.current.comparePosition ?? .5));
        renderer.setScissorTest(true); renderer.setScissor(0, 0, split, size.y);
        renderer.shadowMap.needsUpdate = true; renderer.clear(); renderer.render(comparison, camera);
        renderer.setScissor(split, 0, size.x - split, size.y);
        renderer.shadowMap.needsUpdate = true; renderer.clear(); renderer.render(current.scene, camera);
        renderer.setScissorTest(false);
      } else { renderer.clear(); renderer.render(current.scene, camera); renderer.clearDepth(); renderer.render(overlay, camera); }
      drawOverlays();
      // Keep old shader owners until the replacement has actually drawn, including coalesced rebuilds.
      if (retired.length) {
        const retained = new Set<THREE.BufferGeometry>();
        current.scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) retained.add(object.geometry); });
        for (const previous of retired.splice(0)) disposeScene(previous, retained);
        for (const [key, asset] of buffers) if (!retained.has(asset.solid)) buffers.delete(key);
      }
    });
    const render = frames.request;
    const invalidateShadows = () => { renderer.shadowMap.needsUpdate = true; };
    const paint = () => {
      const current = engine.current; if (!current) return;
      const p = stateRef.current;
      for (const part of current.parts) {

        const isSelected = p.selected.includes(part.featureId), isHover = hovered === part.featureId;
        const body = part.mesh.material as THREE.MeshStandardMaterial, edge = part.outline.material as THREE.LineBasicMaterial;
        if((part.mesh.userData.display as import('../shared/protocol').DisplayMesh)?.resultKind==='sheet'){body.color.setHex(0x69bcc4);body.transparent=true;body.opacity=0.5;body.side=THREE.DoubleSide;body.polygonOffset=true;body.polygonOffsetFactor=-2;body.polygonOffsetUnits=-2;body.depthWrite=false;part.outline.visible=true;edge.color.setHex(0x209ba9);continue;}
        part.outline.visible = showOutline(p.edges ?? DEFAULT_WORKBENCH_EDGES, isSelected, isHover, part.ghost, !!p.flagged?.includes(part.featureId), p.edgePick?.target === part.featureId);
        if (part.ghost) { body.opacity = isHover ? 0.34 : 0.22; edge.color.setHex(isSelected ? WORKBENCH.selectedEdge : WORKBENCH.ghostEdge); continue; }
        const isFlagged = !!p.flagged?.includes(part.featureId);
        const contributed = p.contribution?.ids.includes(part.featureId);
        if (contributed && !isSelected && !isHover && !isFlagged) {
          part.outline.visible = true; edge.color.set(p.contribution!.color); edge.opacity = .9; continue;
        }
        edge.opacity = isSelected || isHover || isFlagged || p.edgePick?.target === part.featureId ? 0.95 : 0.4;
        if (part.styled) {
          // Keep the material's own color; show state with a glow and the edge color.
          (body as unknown as THREE.MeshPhysicalMaterial).emissive.setHex(isSelected && !appearanceMode.current ? 0x5a2208 : isHover && !appearanceMode.current ? 0x202326 : isFlagged ? 0x5a0b06 : 0x000000);
          edge.color.setHex(isSelected ? WORKBENCH.selectedEdge : isHover ? part.darkSurface ? WORKBENCH.darkSurfaceHoverEdge : WORKBENCH.hoverEdge : isFlagged ? WORKBENCH.flaggedEdge : part.darkSurface ? WORKBENCH.darkSurfaceEdge : WORKBENCH.edge);
          continue;
        }
        body.color.setHex(isSelected && !appearanceMode.current ? WORKBENCH.selectedBody : isHover && !appearanceMode.current ? WORKBENCH.hoverBody : isFlagged ? WORKBENCH.flaggedBody : WORKBENCH.body);
        edge.color.setHex(isSelected ? WORKBENCH.selectedEdge : isHover ? WORKBENCH.hoverEdge : isFlagged ? WORKBENCH.flaggedEdge : WORKBENCH.edge);
      }
      render();
    };
    const cancel = () => {
      cancelled = true; gesture = undefined; transform.reset(); transform.pointerUp(null); controls.enabled = true; setDragging(false); invalidateShadows(); render();
    };
    const annotate = () => {
      for (const child of [...annotations.children]) {
        annotations.remove(child);
        child.traverse(object => { if (object instanceof THREE.Line || object instanceof THREE.Mesh || object instanceof THREE.Points) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
      }
      const p = stateRef.current;
      const id = p.selected.length === 1 ? p.selected[0] : undefined;
      const info = id ? p.evaluation.geometry.find(g => g.featureId === id) : undefined;
      dimBounds = info?.bounds;
      if (info) {
        const [x0, y0, z0] = info.bounds.min, [x1, y1, z1] = info.bounds.max;
        const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        const pairs = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(pairs.flatMap(i => corners[i]), 3));
        const box = new THREE.LineSegments(geometry, new THREE.LineDashedMaterial({ color: WORKBENCH.selectedEdge, dashSize: Math.max(info.bounds.size[0], info.bounds.size[1], info.bounds.size[2], 1) / 60, gapSize: Math.max(...info.bounds.size, 1) / 60, transparent: true, opacity: 0.55, depthTest: false }));
        box.computeLineDistances(); annotations.add(box);
      }
      // Picked edge points for a fillet or chamfer.
      if (p.edgePick?.points.length) {
        annotations.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(p.edgePick.points.map(point => new THREE.Vector3(...point))), new THREE.PointsMaterial({ color: WORKBENCH.selectedEdge, size: 9, sizeAttenuation: false, depthTest: false })));
      }
      // Pending hole markers: a preview of entered values, never CAD state.
      if (p.pick) {
        const target = p.evaluation.geometry.find(g => g.featureId === p.pick!.target);
        const index = AXES.indexOf(p.pick.axis);
        for (const center of p.pick.centers) {
          if (!center.every(Number.isFinite) || !(p.pick.diameter > 0)) continue;
          const ring = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 49 }, (_, i) => {
            const a = i / 48 * Math.PI * 2, r = p.pick!.diameter / 2;
            const v = [0, 0, 0]; v[(index + 1) % 3] = Math.cos(a) * r; v[(index + 2) % 3] = Math.sin(a) * r;
            return new THREE.Vector3(...v);
          }));
          const markers = new THREE.Group(); markers.position.set(...center);
          if (target) markers.position.setComponent(index, target.bounds.max[index] + 0.01);
          markers.add(new THREE.Line(ring, new THREE.LineBasicMaterial({ color: WORKBENCH.selectedEdge, depthTest: false })));
          if (target) {
            const low = target.bounds.min[index] - target.bounds.max[index] - 0.02;
            const axisLine = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...AXES.map((_, i) => i === index ? low : 0))]);
            const drill = new THREE.Line(axisLine, new THREE.LineDashedMaterial({ color: WORKBENCH.selectedEdge, dashSize: 1, gapSize: 0.8, depthTest: false }));
            drill.computeLineDistances(); markers.add(drill);
            const bottom = new THREE.Line(ring.clone(), new THREE.LineBasicMaterial({ color: WORKBENCH.selectedEdge, transparent: true, opacity: 0.45, depthTest: false }));
            bottom.position.setComponent(index, low); markers.add(bottom);
          }
          annotations.add(markers);
        }
      }
      render();
    };
    const updateSnap = () => {
      const p = stateRef.current;
      transform.setTranslationSnap(p.snap ? 1 : null);
      transform.setRotationSnap(p.snap ? Math.PI / 12 : null);
      transform.setScaleSnap(p.snap ? 0.1 : null);
    };
    const updateGizmo = () => {
      const current = engine.current; if (!current) return;
      if (gesture) cancel();
      transform.detach();
      if (pivot) {
        for (const child of [...pivot.children]) current.scene.attach(child);
        current.scene.remove(pivot); pivot = undefined;
      }
      const p = stateRef.current;
      const id = p.selected.length === 1 ? p.selected[0] : undefined;
      if (p.gizmoMode && id && p.evaluation.visibleFeatureIds.includes(id)) {
        const bounds = modelBounds(p.evaluation, [id]);
        pivot = new THREE.Group();
        pivot.position.set(...bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vector3);
        current.scene.add(pivot); current.scene.updateMatrixWorld(true);
        for (const object of [...current.scene.children]) if (object.userData.featureId === id) pivot.attach(object);
        transform.setMode(p.gizmoMode === 'move' ? 'translate' : p.gizmoMode);
        transform.attach(pivot);
      }
      updateSnap(); render();
    };
    const rebuild = () => {
      const current = engine.current; if (!current) return;
      if (gesture) cancel();
      transform.detach();
      // Dispose the old scene only after the new one has rendered: three.js frees a shader program when its last
      // material goes, so disposing first recompiles every program on each model update.
      const previous = current.scene;
      const p = stateRef.current;
      const built = createWorkbenchScene(p.evaluation, p.selected, p.ghosts, p.appearances, p.edges ?? DEFAULT_WORKBENCH_EDGES, buffers);
      if(p.studioLooks)applyMaterialLooks(built.scene,p.studioLooks);
      if (p.flagged !== undefined) addInterferenceVolumes(built.scene, p.evaluation, p.evaluation.visibleFeatureIds, p.section ? [sectionPlane] : undefined);
      pivot = undefined; current.scene = built.scene; current.parts = built.parts;
      if (p.evaluation.visibleFeatureIds.length) { environment ??= studioEnvironment(renderer); current.scene.environment = environment; }
      invalidateShadows();
      const graphicsScene = built.scene;
      void addSurfaceGraphics(graphicsScene, p.evaluation.meshes.filter(mesh => p.evaluation.visibleFeatureIds.includes(mesh.featureId) && !p.ghosts.includes(mesh.featureId)), () => engine.current?.scene === graphicsScene).then(() => {
        if (engine.current?.scene !== graphicsScene) return;
        for (const object of [...graphicsScene.children]) if (object instanceof THREE.Mesh && object.userData.graphicId) {
          (object.material as THREE.Material).clippingPlanes = p.section ? [sectionPlane] : [];
          const latest = stateRef.current;
          if (pivot && latest.gizmoMode && latest.selected.length === 1 && object.userData.featureId === latest.selected[0]) {
            pivot.updateMatrixWorld(true);
            pivot.attach(object);
          }
        }
        render();
      }).catch(error => { if (engine.current?.scene === graphicsScene) setError(String(error)); });
      if (p.section) {
        // Clip every solid; back faces seen through the cut are drawn as a flat cap so sections read as solid.
        for (const part of built.parts) {
          (part.mesh.material as THREE.Material).clippingPlanes = [sectionPlane];
          (part.outline.material as THREE.Material).clippingPlanes = [sectionPlane];
          if (part.ghost) continue;
          const cap = new THREE.Mesh(part.mesh.geometry, new THREE.MeshBasicMaterial({ color: CAP_COLOR, side: THREE.BackSide, clippingPlanes: [sectionPlane] }));
          cap.applyMatrix4(part.mesh.matrix);
          cap.userData.cap = true; built.scene.add(cap);
        }
      }
      if (p.evaluation.visibleFeatureIds.length) current.scene.add(createGrid(modelBounds(p.evaluation), p.dark));
      if (hovered && !built.parts.some(part => part.featureId === hovered)) hovered = undefined;
      updateGizmo();
      paint(); annotate();
      retired.push(previous);
    };
    /** Fit into the area not covered by floating panels (siblings marked data-inset). */
    const fit = (bounds?: Bounds, retainDirection = false) => {
      if (gesture) return;
      const p = stateRef.current;
      const rect = element.getBoundingClientRect();
      const W = Math.max(rect.width, 1), H = Math.max(rect.height, 1);
      let L = 0, R = 0, T = 0, B = 0;
      for (const other of element.parentElement?.querySelectorAll<HTMLElement>('[data-inset]') ?? []) {
        const r = other.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if ((other.dataset.inset === 'left' || other.dataset.inset === 'right') && r.width > W * .8 && r.top > rect.top + H * .25) { B = Math.max(B, rect.bottom - r.top); continue; }
        if (other.dataset.inset === 'left') L = Math.max(L, r.right - rect.left);
        if (other.dataset.inset === 'right') R = Math.max(R, rect.right - r.left);
        if (other.dataset.inset === 'top') T = Math.max(T, r.bottom - rect.top);
        if (other.dataset.inset === 'bottom') B = Math.max(B, rect.bottom - r.top);
      }
      let freeW = W - L - R, freeH = H - T - B;
      if (freeW < W * 0.35) { L = R = 0; freeW = W; }
      if (freeH < H * 0.35) { T = B = 0; freeH = H; }
      const direction = retainDirection ? camera.position.clone().sub(controls.target) : undefined;
      controls.target.copy(fitCamera(camera, bounds ?? modelBounds(p.evaluation), direction?.lengthSq() ? direction : p.view, freeW / freeH));
      const unit = (camera.top - camera.bottom) / freeH;
      camera.left = -(L + freeW / 2) * unit; camera.right = (R + freeW / 2) * unit;
      camera.top = (T + freeH / 2) * unit; camera.bottom = -(B + freeH / 2) * unit;
      camera.updateProjectionMatrix();
      controls.update(); render();
    };
    const updateSection = () => {
      const p = stateRef.current;
      for (const child of [...sectionFrame.children]) { sectionFrame.remove(child); child.traverse(o => { if (o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }); }
      if (p.section) {
        const normal = new THREE.Vector3(); normal.setComponent(p.section.axis, p.section.flip ? 1 : -1);
        sectionPlane.set(normal, p.section.flip ? -p.section.offset : p.section.offset);
        // The cut plane's outline over the model's extent: a spatial reference, not geometry.
        const b = modelBounds(p.evaluation), a = p.section.axis, u = (a + 1) % 3, v = (a + 2) % 3;
        const pad = Math.max(...b.size) * 0.08;
        const corner = (du: number, dv: number) => { const c = new THREE.Vector3(); c.setComponent(a, p.section!.offset); c.setComponent(u, du); c.setComponent(v, dv); return c; };
        const [u0, u1, v0, v1] = [b.min[u] - pad, b.max[u] + pad, b.min[v] - pad, b.max[v] + pad];
        const frame = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)]), new THREE.LineDashedMaterial({ color: WORKBENCH.selectedEdge, dashSize: pad / 2, gapSize: pad / 3, transparent: true, opacity: 0.7, depthTest: false }));
        frame.computeLineDistances(); sectionFrame.add(frame);
      }
      renderer.localClippingEnabled = !!p.section;
      invalidateShadows(); render();
    };
    const drawMeasure = () => {
      for (const child of [...measureGroup.children]) { measureGroup.remove(child); if (child instanceof THREE.Line || child instanceof THREE.Points) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } }
      const label = measureLabel.current;
      if (measurePoints.length) {
        measureGroup.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(measurePoints), new THREE.PointsMaterial({ color: WORKBENCH.selectedEdge, size: 9, sizeAttenuation: false, depthTest: false })));
        if (measurePoints.length === 2) measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePoints), new THREE.LineBasicMaterial({ color: WORKBENCH.selectedEdge, depthTest: false })));
      }
      if (label) {
        if (measurePoints.length === 2) {
          const d = measurePoints[1].clone().sub(measurePoints[0]);
          label.querySelector('b')!.textContent = `${fmt(d.length(), 2)} mm`;
          label.querySelector('span')!.textContent = `ΔX ${fmt(d.x, 2)} · ΔY ${fmt(d.y, 2)} · ΔZ ${fmt(d.z, 2)}`;
        } else if (measurePoints.length === 1) {
          label.querySelector('b')!.textContent = 'Pick a second point';
          label.querySelector('span')!.textContent = measurePoints[0].toArray().map(v => fmt(v, 2)).join(', ');
        }
      }
      render();
    };
    const clearMeasure = () => { measurePoints = []; drawMeasure(); };
    const compare = () => {
      if (comparison) { const previous = comparison; comparison = undefined; disposeScene(previous); }
      const data = stateRef.current.compare;
      if (data) {
        comparison = createWorkbenchScene(data.evaluation, [], [], data.appearances, stateRef.current.edges).scene;
        environment ??= studioEnvironment(renderer); comparison.environment = environment;
        comparison.add(createGrid(modelBounds(data.evaluation), stateRef.current.dark));
        const current = comparison;
        void addSurfaceGraphics(current, data.evaluation.meshes.filter(m => data.evaluation.visibleFeatureIds.includes(m.featureId)), () => comparison === current).then(render).catch(error => { if (comparison === current) setError(String(error)); });
        if (compared !== data) {
          const live = stateRef.current.evaluation;
          fit(modelBounds({ ...live, geometry: [...live.geometry, ...data.evaluation.geometry], visibleFeatureIds: [...new Set([...live.visibleFeatureIds, ...data.evaluation.visibleFeatureIds])] }));
        }
      }
      compared = data;
      render();
    };
    /** The point on target's displayed edges nearest the click, within 10 px on screen. */
    const nearestEdgePoint = (clientX: number, clientY: number, target: string): THREE.Vector3 | undefined => {
      const part = engine.current?.parts.find(candidate => candidate.featureId === target);
      if (!part) return undefined;
      const rect = element.getBoundingClientRect();
      const click = { x: clientX - rect.left, y: clientY - rect.top };
      const positions = part.outline.geometry.getAttribute('position');
      let best: THREE.Vector3 | undefined, bestDistance = 10;
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (let i = 0; i + 1 < positions.count; i += 2) {
        a.fromBufferAttribute(positions, i).applyMatrix4(part.outline.matrixWorld); b.fromBufferAttribute(positions, i + 1).applyMatrix4(part.outline.matrixWorld);
        const pa = project(a), pb = project(b);
        const dx = pb.x - pa.x, dy = pb.y - pa.y, length2 = dx * dx + dy * dy;
        const t = length2 ? Math.max(0, Math.min(1, ((click.x - pa.x) * dx + (click.y - pa.y) * dy) / length2)) : 0;
        const distance = Math.hypot(pa.x + t * dx - click.x, pa.y + t * dy - click.y);
        if (distance < bestDistance) { bestDistance = distance; best = a.clone().lerp(b, t); }
      }
      return best;
    };
    /** Snap a surface hit to the nearest triangle corner within 8 px, so corners and edges measure exactly. */
    const snapToVertex = (hit: THREE.Intersection): THREE.Vector3 => {
      if (!hit.face) return hit.point.clone();
      const position = (hit.object as THREE.Mesh).geometry.getAttribute('position');
      const at = project(hit.point);
      let best = hit.point.clone(), bestDistance = 8;
      for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
        const vertex = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(hit.object.matrixWorld);
        const screen = project(vertex);
        const distance = Math.hypot(screen.x - at.x, screen.y - at.y);
        if (distance < bestDistance) { bestDistance = distance; best = vertex; }
      }
      return best;
    };
    const firstModel = () => {
      if (stateRef.current.history) return;
      const has = stateRef.current.evaluation.visibleFeatureIds.length > 0;
      if (has && !hadModel) fit();
      hadModel = has;
    };
    const restore = (pose: CameraPose) => {
      camera.position.fromArray(pose.position); camera.up.fromArray(pose.up); camera.zoom = pose.zoom; controls.target.fromArray(pose.target);
      const [left, right, top, bottom, near, far] = pose.frustum;
      camera.left = left * element.clientWidth / pose.width; camera.right = right * element.clientWidth / pose.width;
      camera.top = top * element.clientHeight / pose.height; camera.bottom = bottom * element.clientHeight / pose.height;
      camera.near = near; camera.far = far; camera.updateProjectionMatrix(); controls.update(); render();
    };
    engine.current = { renderer, camera, controls, transform, scene: new THREE.Scene(), parts: [], render, fit, rebuild, annotate, cancel, firstModel, updateSection, clearMeasure, updateGizmo, updateSnap, repaint: paint, compare, restore };
    if (props.api) props.api.current = {
      normalTo: () => { normalMode.current = !normalMode.current; setNormalPicking(normalMode.current); },
      fit: () => fit(undefined, true),
      capture: () => ({ position: camera.position.toArray() as Vector3, target: controls.target.toArray() as Vector3, up: camera.up.toArray() as Vector3, zoom: camera.zoom, frustum: [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far], width: Math.max(element.clientWidth, 1), height: Math.max(element.clientHeight, 1) }),
      restore: pose => { if (stateRef.current.evaluation.visibleFeatureIds.length) restore(pose); else pendingCamera.current = pose; },
      frame: () => {
        const p = stateRef.current, ids = p.selected.filter(id => p.evaluation.visibleFeatureIds.includes(id));
        if (!ids.length) { fit(); return; }
        const bounds = modelBounds(p.evaluation, ids), at = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.size).multiplyScalar(.5));
        camera.position.add(at.clone().sub(controls.target)); controls.target.copy(at); controls.update(); render();
      },
    };
    // Keep the current view on resize; only the projection aspect changes.
    let size = { width: 0, height: 0 };
    const resize = new ResizeObserver(() => {
      const width = Math.max(element.clientWidth, 1), height = Math.max(element.clientHeight, 1);
      renderer.setPixelRatio(workbenchPixelRatio(width, height, devicePixelRatio));
      renderer.setSize(width, height);
      const previous = size; size = { width, height };
      if (!previous.width) { fit(); return; }
      if (stateRef.current.fitOnResize) { fit(undefined, true); return; }
      // Same world-per-pixel scale and anchor; the frustum simply grows or shrinks with the canvas.
      camera.left *= width / previous.width; camera.right *= width / previous.width;
      camera.top *= height / previous.height; camera.bottom *= height / previous.height;
      camera.updateProjectionMatrix(); render();
    });
    resize.observe(element);
    controls.addEventListener('change', render);
    transform.addEventListener('change', render);
    transform.addEventListener('objectChange', () => {
      invalidateShadows(); render();
      // Snap the movement itself to 1 mm, even when the part starts off-grid.
      if (!cancelled && pivot && gesture && stateRef.current.gizmoMode === 'move' && stateRef.current.snap) {
        const origin = gesture.origin;
        pivot.position.set(...origin.map((o, i) => o + Math.round(pivot!.position.getComponent(i) - o)) as Vector3);
      }
      if (cancelled || scaling || !pivot || stateRef.current.gizmoMode !== 'scale') return;
      scaling = true;
      // A screen-distance ratio avoids the stock center handle's singularity
      // when its initial distance from the pivot is zero or almost zero.
      const delta = (pointerNow.x - pointerStart.x) - (pointerNow.y - pointerStart.y);
      let scale = Math.exp(Math.max(-6.9, Math.min(6.9, delta / 200)));
      if (stateRef.current.snap) scale = Math.max(0.1, Math.round(scale * 10) / 10);
      pivot.scale.setScalar(scale); scaling = false; render();
    });
    transform.addEventListener('mouseDown', () => {
      if (!pivot) return;
      const p = stateRef.current;
      usedHandle = true; cancelled = false; controls.enabled = false; setDragging(true);
      gesture = { origin: pivot.position.toArray() as Vector3, target: p.selected[0], documentId: p.documentId, revision: p.revision };
    });
    transform.addEventListener('mouseUp', () => {
      controls.enabled = true; setDragging(false);
      const start = gesture; gesture = undefined;
      if (!start || !pivot || cancelled) return;
      const translation = pivot.position.clone().sub(new THREE.Vector3(...start.origin)).toArray() as Vector3;
      const quaternion = pivot.quaternion.clone().normalize();
      if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1));
      const sin = Math.sin(angle / 2);
      const rotationAxis: Vector3 = sin > 1e-8 ? [quaternion.x / sin, quaternion.y / sin, quaternion.z / sin] : [0, 0, 1];
      const scale = pivot.scale.x;
      if (Math.hypot(...translation) < 1e-8 && angle < 1e-8 && Math.abs(scale - 1) < 1e-8) return;
      // Restore the committed mesh before computation. Preview matrices are never CAD state.
      pivot.position.set(...start.origin); pivot.quaternion.identity(); pivot.scale.setScalar(1); invalidateShadows(); render();
      void stateRef.current.onTransform({ ...start, translation, rotationAxis, angleDegrees: THREE.MathUtils.radToDeg(angle), scale });
    });
    const raycast = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
      const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, camera);
      const p = stateRef.current, current = engine.current!;
      const candidates = current.parts.filter(part => p.pick ? (p.pick.surfaces ?? [p.pick.target]).includes(part.featureId) : !part.ghost).map(part => part.mesh);
      // Material removed by the section plane cannot be picked.
      return raycaster.intersectObjects(candidates).find(hit => !p.section || sectionPlane.distanceToPoint(hit.point) >= -1e-6);
    };
    const hitAxis = (hit: THREE.Intersection) => hit.face ? dominantAxis(hit.face.normal.clone().transformDirection(hit.object.matrixWorld)) : undefined;
    let down = { x: 0, y: 0 };
    const pointerdown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; pointerStart = { ...down }; pointerNow = { ...down }; usedHandle = !!transform.axis; };
    const pointermove = (event: PointerEvent) => {
      pointerNow = { x: event.clientX, y: event.clientY };
      if (event.buttons || gesture) return;
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => {
        const hit = raycast(event.clientX, event.clientY);
        const id = hit?.object.userData.featureId as string | undefined;
        const tooltip = tip.current;
        if (tooltip) {
          const p = stateRef.current;
          tooltip.hidden = !id;
          if (id) {
            const rect = element.getBoundingClientRect();
            tooltip.style.transform = `translate(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 16}px)`;
            const axis = hit && p.pick ? hitAxis(hit) : undefined;
            tooltip.textContent = p.edgePick ? 'Pick the edge nearest the cursor' : p.measure ? (measurePoints.length === 1 ? 'Second point' : 'First point') : p.pick ? `Place hole${axis ? ` · drill along ${axis}` : ' · slanted face, keeps current axis'}` : p.name(id);
          }
        }
        renderer.domElement.style.cursor = stateRef.current.navigationTool === 'pan' ? 'grab' : stateRef.current.navigationTool === 'zoom' ? 'zoom-in' : stateRef.current.pick || stateRef.current.measure || stateRef.current.edgePick ? (id ? 'crosshair' : 'not-allowed') : id ? 'pointer' : '';
        const p=stateRef.current,data=hit?.object.userData.display as import('../shared/protocol').DisplayMesh|undefined;
        let hoveredFace:import('../shared/protocol').SurfacePick|undefined;
        if(hit&&data&&hit.faceIndex!=null&&p.storageVersion&&p.evaluation.displayKey&&(event.altKey||p.selected.includes(data.featureId))){for(let i=0;i<(data.faceRanges?.length??0);i+=4)if(hit.faceIndex>=data.faceRanges![i]&&hit.faceIndex<data.faceRanges![i]+data.faceRanges![i+1]){hoveredFace={documentId:p.documentId,revision:p.revision,storageVersion:p.storageVersion,displayKey:p.evaluation.displayKey,feature:data.featureId,path:data.occurrencePath?.slice(1)??[],faceIndex:data.faceRanges![i+2],point:hit.point.toArray() as Vector3,normal:[0,0,1]};break;}}
        setFaceHover(previous=>previous?.feature===hoveredFace?.feature&&previous?.faceIndex===hoveredFace?.faceIndex&&JSON.stringify(previous?.path)===JSON.stringify(hoveredFace?.path)?previous:hoveredFace);
        if (id !== hovered) { hovered = id; paint(); }
      });
    };
    const pointerleave = () => { setFaceHover(undefined); cancelAnimationFrame(hoverFrame); if (tip.current) tip.current.hidden = true; if (hovered) { hovered = undefined; paint(); } };
    const pointerup = (event: PointerEvent) => {
      if (stateRef.current.compare || (stateRef.current.navigationTool && stateRef.current.navigationTool !== 'select')) return;
      if (event.button !== 0 || usedHandle || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      const hit = raycast(event.clientX, event.clientY);
      const p = stateRef.current;
      if (normalMode.current) {
        if (hit && normalToSurface(camera, controls.target, hit)) { normalMode.current = false; setNormalPicking(false); controls.update(); render(); }
        return;
      }
      if (p.edgePick) {
        const point = nearestEdgePoint(event.clientX, event.clientY, p.edgePick.target);
        if (point) p.onPick?.(point.toArray().map(v => Math.round(v * 1000) / 1000) as Vector3, undefined);
        return;
      }
      if (p.measure) {
        if (hit) { measurePoints = measurePoints.length === 1 ? [measurePoints[0], snapToVertex(hit)] : [snapToVertex(hit)]; drawMeasure(); }
        return;
      }
      if (p.pick) {
        if (hit) {
          const precision = p.snap ? 1 : 10;
          p.onPick?.(hit.point.toArray().map(v => Math.round(v * precision) / precision) as Vector3, hitAxis(hit));
        }
        return;
      }
      if(p.preview)return;
      const data = hit?.object.userData.display as import('../shared/protocol').DisplayMesh | undefined;
      if (hit && data && hit.faceIndex !== undefined && hit.faceIndex !== null && p.evaluation.displayKey && p.storageVersion && (event.altKey || p.selected.length === 1 && p.selected[0] === data.featureId)) {
        const ranges=data.faceRanges??[];
        for(let i=0;i<ranges.length;i+=4)if(hit.faceIndex>=ranges[i]&&hit.faceIndex<ranges[i]+ranges[i+1]){
          const normal=hit.face?.normal.clone().transformDirection(hit.object.matrixWorld)??new THREE.Vector3();
          p.onSelect(data.featureId,false);
          selectSurface({documentId:p.documentId,revision:p.revision,storageVersion:p.storageVersion,displayKey:p.evaluation.displayKey,feature:data.featureId,path:data.occurrencePath?.slice(1)??[],faceIndex:ranges[i+2],point:hit.point.toArray() as Vector3,normal:normal.toArray() as Vector3},{feature:data.featureId,path:data.occurrencePath?.slice(1)??[],select:{faces:data.topology?.faces[ranges[i+2]]?.lineage??[],fragments:'one'},signature:data.topology?.faces[ranges[i+2]]?{surface:data.topology.faces[ranges[i+2]].surface,areaMm2:data.topology.faces[ranges[i+2]].areaMm2,shapeSamples:data.topology.faces[ranges[i+2]].shapeSamples,normal:data.topology.faces[ranges[i+2]].normal}:undefined});
          return;
        }
      }
      selectSurface();
      p.onSelect(hit?.object.userData.featureId as string | undefined, event.shiftKey || event.metaKey || event.ctrlKey);
    };
    const contextmenu = (event: MouseEvent) => {
      event.preventDefault();
      const p = stateRef.current;
      if (p.pick || p.measure || p.edgePick || !p.onContextMenu || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      p.onContextMenu(raycast(event.clientX, event.clientY)?.object.userData.featureId as string | undefined, event.clientX, event.clientY);
    };
    const wheel = (event: WheelEvent) => {
      if (!controls.enabled) return;
      const intent = studioWheelIntent(stateRef.current.navigation ?? 'mouse', event, element.clientHeight);
      if (intent.kind === 'native') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (intent.kind === 'pan') controls.pan(intent.x, intent.y);
      else {
        const angle = 2 * Math.PI / Math.max(element.clientHeight, 1);
        controls.rotateLeft(intent.x * angle); controls.rotateUp(intent.y * angle);
      }
    };
    const focus = (event: MouseEvent) => {
      if (gesture || stateRef.current.pick || stateRef.current.measure || stateRef.current.edgePick) return;
      const hit = raycast(event.clientX, event.clientY); if (!hit) return;
      const offset = hit.point.clone().sub(controls.target);
      camera.position.add(offset); controls.target.copy(hit.point); controls.update(); render();
    };
    const cancelNormal = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !normalMode.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); normalMode.current = false; setNormalPicking(false);
    };
    window.addEventListener('keydown', cancelNormal, true);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { normalMode.current = false; setNormalPicking(false); cancel(); if (measurePoints.length) clearMeasure(); } };
    const pointercancel = () => { cancel(); rebuild(); };
    const stopOrbit = () => { stateRef.current.onStopOrbit?.(); stateRef.current.onInteraction?.(); };
    const lost = (event: Event) => { stopOrbit(); event.preventDefault(); cancel(); setError('The browser lost its WebGL context. Reload to restore the viewport. The exact document is saved separately.'); };
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', stopOrbit, true); canvas.addEventListener('wheel', stopOrbit, true);
    canvas.addEventListener('wheel', wheel, { capture: true, passive: false }); canvas.addEventListener('dblclick', focus);
    canvas.addEventListener('pointermove', pointermove, true); canvas.addEventListener('pointerdown', pointerdown, true); canvas.addEventListener('pointerup', pointerup);
    canvas.addEventListener('pointerleave', pointerleave); canvas.addEventListener('contextmenu', contextmenu);
    canvas.addEventListener('pointercancel', pointercancel); window.addEventListener('keydown', keydown);
    canvas.addEventListener('webglcontextlost', lost);
    rebuild(); fit(); hadModel = stateRef.current.evaluation.visibleFeatureIds.length > 0;
    return () => {
      window.removeEventListener('keydown', cancelNormal, true);
      cancelAnimationFrame(hoverFrame); frames.cancel();
      canvas.removeEventListener('pointerdown', stopOrbit, true); canvas.removeEventListener('wheel', stopOrbit, true);
      canvas.removeEventListener('wheel', wheel, true); canvas.removeEventListener('dblclick', focus);
      resize.disconnect(); transform.detach(); transform.dispose(); controls.dispose();
      canvas.removeEventListener('pointermove', pointermove, true); canvas.removeEventListener('pointerdown', pointerdown, true); canvas.removeEventListener('pointerup', pointerup);
      canvas.removeEventListener('pointerleave', pointerleave); canvas.removeEventListener('contextmenu', contextmenu);
      canvas.removeEventListener('pointercancel', pointercancel); window.removeEventListener('keydown', keydown); canvas.removeEventListener('webglcontextlost', lost);
      const retained = new Set<THREE.BufferGeometry>();
      engine.current!.scene.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) retained.add(o.geometry); });
      for (const previous of retired) disposeScene(previous, retained);
      disposeScene(engine.current!.scene); disposeScene(overlay); environment?.dispose(); engine.current = null; renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
      if (props.api) props.api.current = null;
      if (comparison) { disposeScene(comparison); comparison = undefined; }
    };
  }, []);
  useEffect(() => {
    if (!props.orbiting || !engine.current || error) return;
    const current = engine.current;
    prepareOrbit(current.camera, current.controls.target);
    const stop = orbitLoop(seconds => {
      advanceOrbit(current.camera, current.controls.target, seconds);
      current.controls.update();
    });
    return stop;
  }, [props.orbiting, error]);
  const sectionKey = props.section ? `${props.section.axis}:${props.section.flip}` : 'off';
  const flaggedKey = props.flagged?.join(',') ?? '';
  const appearanceKey = JSON.stringify(props.appearances ? [...props.appearances] : []);
  // Only model/material/visibility and section topology rebuild the scene. Editing feedback reuses it.
  const ghostKey = ghosts.join(',');
  const selectedKey = selected.join(',');
  useEffect(() => { engine.current?.rebuild(); }, [evaluation, ghostKey, documentId, revision, sectionKey, appearanceKey, props.flagged !== undefined, props.dark, JSON.stringify(props.studioLooks)]);
  useEffect(() => { engine.current?.repaint(); engine.current?.annotate(); }, [selected]);
  useEffect(() => { engine.current?.repaint(); }, [props.edges, flaggedKey, props.edgePick?.target,appearanceEditing]);
  useEffect(() => {
    const current = engine.current; if (!current) return;
    current.controls.mouseButtons.LEFT = props.navigationTool === 'pan' ? THREE.MOUSE.PAN : props.navigationTool === 'zoom' ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
    current.renderer.domElement.style.cursor = props.navigationTool === 'pan' ? 'grab' : props.navigationTool === 'zoom' ? 'zoom-in' : '';
  }, [props.navigationTool]);
  useEffect(() => { engine.current?.repaint(); }, [props.contribution]);
  useEffect(() => { engine.current?.compare(); }, [props.compare, props.dark]);
  useEffect(() => { engine.current?.render(); }, [props.comparePosition]);
  useEffect(() => { engine.current?.renderer.domElement.setAttribute('aria-label', `Model viewport. ${studioNavigationHelp(props.navigation ?? 'mouse')}`); }, [props.navigation]);
  useEffect(() => { engine.current?.updateGizmo(); }, [gizmoMode, selectedKey]);
  useEffect(() => { engine.current?.updateSnap(); }, [snap]);
  useEffect(() => { engine.current?.updateSection(); }, [props.section, evaluation]);
  useEffect(() => { if (!props.measure) engine.current?.clearMeasure(); }, [props.measure]);
  useEffect(() => { engine.current?.clearMeasure(); }, [evaluation, documentId]);
  useEffect(() => { engine.current?.annotate(); }, [pick, props.edgePick]);
  useEffect(() => { engine.current?.fit(); }, [view, fitKey]);
  // Refit only when a model first appears, so edits and agent changes keep the human's camera.
  useEffect(() => { engine.current?.firstModel(); }, [evaluation]);
  useEffect(() => { if (pendingCamera.current && evaluation.visibleFeatureIds.length) { engine.current?.restore(pendingCamera.current); pendingCamera.current = undefined; } }, [evaluation]);
  const selectedVisible = selected.length === 1 && evaluation.visibleFeatureIds.includes(selected[0]);
  useEffect(()=>{
    const current=engine.current;if(!current||props.preview)return;
    const overlays:THREE.Mesh[]=[];
    for(const [selection,hover] of [[faceSelection,false],[faceHover,true]] as const){
      if(!selection||selection.documentId!==props.documentId||selection.displayKey!==evaluation.displayKey)continue;
      for(const part of current.parts){const data=part.mesh.userData.display as import('../shared/protocol').DisplayMesh|undefined;
        if(!data||data.featureId!==selection.feature||JSON.stringify(data.occurrencePath?.slice(1)??[])!==JSON.stringify(selection.path))continue;
        const positions:number[]=[];for(let i=0;i<(data.faceRanges?.length??0);i+=4)if(data.faceRanges![i+2]===selection.faceIndex)for(let t=data.faceRanges![i]*3;t<(data.faceRanges![i]+data.faceRanges![i+1])*3;t++){const index=data.triangles[t]*3;positions.push(...data.vertices.slice(index,index+3));}
        if(!positions.length)continue;
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
        const material=new THREE.MeshBasicMaterial({color:hover?0x77bbee:0x458df0,transparent:true,opacity:hover?0.18:0.42,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,side:THREE.DoubleSide});
        const overlay=new THREE.Mesh(geometry,material);overlay.raycast=()=>{};overlay.matrix.copy(part.mesh.matrix);overlay.matrixAutoUpdate=false;overlay.renderOrder=5;current.scene.add(overlay);overlays.push(overlay);
      }
    }
    current.render();return()=>{for(const overlay of overlays){current.scene.remove(overlay);overlay.geometry.dispose();(overlay.material as THREE.Material).dispose();}current.render();};
  },[faceSelection,faceHover,evaluation,props.documentId,props.preview]);
  useEffect(()=>{
    const current=engine.current;if(!current||!props.preview)return;
    const group=new THREE.Group();
    const line=(positions:number[],color:number)=>{if(!positions.length)return;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));const lines=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,depthTest:false,transparent:true,opacity:0.9}));lines.renderOrder=8;group.add(lines);};
    for(const info of evaluation.geometry){
      const d=info.diagnostics as {sections?:{outline?:number[];vertices?:number[][]}[];selectedEdges?:{previewLines:number[]}[];adjacentFaces?:{patches:{vertices:number[];triangles:number[]}[]}}|undefined;
      d?.sections?.forEach((section,i)=>{if(section.outline)line(section.outline,0x55bdd5);if(section.vertices&&i){const previous=d.sections![i-1].vertices;if(previous)line(section.vertices.flatMap((p,j)=>previous[j]?[...previous[j],...p]:[]),0xff8800);}
        if(section.vertices?.[0]){const dot=new THREE.Mesh(new THREE.SphereGeometry(Math.max(...info.bounds.size)*0.012,8,8),new THREE.MeshBasicMaterial({color:0xff8800,depthTest:false}));dot.position.fromArray(section.vertices[0]);dot.renderOrder=9;group.add(dot);}
      });
      d?.selectedEdges?.forEach(e=>line(e.previewLines,0xff8800));
      d?.adjacentFaces?.patches.forEach(patch=>{const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(patch.vertices,3));geometry.setIndex(patch.triangles);const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x42b5cf,transparent:true,opacity:0.2,depthWrite:false,depthTest:false,side:THREE.DoubleSide}));mesh.renderOrder=7;group.add(mesh);});
    }
    current.scene.add(group);current.render();return()=>{current.scene.remove(group);group.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){object.geometry.dispose();(object.material as THREE.Material).dispose();}});current.render();};
  },[evaluation,props.preview]);
  return <div className="viewport" ref={host}>
    {normalPicking && <button type="button" className="normal-view-prompt" onClick={() => { normalMode.current = false; setNormalPicking(false); }} role="status">Normal To: click a surface · Esc to cancel</button>}
    <svg ref={triad} className="axis-triad" viewBox="0 0 60 60" aria-hidden="true">
      <circle cx="30" cy="30" r="2.2" />
      {AXES.map(axis => <g key={axis} data-axis={axis} className={`axis-${axis.toLowerCase()}`}><line x1="30" y1="30" x2="30" y2="30" /><text textAnchor="middle">{axis}</text></g>)}
    </svg>
    <div ref={dims} className="dimension-callouts" hidden aria-hidden="true">
      {AXES.map(axis => <span key={axis} className={`callout callout-${axis.toLowerCase()}`}><b>{axis}</b><span /></span>)}
    </div>
    <div ref={tip} className="hover-tip" hidden aria-hidden="true" />
    <div ref={measureLabel} className="measure-label" hidden role="status" aria-live="polite"><b /><span /></div>
    {error && <p className="viewport-error" role="alert">{error}</p>}
    {gizmoMode && <div className="gizmo-hint" role="status">{selectedVisible ? `${dragging ? 'Previewing · release to apply' : `Drag the ${gizmoMode === 'scale' ? 'center handle to scale' : gizmoMode === 'rotate' ? 'rings to rotate' : 'arrows to move'}`}${snap ? ' · snap on' : ''} · Esc cancels` : 'Handles need a visible result. Use the numeric fields for construction features.'}</div>}
  </div>;
}
