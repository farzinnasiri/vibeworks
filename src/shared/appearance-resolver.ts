import type { Appearance, Presentation } from './protocol';
import { finishLook, materialById, NEUTRAL_COLOR } from './materials';

export interface AppearanceLayer { value?: Appearance; from: { documentId: string; featureId: string; path?: string[]; layer: string; styleId?: string } }
/** Legacy arrays retain replacement semantics. Keyed edits materialize the intended merged array first. */
export function resolveAppearance(layers: AppearanceLayer[]) {
  const effective: Appearance = {}, fields: Record<string, { value: unknown; from: AppearanceLayer['from'] }> = {};
  for (const layer of layers) for (const [key, value] of Object.entries(layer.value ?? {})) if (value !== undefined) {
    Object.assign(effective, { [key]: value }); fields[key] = { value, from: layer.from };
  }
  const look=resolveLook(effective),material=effective.visualMaterial??effective.material??'unassigned';
  for(const [key,value]of Object.entries({color:look.color,roughness:look.roughness,detail:look.detail,detailScale:look.detailScale,coat:look.clearcoat?'clear':'none'}))if(!fields[key])fields[key]={value,from:{documentId:'materials',featureId:material,layer:'material-default'}};
  return { effective, fields };
}
export function resolveLook(appearance: Appearance | undefined, presentation?: Presentation, mode: 'authored' | 'studio' = 'authored') {
  const material = materialById(appearance?.visualMaterial ?? appearance?.material);
  const studio = mode === 'studio' ? presentation?.materials?.[appearance?.material ?? 'unassigned']??(presentation?.carbonFinish==='coated'&&appearance?.material==='carbon_fiber'?{coat:'clear' as const,detail:'carbon' as const}:undefined) : undefined;
  const finish = studio?.finish ?? appearance?.finish;
  const coat = studio?.coat ?? appearance?.coat;
  return {
    color: appearance?.color ?? material?.color ?? NEUTRAL_COLOR,
    metalness: material?.metalness ?? 0,
    roughness: studio?.finish ? finishLook(studio.finish).roughness! : appearance?.roughness ?? finishLook(finish).roughness ?? material?.roughness ?? 0.5,
    clearcoat: coat ? (coat === 'clear' ? 1 : 0) : material?.clearcoat ?? 0,
    transmission: material?.transmission ?? 0,
    detail: studio?.detail ?? appearance?.detail ?? material?.detail ?? 'plain',
    detailScale: studio?.detailScale ?? appearance?.detailScale ?? 1,
  };
}

export function resolveGraphicEdits(appearance:Appearance|undefined,edits:import('./protocol').Feature['graphicEdits']):Appearance|undefined{
 if(!edits)return appearance;
 const graphics=new Map((appearance?.graphics??[]).map(g=>[g.id,g]));
 for(const id of edits.remove)graphics.delete(id);for(const graphic of edits.upsert)graphics.set(graphic.id,graphic);
 const ordered=[...(edits.order??[]).filter(id=>graphics.has(id)),...[...graphics.keys()].filter(id=>!edits.order?.includes(id))];
 return{...appearance,graphics:ordered.map(id=>graphics.get(id)!)};
}
