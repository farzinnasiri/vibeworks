import { loadStudioEnvironment, loadFloorTextures, applyFloorTextures, prepareSweepTextures } from './studio-scene';
import {worldMesh} from '../shared/display';
import { addSurfaceGraphics } from './surface-graphics';
import { analysisStatus, floatingDescription, floatingAdvice } from '../cad/health';
import * as THREE from 'three';
import { profilePreview } from './profile-preview';
import type { ContactSheetRenderer } from '../cad/runtime';
import { CadError } from '../cad/document';
import type { RenderedTile, Shot, ViewName } from '../shared/protocol';
import { scaleBarLength, shotCamera } from './shots';
import { addInterferenceVolumes, WORKBENCH, configureRenderer, createModelScene, disposeScene, PART_COLORS, stageStudio } from './scene';
import { effectiveAppearance } from '../cad/document';

const SUPERSAMPLED_PIXELS = 2_400_000;
const DEFAULT_VIEWS: ViewName[] = ['front', 'back', 'left', 'right', 'top', 'isometric'];

/** Four views use 2 x 2; incomplete final rows fill the width with the requested views. */
export function contactSheetLayout(count: number, tileSize: number) {
  const columns = count === 4 ? 2 : Math.min(3, count);
  const rows = Math.ceil(count / columns), width = columns * tileSize;
  return { width, height: rows * tileSize, tiles: Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns), rowCount = Math.min(columns, count - row * columns);
    const x = Math.round(index % columns * width / rowCount);
    return { x, y: row * tileSize, width: Math.round((index % columns + 1) * width / rowCount) - x, height: tileSize };
  }) };
}

