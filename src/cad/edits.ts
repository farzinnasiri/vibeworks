import {checkRoot} from '../shared/protocol';
import { countLabel } from '../shared/format';
import { checkFeatures, featureSchema, type CadDocument, type Edit } from '../shared/protocol';
import { CadError, copyDocument, deletionIds, consumedReferences, validateDocument, effectiveAppearance } from './document';
import { parameterUsage, resolveBindings, valueAt } from './parameters';

export interface EditOutcome { document: CadDocument; created: string[]; updated: string[]; deleted: string[]; removedChecks?:string[]; warnings: string[] }

function withoutEmptyParameters(document: CadDocument): void {
  if (document.parameters && !document.parameters.length) delete document.parameters;
}

const consumes = consumedReferences;
function expandEdit(edit:Edit,document:CadDocument):Exclude<Edit,{op:'patch'}>{
 if(edit.op!=='patch')return edit;
 const previous=document.features.find(f=>f.id===edit.id);
 if(!previous)throw new CadError('FEATURE_NOT_FOUND',`Feature '${edit.id}' does not exist.`);
 const {op:_op,id:_id,params,appearance,...metadata}=edit;
 if (appearance && 'graphics' in appearance) throw new CadError('APPEARANCE_GRAPHICS_PATCH', 'Use appearance.graphics upsert/remove to edit graphics.');
 const merged = { ...previous.appearance } as Record<string, unknown>;
 for (const [key, value] of Object.entries(appearance ?? {})) { if (value === null) delete merged[key]; else if (value !== undefined) merged[key] = value; }
 return {op:'update',feature:featureSchema.parse({...previous,...metadata,...(appearance ? {appearance:merged} : {}),params:{...previous.params,...params}})};
}


/**
 * New features that build on a shape another feature already consumed fork the model into two results,
 * which is rarely intended (an earlier list row was selected instead of the latest result).
 */
function forkWarnings(document: CadDocument, created: string[]): string[] {
  const warnings: string[] = [];
  for (const id of created) {
    const feature = document.features.find(f => f.id === id);
    if (!feature) continue;
    for (const ref of consumes(feature)) {
      const other = document.features.find(f => f.id !== id && consumes(f).includes(ref));
      if (other) warnings.push(`'${id}' builds on '${ref}', which '${other.id}' already uses, so '${id}' and '${other.id}' become separate overlapping results. To continue the latest shape, target the visible result instead.`);
    }
  }
  return warnings;
}

/**
 * Apply edits in order to a copy of the document and validate the resulting graph.
 * Pure: no kernel, no revision change, no history. A failure names the edit that caused it.
 */
