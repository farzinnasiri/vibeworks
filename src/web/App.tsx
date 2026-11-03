import {ExtractDialog} from './ExtractDialog';
import {ProjectBrowser} from './ProjectPicker';
import {getAppearanceFeedback} from './appearance-feedback';
import {Playback,type PlaybackMode,type PlaybackScope} from './playback';
import {ReplayPlayer} from './ReplayPlayer';
import {ProjectSwitcher} from './DocumentSwitcher';
import {FloatingPanel,usePanelLayout,type PanelMode,type PanelSide} from './FloatingPanel';
import { projectDocument } from './projects';
import {useProjectWork,AgentsTab,AgentDetail} from './Agents';
import {DialogHost,ContextMenu,dialogs,type ContextEntry} from './Dialogs';
import {participantFocus,agentActivity,agentColor,agentLabel,shortDocumentName} from './participants';
import type { Author } from './BuildLog';
import {useDisplayProjection} from './useDisplayProjection';

import { workspaceCommands } from './workspaceCommands';
import { StudioWorkspace } from './StudioWorkspace';
import { WorkspacePresentation } from './WorkspacePresentation';
import { ViewControls } from './ViewControls';
import { OperationDock } from './OperationDock';
import { WorkspaceStatus } from './WorkspaceStatus';
import { TopBar } from './TopBar';
import { BuildPanel, InspectPanel, type LeftTab } from './WorkspacePanels';
import { KeyboardHelp } from './KeyboardHelp';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import { context, demoCommand } from '../cad/demo';
import { effectiveAppearance, references, visibleFeatures } from '../cad/document';
import type { Evaluation } from '../cad/types';
import type { LivePreview } from './preview';
import type { CadResult, CadDocument, GraphSnapshot, ActivityOperation, Feature, ViewName } from '../shared/protocol';
import { BrowserBridge, type ConnectionState } from './bridge';
import { Viewport, type GizmoEdit, type HolePreview, type Section, type ViewportView, type CameraPose } from './Viewport';
import { modelBounds } from './scene';
import { DEFAULT_WORKBENCH_EDGES } from './workbench';
import { type PickEvent } from './ToolCard';
import { CommandPalette } from './CommandPalette';
import { Icon } from './icons';
import { featureName, nextFeatureId, moveInstance, toolSpec, unavailableReason, type Tool } from './modeling';
import { activity, track } from './activity';
import { loadDocumentFile } from './load-document';
import { flaggedParts } from './AnalysisPanel';
import { useAppearance } from './appearance';
import { readStudioNavigation, saveStudioNavigation } from './studio-navigation';
import { restoreDocument } from './restore-document';
import { WorkspaceSettings } from './WorkspaceSettings';
import { RevisionHistory } from './RevisionHistory';
import { ModelExplorer } from './ModelExplorer';
import { useDocumentNavigation } from './document-navigation';
import { AgentMark } from './AgentMark';
import { AgentViews, MAX_AGENT_FOLLOWERS, agentViewTarget } from './AgentViews';
import { ComparisonSplit } from './ComparisonSplit';