export const renderContactSheet: ContactSheetRenderer = async (evaluation, command, document, health, _budget, comparisonBounds) => {
  const ids = command.params.featureId ? [command.params.featureId] : evaluation.visibleFeatureIds;
  if (!ids.length) throw new CadError('EMPTY_MODEL', 'Create a solid before rendering views.');
  const shots: Shot[] = command.params.shots ?? (command.params.views ?? DEFAULT_VIEWS).map(view => ({ view }));
  for (const [index, shot] of shots.entries()) {
    const named = [...(shot.frame && 'featureIds' in shot.frame ? shot.frame.featureIds : []), ...(shot.hide ?? []), ...(shot.ghost ?? [])];
    const unknown = named.filter(id => !ids.includes(id));
    if (unknown.length) throw new CadError('INVALID_SHOT', `Shot ${index + 1} names ${unknown.slice(0, 5).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not shown in this render. Shown results: ${ids.slice(0, 24).join(', ')}${ids.length > 24 ? ', …' : ''}.`, { shot: index, unknown, shown: ids.slice(0, 64) });
  }
  const tileSize = command.params.tileSize ?? 384;
  const layout = contactSheetLayout(shots.length, tileSize);
  const labelHeight = 30;
  const width = layout.width;
  const global = command.params.section;
  const titleLines = wrapLabel(`Vibeworks · ${document.name ?? document.documentId.slice(0, 8)} · revision ${document.revision} · mm · Z up${global ? ` · section ${global.axis} ${global.flip ? '≥' : '≤'} ${global.offset}` : ''}`, width - 28, 'bold 15px Arial');
  const sourceLines = evaluation.references?.length ? wrapLabel(`Sources: ${evaluation.references.map(ref => `${ref.documentId.slice(0, 8)} r${ref.revision}`).join(' · ')}`, width - 28) : [];
  const titleHeight = titleLines.length * 20 + sourceLines.length * 16;
  // With several solids, each gets a color and the legend names it, so overlapping parts stay distinguishable.
  const realistic = command.params.appearance === 'materials';
  const issues = command.params.appearance === 'issues';
  const floating = new Set(health.issues.floating);
  const colors = issues ? new Map(ids.map(id => [id, floating.has(id) ? WORKBENCH.flaggedBody : WORKBENCH.body])) : !realistic && ids.length > 1 ? new Map(ids.map((id, i) => [id, PART_COLORS[i % PART_COLORS.length]])) : undefined;
  const appearances = realistic ? new Map(ids.map(id => [id, effectiveAppearance(document, id)])) : undefined;
  const legend = colors ? layoutLegend(ids, width, titleHeight + 32) : { rows: [] as { id: string; x: number; y: number }[], height: 0 };
  const statusLines = wrapLabel(`${analysisStatus(health)}${issues ? ' · red = overlap (x-ray); pink = not connected through contact' : ''}`, width - 28);
  if (issues && evaluation.analysis && health.analysis !== 'unchecked') {
    for (const f of evaluation.analysis.floating.filter(f => !f.intendedBy?.length && ids.includes(f.featureId)).slice(0, 8)) {
      statusLines.push(...wrapLabel(`${f.featureId} ${floatingDescription(f, evaluation.analysis)}`, width - 28));
    }
    if (evaluation.analysis.floating.some(f => !f.intendedBy?.length && ids.includes(f.featureId))) {
      statusLines.push(...wrapLabel(floatingAdvice(evaluation.analysis), width - 28));
    }
  }
  const header = titleHeight + 38 + legend.height + statusLines.length * 16;
  const canvas = documentCanvas(width, layout.height + header);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CadError('RENDER_FAILED', 'The browser could not create a 2D canvas.');
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: realistic, preserveDrawingBuffer: true }); }
  catch (error) { throw new CadError('WEBGL_UNAVAILABLE', 'WebGL is unavailable for the contact sheet.', String(error)); }
  const scene = createModelScene(evaluation, [], ids, colors, appearances);
  for(const requested of command.params.review?.profiles??[]){
    const info=evaluation.geometry.find(g=>g.featureId===requested.featureId),sections=info?.diagnostics?.sections as {outline?:number[];vertices?:number[][]}[]|undefined;
    const line=(positions:number[],color:number)=>{if(!positions.length)return;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));const object=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,depthTest:false}));object.userData={featureId:requested.featureId,shaping:true};object.renderOrder=8;scene.add(object);};
    sections?.forEach((section,i)=>{if(section.outline)line(section.outline,0x168da6);if(i&&section.vertices&&sections[i-1].vertices)line(section.vertices.flatMap((p,j)=>sections[i-1].vertices![j]?[...sections[i-1].vertices![j],...p]:[]),0xee740e);
      if(section.vertices?.[0]){const object=new THREE.Mesh(new THREE.SphereGeometry(Math.max(...info!.bounds.size)*0.012,8,8),new THREE.MeshBasicMaterial({color:0xee740e,depthTest:false}));object.position.fromArray(section.vertices[0]);object.userData={featureId:requested.featureId,shaping:true};object.renderOrder=9;scene.add(object);}
    });
  }
  try { if (realistic) await addSurfaceGraphics(scene, evaluation.meshes.filter(mesh => ids.includes(mesh.featureId))); }
  catch (error) { disposeScene(scene); renderer.dispose(); renderer.forceContextLoss(); throw error; }
  const parts = [...scene.children].filter((object): object is THREE.Mesh | THREE.LineSegments => object instanceof THREE.Mesh || object instanceof THREE.LineSegments);
  // Display-only clipping, as in the interactive section view: back faces through the cut render as a flat cap.
  const caps = shots.some(shot => shot.section ?? global) ? parts.filter((object): object is THREE.Mesh => object instanceof THREE.Mesh && !object.userData.graphicId).map(object => {
    const cap = new THREE.Mesh(object.geometry, new THREE.MeshBasicMaterial({ color: 0xe8743f, side: THREE.BackSide }));
    cap.applyMatrix4(object.matrix); cap.userData.featureId = object.userData.featureId; scene.add(cap); return cap;
  }) : [];
  const ghostBody = new THREE.MeshStandardMaterial({ color: WORKBENCH.ghostBody, roughness: 0.52, metalness: 0.22, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  const ghostEdge = new THREE.LineBasicMaterial({ color: WORKBENCH.ghostEdge, transparent: true, opacity: 0.6, depthWrite: false });
  const original = new Map(parts.map(object => [object, object.material as THREE.Material]));
  if (issues) addInterferenceVolumes(scene, evaluation, ids);
  try {
    configureRenderer(renderer);
    // Material renders are presentation images: supersample for clean edges, up to 2x per axis, within a fixed
    // pixel budget so large sheets stay inside the render deadline in software WebGL.
    const sheetPixels = layout.tiles.reduce((sum, tile) => sum + tile.width * (tile.height - labelHeight), 0);
    renderer.setPixelRatio(realistic ? Math.max(1, Math.min(2, Math.sqrt(SUPERSAMPLED_PIXELS / sheetPixels))) : 1);
    // Frame the real silhouette: display-mesh vertices, thinned for very large meshes.
    const meshes = evaluation.meshes.filter(m => ids.includes(m.featureId));
    const total = meshes.reduce((n, m) => n + m.vertices.length, 0);
    const stride = Math.max(1, Math.ceil(total / 3 / 60_000)) * 3;
    const silhouettes = new Map<string, number[]>();
    for (const mesh of meshes) {
      const v = worldMesh(mesh).vertices, points = silhouettes.get(mesh.featureId) ?? [];
      for (let i = 0; i + 2 < v.length; i += stride) points.push(v[i], v[i + 1], v[i + 2]);
      silhouettes.set(mesh.featureId, points);
    }
    ctx.fillStyle = '#eef1f2'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#20313b'; ctx.font = 'bold 15px Arial'; ctx.textBaseline = 'middle';
    titleLines.forEach((line, i) => ctx.fillText(line, 14, 24 + i * 20));
    ctx.font = '11px Arial';
    sourceLines.forEach((line, i) => ctx.fillText(line, 14, 24 + titleLines.length * 20 + i * 16));
    ctx.fillStyle = health.ok ? '#20313b' : '#b42318';
    statusLines.forEach((line, i) => ctx.fillText(line, 14, titleHeight + 34 + legend.height + i * 16));
    for (const entry of legend.rows) {
      ctx.fillStyle = `#${colors!.get(entry.id)!.toString(16).padStart(6, '0')}`; ctx.fillRect(entry.x, entry.y - 5, 10, 10);
      ctx.fillStyle = '#20313b'; ctx.fillText(entry.id, entry.x + 14, entry.y);
    }
    if (realistic) {
      const all = new THREE.Box3();
      for (const points of silhouettes.values()) for (let i = 0; i + 2 < points.length; i += 3) all.expandByPoint(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
      if(comparisonBounds)all.set(new THREE.Vector3(...comparisonBounds.min),new THREE.Vector3(...comparisonBounds.max));
      const presentation = { ...document.presentation, ...command.params.presentation };
      const [environment, floorTextures] = await Promise.all([loadStudioEnvironment(presentation.environmentPreset), loadFloorTextures(presentation.floor)]);
      stageStudio(scene, renderer, all, presentation, environment);
      applyFloorTextures(scene, prepareSweepTextures(floorTextures, presentation, Math.max(all.getBoundingSphere(new THREE.Sphere()).radius, 1)), presentation);
      renderer.setClearColor(0x000000, 0);
    }
    const tiles: RenderedTile[] = [];
    for (const [index, shot] of shots.entries()) {
      const tile = layout.tiles[index], x = tile.x, y = tile.y + header, pixelHeight = tile.height - labelHeight;
      const hidden = new Set(shot.hide), ghosts = new Set(shot.ghost);
      const shown = ids.filter(id => !hidden.has(id));
      const framed = shot.frame && 'featureIds' in shot.frame ? shot.frame.featureIds : shown;
      const box = shot.frame && 'min' in shot.frame ? shot.frame : undefined;
      const framePoints = box ? [0, 1].flatMap(a => [0, 1].flatMap(b => [0, 1].flatMap(c => [a ? box.max[0] : box.min[0], b ? box.max[1] : box.min[1], c ? box.max[2] : box.min[2]])))
        : framed.flatMap(id => silhouettes.get(id) ?? []);
      const sceneBox = new THREE.Box3();
      for (const id of shown) { const p = silhouettes.get(id) ?? []; for (let i = 0; i + 2 < p.length; i += 3) sceneBox.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2])); }
      if(comparisonBounds)sceneBox.set(new THREE.Vector3(...comparisonBounds.min),new THREE.Vector3(...comparisonBounds.max));
      const section = shot.section ?? global;
      // A shot without a direction faces its own or the sheet's cut.
      const { camera, tile: rendered } = shotCamera(section && !shot.section && !shot.view && !shot.from && command.params.shots ? { ...shot, section } : shot, index, framePoints, sceneBox, tile.width / pixelHeight, pixelHeight);
      let plane: THREE.Plane | undefined;
      if (section) {
        const normal = new THREE.Vector3(); normal.setComponent(['X', 'Y', 'Z'].indexOf(section.axis), section.flip ? 1 : -1);
        plane = new THREE.Plane(normal, section.flip ? -section.offset : section.offset);
      }
      for (const object of parts) {
        const id = object.userData.featureId as string;
        // CAD outlines help reading parts and issues; a material render shows surfaces only.
        object.visible = !hidden.has(id) && !(realistic && object instanceof THREE.LineSegments && !object.userData.shaping) && !(object.userData.graphicId && ghosts.has(id));
        object.material = ghosts.has(id) ? (object instanceof THREE.Mesh ? ghostBody : ghostEdge) : original.get(object)!;
      }
      for (const cap of caps) cap.visible = !!plane && !hidden.has(cap.userData.featureId) && !ghosts.has(cap.userData.featureId);
      renderer.clippingPlanes = plane ? [plane] : [];
      if (!visibleIn(camera, parts.filter(object => object.visible && object instanceof THREE.Mesh), plane))
        throw new CadError('EMPTY_SHOT', `Shot ${index + 1} (${rendered.label}) shows no geometry: nothing shown lies inside its frame${plane ? ' on the kept side of its section' : ''}. Frame a feature id, or check frame center/bounds against inspect_model bounds.`, { shot: index, tile: rendered });
      renderer.setSize(tile.width, pixelHeight, false);
      renderer.render(scene, camera);
      if (realistic && ({ ...document.presentation, ...command.params.presentation }).backgroundMode !== 'transparent') {
        // A soft studio backdrop behind the transparent render.
        const backdrop = ctx.createLinearGradient(0, y + labelHeight, 0, y + tile.height);
        backdrop.addColorStop(0, '#f7f8f9'); backdrop.addColorStop(1, '#d9dee2');
        ctx.fillStyle = backdrop; ctx.fillRect(x, y + labelHeight, tile.width, pixelHeight);
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(renderer.domElement, x, y + labelHeight, tile.width, pixelHeight);
      ctx.fillStyle = '#20313b'; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, rendered.label.toUpperCase(), tile.width - 110), x + 12, y + labelHeight / 2);
      ctx.font = '11px Arial'; ctx.textAlign = 'right';
      ctx.fillText(`${rendered.projection === 'perspective' ? '≈' : ''}${formatScale(rendered.mmPerPixel)} mm/px`, x + tile.width - 10, y + labelHeight / 2);
      ctx.textAlign = 'left';
      if (rendered.projection === 'orthographic') drawScaleBar(ctx, x + 12, y + tile.height - 14, rendered.mmPerPixel, tile.width);
      ctx.strokeStyle = '#c9d2d7'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, tile.width - 1, tile.height - 1);
      tiles.push(rendered);
    }
    const dataUrl = canvas.toDataURL('image/png');
    const panels:import('../shared/protocol').RenderedPNG[]=[];
    if(command.params.outputs==='both')for(const [index,tile]of layout.tiles.entries()){
      const single=documentCanvas(tile.width,header+tile.height),paint=single.getContext('2d')!;
      paint.drawImage(canvas,0,0,Math.min(canvas.width,tile.width),header,0,0,tile.width,header);
      paint.drawImage(canvas,tile.x,tile.y+header,tile.width,tile.height,0,header,tile.width,tile.height);
      panels.push({kind:'view',label:tiles[index].label,mimeType:'image/png',width:single.width,height:single.height,base64:single.toDataURL('image/png').split(',')[1]});
    }
    for(const profile of command.params.review?.profiles??[])panels.push(profilePreview(document,profile.featureId,profile.sectionIndex,tileSize,evaluation.geometry.find(g=>g.featureId===profile.featureId)?.diagnostics));
    if(panels.length&&dataUrl.length+panels.reduce((n,p)=>n+p.base64.length,0)>16*1024*1024)
      throw new CadError('REVIEW_TOO_LARGE','Inspection images exceed the 16 MiB encoded bundle budget. Reduce tileSize or the number of shots/profiles.');
    return { mimeType: 'image/png', base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: canvas.width, height: canvas.height, tiles,...(panels.length?{panels}:{}) };
  } finally {
    for (const [object, material] of original) object.material = material;
    ghostBody.dispose(); ghostEdge.dispose();
    disposeScene(scene); renderer.dispose(); renderer.forceContextLoss();
  }
};