export function applyEdits(source: CadDocument, edits: Edit[], inherited?:Map<string,import('../shared/protocol').Appearance>): EditOutcome {
  const document = copyDocument(source);
  const created: string[] = [], updated: string[] = [], deleted: string[] = [],removedChecks:string[]=[];
  edits.forEach((original, index) => {
    try {
      const edit=expandEdit(original,document);
      if (edit.op === 'appearance') {
        const feature = document.features.find(f => f.id === edit.target.feature);
        if (!feature) throw new CadError('FEATURE_NOT_FOUND', `Feature '${edit.target.feature}' does not exist.`);
        if (edit.regions) {
          if (edit.set || edit.unset || edit.replace !== undefined || edit.graphics) throw new CadError('APPEARANCE_MODE_CONFLICT','Region operations cannot combine other appearance edits.');
          const regions = new Map((feature.paintRegions??[]).map(r=>[r.id,r]));
          for (const id of edit.regions.remove??[]) if (!regions.delete(id)) throw new CadError('REGION_NOT_FOUND',`Region '${id}' does not exist.`);
          for (const region of edit.regions.upsert??[]) {
            if (region.target.feature !== feature.id || !('faces' in region.target.select) || !region.target.signature) throw new CadError('REFERENCE_SIGNATURE_REQUIRED','Regions require named support faces and a captured signature on the edited feature.');
            regions.set(region.id,region);
          }
          if (regions.size>32) throw new CadError('REGION_LIMIT','At most 32 regions per feature.');
          feature.paintRegions=[...regions.values()];
          if (!updated.includes(feature.id)) updated.push(feature.id);
          return;
        }
        const faceTarget='faces'in edit.target.select;
        if (faceTarget) {
          if (edit.graphics || edit.set?.material || edit.replace?.material || edit.replace?.graphics || edit.unset?.includes('material')) throw new CadError('APPEARANCE_FIELD_NOT_ALLOWED','Face paint accepts visual fields only. Physical material belongs to the whole result.');
          if (!edit.target.signature) throw new CadError('REFERENCE_SIGNATURE_REQUIRED','Capture the face signature through inspect_model before painting.',{target:edit.target});
          if (edit.replace !== undefined && (edit.set || edit.unset || edit.graphics)) throw new CadError('APPEARANCE_MODE_CONFLICT','replace cannot combine set, unset or graphics.');
          const identity=(target:typeof edit.target)=>JSON.stringify([target.feature,target.path??[],'faces'in target.select?[...target.select.faces].sort():[], 'faces'in target.select?target.select.fragments:undefined]);
          const styles=feature.surfaceStyles??[];
          const at=styles.findIndex(s=>identity(s.target)===identity(edit.target));
          const look=edit.replace!==undefined?{...(edit.replace??{})}:{...(at>=0?styles[at].look:{}),...edit.set};
          for(const key of edit.unset??[])delete look[key as keyof typeof look];
          if (edit.replace===null) {if(at>=0)styles.splice(at,1);}
          else if(at<0)styles.push({target:edit.target,look});else styles[at]={target:edit.target,look};
          if(styles.length)feature.surfaceStyles=styles;else delete feature.surfaceStyles;
          if(!updated.includes(feature.id))updated.push(feature.id);
          return;
        }
        if(edit.target.path?.length)throw new CadError('REFERENCE_UNSUPPORTED','Whole-result nested occurrence overrides require a source result target.');
        if (edit.replace !== undefined && (edit.set || edit.unset || edit.graphics)) throw new CadError('APPEARANCE_MODE_CONFLICT', 'replace cannot combine set, unset or graphics.');
        const next = edit.replace !== undefined ? { ...(edit.replace ?? {}) } : { ...feature.appearance, ...edit.set };
        for (const key of edit.unset ?? []) delete next[key];
        if(edit.graphics&&feature.kind==='instance'){
          const available=new Map([...(inherited?.get(feature.id)?.graphics??[]),...(feature.appearance?.graphics??[])].map(g=>[g.id,g]));
          const upsert=new Map((feature.graphicEdits?.upsert??[]).map(g=>[g.id,g])),remove=new Set(feature.graphicEdits?.remove??[]);
          for(const id of edit.graphics.remove??[]){if(!available.has(id)&&!upsert.has(id))throw new CadError('GRAPHIC_NOT_FOUND',`Graphic '${id}' does not exist on this occurrence.`);upsert.delete(id);remove.add(id);}
          for(const g of edit.graphics.upsert??[]){upsert.set(g.id,g);remove.delete(g.id);}
          const order=edit.graphics.order??feature.graphicEdits?.order;
          if(order&&(new Set(order).size!==order.length||order.some(id=>!available.has(id)&&!upsert.has(id))))throw new CadError('GRAPHIC_ORDER','Graphic order must name available graphic IDs without duplicates.');
          if(Object.keys(next).length)feature.appearance=next;else delete feature.appearance;
          feature.graphicEdits={upsert:[...upsert.values()],remove:[...remove],...(order?{order}:{})};
          if(!updated.includes(feature.id))updated.push(feature.id);
          return;
        }
        if (edit.graphics) {
          const graphics = new Map((inherited?.get(feature.id)?.graphics ?? effectiveAppearance(document, feature.id)?.graphics ?? []).map(g => [g.id, g]));
          for (const id of edit.graphics.remove ?? []) { if (!graphics.delete(id)) throw new CadError('GRAPHIC_NOT_FOUND', `Graphic '${id}' does not exist.`); }
          for (const graphic of edit.graphics.upsert ?? []) graphics.set(graphic.id, graphic);
          const order = edit.graphics.order;
          if (order && (new Set(order).size !== order.length || order.length !== graphics.size || order.some(id => !graphics.has(id)))) throw new CadError('GRAPHIC_ORDER', 'order must name every resulting graphic exactly once.');
          next.graphics = (order ?? [...graphics.keys()]).map(id => graphics.get(id)!);
        }
        if (Object.keys(next).length) feature.appearance = next; else delete feature.appearance;
        if (!created.includes(feature.id) && !updated.includes(feature.id)) updated.push(feature.id);
      } else if (edit.op === 'add') {
        if (document.features.some(f => f.id === edit.feature.id)) throw new CadError('DUPLICATE_FEATURE', `Feature '${edit.feature.id}' already exists. Use an update edit or a new id.`);
        const at=edit.before?document.features.findIndex(f=>f.id===edit.before):document.features.length;
        if(at<0)throw new CadError('FEATURE_NOT_FOUND',`Insertion target '${edit.before}' does not exist.`);
        document.features.splice(at,0,edit.feature); created.push(edit.feature.id);
      } else if (edit.op === 'update') {
        const at = document.features.findIndex(f => f.id === edit.feature.id);
        if (at < 0) throw new CadError('FEATURE_NOT_FOUND', `Feature '${edit.feature.id}' does not exist.`);
        if (document.features[at].kind !== edit.feature.kind) throw new CadError('FEATURE_KIND_MISMATCH', 'An update must preserve the feature ID and kind.');
        // A bound value is owned by its expression: changing the number while keeping the binding would be silently undone.
        const previous = document.features[at];
        for (const [path, expression] of Object.entries(edit.feature.bindings ?? {})) {
          const before = valueAt(previous.params, path), after = valueAt(edit.feature.params, path);
          if (previous.bindings?.[path] === expression && before !== undefined && after !== undefined && before !== after) {
            throw new CadError('BINDING_CONFLICT', `Field '${path}' of '${edit.feature.id}' is bound to '${expression}', so ${after} would be replaced by ${before}. Change the parameter with set_parameter, or remove '${path}' from bindings to set a number.`, { featureId: edit.feature.id, path, expression });
          }
        }
        document.features[at] = edit.feature;
        if (!created.includes(edit.feature.id) && !updated.includes(edit.feature.id)) updated.push(edit.feature.id);
      } else if (edit.op === 'set_presentation') {
        if (edit.presentation === null) delete document.presentation;
        else document.presentation = edit.presentation;
      } else if (edit.op === 'set_video') {
        if (edit.video === null) delete document.video;
        else document.video = edit.video;
      } else if (edit.op === 'set_parameter') {
        const { op: _op, ...parameter } = edit;
        const parameters = document.parameters ?? [];
        const at = parameters.findIndex(p => p.name === edit.name);
        document.parameters = at < 0 ? [...parameters, parameter] : parameters.map((p, i) => i === at ? parameter : p);
      } else if (edit.op === 'delete_parameter') {
        if (!document.parameters?.some(p => p.name === edit.name)) throw new CadError('PARAMETER_NOT_FOUND', `Parameter '${edit.name}' does not exist.`);
        const users = parameterUsage(document, edit.name);
        if (users.length) throw new CadError('PARAMETER_IN_USE', `Parameter '${edit.name}' drives ${countLabel(users.length, 'field')}. Unbind them first.`, { usedBy: users });
        document.parameters = document.parameters.filter(p => p.name !== edit.name);
        withoutEmptyParameters(document);
      } else if (edit.op === 'set_analysis') {
        const settings = { ...(document.analysis ?? {}) };
        if (edit.auto !== undefined) settings.auto = edit.auto;
        if (edit.toleranceMm !== undefined) settings.toleranceMm = edit.toleranceMm;
        if (edit.ground === null) delete settings.ground; else if (edit.ground !== undefined) settings.ground = edit.ground;
        document.analysis = settings;
      } else if (edit.op === 'set_check') {
        // Keep the intent explanation with the check through updates, undo and JSON persistence.
        const check = { ...edit.check, ...(edit.check.note ? { note: edit.check.note.trim() } : {}) };
        const checks = document.analysis?.checks ?? [];
        const at = checks.findIndex(c => c.id === edit.check.id);
        document.analysis = { ...(document.analysis ?? {}), checks: at < 0 ? [...checks, check] : checks.map((c, i) => i === at ? check : c) };
      } else if (edit.op === 'delete_check') {
        if(removedChecks.includes(edit.id))return;
        if (!document.analysis?.checks?.some(c => c.id === edit.id)) throw new CadError('CHECK_NOT_FOUND', `Check '${edit.id}' does not exist.`);
        document.analysis = { ...document.analysis, checks: document.analysis.checks.filter(c => c.id !== edit.id) };removedChecks.push(edit.id);
      } else {
        const removed = deletionIds(document, edit.featureIds, edit.cascade);
        document.features = document.features.filter(f => !removed.includes(f.id));
        document.selectedFeatureIds = document.selectedFeatureIds.filter(id => !removed.includes(id));
        // Checks and the ground part follow their features out of the document.
        if (document.analysis) {
          const { ground, checks } = document.analysis;
          const gone = (c: NonNullable<typeof checks>[number]) => checkFeatures(c).some(id => removed.includes(id));
          for(const c of checks??[])if(gone(c))removedChecks.push(c.id);
          document.analysis = { ...document.analysis, checks: checks?.filter(c => !gone(c)) };
          if (ground && removed.includes(checkRoot(ground))) delete document.analysis.ground;
        }
        for (const id of removed) {
          const wasCreated = created.indexOf(id);
          if (wasCreated >= 0) created.splice(wasCreated, 1); else deleted.push(id);
          const wasUpdated = updated.indexOf(id);
          if (wasUpdated >= 0) updated.splice(wasUpdated, 1);
        }
      }
    } catch (error) {
      if (edits.length > 1 && error instanceof CadError) throw new CadError(error.code, `Edit ${index + 1} of ${edits.length} (${original.op}): ${error.message}`, { editIndex: index, ...(isRecord(error.details) ? error.details : {}) });
      throw error;
    }
  });
  if(document.features.some(f=>f.graphicEdits||f.paintRegions?.length||f.surfaceStyles?.length||f.appearance&&['coat','roughness','detailScale','visualMaterial'].some(k=>k in f.appearance!)))document.schemaVersion=2;
  try {
    resolveBindings(document); validateDocument(document);
    // A parameter change updates every feature whose resolved values moved.
    for (const feature of document.features) {
      const before = source.features.find(f => f.id === feature.id);
      if (before && !created.includes(feature.id) && !updated.includes(feature.id) && JSON.stringify(before.params) !== JSON.stringify(feature.params)) updated.push(feature.id);
    }
  }
  catch (error) {
    if (error instanceof CadError) throw new CadError(error.code, `${error.message} No edit was applied.`, error.details);
    throw error;
  }
  return { document, created, updated, deleted,removedChecks:[...new Set(removedChecks)],warnings:[...forkWarnings(document, created),...(removedChecks.length?[`Removed checks: ${[...new Set(removedChecks)].join(', ')}.`]:[])] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
