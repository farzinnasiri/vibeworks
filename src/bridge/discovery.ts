import {resolveAppearance,resolveLook} from '../shared/appearance-resolver';
import { createHash } from 'node:crypto';
import {commandInfo,commandInputSchema,FEATURE_KINDS,MAX_ASSEMBLY_FEATURES,MAX_INSTANCE_DEPTH,MAX_REFERENCED_DOCUMENTS,type CadCommand,type CadResult} from '../shared/protocol';
import {references,appearanceLayers,CadError} from '../cad/document';
const origin=[0,0,0],axis=[0,0,1];
const frame={origin,normal:axis,xDirection:[1,0,0]};
const features:Record<string,unknown>={
 box:{origin,size:[40,30,8]},cylinder:{origin,radius:5,height:20},rod:{from:origin,to:[40,0,0],radius:3},
 extrude:{profile:{type:'rectangle',width:40,height:30},plane:'XY',origin,distance:8},
 revolve:{points:[[4,0],[8,0],[8,10],[4,10]],origin,angleDegrees:360},
 fill:{boundary:[{edge:{feature:'body',name:'edge(+X|+Z)',signature:{center:[40,15,8],lengthMm:30}},continuity:'G0'}],tolerances:{g0Mm:0.01,g1Deg:0.5}},
 join:{target:'body',replaceFaces:{feature:'body',select:{faces:['+Z'],fragments:'one'},signature:{surface:'PLANE',areaMm2:1200,normal:[0,0,1]}},surfaces:['cap'],toleranceMm:0.001},
 loft:{sections:[{profile:{type:'circle',radius:10},frame},{profile:{type:'circle',radius:6},frame:{...frame,origin:[0,0,30]}}],ruled:false},
 sweep:{profile:{type:'circle',radius:4},path:{points:[[0,0,0],[30,10,5],[60,40,20],[70,80,30]]},endScale:1.5},
 shell:{target:'body',thickness:2,removeFaces:[{point:[0,0,8],normal:axis,toleranceMm:0.001,expectedCount:1}]},
 fillet:{target:'body',radius:3,edges:{between:['housing','boss']}},chamfer:{target:'body',distance:0.5,edges:{on:{axis:'Z',value:8},curve:'circle'}},
 union:{target:'body',tools:['boss']},subtract:{target:'body',tools:['cutter']},intersect:{target:'body',tools:['tool']},
 transform:{target:'body',translation:[10,0,0],rotationAxis:axis,angleDegrees:4500,origin,scale:1,copy:false},
 mirror:{target:'body',plane:'YZ',origin,copy:true},
 pattern:{target:'body',layout:{type:'circular',axis,count:4,origin,angleDegrees:360}},
 drill_holes:{target:'body',centers:[[10,10,0],[30,10,0]],diameter:4,axis:'Z'},
 text:{text:'PART',plane:'XY',origin,size:6,depth:0.5,target:'body',mode:'engrave'},
 instance:{document:'00000000-0000-4000-8000-000000000001',translation:origin,rotationAxis:axis,angleDegrees:0,origin},
};
/** Focused discovery comes from the shared validator, plus one small contextual example. */
export function describeTool(params:Extract<CadCommand,{type:'describe'}>['params']):NonNullable<CadResult['help']>{
 const {tool,kind}=params;if(kind&&tool!=='apply_edits')throw new CadError('INVALID_ARGUMENT','Feature kind applies to apply_edits only.');
 let schema=commandInputSchema(tool,kind),example:Record<string,unknown>={};
 const notes=[commandInfo[tool].description.split('\n')[0],'Examples use illustrative feature/document IDs. Inspect your own model and replace them.'];
 if(tool==='workspace_view')return {tool,schema,example:{action:'present',documentId:'00000000-0000-4000-8000-000000000001',state:{panes:[{view:'top'}],selection:['body'],isolate:['body']}},notes};
 if(tool==='apply_edits'){
  example={documentId:'00000000-0000-4000-8000-000000000001',expectedRevision:0,edits:[{op:'add',feature:{id:'part',kind:kind??'box',params:features[kind??'box'],appearance:{material:'steel'}}}]};
  notes.push('appearance targets whole results or supported named faces. Regions use appearance.regions.upsert/remove with named target, captured signature, keep predicates and visual look. Face targets require captured signature {surface,areaMm2,normal?} and explicit fragments all/one. Face paint accepts visual fields only. patch.appearance merges fields; null resets a field to inherit. Edit graphics through appearance.graphics upsert/remove/order, not patch. Native builder history retains supported input face lineage through nearby operations. Unsupported anonymous faces fail explicitly.');
  notes.push('add.before inserts before an existing history entry. patch preserves omitted metadata; update replaces the entire feature. Resolve a rejected source edit before dependent work.','set_analysis uses ground:"feature_id". drill_holes.axis is X/Y/Z; circular pattern.axis and rotationAxis are numeric three-vectors.','Rigid angles/twists may contain multiple turns; geometry uses equivalent orientation. Revolve angleDegrees remains 0.1–360.','Cascade deletion removes associated checks and reports removedChecks. Explicit cleanup of the same checks in that batch is harmless.');
  notes.push('Optional review:{shots:[{view:"top"}],compareTo:snapshotId,sections:[{axis:"Z",offset:5}],profiles:[{featureId:"part"}]} returns images and exact evidence after committing. reviewFailure preserves the successful edit: retry render_views, not apply_edits.');
  if(!kind)notes.push('Request kind for a smaller schema. Kinds: '+FEATURE_KINDS.join(', '));
  if(kind==='instance')notes.push(
   `Nesting beyond ${MAX_INSTANCE_DEPTH} levels fails INSTANCE_DEPTH; cycles fail INSTANCE_CYCLE; missing sources fail DOCUMENT_NOT_FOUND; hidden or empty results fail INSTANCE_RESULT_NOT_VISIBLE. Graphs allow ${MAX_REFERENCED_DOCUMENTS} referenced documents and ${MAX_ASSEMBLY_FEATURES} unique features and expanded pieces (ASSEMBLY_LIMIT). Repeated instances share display assets; display size never rejects an edit.`,
   'attachment:{source:{featureId,name},target:{featureId,name}|{frame},mode:"align"|"mate",offset:[u,v,n],twistDegrees}. Source is a mount on an included source result; target is a mount on an earlier result or an explicit frame. Align matches axes; positive twist is right-handed about the target normal; mate then flips normal and V about the twisted U. Offset uses the original target axes. Manual translation, angle and origin must be zero when attached.',
   'Mounts are static frames in document coordinates: derived results inherit target mounts, transform/mirror move them, patterns need explicit mounts, own names override inherited ones. Instance mounts are named resultId/mountName, including nested paths, up to 256 per result. Changed source mounts refresh placements; missing ones fail MOUNT_NOT_FOUND. Mounts never track faces.');
  if(kind==='intersect'||kind==='subtract')notes.push('To split a part into pieces, intersect it with one box per piece; each intersect is its own result, so the warning that the target is reused is expected.');
  if(kind==='loft')notes.push('correspondence:authored disables OCCT compatibility edits and requires equal edge counts. Each section accepts seam [0,1), splitAt[], reverse and mapping listing connected authored segment names. Splits trim original curves at normalized perimeter arclength. Diagnostics include normalized vertices, paired points, displacement and frame twist. Omitted controls preserve the legacy loft. smoothing/continuity C1/C2/maxDegree control internal approximation, never boundary G1/G2.');
  if(kind==='fill')notes.push('Exact construction sheet with zero physical volume. boundary is one ordered closed loop of semantic EdgeRefs from inspect topology. G1/G2 require a captured supporting FaceRef per constrained edge; G2 also requires tolerances.g2 in inverse mm. Bounds: 32 boundary edges/points, degree 2–8, 32 segments, g0Mm 1e-6–0.01. Independent samples measure exact distances, normals and curvature; kernel maxima are reported separately. Shared planar support initializes the plate; one tighter fit may retry with unchanged acceptance thresholds. Samples are not a global continuity certificate. CONTINUITY_NOT_MET includes candidate mesh and failing points, without committing. Sheets stay visible for construction, are excluded from physical analysis/STEP/STL/GLB and retained in JSON.');
  if(kind==='join')notes.push('Replace explicit captured target face references with construction sheet ids, sewing tolerance 1e-6–0.01 mm. All shells, including cavities, are retained. Free edges/multiple edges or invalid solids reject atomically; diagnostics give counts and free-edge midpoints. Optional continuity.maxAngleDeg and continuity.maxCurvaturePerMm gate sampled exact seam normals and curvature; they do not reshape surfaces or certify global continuity.');
  if(kind==='fillet')notes.push('radius may be {stations:[[0,r0],...,[1,r1]]}: 2–16 strictly increasing stations, t is normalized arclength on the selected native forward edge, not the underlying curve parameter; radii 0.01–10000 mm. OCCT Add(UandR,edge) applies the law. Tangent contours with multiple edges are rejected; closed edges require equal endpoint radii. edges:{refs:[{feature,name,signature:{center,lengthMm}}]} re-resolves captured semantic edges; references must belong to target. Inspect topology with edges.query before blending. Failure diagnostics contain individual observed radius trials within a 4 s scheduling budget, with no monotonicity claim or automatic radius reduction. Native calls cannot be interrupted inside a worker; the worker deadline remains authoritative.');
  if(kind==='sweep')notes.push('sections:[{at,profile,rotationDegrees?},...] increase from 0 to 1 in normalized native spine parameter, not arclength. Exact path splits supply explicit section locations. Corrected Frenet frame; rotation is about the local tangent, profileX sets initial U. guide:{path,curvilinear:true,contact:"none"} uses the actual auxiliary-spine builder. Supported advanced paths have one arc/Bezier/spline edge. Contact/border guide modes fail explicitly. endScale cannot combine with advanced options. Reports kernel ErrorOnSurface and independent perimeter-to-surface section residuals. The latter checks requested sections, not a global sweep error.');
  if(kind==='sweep')notes.push('A planar path lies in its frame plane with line/arc/Bezier segments. A points path is an exact interpolating B-spline through 3D points: use it for pipes, rails and spirals. endScale grows or shrinks the section linearly from start to end, e.g. a volute or a tapered tube. Keep the profile smaller than the tightest bend at every scale.');
  if(kind==='fillet'||kind==='chamfer')notes.push(
   'edges selects edges of the target again on every rebuild: "all", "vertical" (straight, parallel to Z) or a query whose criteria must all hold.',
   'Query criteria: parallel:"X"|"Y"|"Z" straight edges along an axis; on:{axis,value} edges lying in that plane; near:[[x,y,z],...] edges within toleranceMm (default 0.5) of a point; between:[a,b] edges lying on the surfaces of both earlier features a and b (default 0.01 mm); curve:"line"|"circle"; minLengthMm/maxLengthMm.',
   'On a united body, blend each joint with between: body = union {target:"housing",tools:["boss"]}, then fillet {target:"body",radius:3,edges:{between:["housing","boss"]}}. Blend several joints in successive features, each targeting the previous blend, and outer rims with on/curve queries.',
   'A failed blend lists each selected edge (midpoint, length, curve) and whether it blends alone, so the next edit can split the selection with near points or use a smaller value. Blend before cuts that leave short edges.');
 }else if(tool==='inspect_model')example={documentId:'00000000-0000-4000-8000-000000000001',include:['parameters','references','mounts']};
 else if(tool==='agent_session'){example={action:'join',client:'codex',task:'Design the assigned mechanical subsystem',phase:'Layout',workState:'working'};notes.push('Every concurrent participant joins independently and passes its returned sessionId on every tool call. parentAgentId records coordination, continuedFrom records work ancestry.','handoff maximum is 8000 characters. Prefer concise decisions and artifact paths; leave with workState:"completed" when done.');}
 else if(tool==='documents'){example=params.action==='extract'?{action:'extract',requestId:'00000000-0000-4000-8000-000000000002',documentId:'00000000-0000-4000-8000-000000000001',expectedRevision:1,expectedStorageVersion:2,features:['body'],name:'Extracted part',dryRun:true}:params.action==='create_project'?{action:'create_project',name:'My design'}:{action:params.action??'list'};if(params.action){const alternatives=schema.oneOf as any[];const selected=alternatives.find(a=>a.properties.action.const===params.action);if(!selected)throw new CadError('INVALID_ARGUMENT','Unknown documents action.');schema={...schema,oneOf:[selected]};}}
 else if(tool==='analyze_model'){example={documentId:'00000000-0000-4000-8000-000000000001',action:'run'};notes.push('Whole-document analysis starts once and advances automatically. Read progress with action:status or action:result and the returned jobId; polling does not advance the work. Incomplete or unknown coverage cannot pass health. Jobs and completed facts survive restart.');}
 else if(tool==='activity')example={projectId:'00000000-0000-4000-8000-000000000001',limit:20};
 else if(tool==='render_image'){example={action:'start',documentId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000003',output:{size:'hd',quality:'draft',denoise:true},shot:{view:'isometric',projection:'perspective'}};}
 else if(tool==='render_views'){example={appearance:'materials',tileSize:384,outputs:'both',review:{},shots:[{view:'isometric'},{from:[1,-1,0.3],frame:{featureIds:['housing']},label:'housing'},{from:[0,-1,0.2],frame:{center:[0,-30,58],radiusMm:20},label:'boss root'},{view:'front',section:{axis:'Y',offset:0},hide:['cover']},{from:[1,1,0.5],projection:'perspective',ghost:['cover']}]};
  notes.push('Without shots, views renders whole-model tiles from named world directions. Each shot frames something in model terms, so it stays meaningful after edits: frame.featureIds fits those results, frame {min,max} a box, frame {center,radiusMm} a detail (smaller radius = closer).',
   'from is where the camera sits relative to the framed center: [1,-1,1] is the isometric corner, [0,0,1] looks down. up defaults to +Z (+Y when looking straight down).',
   'A section keeps material at or below offset (above with flip). A shot with a section and no view or from faces the cut; with a view, put the camera on the removed side to see the cut face.',
   'hide removes results from one shot; ghost draws them translucent. Both name shown results. A shot whose frame contains nothing visible fails EMPTY_SHOT instead of returning an empty tile.',
   'image.tiles reports each tile: eye, target, up, widthMm, heightMm and mmPerPixel. Compare a reference by repeating the same from and frame:{center,radiusMm} after an edit; never transform the model to change the view.');}
 else if(tool==='export_model')example={format:'step',filename:'assembly-final.step'};
 else if(tool==='select_features')example={documentId:'00000000-0000-4000-8000-000000000001',expectedRevision:0,featureIds:['body']};
 else if(tool==='document_action')example={action:'undo',documentId:'00000000-0000-4000-8000-000000000001',expectedRevision:1};
 else example={tool:'apply_edits',kind:'pattern'};
 if(tool==='inspect_model')notes.push('select.features projects IDs and requested fields; appearance summaries omit inline image bytes. select.topology returns exact face metrics, source and occurrence paths. Face picks include displayKey and fail TOPOLOGY_STALE when mismatched. page cursors pin a snapshot; repeat the same select/include with page.cursor. All default reads are compact with a 24 KiB budget. Explicit detail:full returns complete editable definitions including portable assets.','Old snapshots require explicit snapshot.reevaluate:true for evaluation with the current engine. Authored engine metadata stays original; evaluationProvenance does not transfer original certification.','replay.step is 1-based, 1..2000. Supply replay.expectedRevision and replay.expectedStorageVersion, not top-level expectedRevision. Pin a graph with snapshot:{} and reuse its returned id.','include selects compact sections without returning full editable history; definitionsOnly:true reads saved definitions without geometry.');
 return {tool,...(kind?{kind}:{}),schema,example,notes};
}

/** Projections never embed image payloads; request raw definitions through JSON export. */
export function selectInspection(result:CadResult, params:Extract<CadCommand,{type:'inspect_model'}>['params'], evaluation?:import('../cad/types').Evaluation):CadResult {
 if(result.status==='error'||(params.detail==='full'&&!params.include&&!params.select&&!params.budgetBytes&&!params.page))return result;
 const {document,geometry,analysis,instances,...metadata}=result;
 const wanted=new Set(params.include??(!params.select?['features','geometry','references']:[])),inspection:Record<string,unknown>={};
 const select=params.select;
 const emptyWorkspace=!result.documentId&&result.documents?.length===0;
 if(select?.diff)inspection.diff=result.inspection?.diff??[];
 if(result.inspection?.selection)inspection.selection=result.inspection.selection;
 if(wanted.has('parameters'))inspection.parameters=document?.parameters??[];
 if(wanted.has('features')||select?.features){
  const options=select?.features;
  const fields=options?.fields??['kind','label','inputs','visible','appearance'];
  const consumed=new Set(document?.features.flatMap(f=>f.kind==='instance'?[]:('target'in f.params&&f.params.target?[f.params.target]:[])));
  inspection.features=(document?.features??[]).filter(f=>(!options?.ids||options.ids.includes(f.id))&&(!options?.kinds||options.kinds.includes(f.kind))).map(f=>{
   const inputs='target'in f.params&&f.params.target?[f.params.target,...('tools'in f.params?f.params.tools:[])]:[];
   const item:Record<string,unknown>={id:f.id};
   for(const field of fields){
    if(field==='inputs')item.inputs=inputs;
    else if(field==='dependents')item.dependents=document?.features.filter(g=>'target'in g.params&&g.params.target===f.id||'tools'in g.params&&g.params.tools.includes(f.id)).map(g=>g.id);
    else if(field==='visible')item.visible=!consumed.has(f.id);
    else if(field==='appearance'){item.appearance=summarizeAppearance(f.appearance);item.appearanceOrigins=Object.fromEntries(Object.entries(resolveAppearance(appearanceLayers(document!,f.id)).fields).filter(([k])=>k!=='graphics'));}
    else if(field in f)item[field]=f[field as keyof typeof f];
   }
   return item;
  });
 }
 if(wanted.has('mounts'))inspection.mounts=geometry?.filter(g=>g.mounts?.length).map(g=>({featureId:g.featureId,mounts:g.mounts}))??[];
 if(wanted.has('references')||select?.references?.sources)inspection.references=result.provenance?.sources??result.health?.references??[];
 if(select?.references?.incoming)inspection.incoming=result.inspection?.incoming??[];
 if(select?.assets)inspection.assets=Object.entries(document?.graphicAssets??{}).map(([hash,{base64,...metadata}])=>({hash,...metadata}));
 if(select?.occurrences)inspection.occurrences=[...new Map((evaluation?.meshes??[]).map(m=>[JSON.stringify(m.occurrencePath),{feature:m.featureId,path:m.occurrencePath,source:m.source}])).values()];
 if(select?.dependencies)inspection.dependencies=document?.features.map(f=>({id:f.id,inputs:references(f),dependents:document.features.filter(g=>references(g).includes(f.id)).map(g=>g.id)}));
 if(select?.topology){
  const query=select.topology;
  const pick=query.faces&&'pick'in query.faces?query.faces.pick:undefined;
  if(pick&&(pick.displayKey!==evaluation?.displayKey||pick.documentId!==result.documentId||pick.revision!==result.revision||pick.storageVersion!==result.storageVersion||pick.feature!==query.target.feature))throw new CadError('TOPOLOGY_STALE','This pick belongs to another geometry delivery. Pick the current surface again.');
  const groups=new Map<string,import('../shared/protocol').DisplayMesh[]>();
  for(const mesh of evaluation?.meshes??[])if(mesh.featureId===query.target.feature&&(!query.target.path||JSON.stringify(mesh.occurrencePath?.slice(1))===JSON.stringify(query.target.path))&&(!pick||JSON.stringify(mesh.occurrencePath?.slice(1)??[])===JSON.stringify(pick.path))){const key=JSON.stringify(mesh.occurrencePath);const group=groups.get(key)??[];group.push(mesh);groups.set(key,group);}
  if(!groups.size)throw new CadError(pick?'TOPOLOGY_STALE':'REFERENCE_MISSING','The requested feature occurrence is unavailable in this delivery.',{reference:query.target,candidates:(evaluation?.meshes??[]).slice(0,8).map(m=>({feature:m.featureId,path:m.occurrencePath?.slice(1),source:m.source}))});
  inspection.topology=[...groups.values()].map(meshes=>{
   const mesh=meshes[0];
   if(pick&&(!mesh.topology||pick.faceIndex>=mesh.topology.faces.length))throw new CadError('TOPOLOGY_STALE','Picked face does not exist in this display.');
   return {displayKey:evaluation?.displayKey,feature:mesh.featureId,path:mesh.occurrencePath,source:mesh.source,regions:meshes.find(m=>m.regionReport)?.regionReport,regionDefinitions:document?.features.find(f=>f.id===mesh.featureId)?.paintRegions,faces:mesh.topology?.faces.map((f,index)=>({...f,index,looks:meshes.filter(m=>m.faceRanges?.some((v,i)=>i%4===2&&v===index)).map(m=>inspectionLook(m,document,params.select?.appearanceMode??'authored')),appearanceOrigins:meshes.find(m=>m.faceRanges?.some((v,i)=>i%4===2&&v===index))?.appearanceOrigins,appearance:summarizeAppearance(meshes.find(m=>m.faceRanges?.some((v,i)=>i%4===2&&v===index))?.appearance)})).filter(f=>(!query.near||evaluation?.topologyQuery?.faceIndices?.includes(f.index))&&(pick?f.index===pick.faceIndex:!query.faces||!('names'in query.faces)||f.lineage.some(n=>'names'in query.faces!&&query.faces.names.includes(n)))),edges:mesh.topology?.edges.map((edge,index)=>({...edge,index})).filter(edge=>(!query.edges?.query||evaluation?.topologyQuery?.edgeIndices?.includes(edge.index))&&(!query.edges?.names||edge.lineage.some(n=>query.edges!.names!.includes(n))))};
  });
 }
 const {documents:_documents,projects:_projects,evaluationStats:_stats,health:_health,history:_history,visibleFeatureIds:_visible,...compact}=metadata;
 const selected:CadResult={...compact,inspection};
 if(wanted.has('health'))selected.health=result.health;
 if(wanted.has('history'))selected.history=result.history;
 if(wanted.has('geometry'))inspection.geometry=geometry?.map(g=>({...g,...(g.diagnostics?{diagnostics:JSON.parse(JSON.stringify(g.diagnostics,(key,value)=>['outline','previewLines','patches'].includes(key)?undefined:value))}:{}),appearance:summarizeAppearance(g.appearance)}))??[];
 if(wanted.has('analysis'))inspection.analysis=analysis;
 const budget=params.budgetBytes??24576;
 const signature=inspectionSignature(params);
 const cursor=params.page?.cursor?decodeInspectionCursor(params.page.cursor):undefined;
 if(cursor&&(cursor.signature!==signature||cursor.documentId!==result.documentId||cursor.snapshotId!==result.snapshot?.snapshotId))throw new CadError('CURSOR_INVALID','Cursor belongs to another inspection projection or snapshot.');
 const rows=Object.entries(inspection).flatMap(([section,value])=>Array.isArray(value)?value.map(item=>({section,item})):[{section,item:value}]);
 const offset=cursor?.offset??0;
 if(offset>rows.length)throw new CadError('CURSOR_INVALID','Cursor offset does not exist.');
 selected.inspection={...Object.fromEntries(Object.entries(inspection).filter(([,value])=>Array.isArray(value)&&value.length===0).map(([key])=>[key,[]])),current:result.inspection?.current??true,...(emptyWorkspace?{emptyWorkspace:true}:{}),...(result.inspection?.displayCache?{displayCache:result.inspection.displayCache}:{})};
 const size=()=>Buffer.byteLength(JSON.stringify(selected));
 const limit=params.page?.limit??1000;
 let i=offset;
 for(;i<rows.length&&i-offset<limit;i++){
  const {section,item}=rows[i];
  const items=(selected.inspection[section]??=[]) as unknown[];
  items.push(item);
  if(size()+1024>budget){
   items.pop();
   if(i===offset){
    const object=item&&typeof item==='object'?item as Record<string,unknown>:{};
    items.push({id:object.id??object.featureId,kind:object.kind,label:object.label,omitted:Object.keys(object).filter(k=>!['id','kind','label'].includes(k)),hint:'Select fewer fields or increase budgetBytes.'});
    if(size()+1024>budget)throw new CadError('INSPECTION_BUDGET','Even the item summary exceeds the budget.',{budgetBytes:budget});
    i++;
   }
   break;
  }
 }
 if(i<rows.length){
  if(!result.snapshot)throw new CadError('INSPECTION_BUDGET','A snapshot is required to page this projection. Repeat with snapshot:{}.',{budgetBytes:budget});
  selected.inspection.nextCursor=Buffer.from(JSON.stringify({snapshotId:result.snapshot.snapshotId,documentId:result.documentId,signature,offset:i})).toString('base64url');
 }
 if(size()>budget)throw new CadError('INSPECTION_BUDGET','Reply metadata exceeds the budget.',{budgetBytes:budget});

 return selected;
}
function summarizeAppearance(appearance:import('../shared/protocol').Appearance|undefined){
 if(!appearance)return undefined;
 const {graphics,...fields}=appearance;
 return {...fields,...(graphics?{graphics:graphics.map(({content,...g})=>({...g,content:content.type==='image'?{type:content.type,bytes:'dataUrl'in content?Buffer.from(content.dataUrl.split(',')[1],'base64').byteLength:undefined,asset:'asset'in content?content.asset:undefined}:content}))}:{})};
}

export function inspectionSignature(params:Extract<CadCommand,{type:'inspect_model'}>['params']):string{
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
 return createHash('sha256').update(JSON.stringify(canonical([params.select,params.include]))).digest('hex');
}
export function decodeInspectionCursor(cursor:string):{snapshotId:string;documentId:string;signature:string;offset:number}{
 try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!v||typeof v.snapshotId!=='string'||typeof v.documentId!=='string'||typeof v.signature!=='string'||!/^[a-f0-9]{64}$/.test(v.signature)||!Number.isSafeInteger(v.offset)||v.offset<0)throw Error();return v;}
 catch{throw new CadError('CURSOR_INVALID','Invalid inspection cursor. Start a fresh projection.');}
}

function inspectionLook(mesh:import('../shared/protocol').DisplayMesh,document:import('../shared/protocol').CadDocument|undefined,mode:'authored'|'studio'){
 const look=resolveLook(mesh.appearance,document?.presentation,mode),origins={...mesh.appearanceOrigins};
 const material=mesh.appearance?.material??'unassigned',studio=mode==='studio'?document?.presentation?.materials?.[material]:undefined;
 for(const [field,active]of Object.entries({roughness:studio?.finish,coat:studio?.coat,detail:studio?.detail,detailScale:studio?.detailScale}))if(active!==undefined)origins[field]={documentId:document!.documentId,featureId:material,layer:'studio'};
 const values={...mesh.appearance,color:look.color,roughness:look.roughness,coat:look.clearcoat?'clear':'none',detail:look.detail,detailScale:look.detailScale};
 return{appearance:summarizeAppearance(mesh.appearance),mode,look,fields:Object.fromEntries(Object.entries(origins).filter(([key])=>key!=='graphics').map(([key,from])=>[key,{value:values[key as keyof typeof values],from}]))};
}