function download(result: CadResult): void {
  if (!result.artifact) return;
  const bytes = Uint8Array.from(atob(result.artifact.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: result.artifact.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.artifact.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function App({ runtime }: { runtime: RuntimeClient }) {
  const { theme } = useAppearance();
  const [navigation, setNavigation] = useState(readStudioNavigation);
  const [navigationTool, setNavigationTool] = useState<'select' | 'pan' | 'orbit' | 'zoom'>('select');
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const entries = useSyncExternalStore(activity.subscribe, activity.entries);
  const touchedByDocument = useSyncExternalStore(activity.subscribe, activity.agentTouched);
  const [connection, setConnection] = useState<ConnectionState>({
    phase: 'offline',
    message: 'Waiting for geometry initialization',
  });
  const bridge = useRef<BrowserBridge | null>(null);
  const [matchStudio,setMatchStudio]=useState(false);
  const [edges, setEdges] = useState(DEFAULT_WORKBENCH_EDGES);
  const [studio, setStudio] = useState(false);
  useEffect(()=>{runtime.reportWorkspaceMode?.(state.workspaceView?.state.mode??(studio?'studio':'modeling'));},[runtime,state.workspaceView,studio]);
  const [orbiting, setOrbiting] = useState(false);
  const stopOrbit = () => setOrbiting(false);
  const playbackController=useMemo(()=>new Playback(runtime),[runtime]);
  const playback=useSyncExternalStore(playbackController.subscribe,playbackController.getSnapshot);
  useEffect(()=>{const off=runtime.subscribe(playbackController.reconcile);return()=>{off();playbackController.close();};},[runtime,playbackController]);
  const [view, setView] = useState<ViewName>('isometric');
  const [fitKey, setFitKey] = useState(0);
  const documentNavigation=useDocumentNavigation(runtime,state);
  const assemblyTrail=documentNavigation.trail;
  const setAssemblyTrail=(_value:unknown)=>documentNavigation.clearTrail();
  const [tool, setTool] = useState<Tool | null>(null);
  const [toolSession, setToolSession] = useState(0);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  /** Touch screens have no Shift key; this dock toggle makes taps add to the selection. */
  const [addMode, setAddMode] = useState(false);
  const [snap, setSnap] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [projectsOpen,setProjectsOpen]=useState(false);
  const closeProjects=()=>{setProjectsOpen(false);requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.topbar [aria-label^="Project:"]')?.focus());};
  const [studioRisk,setStudioRisk]=useState({draft:false,rendering:false});
  const [leftTab, setLeftTab] = useState<LeftTab>('build');
  const panels=usePanelLayout();
  const [sheet, setSheetState] = useState<'build' | 'inspect' | null>(null);
  const setSheet=(next:'build'|'inspect'|null)=>{if(next)panels.set(next==='build'?'left':'right','expanded');setSheetState(next);};
  const panelMode=(side:PanelSide,mode:PanelMode)=>{setMenu(null);panels.set(side,mode);if(mode==='collapsed')setSheetState(current=>current===(side==='left'?'build':'inspect')?null:current);};
  const [hoverGhost, setHoverGhost] = useState<string | undefined>();
  const [draft, setDraft] = useState<Feature | undefined>();
  const [pickEvent, setPickEvent] = useState<PickEvent | undefined>();
  /** History step being viewed (1-based), or null for the latest model. View-only. */
  const [displayDetail,setDisplayDetail] = useState<'auto'|'fine'|'coarse'>('auto');
  useEffect(()=>playbackController.setDetail(displayDetail),[playbackController,displayDetail]);
  const [historyExit,setHistoryExit]=useState(0);
  const historicalView=playback.mode==='changes'&&playback.active&&playback.displayed&&playback.document&&playback.snapshot&&playback.frame?{document:playback.document,evaluation:playback.frame,snapshot:playback.snapshot}:undefined;
  const reviewOperation=playback.operation;
  const [comparison, setComparison] = useState<{ evaluation: Evaluation; appearances: Map<string, import('../shared/protocol').Appearance | undefined>; revision: number }>();
  const [comparisonPosition, setComparisonPosition] = useState(.5);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [contribution, setContribution] = useState<ActivityOperation>();
  const contributionCursor = useRef<{ project?: string; sequence?: number }>({});
  const [historySelection, setHistorySelection] = useState<string[]>([]);
  const step=playback.active&&playback.mode==='construction'?playback.requested:null;
  const replaying=playback.playing;
  const [section, setSection] = useState<Section | null>(null);
  const [measuring, setMeasuring] = useState(false);
  /** Clicking edges for a fillet or chamfer: shows the unrounded part instead of the preview. */
  const [edgePicking, setEdgePicking] = useState(false);
  // Forms (tool/inspector) and the parameter panel preview independently; a form preview wins while both exist.
  const [formPreview, setFormPreview] = useState<LivePreview | undefined>();
  const [parameterPreview, setParameterPreview] = useState<LivePreview | undefined>();
  const livePreview = analysisOpen ? undefined : (formPreview ?? parameterPreview);
  const fileInput = useRef<HTMLInputElement>(null);
  const historicalLoading=playback.active&&playback.mode==='changes'&&playback.loading;
  const working = state.phase !== 'ready' || state.busy || demoBusy;
  // Viewing history is read-only: edits always apply to the latest model.
  const disabled = working || playback.active;
  const doc = state.document;
  const [enteringWorkspace, setEnteringWorkspace] = useState(true);
  useLayoutEffect(() => {
    setEnteringWorkspace(true);
    const timer = window.setTimeout(() => setEnteringWorkspace(false), 420);
    return () => clearTimeout(timer);
  }, [doc.projectId]);
  const [projectId,setProjectId]=useState(doc.projectId);
  const lastDocument=useRef(doc.documentId);
  useEffect(()=>{
    if(lastDocument.current!==doc.documentId&&doc.projectId){setProjectId(doc.projectId);sessionStorage.setItem('vibeworks.view.activeProjectId',doc.projectId);}
    lastDocument.current=doc.documentId;
  },[doc.documentId,doc.projectId]);
  const projectWork=useProjectWork(runtime,projectId);
  const projectChanges=useProjectWork(runtime,projectId,true);
  useEffect(() => {
    const latest = [...projectChanges.work.operations].filter(o => o.toVersion !== undefined && o.kind === 'agent').sort((a, b) => b.sequence - a.sequence)[0];
    if (projectChanges.loading) return;
    const cursor = contributionCursor.current;
    if (cursor.project !== projectId || cursor.sequence === undefined) { contributionCursor.current = { project: projectId, sequence: latest?.sequence ?? 0 }; return; }
    if (latest && latest.sequence > cursor.sequence) { cursor.sequence = latest.sequence; setContribution(latest); }
  }, [projectId, projectChanges.loading, projectChanges.work.operations]);
  useEffect(() => { if (!contribution) return; const timer = setTimeout(() => setContribution(undefined), 5000); return () => clearTimeout(timer); }, [contribution]);
  /** An agent picked in the Agents tab; its details replace the inspector on the right. */
  const [selectedAgent,setSelectedAgent]=useState<string>();
  const [extracting,setExtracting]=useState<string[]|null>(null);
  const [contextMenu,setContextMenu]=useState<{x:number;y:number;id?:string}>();
  const [following,setFollowing]=useState<string>();
  const viewportApi = useRef<ViewportView | null>(null);
  const followOrigin = useRef<{ documentId: string; selected: string[]; camera?: CameraPose } | undefined>(undefined);
  const [watchPaused,setWatchPaused]=useState(false);
  /** 'show' is one explicit visit to an agent's design; 'follow' keeps tracking its focus until paused. */
  const [followMode,setFollowMode]=useState<'show'|'follow'>('follow');
  /** Selection made by following, so it does not replace the open agent details. */
  const followSelection=useRef('');
  /** A brief, explicitly requested outline of an agent's work. Display only; never recolors authored parts. */
  const [agentHighlight,setAgentHighlight]=useState<{documentId:string;ids:string[];color:string}>();
  useEffect(()=>{if(!agentHighlight)return;const timer=setTimeout(()=>setAgentHighlight(undefined),6000);return()=>clearTimeout(timer);},[agentHighlight]);
  const historicalGeneration=useRef(0),followTarget=useRef(''),watchGeneration=useRef(0);
  const agents=projectWork.work.participants.filter(p=>p.identity.kind==='agent');
  const [agentViewSelection, setAgentViewSelection] = useState<{ projectId?: string; ids: string[] }>({ ids: [] });
  const liveViewIds = agentViewSelection.projectId === projectId ? agentViewSelection.ids : [];
  const agentSplit = !studio && !!projectId && liveViewIds.length > 0;
  useEffect(() => { setAgentViewSelection({ projectId, ids: [] }); setSelectedAgent(undefined); }, [projectId]);
  const setLiveViews = (ids: string[], keepDetails = false) => {
    stopWatch(); stopOrbit(); if (!keepDetails) setSelectedAgent(undefined);
    setAgentViewSelection({ projectId, ids: [...new Set(ids)].slice(0, MAX_AGENT_FOLLOWERS) });
    if (!keepDetails) setSheet(null);
  };

  const agentInFocus=agents.find(p=>p.identity.agentId===selectedAgent);
  const watched=agents.find(p=>p.identity.agentId===following);
  const pauseWatch=()=>{watchGeneration.current++;setWatchPaused(true);};
  const stopWatch=(restore = false)=>{
    const origin = followOrigin.current; followOrigin.current = undefined;
    const run = ++watchGeneration.current; setFollowing(undefined);setWatchPaused(false);followTarget.current='';
    if (restore && origin) void (async () => {
      const result = runtime.getSnapshot().document.documentId === origin.documentId ? undefined : await runtime.openDocument(origin.documentId);
      if (run !== watchGeneration.current) return;
      if (result?.status === 'error') { setNotice({kind:'error',text:result.error!.message}); return; }
      await runtime.select(origin.selected.filter(id => runtime.getSnapshot().document.features.some(f => f.id === id)));
      requestAnimationFrame(() => { if (run === watchGeneration.current && origin.camera) viewportApi.current?.restore(origin.camera); });
    })().catch(error => setNotice({kind:'error',text:String(error)}));
  };
  const follow=async(participant:import('../shared/protocol').Participant,mode:'show'|'follow'='follow')=>{
    if (!followOrigin.current) followOrigin.current = { documentId: doc.documentId, selected: [...doc.selectedFeatureIds], camera: viewportApi.current?.capture() };
    setFollowing(participant.identity.agentId);setFollowMode(mode);setWatchPaused(mode==='show');
    const focus=participantFocus(participant);if(!focus?.documentId)return;
    const key=JSON.stringify([participant.identity.agentId,focus]);followTarget.current=key;
    const run=++watchGeneration.current;++historicalGeneration.current;
    playbackController.close();stopOrbit();chooseTool(null);setFormPreview(undefined);setParameterPreview(undefined);
    const opened=runtime.getSnapshot().document.documentId===focus.documentId?undefined:await runtime.openDocument(focus.documentId);
    if(run!==watchGeneration.current)return;
    if(opened?.status==='error'){setWatchPaused(true);setNotice({kind:'error',text:opened.error!.message});return;}
    const ids=(focus.featureIds??[]).filter(id=>runtime.getSnapshot().document.features.some(f=>f.id===id));followSelection.current=ids.join('|');await runtime.select(ids);
  };
  /** Explicit Details actions. Asks before abandoning unapplied work; selecting an agent alone never navigates. */
  const startFollow=async(participant:import('../shared/protocol').Participant,mode:'show'|'follow')=>{
    const target=participantFocus(participant)?.documentId;
    if(target&&target!==runtime.getSnapshot().document.documentId&&!await confirmNavigation())return;
    followTarget.current='';await follow(participant,mode);
  };
  const resumeFollow=()=>{if(!watched)return;followTarget.current='';setFollowMode('follow');setWatchPaused(false);void follow(watched,'follow');};
  useEffect(()=>{
    if(!following||watchPaused||!watched?.connected)return;
    const focus=participantFocus(watched),key=JSON.stringify([following,focus]);
    if(key===followTarget.current||!focus?.documentId)return;
    void follow(watched);
  },[following,watchPaused,projectWork.work.participants]);
  const openChanges=async(scope?:Partial<PlaybackScope>,operation?:ActivityOperation)=>{
    const root=scope?.documentId?state.documents.find(d=>d.documentId===scope.documentId):state.documents.find(d=>d.documentId===state.projects.find(p=>p.projectId===projectId)?.mainAssemblyId)??doc;
    const id=root?.documentId??scope?.documentId??doc.documentId;
    historicalGeneration.current++;stopWatch();stopOrbit();chooseTool(null);setComparison(undefined);setHistorySelection([]);setSelectedAgent(undefined);setLeftTab('history');panels.set('left','expanded');
    await playbackController.openChanges({documentId:id,name:root?.name??'Historical design',projectId, ...scope,author:scope?.agentId?agentLabel(projectWork.work.participants.find(p=>p.identity.agentId===scope.agentId)?.identity.name??'Unknown agent'):undefined},{operation});
  };
  const viewOperation=async(operation:ActivityOperation)=>{
    if(!operation.documentId)return;panels.set('right','expanded');
    await openChanges({documentId:operation.documentId,filterDocumentId:operation.documentId},operation);
  };
  useEffect(()=>{historicalGeneration.current++;setComparison(undefined);},[playback.generation,playback.displayed]);
  useEffect(()=>{if(!playback.active)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!palette&&!help&&!settingsOpen&&!projectsOpen&&!document.querySelector('.shared-popover:not([aria-hidden=true])')){event.preventDefault();playbackController.close();setComparison(undefined);}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[playback.active,palette,help,settingsOpen,projectsOpen,playbackController]);
  const framedReplayScope=useRef<string|undefined>(undefined);
  useEffect(()=>{if(!playback.active){framedReplayScope.current=undefined;return;}if(playback.displayed&&playback.scope?.documentId!==framedReplayScope.current){framedReplayScope.current=playback.scope?.documentId;if(playback.scope?.documentId!==doc.documentId)setFitKey(k=>k+1);}},[playback.active,playback.displayed,playback.scope?.documentId,doc.documentId]);
  const switchReplayMode=(mode:PlaybackMode)=>{
    if(mode===playback.mode)return;
    if(mode==='changes')void openChanges(playback.scope);
    else playbackController.openConstruction({scope:playback.scope,document:playback.document,snapshot:playback.snapshot,prepareOnly:true});
  };
  const compareChange = async () => {
    if (comparison) { setComparison(undefined); return; }
    if (!reviewOperation?.documentId || !reviewOperation.fromVersion || !reviewOperation.commitSequence || !historicalView) return;
    const run = historicalGeneration.current; setComparisonLoading(true);
    try {
      const outcome = await runtime.replay({ type: 'inspect_model', params: { documentId: historicalView.document.documentId, snapshot: { sequence: reviewOperation.commitSequence - 1 } } });
      if (run !== historicalGeneration.current) return;
      if (outcome.result.status === 'error' || !outcome.evaluation || !outcome.result.document) throw new Error(outcome.result.error?.message ?? 'The previous revision is unavailable.');
      const before = outcome.result.document;
      setComparison({ evaluation: outcome.evaluation, appearances: new Map(before.features.map(f => [f.id, effectiveAppearance(before, f.id)])), revision: before.revision }); setComparisonPosition(.5);
    } catch (error) { if (run === historicalGeneration.current) setNotice({ kind: 'error', text: String(error) }); }
    finally { setComparisonLoading(false); }
  };

  const [restoring,setRestoring]=useState(false);
  const restoreHistorical = async () => {
    if(!historicalView||restoring)return;const captured=historicalView;setRestoring(true);
    try{
      const current=await runtime.replay({type:'inspect_model',params:{documentId:captured.document.documentId,definitionsOnly:true}});
      if(current.result.status==='error'||current.result.revision===undefined||!current.result.storageVersion)throw new Error(current.result.error?.message??'The current document is unavailable.');
      const confirmed=await dialogs.confirm({title:'Restore this document as a new revision?',
        body:<><p>Restore {captured.document.name} from r{captured.document.revision}. Later recorded changes remain in History, and Undo can reverse this restore.</p>{captured.snapshot.sources.length>0&&<p>Only this document is restored. Its source parts keep their current revisions; this does not roll back the entire assembly graph.</p>}</>,confirmLabel:'Restore as new revision'});
      if(!confirmed)return;
      const result=await track('document_action:load',()=>restoreDocument(runtime,captured.document,{revision:current.result.revision!,storageVersion:current.result.storageVersion!}));
      if(!fail(result))return;viewStep(null);await documentNavigation.navigate(captured.document.documentId);setNotice({kind:'info',text:`Document restored as r${result.revision}. Previous history is preserved.`});
    }catch(error){setNotice({kind:'error',text:String(error)});}finally{setRestoring(false);}
  };

  const agentTouched = useMemo(
    () => touchedByDocument.get(doc.documentId) ?? new Map<string, number>(),
    [touchedByDocument, doc.documentId]
  );
  // Who last committed a change to each feature, from attributed project history. Unknown stays unmarked.
  const authors = useMemo(() => {
    const people = new Map(projectWork.work.participants.map(p => [p.identity.agentId, p]));
    const map = new Map<string, Author>();
    for (const o of [...projectChanges.work.operations].sort((a, b) => (a.commitSequence ?? 0) - (b.commitSequence ?? 0))) {
      if (o.documentId !== doc.documentId || o.toVersion === undefined || !o.agentId) continue;
      const person = people.get(o.agentId);
      for (const id of o.featureIds) {
        if (person?.identity.kind === 'agent') map.set(id, { name: agentLabel(person.identity.name), color: agentColor(person.identity.agentId) });
        else map.delete(id);
      }
    }
    return map;
  }, [projectChanges.work.operations, projectWork.work.participants, doc.documentId]);
  const volumeDeltas = useMemo(() => new Map(entries.filter(e => e.volumeDelta !== undefined && e.documentId && e.revision !== undefined)
    .map(e => [`${e.documentId}:${e.revision}`, e.volumeDelta!])), [entries]);
  const historyActive = playback.active;
  const selected = historyActive ? historySelection : doc.selectedFeatureIds;
  // Picking a feature makes the right panel about that feature, not the agent that was open there.
  const selectionKey = selected.join('|');
  useEffect(() => { if (selectionKey && selectionKey !== followSelection.current) setSelectedAgent(undefined); }, [selectionKey]);
  const name = useCallback((id: string) => featureName(doc.features.find((f) => f.id === id)) || id, [doc]);

  useEffect(() => {
    const connection = new BrowserBridge(runtime, setConnection);
    bridge.current = connection;
    connection.start();
    return () => {
      connection.stop();
      bridge.current = null;
    };
  }, [runtime]);
  useEffect(() => {
    if (state.phase === 'ready')
      activity.observe(
        doc.documentId,
        state.evaluation.geometry
          .filter((g) => state.evaluation.visibleFeatureIds.includes(g.featureId))
          .reduce((sum, g) => sum + g.volumeMm3, 0)
      );
  }, [state.phase, doc.documentId]);
  useEffect(() => {
    if (notice?.kind !== 'info') return;
    const timer = setTimeout(() => setNotice(null), 3_500);
    return () => clearTimeout(timer);
  }, [notice]);

  const fail = (result: CadResult) => {
    if (result.status === 'error') setNotice({ kind: 'error', text: `${result.error!.message}` });
    return result.status === 'success';
  };
  const action = async (name: 'undo' | 'redo' | 'reset') => {
    if (disabled) return;
    if(getAppearanceFeedback()?.appearance){setNotice({kind:'info',text:'Apply or cancel the appearance preview first.'});return;}
    setNotice(null);
    if(name!=='reset'&&runtime.manualHistoryAction){fail(await track(`document_action:${name}`,()=>runtime.manualHistoryAction!(name)));return;}
    fail(
      await track(`document_action:${name}`, () =>
        runtime.execute({ type: 'document_action', params: { ...context(doc), action: name } })
      )
    );
  };
  const createDocument = async (kind: 'part' | 'assembly') => {
    if(!await confirmNavigation())return;
    const result = await track('documents:create', () =>
      runtime.execute({ type: 'documents', params: { action: 'create', kind, projectId: projectId ?? doc.projectId } })
    );
    if (fail(result)) {
      viewStep(null);chooseTool(null);setLeftTab('build');setAssemblyTrail([]);
      await documentNavigation.navigate(result.createdDocumentId??result.documentId!);
    }
  };
  const navigateDocument = async (documentId:string,featureId?:string,trail?:import('./ModelExplorer').ExplorerLocation[],confirmed=false) => {
    if(documentId!==runtime.getSnapshot().document.documentId&&!confirmed&&!await confirmNavigation())return;
    pauseWatch();viewStep(null);chooseTool(null);setSelectedAgent(undefined);
    try{await documentNavigation.navigate(documentId,featureId,trail);setLeftTab('build');}catch(error){setNotice({kind:'error',text:String(error)});}
  };
  const openPart = async (documentId: string) => {
    if(!await confirmNavigation())return;
    panels.set('right','expanded');
    pauseWatch();viewStep(null);chooseTool(null);
    try{await documentNavigation.openSource(documentId);setLeftTab('build');}catch(error){setNotice({kind:'error',text:String(error)});}
  };
  const backToAssembly = async () => {
    viewStep(null);chooseTool(null);
    try{await documentNavigation.returnToSourceParent();}catch(error){setNotice({kind:'error',text:String(error)});}
  };
  const exportFile = async (format: 'json' | 'step' | 'stl', featureId?: string) => {
    if (disabled) return;
    const result = await track('export_model', () =>
      runtime.execute({ type: 'export_model', params: { format, ...(featureId ? { featureId } : {}) } })
    );
    if (fail(result)) {
      download(result);
      setNotice({
        kind: 'info',
        text: `Exported ${result.artifact!.filename} · ${new Intl.NumberFormat('en').format(result.artifact!.byteLength)} bytes`,
      });
    }
  };
  const demo = async () => {
    if (
      doc.features.length &&
      !(await dialogs.confirm({
        title: 'Replace this document with the demo plate?',
        body: 'Save JSON first to keep a separate copy. One undo restores the previous features.',
        confirmLabel: 'Replace',
        danger: true,
      }))
    )
      return;
    setDemoBusy(true);
    setNotice(null);
    chooseTool(null);
    try {
      if (fail(await track('apply_edits', () => runtime.execute(demoCommand(doc))))) {
        setView('isometric');
        setFitKey((key) => key + 1);
      }
    } finally {
      setDemoBusy(false);
    }
  };
  const viewStep=(next:number|null)=>{
    setComparison(undefined);stopOrbit();setHistorySelection([]);
    if(next===null){historicalGeneration.current++;setHistoryExit(v=>v+1);playbackController.close();return;}
    if(tool)chooseTool(null);
    if(!playback.active)playbackController.openConstruction({step:next});
    else{playbackController.pause();playbackController.seek(next);}
  };
  const toggleReplay=()=>{
    stopOrbit();setLeftTab('build');panels.set('left','expanded');if(tool)chooseTool(null);
    if(playback.active)playbackController.toggle();
    else playbackController.openConstruction({prepareOnly:true});
  };
  const reset = async () => {
    if (await dialogs.confirm({ title: 'Reset this document to empty?', body: 'Undo can restore it during this session.', confirmLabel: 'Reset document', danger: true }))
      void action('reset');
  };
  const loadFile = async (file?: File) => {
    if (!file) return;
    setNotice(null);
    const target = context(doc);
    try {
      if (fail(await track('document_action:load', () => loadDocumentFile(runtime, file, target)))) {
        setFitKey((key) => key + 1);
        setNotice({ kind: 'info', text: `Loaded ${file.name}` });
      }
    } catch (error) {
      setNotice({
        kind: 'error',
        text: `Could not load JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (fileInput.current) fileInput.current.value = '';
  };
  function chooseTool(next: Tool | null) {
    if (next) { setNavigationTool('select'); setMeasuring(false); }
    if (next && following) pauseWatch();
    stopOrbit();
    setAnalysisOpen(false);
    setTool(next);
    setToolSession((i) => i + 1);
    setDraft(undefined);
    setMenu(null);
    setEdgePicking(false);
    if (next) setSheet('inspect');
  }
  function chooseNavigation(next: 'select' | 'pan' | 'orbit' | 'zoom') {
    chooseTool(null);
    setMeasuring(false);
    setNavigationTool(next);
  }
  function toggleMeasure() {
    stopOrbit();
    setNavigationTool('select');
    setMeasuring(on => !on);
  }
  const selectPersonal=async(ids:string[])=>{
    const active=runtime.getSnapshot().document;
    if(ids.join(',')===active.selectedFeatureIds.join(','))return;
    if(getAppearanceFeedback()?.appearance&&!await dialogs.confirm({title:'Discard appearance preview?',body:'The appearance has not been applied.',confirmLabel:'Discard preview'}))return;
    if(runtime.getSnapshot().document.documentId===active.documentId)await runtime.select(ids);
  };
  const select = (id?: string, additive = false) => {
    if (following) pauseWatch();
    stopOrbit();
    if (state.phase !== 'ready') return;
    const ids =
      (additive || addMode) && id
        ? selected.includes(id)
          ? selected.filter((v) => v !== id)
          : [...selected, id]
        : id
          ? [id]
          : [];
    if (historyActive) { setHistorySelection(ids); return; }
    void selectPersonal(ids);
    if (
      !analysisOpen &&
      tool &&
      tool !== 'delete' &&
      !(['move', 'rotate', 'scale'].includes(tool) && ids.length === 1)
    )
      chooseTool(null);
  };
  const selectIds = (ids: string[]) => {
    if (following) pauseWatch();
    if (historyActive) { setHistorySelection(ids); return; }
    if (state.phase === 'ready') void selectPersonal(ids.filter((id) => doc.features.some((f) => f.id === id)));
  };
  const gizmoEdit = async (edit: GizmoEdit) => {
    const instance =
      doc.documentId === edit.documentId
        ? doc.features.find((f) => f.id === edit.target && f.kind === 'instance')
        : undefined;
    if (instance?.kind === 'instance' && edit.scale === 1) {
      const result = await track('apply_edits', () =>
        runtime.execute({
          type: 'apply_edits',
          params: {
            documentId: edit.documentId,
            expectedRevision: edit.revision,
            edits: [{ op: 'update', feature: moveInstance(instance, edit) }],
          },
        })
      );
      if (fail(result)) {
        setToolSession((i) => i + 1);
        setDraft(undefined);
      }
      return;
    }
    const result = await track('apply_edits', () =>
      runtime.execute({
        type: 'apply_edits',
        params: {
          documentId: edit.documentId,
          expectedRevision: edit.revision,
          edits: [
            {
              op: 'add',
              feature: {
                id: nextFeatureId(doc, 'transform'),
                kind: 'transform',
                params: {
                  target: edit.target,
                  translation: edit.translation,
                  rotationAxis: edit.rotationAxis,
                  angleDegrees: edit.angleDegrees,
                  origin: edit.origin,
                  scale: edit.scale,
                  copy: false,
                },
              },
            },
          ],
        },
      })
    );
    if (result.status === 'success') {
      await runtime.select(result.created);
      setToolSession((i) => i + 1);
      setDraft(undefined);
    } else setNotice({ kind: 'error', text: `${result.error!.message} The committed model is unchanged.` });
  };
  useEffect(()=>{const hide=()=>{if(document.hidden){stopOrbit();playbackController.pause();}};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[playbackController]);
  const sectionRange = useMemo(() => {
    const bounds = modelBounds(state.evaluation);
    return { min: bounds.min, max: bounds.max };
  }, [state.evaluation]);
  function toggleSection() {
    setSection((current) =>
      current
        ? null
        : {
            axis: 0,
            offset: Math.round(((sectionRange.min[0] + sectionRange.max[0]) / 2) * 10) / 10,
            flip: false,
          }
    );
  }
  const sectionAxis = (axis: 0 | 1 | 2) =>
    setSection(
      (current) =>
        current && {
          ...current,
          axis,
          offset: Math.round(((sectionRange.min[axis] + sectionRange.max[axis]) / 2) * 10) / 10,
        }
    );
  const toolAvailable = (t: Tool) => !disabled && !unavailableReason(toolSpec(t), selected.length);
  const fit = () => { stopOrbit(); setFitKey(key => key + 1); };
  const setCamera = (next: ViewName) => {
    stopOrbit();
    setView(next);
    setFitKey((key) => key + 1);
  };

  useKeyboardShortcuts({
    studio,
    dialogOpen: palette || help,
    onPalette: () => setPalette((open) => !open),
    onHelp: () => setHelp(true),
    onUndo: () => void action('undo'),
    onRedo: () => void action('redo'),
    onSelectAll: () => selectIds(state.evaluation.visibleFeatureIds),
    onEscape: () => {
      if (studio) { setStudio(false); return; }
      if (menu) setMenu(null);
      else if (analysisOpen) setAnalysisOpen(false);
      else if (edgePicking) setEdgePicking(false);
      else if (measuring) setMeasuring(false);
      else if (playback.active) viewStep(null);
      else if (tool) chooseTool(null);
      else if (selected.length) selectIds([]);
    },
    onStep:(direction)=>{playbackController.pause();viewStep((playback.active?playback.requested:doc.features.length)+direction);},
    onFit: fit,
    onSnap: () => setSnap((on) => !on),
    onSection: toggleSection,
    onMeasure: toggleMeasure,
    onCamera: setCamera,
    onTool: chooseTool,
    toolAvailable,
  });

  const extraDisplayIds = [...new Set([...selected, ...(hoverGhost ? [hoverGhost] : [])])].filter(id=>!state.evaluation.visibleFeatureIds.includes(id));
  const displayRequest=!playback.active&&state.phase==='ready'&&state.storageVersion&&!livePreview&&(extraDisplayIds.length>0||displayDetail!=='auto')?{
    documentId:doc.documentId,params:{expectedRevision:doc.revision,expectedStorageVersion:state.storageVersion,detail:displayDetail,featureIds:extraDisplayIds},
    key:JSON.stringify([doc.documentId,doc.revision,state.storageVersion,state.evaluation.references,extraDisplayIds,displayDetail])
  }:undefined;
  const displayProjection=useDisplayProjection(runtime,displayRequest);
  useEffect(()=>{
    const text=displayProjection.error;if(!text)return;
    setNotice({kind:text==='A source changed. Refreshing the latest model.'?'info':'error',text});
    return()=>setNotice(current=>current?.text===text?null:current);
  },[displayProjection.error]);

  // What the viewport shows: a history step, an exact uncommitted preview, or the committed model.

  // A stable object, so a selection change does not hand the viewport a "new" model to rebuild.
  const projected = useMemo(() => displayProjection.frame ? { ...displayProjection.frame, analysis: state.evaluation.analysis } : undefined, [displayProjection.frame, state.evaluation.analysis]);
  const shown = useMemo<{
    evaluation: Evaluation;
    selected: string[];
    mode: 'history' | 'preview' | 'live';
  }>(() => {
    if(playback.active){
      const frame=playback.frame??state.evaluation;
      const affected=playback.mode==='changes'&&playback.operation?.documentId===playback.document?.documentId?playback.operation?.featureIds:playback.mode==='construction'?playback.detail==='components'?[playback.replay?.steps[(playback.displayed||1)-1]?.path[0]?.featureId]:[playback.document?.features[(playback.displayed||1)-1]?.id]:[];
      return{evaluation:frame,selected:historySelection.length?historySelection:(affected??[]).filter((id):id is string=>!!id&&frame.visibleFeatureIds.includes(id)),mode:'history'};
    }
    if (livePreview && !edgePicking)
      return { evaluation: livePreview.evaluation, selected: livePreview.focus, mode: 'preview' };
    if (displayRequest && displayProjection.error) return {evaluation:{geometry:[],meshes:[],visibleFeatureIds:[]},selected,mode:'live'};
    return { evaluation: projected ?? state.evaluation, selected, mode: 'live' };
  }, [historySelection, playback, doc, state.evaluation, livePreview, selected, edgePicking, displayProjection.frame, displayProjection.error, displayRequest?.key, projected]);
  const ghosts = useMemo(() => {
    const ids = shown.selected.filter(
      (id) =>
        !shown.evaluation.visibleFeatureIds.includes(id) &&
        shown.evaluation.meshes.some((m) => m.featureId === id)
    );
    if (shown.mode === 'live' && hoverGhost && !ids.includes(hoverGhost)) ids.push(hoverGhost);
    return ids;
  }, [shown, hoverGhost]);
  const openAnalysis = async () => {
    panels.set('right','expanded');
    playbackController.close();
    setAnalysisOpen(!!tool);
    setEdgePicking(false);


    setSheet('inspect');
    await runtime.select([]);
    requestAnimationFrame(() => {
      const panel = document.getElementById('physical-analysis');
      const findings = panel?.querySelector<HTMLDetailsElement>('.health-details'); if (findings) findings.open = true;
      panel?.scrollIntoView({ block: 'nearest' });
      panel?.focus({ preventScroll: true });
    });
  };
  const flagged = useMemo(() => flaggedParts(state), [state.evaluation]);
  const edgePick = useMemo(
    () =>
      edgePicking &&
      (draft?.kind === 'fillet' || draft?.kind === 'chamfer') &&
      typeof draft.params.edges === 'object'
        ? { target: draft.params.target, points: draft.params.edges.near ?? [] }
        : undefined,
    [edgePicking, draft]
  );
  const appearances = useMemo(
    () => new Map(shown.evaluation.visibleFeatureIds.map((id) => [id, effectiveAppearance(historicalView?.document ?? doc, id)])),
    [doc, historicalView?.document, shown.evaluation]
  );
  const contributionHighlight = useMemo(() => shown.mode !== 'live' ? undefined
    : agentHighlight?.documentId === doc.documentId ? { ids: agentHighlight.ids, color: agentHighlight.color }
    : contribution ? {
    ids: contribution.documentId === doc.documentId ? contribution.featureIds : doc.features.filter(f => f.kind === 'instance' && f.params.document === contribution.documentId).map(f => f.id),
    color: agentColor(contribution.agentId ?? ''),
  } : undefined, [contribution, agentHighlight, shown.mode, doc]);
  const pick = useMemo<HolePreview | undefined>(
    () =>
      tool === 'drill_holes' && draft?.kind === 'drill_holes' && draft.params.target
        ? {
            target: draft.params.target,
            surfaces: [draft.params.target, draft.id],
            centers: draft.params.centers,
            diameter: draft.params.diameter,
            axis: draft.params.axis,
          }
        : undefined,
    [tool, draft]
  );
  const gizmoMode =
    !analysisOpen && !disabled && selected.length === 1 && tool && ['move', 'rotate', 'scale'].includes(tool) && !doc.features.some(f => f.id === selected[0] && f.kind === 'instance' && f.params.attachment)
      ? (tool as 'move' | 'rotate' | 'scale')
      : undefined;
  // Parts an agent changed in the last two minutes, for the live marker in the document switcher.
  const agentDocuments = useMemo(
    () =>
      new Set(
        entries
          .filter((e) => e.actor === 'agent' && e.documentId && Date.now() - e.at < 120_000)
          .map((e) => e.documentId!)
      ),
    [entries]
  );
  // Switching parts leaves any history view, tool and preview behind.
  useEffect(() => {
    setComparison(undefined); setContribution(undefined);

    historicalGeneration.current++;playbackController.close();


    playbackController.close();
    chooseTool(null);
    setFitKey((key) => key + 1);
  }, [doc.documentId]);

  // Switching project opens its main assembly or its most recent document, so the view matches the project.
  const confirmNavigation=async()=>{
    if(getAppearanceFeedback()?.appearance){if(!await dialogs.confirm({title:'Discard appearance preview?',body:'The appearance has not been applied.',confirmLabel:'Discard preview'}))return false;}
    if(!(tool||formPreview||parameterPreview||studioRisk.draft||studioRisk.rendering))return true;
    return dialogs.confirm({title:'Leave this design?',body:<>{(tool||formPreview||parameterPreview||studioRisk.draft)&&<p>Unapplied edits in this design will be discarded.</p>}{studioRisk.rendering&&<p>The active render will be stopped.</p>}</>,confirmLabel:'Leave design'});
  };
  const openFromBrowser=async(id:string)=>{if(id!==runtime.getSnapshot().document.documentId){if(!await confirmNavigation())return;await navigateDocument(id,undefined,undefined,true);}closeProjects();};
  const chooseProject = async(id: string) => {
    const snapshot=runtime.getSnapshot(),project=snapshot.projects.find(p=>p.projectId===id),target=project&&projectDocument(project,snapshot.documents);
    if(!target){setNotice({kind:'info',text:'This project has no documents. Create a part in the project browser.'});setProjectsOpen(true);return;}
    if(snapshot.document.projectId===id)return;
    if(!await confirmNavigation())return;
    setProjectId(id);await navigateDocument(target.documentId,undefined,undefined,true);setSheet(null);
  };
  const showDetails = () => { setSelectedAgent(undefined); setSheet('inspect'); };
  const renameFeature = async (id: string) => {
    const feature = doc.features.find(f => f.id === id);
    if (!feature) return;
    const label = await dialogs.prompt({ title: 'Rename feature', label: 'Name', initial: featureName(feature), confirmLabel: 'Rename' });
    if (label && label !== featureName(feature)) fail(await track('apply_edits', () => runtime.execute({ type: 'apply_edits', params: { ...context(doc), edits: [{ op: 'patch', id, label }] } })));
  };
  const contextItems = (id?: string): ContextEntry[] => {
    const feature = id ? doc.features.find(f => f.id === id) : undefined;
    const navigationEntries: ContextEntry[] = [
      { label: 'Select', icon: 'select', onSelect: () => chooseNavigation('select') },
      { label: 'Pan', icon: 'hand', onSelect: () => chooseNavigation('pan') },
      { label: 'Orbit', icon: 'rotate', onSelect: () => chooseNavigation('orbit') },
      { label: 'Zoom', icon: 'search', onSelect: () => chooseNavigation('zoom') },
      { label: 'Fit model', icon: 'fit', hint: 'F', onSelect: fit },
      ...(selected.length ? [{ label: 'Focus selection', icon: 'fit' as const, onSelect: () => viewportApi.current?.frame() }] : []),
      'separator',
    ];
    if (!feature) return [
      ...navigationEntries,

      { label: 'Select all results', icon: 'select', hint: `${'⌘'}A`, disabled, onSelect: () => selectIds(state.evaluation.visibleFeatureIds) },
      { label: 'Clear selection', icon: 'close', hint: 'Esc', disabled: !selected.length, onSelect: () => selectIds([]) },
      'separator',
      { label: 'Search commands…', icon: 'search', hint: '⌘K', onSelect: () => setPalette(true) },
    ];
    const many = selected.length > 1 && selected.includes(feature.id);
    const inputs = references(feature).filter(ref => doc.features.some(f => f.id === ref));
    const usedBy = doc.features.filter(f => references(f).includes(feature.id)).map(f => f.id);
    const toolItem = (t: Tool, label?: string): ContextEntry => ({ label: label ?? toolSpec(t).label, icon: toolSpec(t).icon, hint: toolSpec(t).shortcut, disabled: !toolAvailable(t), onSelect: () => chooseTool(t) });
    if (many) return [
      ...navigationEntries,
      {label:'Extract to part…',icon:'box',disabled,onSelect:()=>setExtracting(selected)},
      toolItem('union'), toolItem('subtract'), toolItem('intersect'), 'separator', toolItem('delete', `Delete ${selected.length} features…`),
    ];
    const visible = state.evaluation.visibleFeatureIds.includes(feature.id);
    return [
      ...navigationEntries,
      {label:'Extract to part…',icon:'box',disabled:disabled||!state.evaluation.visibleFeatureIds.includes(feature.id),onSelect:()=>setExtracting([feature.id])},
      { label: 'Show details', icon: 'inspector', onSelect: showDetails },
      { label:'Part history',icon:'history',onSelect:()=>void openChanges({documentId:doc.documentId,filterDocumentId:doc.documentId}) },
      ...(feature.kind==='instance'?[
        {label:'Source history',icon:'history' as const,onSelect:()=>void openChanges({documentId:feature.params.document,filterDocumentId:feature.params.document})},
        {label:'Placement history',icon:'history' as const,onSelect:()=>void openChanges({documentId:doc.documentId,filterDocumentId:doc.documentId,featureId:feature.id,name:`${doc.name} / ${featureName(feature)}`})}
      ]:[]),
      { label: 'Rename…', icon: 'rename', disabled, onSelect: () => void renameFeature(feature.id) },
      ...(feature.kind === 'instance' ? [{ label: 'Open part', icon: 'box' as const, disabled, onSelect: () => void openPart(feature.params.document) }] : []),
      'separator',
      toolItem('move'), toolItem('rotate'), toolItem('duplicate'),
      'separator',
      { label: inputs.length ? `Select inputs (${inputs.length})` : 'Select inputs', icon: 'layers', disabled: !inputs.length, onSelect: () => selectIds(inputs) },
      { label: usedBy.length ? `Select used by (${usedBy.length})` : 'Select used by', icon: 'layers', disabled: !usedBy.length, onSelect: () => selectIds(usedBy) },
      ...(visible ? ['separator' as const,
        { label: 'Export STEP', icon: 'export' as const, hint: 'this result', disabled, onSelect: () => void exportFile('step', feature.id) },
        { label: 'Export STL', icon: 'export' as const, hint: 'this result', disabled, onSelect: () => void exportFile('stl', feature.id) }] : []),
      'separator',
      toolItem('delete', 'Delete…'),
    ];
  };
  const openContextMenu = (id: string | undefined, x: number, y: number) => {
    if (shown.mode === 'history') return;
    if (id && !selected.includes(id)) select(id);
    setMenu(null);
    setContextMenu({ x, y, id });
  };

  const paletteItems = workspaceCommands({
    state:runtime.manualHistoryTarget?{...state,canUndo:!!runtime.manualHistoryTarget('undo'),canRedo:!!runtime.manualHistoryTarget('redo')}:state,
    disabled,
    snap,
    step,
    section,
    measuring,
    chooseTool,
    action,
    setCamera,
    toggleReplay,
    viewStep,
    toggleSection,
    setMeasuring: value => { stopOrbit(); setNavigationTool('select'); setMeasuring(value); },
    setFitKey: value => { stopOrbit(); setFitKey(value); },
    setSnap,
    selectIds,
    exportFile,
    fileInput,
    demo,
    reset,
    setLeftTab,
    setSheet,
    setHelp,
  });

  const mainViewport = (<Viewport
          preview={shown.mode==='preview'}
          studioLooks={matchStudio?doc.presentation:undefined}
          fitOnResize={agentSplit}
          api={viewportApi}
          navigationTool={navigationTool}
          compare={historicalView && step === null ? comparison : undefined}
          comparePosition={comparisonPosition}
          contribution={contributionHighlight}
          navigation={navigation}
          dark={theme === 'dark'}
          onInteraction={() => { if (following && !watchPaused) pauseWatch(); }}
          history={shown.mode === 'history'}
          edges={edges}
          orbiting={orbiting}
          onStopOrbit={stopOrbit}
          evaluation={shown.evaluation}
          selected={shown.selected}
          ghosts={ghosts}
          view={view}
          fitKey={fitKey}
          onSelect={select}
          onContextMenu={openContextMenu}
          documentId={doc.documentId}
          revision={doc.revision}
          storageVersion={state.storageVersion}
          gizmoMode={gizmoMode}
          snap={snap}
          onTransform={gizmoEdit}
          name={name}
          pick={analysisOpen || shown.mode === 'history' ? undefined : pick}
          section={section ?? undefined}
          measure={measuring}
          flagged={shown.mode === 'live' ? flagged : undefined}
          appearances={appearances}
          edgePick={analysisOpen || shown.mode === 'history' ? undefined : edgePick}
          onPick={(point, axis) => setPickEvent((prev) => ({ seq: (prev?.seq ?? 0) + 1, point, axis }))}
        />);

  return (
    <div className={`app ${enteringWorkspace ? 'workspace-enter' : ''} ${sheet ? `sheet-${sheet}` : ''}`} data-left-panel={panels.left} data-right-panel={panels.right} onKeyDownCapture={e=>{if(following&&e.key==='Escape')pauseWatch();}}>
      <TopBar
        onBrowse={()=>void(async()=>{if(await dialogs.confirm({title:'Browse all projects?',body:'Open the project selector. This workspace stays open underneath so you can return without rebuilding the model.',confirmLabel:'All projects'}))setProjectsOpen(true);})()}
        projectControl={<ProjectSwitcher runtime={runtime} projects={state.projects} documents={state.documents} projectId={projectId} disabled={working} open={menu==='projects'} onToggle={setMenu} onNotice={setNotice} onChoose={id=>{setMenu(null);void chooseProject(id);}} onBrowse={()=>setProjectsOpen(true)} onBeforeChange={confirmNavigation}/>}
        selectionPath={<span className="location-path">{assemblyTrail.map((entry,index)=><span key={`${entry.documentId}-${index}`}><button type="button" aria-label={`Back to ${entry.name}`} title={entry.name} onClick={()=>void navigateDocument(entry.documentId,entry.selection[0],assemblyTrail.slice(0,index))}>{shortDocumentName(entry.name,state.projects.find(p=>p.projectId===projectId)?.name)}</button><span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={12}/></span></span>)}<strong title={historicalView?.document.name??doc.name}>{shortDocumentName(historicalView?.document.name??doc.name,state.projects.find(p=>p.projectId===projectId)?.name)}</strong>{selected.length===1&&<><span className="crumb-sep" aria-hidden="true"><Icon name="chevron" size={12}/></span><span>{featureName((historicalView?.document??doc).features.find(f=>f.id===selected[0]))}</span></>}<span className="rev">r{historicalView?.document.revision??doc.revision}</span></span>}
        studio={state.workspaceView?.state.mode==='studio'||studio}
        onStudio={() => { const next=state.workspaceView?state.workspaceView.state.mode!=='studio':!studio;runtime.dismissWorkspaceView?.();stopOrbit(); setMenu(null); setSheet(null); if (next) { chooseTool(null); viewStep(null); setSection(null); setMeasuring(false); } setStudio(next); }}
        history={shown.mode === 'history'}
        agents={agents}
        onAgents={()=>{setLeftTab('agents');panels.set('left','expanded');setSheet('build');}}
        projectId={projectId}
        state={state}
        connection={connection}
        disabled={disabled}
        working={working}
        menu={menu}
        setMenu={setMenu}
        sheet={sheet}
        setSheet={setSheet}
        documentNavigation={{...documentNavigation,back:async()=>{if(await confirmNavigation())await documentNavigation.back();},forward:async()=>{if(await confirmNavigation())await documentNavigation.forward();}}}
        onSettings={()=>setSettingsOpen(true)}
        setNotice={setNotice}
        openAnalysis={openAnalysis}
        action={action}
        manualHistory={!!runtime.manualHistoryAction} undoTarget={runtime.manualHistoryTarget?.('undo')?.name} redoTarget={runtime.manualHistoryTarget?.('redo')?.name}
        exportFile={exportFile}
        fileInput={fileInput}
        loadFile={loadFile}
        setPalette={setPalette}
        setHelp={setHelp}
        name={name}
      />

      {state.phase === 'error' && (
        <div className="banner" role="alert">
          <Icon name="warning" size={16} />
          <span>Node authority unavailable. {state.error} Editing resumes after reconnection.</span>
          <button type="button" className="primary-button" onClick={() => void runtime.retryInitialization()}>
            Retry workspace
          </button>
        </div>
      )}
      {state.phase === 'ready' && state.displayStatus === 'failed' && (
        <div className="banner" role="alert">
          <Icon name="warning" size={16} />
          <span>This model couldn't load. {state.error} Your saved projects are available in the project menu.</span>
          <button type="button" className="primary-button" onClick={() => void runtime.openDocument(doc.documentId)}>
            Retry model
          </button>
        </div>
      )}

      {projectsOpen&&<ProjectBrowser runtime={runtime} state={state} onClose={closeProjects} onOpen={openFromBrowser} onBeforeChange={confirmNavigation}/>}
      {settingsOpen&&<WorkspaceSettings navigation={navigation} onNavigation={value=>{setNavigation(value);saveStudioNavigation(value);}} detail={displayDetail} onDetail={setDisplayDetail} onClose={()=>setSettingsOpen(false)} onHelp={()=>{setSettingsOpen(false);setHelp(true);}}/>}
      <main className={`stage ${studio ? 'studio-stage' : ''} ${agentSplit ? `agent-stage ${tool || selected.length || selectedAgent || analysisOpen ? 'agent-stage-inspecting' : ''}` : ''}`}>
        {state.workspaceView ? <WorkspacePresentation key={state.workspaceView.requestId} runtime={runtime} state={state} request={state.workspaceView} onClose={()=>runtime.dismissWorkspaceView?.()}/>
        : studio ? <StudioWorkspace key={doc.documentId} runtime={runtime} state={state} disabled={disabled} onNavigationRisk={setStudioRisk}/> : <>
        {agentSplit ? <AgentViews key={projectId} runtime={runtime} projectId={projectId!}
          projectName={state.projects.find(p => p.projectId === projectId)?.name ?? 'Project'} ids={liveViewIds}
          mainView={mainViewport} mainDocument={doc} onFitMain={() => viewportApi.current?.fit()}
          participants={agents} documents={state.documents} dark={theme === 'dark'} navigation={navigation}
          changeSequence={Math.max(0, ...projectChanges.work.operations.filter(o => o.toVersion !== undefined).map(o => o.sequence))}
          onRemove={id => setLiveViews(liveViewIds.filter(value => value !== id))} onClose={() => setLiveViews([])} /> : mainViewport}

        <BuildPanel
          mode={panels.left} restoreMode={panels.open.left} onMode={mode=>panelMode('left',mode)}
          projectContent={<ModelExplorer onExtract={()=>setExtracting(selected.filter(id=>state.evaluation.visibleFeatureIds.includes(id)))} runtime={runtime} state={state} disabled={disabled} onSelect={select} onNavigate={navigateDocument} onHover={setHoverGhost} onMenu={openContextMenu} trail={assemblyTrail} onCreate={createDocument} onNotice={setNotice} onDocumentNavigate={()=>{pauseWatch();viewStep(null);chooseTool(null);}} agentDocuments={agentDocuments} onReplay={toggleReplay} replaying={replaying} onHistory={id=>void openChanges({documentId:id,filterDocumentId:id})}/>}
          playbackContent={playback.active?<ReplayPlayer controller={playbackController} state={playback} onMode={switchReplayMode}/>:undefined}
          historyContent={<RevisionHistory work={projectChanges.work} documents={state.documents} loading={projectChanges.loading} error={projectChanges.error} onView={viewOperation} selected={reviewOperation?.operationId} loadEarlier={projectChanges.loadEarlier} onPlay={(documentId,agentId)=>void openChanges({...(documentId?{documentId,filterDocumentId:documentId}:{}),agentId})}/>}
          runtime={runtime}
          state={state}
          disabled={disabled}
          leftTab={leftTab}
          setLeftTab={setLeftTab}
          liveAgents={agents.filter(p=>p.connected).length}
          setParameterPreview={setParameterPreview}
          agentsContent={<AgentsTab sideViews={liveViewIds} deltas={volumeDeltas} runtime={runtime} changes={projectChanges} work={projectWork.work} error={projectWork.error} documents={state.documents}
            projects={state.projects} projectId={projectId} connection={connection} doc={doc} selected={selectedAgent}
            followPaused={watchPaused || followMode === 'show'} canAddSide={liveViewIds.length < MAX_AGENT_FOLLOWERS}
            onToggleFollow={p=>{if(following===p.identity.agentId){if(watchPaused||followMode==='show')resumeFollow();else pauseWatch();}else void startFollow(p,'follow').catch(error=>setNotice({kind:'error',text:String(error)}));}}
            onToggleSide={id=>setLiveViews(liveViewIds.includes(id)?liveViewIds.filter(value=>value!==id):[...liveViewIds,id],true)}
            onSelect={id=>{setSelectedAgent(id);if(id)setSheet('inspect');}} following={following} onView={viewOperation} viewing={playback.active?playback.operation?.operationId:undefined} onPlayChanges={agentId=>void openChanges({agentId})}
            loadEarlier={projectWork.loadEarlier} cancelKey={historyExit} reconnect={() => bridge.current?.reconnect()} />}
        />
        {shown.mode === 'history' && !agentInFocus ? <FloatingPanel side="right" mode={panels.right} restoreMode={panels.open.right} onMode={mode=>panelMode('right',mode)} label="Details" compact={<div className="compact-inspector"><strong>{historicalView?.document.name??'Construction replay'}</strong><p>{historicalView?`Recorded revision r${historicalView.document.revision}`:'View only'}</p><button type="button" className="ghost-button" onClick={()=>panelMode('right','expanded')}>Review this state</button><button type="button" className="ghost-button" onClick={()=>viewStep(null)}>Return to latest</button></div>}>
          <header className="card-head">
            <span className="tool-glyph"><Icon name="history" size={20} /></span>
            <div><h2>{playback.mode==='changes'?'Recorded change':'Construction replay'}</h2><p>{playback.scope?.name} · {playback.displayed?`Showing ${playback.displayed} of ${playback.total}`:'Preparing first frame'} · view only</p></div>
          </header>
          <div className="card-body">
            <p className="field-hint">Select a visible result to inspect this state. Return to latest to edit.</p>
            {historicalView&&<div className="history-actions"><button type="button" className="ghost-button" disabled={comparisonLoading||!reviewOperation?.fromVersion||!reviewOperation.commitSequence||reviewOperation.action==='delete'} onClick={()=>void compareChange()}>{comparison?'Single view':'Compare before / after'}</button><button type="button" className="primary-button" disabled={restoring||reviewOperation?.documentId!==historicalView.document.documentId||!state.documents.some(d=>d.documentId===historicalView.document.documentId)} onClick={()=>void restoreHistorical()}>{restoring?'Restoring…':'Restore as new revision'}</button><p className="field-hint">Restores this document only. Source parts keep their current revisions.</p></div>}
            {playback.loading&&<p className="field-hint" role="status">Preparing {playback.requested}; the last valid frame remains visible.</p>}
            {displayProjection.error && <p className="notice error" role="alert"><Icon name="warning" size={16} /><span>{displayProjection.error} Return to latest or choose coarser display detail.</span></p>}
            {shown.evaluation.geometry.filter(info => shown.selected.includes(info.featureId)).map(info => <section key={info.featureId}>
              <h3>{info.featureId}</h3><dl className="metric-grid">
                <div><dt>Exact volume</dt><dd>{info.volumeMm3.toFixed(2)} mm³</dd></div>
                <div className="span-2"><dt>Size</dt><dd>{info.bounds.size.map(v => v.toFixed(2)).join(' × ')} mm</dd></div>
                <div><dt>Solid validity</dt><dd>{info.valid ? 'Valid' : 'Invalid'}</dd></div>
              </dl></section>)}

          </div>
        </FloatingPanel> : <InspectPanel
          mode={panels.right} restoreMode={panels.open.right} onMode={mode=>panelMode('right',mode)}
          drafting={!!formPreview}
          override={agentInFocus && <AgentDetail key={agentInFocus.identity.agentId} participant={agentInFocus} participants={projectWork.work.participants}
            projects={state.projects} projectId={projectId} documents={state.documents} viewing={doc}
            commits={projectChanges.work.operations} operations={projectWork.work.operations}
            follow={following === agentInFocus.identity.agentId ? { mode: followMode, paused: watchPaused } : undefined}
            sideView={liveViewIds.includes(agentInFocus.identity.agentId)} canAddSide={liveViewIds.length < MAX_AGENT_FOLLOWERS}
            onShowWork={() => void startFollow(agentInFocus, 'show').catch(error => setNotice({ kind: 'error', text: String(error) }))}
            onFollow={() => void startFollow(agentInFocus, 'follow').catch(error => setNotice({ kind: 'error', text: String(error) }))}
            onPauseFollow={pauseWatch} onResumeFollow={resumeFollow} onReturn={() => stopWatch(true)}
            onToggleSide={() => { const id = agentInFocus.identity.agentId; setLiveViews(liveViewIds.includes(id) ? liveViewIds.filter(value => value !== id) : [...liveViewIds, id], true); }}
            onHighlight={ids => setAgentHighlight({ documentId: doc.documentId, ids, color: agentColor(agentInFocus.identity.agentId) })}
            onReviewChange={operation => void viewOperation(operation).catch(error => setNotice({ kind: 'error', text: String(error) }))}
            onClose={() => setSelectedAgent(undefined)} />}
          runtime={runtime}
          state={state}
          disabled={disabled}
          analysisOpen={analysisOpen}
          tool={tool}
          toolSession={toolSession}
          setAnalysisOpen={setAnalysisOpen}
          selectIds={selectIds}
          pickEvent={pickEvent}
          setDraft={setDraft}
          setFormPreview={setFormPreview}
          edgePicking={edgePicking}
          setEdgePicking={setEdgePicking}
          onDone={(created) => {
            chooseTool(null);
            if (created?.length) void runtime.select(created);
          }}
          agentTouched={agentTouched}
          openPart={openPart}
        />}

        {!agentSplit && <>
        {following&&<div className="frozen-context follow-bar" role="status">
          {watched&&<AgentMark id={watched.identity.agentId} size={20}/>}
          <span>{historicalLoading?'Loading historical graph…':(()=>{const who=agentLabel(watched?.identity.name??'Agent'),where=watched&&projectId?agentViewTarget(watched,projectId,state.documents):undefined,design=where?` · ${shortDocumentName(where.name,state.projects.find(p=>p.projectId===projectId)?.name)}`:'';
            if(followMode==='show')return `Showing ${who}'s work${design}`;
            if(watchPaused)return `Following ${who} · paused${design}`;
            return `Following ${who}${design} · ${watched?agentActivity(watched).label:'waiting for contact'}${watched&&!watched.connected&&watched.session?.workState!=='completed'?' · resumes on reconnect':''}`;})()}</span>
          <button className="ghost-button" type="button" onClick={() => viewportApi.current?.frame()}>Frame</button>
          {followMode==='show'||watchPaused?<button className="ghost-button" type="button" disabled={!watched?.connected} onClick={resumeFollow}><Icon name="play" size={14}/>{followMode==='show'?'Follow live':'Resume'}</button>:<button className="ghost-button" type="button" onClick={pauseWatch}><Icon name="pause" size={14}/>Pause</button>}
          <button className="primary-button" type="button" onClick={() => stopWatch(true)}>Return to my view</button>
          <button className="icon-button quiet" type="button" aria-label="Stop following and stay here" title="Stop following and stay here" onClick={() => stopWatch(false)}><Icon name="close" size={14}/></button>
          {historicalView && reviewOperation?.fromVersion && reviewOperation.commitSequence && reviewOperation.action !== 'delete' && <button type="button" className="ghost-button" disabled={comparisonLoading} onClick={() => void compareChange()}>{comparisonLoading ? 'Loading comparison…' : comparison ? 'Single view' : 'Compare before / after'}</button>}
        </div>}
        {comparison && historicalView && <><ComparisonSplit value={comparisonPosition} onChange={setComparisonPosition} /><div className="comparison-control" data-inset="bottom"><span>Before · r{comparison.revision}</span><input type="range" min="0" max="1" step=".01" value={comparisonPosition} aria-label="Before and after split" onChange={e => setComparisonPosition(Number(e.target.value))} /><span>After · r{historicalView.document.revision}</span></div></>}
        {contribution && !historyActive && !following && <button type="button" className="contribution-receipt" onClick={() => void viewOperation(contribution).catch(error => setNotice({ kind: 'error', text: String(error) }))}><AgentMark id={contribution.agentId ?? ''} size={28} /><span>{agentLabel(projectWork.work.participants.find(p => p.identity.agentId === contribution.agentId)?.identity.name ?? 'Agent')}<small>{shortDocumentName(state.documents.find(d => d.documentId === contribution.documentId)?.name ?? 'Project', state.projects.find(p => p.projectId === projectId)?.name)} · r{contribution.revision}{contribution.status !== 'success' ? ' · delivery unresolved' : ''}</small></span><Icon name="eye" size={15} /></button>}
        <ViewControls
          matchStudio={matchStudio} onMatchStudio={()=>setMatchStudio(value=>!value)}
          onNormalTo={() => { chooseNavigation('select'); viewportApi.current?.normalTo(); }}
          navigationTool={navigationTool} onNavigationTool={chooseNavigation}
          navigation={navigation} onNavigation={value => { setNavigation(value); saveStudioNavigation(value); }}
          edges={edges} onEdges={() => setEdges(value => !value)} orbiting={orbiting}
          detail={displayDetail} onDetail={value=>{stopOrbit();setDisplayDetail(value);}}
          orbitDisabled={working || playback.active || !!tool || !!state.evaluation.referenceError || !state.evaluation.visibleFeatureIds.length}
          onOrbit={() => setOrbiting(value => !value)}
          view={view}
          setCamera={setCamera}
          menu={menu}
          setMenu={setMenu}
          section={section}
          setSection={setSection}
          sectionAxis={sectionAxis}
          sectionRange={sectionRange}
          toggleSection={toggleSection}
          measuring={measuring}
          snap={snap}
          onFit={fit}
          onMeasure={toggleMeasure}
          onSnap={() => setSnap((on) => !on)}
        />

        <WorkspaceStatus
          state={state}
          tool={tool}
          disabled={disabled}
          chooseTool={chooseTool}
          demo={demo}
          openFile={() => fileInput.current?.click()}
          connection={connection}
          projectName={state.projects.find(p => p.projectId === doc.projectId)?.name}
        />
        {!playback.active&&<OperationDock
          replayLabel={playback.active?{title:playback.mode==='changes'?'Recorded changes':'Construction',detail:playback.error??(playback.loading?`Preparing ${playback.requested} · showing ${playback.displayed||'current design'}`:`Showing ${playback.displayed} of ${playback.total}`)}:undefined}
          doc={doc}
          tool={tool}
          disabled={disabled}
          menu={menu}
          setMenu={setMenu}
          chooseTool={chooseTool}
          name={name}
          selectIds={selectIds}
          notice={notice}
          setNotice={setNotice}
          measuring={measuring}
          previewing={shown.mode === 'preview'}
          step={step}
          replaying={replaying}
          agentTouched={agentTouched}
          toggleReplay={toggleReplay}
          replaySpeed={playback.speed}
          cycleSpeed={()=>playbackController.setSpeed(playback.speed===16?1:playback.speed*2)}
          viewStep={viewStep}
          addMode={addMode}
          setAddMode={setAddMode}
        />}
        </>}
        </>}
      </main>


      {palette && <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />}
      {extracting&&<ExtractDialog runtime={runtime} state={state} initial={extracting} onClose={()=>setExtracting(null)}/>}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} title={contextMenu.id ? name(contextMenu.id) : undefined}
        items={contextItems(contextMenu.id)} onClose={() => setContextMenu(undefined)} />}
      <DialogHost />
      {help && <KeyboardHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