/** Conservative: a part counts when its bounds meet the view volume and reach the kept side of the section. */
function visibleIn(camera: THREE.Camera, meshes: THREE.Object3D[], plane?: THREE.Plane): boolean {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  return meshes.some(object => {
    const box = new THREE.Box3().setFromObject(object);
    if (!frustum.intersectsBox(box)) return false;
    if (!plane) return true;
    return [0, 1].some(a => [0, 1].some(b => [0, 1].some(c => plane.distanceToPoint(new THREE.Vector3(a ? box.max.x : box.min.x, b ? box.max.y : box.min.y, c ? box.max.z : box.min.z)) >= 0)));
  });
}

const formatScale = (mmPerPixel: number) => mmPerPixel >= 10 ? mmPerPixel.toFixed(0) : mmPerPixel >= 1 ? mmPerPixel.toFixed(1) : mmPerPixel.toPrecision(2);

/** A round-length bar about a fifth of the tile wide, so distances can be read off the image. */
function drawScaleBar(ctx: CanvasRenderingContext2D, x: number, y: number, mmPerPixel: number, tileWidth: number) {
  const length = scaleBarLength(mmPerPixel * tileWidth * 0.2), pixels = length / mmPerPixel;
  // A light halo keeps the bar readable over dark parts without hiding them.
  for (const [color, width] of [['rgba(255, 255, 255, 0.8)', 4], ['#20313b', 2]] as const) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + pixels, y); ctx.lineTo(x + pixels, y - 5); ctx.stroke();
  }
  ctx.font = '11px Arial'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.strokeText(`${length} mm`, x + pixels + 6, y - 3);
  ctx.fillStyle = '#20313b'; ctx.fillText(`${length} mm`, x + pixels + 6, y - 3);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Wrap legend entries (swatch + feature id) into rows that fit the sheet width. */
function layoutLegend(ids: string[], width: number, top: number) {
  const measure = documentCanvas(1, 1).getContext('2d')!; measure.font = '11px Arial';
  const rows: { id: string; x: number; y: number }[] = [];
  let x = 14, y = top;
  for (const id of ids) {
    const w = 14 + measure.measureText(id).width + 14;
    if (x + w > width - 8 && x > 14) { x = 14; y += 16; }
    rows.push({ id, x, y }); x += w;
  }
  return { rows, height: ids.length ? y - top + 22 : 0 };
}

function documentCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}

/** Keep the analysis label readable even in a single 128 px tile. */
function wrapLabel(text: string, width: number, font = '11px Arial'): string[] {
  const ctx = documentCanvas(1, 1).getContext('2d')!; ctx.font = font;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
