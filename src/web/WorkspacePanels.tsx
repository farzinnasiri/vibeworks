import type { ReactNode } from 'react';
import type { RuntimeClient, RuntimeState } from '../cad/runtime';
import type { Feature } from '../shared/protocol';
import { Icon } from './icons';
import { ParametersPanel } from './ParametersPanel';
import { AnalysisPanel } from './AnalysisPanel';
import { ToolCard, type PickEvent } from './ToolCard';
import { Inspector } from './Inspector';
import { toolSpec, type Tool } from './modeling';
import type { LivePreview } from './preview';
import {FloatingPanel,type PanelMode} from './FloatingPanel';
import {featureName,fmt,kindLabels} from './modeling';

export type LeftTab = 'build' | 'parameters' | 'agents' | 'project' | 'history';
interface BuildPanelProps {
 mode:PanelMode;restoreMode:PanelMode;onMode:(mode:PanelMode)=>void;
 playbackContent?:ReactNode;projectContent:ReactNode;historyContent:ReactNode;agentsContent:ReactNode;liveAgents:number;
 runtime:RuntimeClient;state:RuntimeState;disabled:boolean;leftTab:LeftTab;setLeftTab:(tab:LeftTab)=>void;
 setParameterPreview:(preview?:LivePreview)=>void;
}
export function BuildPanel({mode,restoreMode,onMode,projectContent,playbackContent,historyContent,agentsContent,liveAgents,runtime,state,disabled,leftTab,setLeftTab,setParameterPreview}:BuildPanelProps){
  const doc = state.document;
  return (
    <FloatingPanel side="left" mode={mode} onMode={onMode} restoreMode={restoreMode} label="Model" heading="Project"
      compact={leftTab==='parameters'||leftTab==='agents'?<div className="compact-inspector"><strong>{leftTab==='parameters'?'Variables':'Activity'}</strong><p>{leftTab==='parameters'?doc.name:liveAgents?`${liveAgents} connected ${liveAgents===1?'agent':'agents'}`:'No agents connected'}</p><button type="button" className="ghost-button" onClick={()=>onMode('expanded')}>{leftTab==='parameters'?'Edit variables':'Open activity'}</button></div>:undefined}>
      <div className="workspace-modes" role="tablist" aria-label="Workspace panel">{([['build','Model','layers'],['parameters','Variables','sliders'],['history','History','history'],['agents','Activity','agent']] as const).map(([id,label,icon])=><button role="tab" type="button" key={id} aria-selected={leftTab===id||id==='build'&&leftTab==='project'} onClick={()=>setLeftTab(id)}><Icon name={icon} size={16}/><span>{label}</span>{id==='agents'&&liveAgents>0&&<span className="count live" aria-label={`${liveAgents} connected`}>{liveAgents}</span>}</button>)}</div>
      <div className="panel-scroll" role="tabpanel">
        {playbackContent}
        {leftTab === 'history' ? historyContent : leftTab === 'parameters' ? (
          <ParametersPanel
            key={doc.documentId}
            runtime={runtime}
            document={doc}
            disabled={disabled}
            onPreview={setParameterPreview}
          />
        ) : leftTab === 'build'||leftTab==='project' ? (
          projectContent
        ) : agentsContent}
      </div>
    </FloatingPanel>
  );
}

interface InspectPanelProps {
  mode:PanelMode;restoreMode:PanelMode;onMode:(mode:PanelMode)=>void;
  drafting:boolean;
  /** Details for something picked outside the model, such as an agent. Replaces the inspector. */
  override?: ReactNode;
  runtime: RuntimeClient;
  state: RuntimeState;
  disabled: boolean;
  analysisOpen: boolean;
  tool: Tool | null;
  toolSession: number;
  setAnalysisOpen: (open: boolean) => void;
  selectIds: (ids: string[]) => void;
  pickEvent?: PickEvent;
  setDraft: (feature?: Feature) => void;
  setFormPreview: (preview?: LivePreview) => void;
  edgePicking: boolean;
  setEdgePicking: (picking: boolean) => void;
  onDone: (created?: string[]) => void;
  agentTouched: Map<string, number>;
  openPart: (documentId: string) => Promise<void>;
}

export function InspectPanel({
  mode,onMode,restoreMode,drafting,
  override,
  runtime,
  state,
  disabled,
  analysisOpen,
  tool,
  toolSession,
  setAnalysisOpen,
  selectIds,
  pickEvent,
  setDraft,
  setFormPreview,
  edgePicking,
  setEdgePicking,
  onDone,
  agentTouched,
  openPart,
}: InspectPanelProps) {
  const doc = state.document;
  return (
    <FloatingPanel side="right" mode={mode} onMode={onMode} restoreMode={restoreMode} label="Details" task={tool?toolSpec(tool).label:drafting?'Unapplied edit':undefined}
      compact={tool||override||drafting?<div className="compact-inspector"><strong>{tool?toolSpec(tool).label:drafting?'Unapplied edit':'Agent details'}</strong><p className="field-hint">{tool||drafting?'This task is still open. Expand to continue editing.':'Expand to inspect this agent.'}</p><button type="button" className="ghost-button" onClick={()=>onMode('expanded')}>{tool||drafting?'Continue editing':'Show agent details'}</button></div>:<CompactInspector state={state} disabled={disabled} onExpand={()=>onMode('expanded')} onOpenPart={openPart}/>}>
      <div className="panel-scroll">
        {override ?? <>
        {tool && analysisOpen && (
          <div className="card-body">
            <button type="button" className="ghost-button" onClick={() => setAnalysisOpen(false)}>
              Back to {toolSpec(tool).label.toLowerCase()}
            </button>
            <AnalysisPanel runtime={runtime} state={state} disabled={disabled} onSelect={selectIds} />
          </div>
        )}
        {tool ? (
          <div hidden={analysisOpen}>
            <ToolCard
              key={toolSession}
              runtime={runtime}
              document={doc}
              geometry={state.evaluation.geometry}
              tool={tool}
              disabled={disabled}
              pick={pickEvent}
              onDraft={setDraft}
              onPreview={setFormPreview}
              edgePicking={edgePicking}
              onEdgePicking={setEdgePicking}
              onDone={onDone}
            />
          </div>
        ) : (
          <Inspector
            runtime={runtime}
            state={state}
            disabled={disabled}
            agentTouched={agentTouched}
            onSelect={selectIds}
            onPreview={setFormPreview}
            onOpenPart={openPart}
          />
        )}
        </>}
      </div>
    </FloatingPanel>
  );
}

export function CompactInspector({state,disabled,onExpand,onOpenPart}:{state:RuntimeState;disabled:boolean;onExpand:()=>void;onOpenPart?:(id:string)=>Promise<void>}){
 const doc=state.document,selected=doc.selectedFeatureIds,feature=selected.length===1?doc.features.find(f=>f.id===selected[0]):undefined;
 const results=state.evaluation.geometry.filter(g=>selected.length?selected.includes(g.featureId):state.evaluation.visibleFeatureIds.includes(g.featureId));
 const size=results.length?[0,1,2].map(i=>Math.max(...results.map(g=>g.bounds.max[i]))-Math.min(...results.map(g=>g.bounds.min[i]))):undefined;
 const source=feature?.kind==='instance'?state.documents.find(d=>d.documentId===feature.params.document):undefined;
 return <div className="compact-inspector"><strong>{feature?featureName(feature):selected.length?`${selected.length} selected`:doc.name}</strong><p>{feature?feature.kind==='instance'?'Component':kindLabels[feature.kind]:doc.kind==='assembly'?'Assembly':'Part'}</p>
  {size&&<dl><div><dt>Size · mm</dt><dd>{size.map(v=>fmt(v,1)).join(' × ')}</dd></div><div><dt>Solids</dt><dd>{results.reduce((n,g)=>n+g.solidCount,0)}</dd></div></dl>}
  {state.evaluation.referenceError?<p className="warn-text">Source references need repair.</p>:state.busy?<p role="status">Rebuilding…</p>:results.length>0&&<p className={results.every(g=>g.valid)?'compact-valid':'warn-text'}>{results.every(g=>g.valid)?'Geometry valid':'Geometry needs attention'}</p>}
  {source&&<div className="compact-source"><small>Source</small><span>{source.name}</span>{onOpenPart&&<button type="button" className="ghost-button" disabled={disabled} onClick={()=>void onOpenPart!(source.documentId)}>Edit source</button>}</div>}
  <button type="button" className="ghost-button" onClick={onExpand}>Show all details</button>
 </div>;
}
