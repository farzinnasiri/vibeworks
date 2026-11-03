import { useState, type MouseEvent } from 'react';
import type { RuntimeClient } from '../cad/runtime';
import { type DocumentSummary, type Project } from '../shared/protocol';
import { copyName } from '../cad/store';
import { countLabel } from '../shared/format';
import { projectDocument } from './projects';
import {MiddleTruncate} from './MiddleTruncate';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';
import { track } from './activity';
import { ContextMenu, dialogs, type ContextEntry } from './Dialogs';

type Notify = (notice: { kind: 'error' | 'info'; text: string } | null) => void;
type Run = (operation: string, command: Parameters<RuntimeClient['execute']>[0]) => ReturnType<RuntimeClient['execute']>;

function useRun(runtime: RuntimeClient, onNotice: Notify): Run {
  return async (operation, command) => {
    const result = await track(operation, () => runtime.execute(command));
    if (result.status === 'error') onNotice({ kind: 'error', text:
      ['documents:delete_project', 'documents:duplicate_project'].includes(operation) && result.error!.code === 'STORAGE_CONFLICT'
        ? 'Project contents changed. Review the current documents, then try again.'
        : result.error!.message });
    return result;
  };
}

/** The project this tab is looking at. Switching opens the project's main assembly or its first document. */
export function ProjectSwitcher({ runtime, projects, documents, projectId, disabled, open, onToggle, onChoose, onNotice, onBrowse,onBeforeChange }: {
  onBrowse?:()=>void;onBeforeChange?:()=>Promise<boolean>;
  runtime: RuntimeClient; projects: Project[]; documents: DocumentSummary[]; projectId?: string; disabled: boolean;
  open: boolean; onToggle: (id: string | null) => void; onChoose: (projectId: string) => void; onNotice: Notify;
}) {
  const run = useRun(runtime, onNotice);
  const project = projects.find(p => p.projectId === projectId) ?? projects[0];
  const count = (id: string) => documents.filter(d => d.projectId === id).length;
  const [copying, setCopying] = useState(false);
  const duplicate = async (target:Project) => {
    if (copying || onBeforeChange && !await onBeforeChange()) return;
    setCopying(true);
    try {
      const result = await duplicateProject(run, target, documents);
      if (result?.status === 'success') {
        onNotice({ kind: 'info', text: result.warnings.join(' ') || 'Project copied. Its documents are independently editable.' });
        const id = result.duplication!.projectId;
        onChoose(id);
      }
    } finally { setCopying(false); }
  };
  const rename = async (project:Project) => {
    const name = await dialogs.prompt({ title: 'Rename project', label: 'Project name', initial: project.name, confirmLabel: 'Rename' });
    if (name && name !== project.name) void run('documents:rename_project', { type: 'documents', params: { action: 'rename_project', projectId: project.projectId, name, expectedStorageVersion: project.version } });
  };
  const remove = async (project:Project) => {
    const contents = documents.filter(document => document.projectId === project.projectId);
    if (!(await dialogs.confirm({ title: `Delete “${project.name}”?`, body: contents.length ? `Delete these ${contents.length} documents with this project? ${contents.map(document => document.name).join(', ')}. References from other projects will block deletion.` : 'This empty project will be removed.', confirmLabel: 'Delete project', danger: true }))) return;
    const result = await run('documents:delete_project', { type: 'documents', params: { action: 'delete_project', projectId: project.projectId, expectedStorageVersion: project.version, documentVersions: Object.fromEntries(contents.map(document => [document.documentId, document.storageVersion])) } });
    if (result.status === 'success' && project.projectId===projectId) {const next=projects.find(p=>p.projectId!==project.projectId);if(next)onChoose(next.projectId);else onBrowse?.();}
  };
  return (
    <Menu id="projects" ariaLabel={`Project: ${project?.name ?? 'none'}`} open={open} onToggle={onToggle} align="start" className="crumb-menu"
      label={<span className="crumb"><Icon name="folder" size={15} /><MiddleTruncate className="crumb-name" text={project?.name ?? 'Project'}/><Icon name="chevron" size={13} /></span>}>
      <div className="switcher project-switcher">
        <div className="project-menu-heading"><span className="menu-label">Projects</span><button type="button" role="menuitem" className="icon-button" aria-label="New project" title="New project" disabled={disabled} onClick={()=>{void(async()=>{if(!onBeforeChange||await onBeforeChange())await createProject(runtime,run,onChoose);})();}}><Icon name="plus" size={17}/></button></div>
        {projects.map(p => <div key={p.projectId} className={`project-switch-row ${p.projectId===project?.projectId?'active':''}`}>
          <button type="button" role="menuitem" className="project-switch-choice" aria-current={p.projectId===project?.projectId?'true':undefined} disabled={disabled} onClick={()=>onChoose(p.projectId)}>
            <Icon name="folder" size={16}/><span className="switch-text"><MiddleTruncate text={p.name}/><small>{countLabel(count(p.projectId),'design')}</small></span>
          </button>
          <div className="project-row-actions">{([
            ['rename','Rename',()=>void rename(p)],['duplicate','Duplicate',()=>void duplicate(p)],['delete','Delete',()=>void remove(p)]
          ] as const).map(([icon,label,click])=><button key={icon} type="button" role="menuitem" className={`icon-button ${icon==='delete'?'danger':''}`} aria-label={`${label} project ${p.name}`} title={label} disabled={disabled||copying} onClick={click}><Icon name={icon} size={15}/></button>)}</div>
        </div>)}
      </div>
    </Menu>
  );
}

/** Capture the reviewed source versions before waiting for the name dialog. */
export async function duplicateProject(run: Run, project: Project, documents: DocumentSummary[]) {
  const documentVersions = Object.fromEntries(documents.filter(d => d.projectId === project.projectId).map(d => [d.documentId, d.storageVersion]));
  const name = await dialogs.prompt({ title: 'Duplicate project', label: 'Copy name', initial: copyName(project.name), confirmLabel: 'Duplicate project',
    body: 'Creates independently editable copies of every part and assembly in this project. Assemblies use the copied parts. References to documents outside this project stay shared. The original project stays unchanged.' });
  if (!name) return;
  return run('documents:duplicate_project', { type: 'documents', params: { action: 'duplicate_project', projectId: project.projectId,
    name, requestId: crypto.randomUUID(), expectedStorageVersion: project.version, documentVersions } });
}

/** Asks for a name and a first document, then opens it, so a new project never shows another project's model. */
export async function createProject(runtime: RuntimeClient, run: Run, onChoose: (projectId: string) => void) {
  const answer = await dialogs.form({
    title: 'New project', label: 'Project name', placeholder: 'Bench vise', confirmLabel: 'Create project',
    body: 'A project groups the parts and assemblies of one design. Agents can work on any document in it.',
    choices: [
      { value: 'part', label: 'Part', hint: 'One body or a few', icon: 'box' },
      { value: 'assembly', label: 'Assembly', hint: 'Combines parts', icon: 'layers' },
    ],
  });
  if (!answer) return;
  const projectId = crypto.randomUUID();
  const created = await run('documents:create_project', { type: 'documents', params: { action: 'create_project', projectId, name: answer.text } });
  if (created.status !== 'success') return;
  const kind = answer.choice === 'assembly' ? 'assembly' : 'part';
  const first = await run('documents:create', { type: 'documents', params: { action: 'create', kind, projectId } });
  if (first.status === 'success') await runtime.openDocument(first.documentId!);
  onChoose(projectId);
}

/** The same conditional document actions are attached to their rows in the Model sidebar. */
export function DocumentActions({ runtime, documents, projects, documentId, disabled, onNotice, onNavigate }: {
  runtime: RuntimeClient; documents: DocumentSummary[]; projects: Project[]; documentId: string; disabled: boolean;
  onNotice: Notify; onNavigate: () => void;
}) {
  const run = useRun(runtime, onNotice);
  const [copying, setCopying] = useState(false);
  const duplicate = async (source: DocumentSummary) => {
    if (copying) return;
    setCopying(true);
    try {
      const name = await dialogs.prompt({ title: source.kind === 'assembly' ? 'Duplicate assembly' : 'Duplicate part', label: 'Copy name', initial: copyName(source.name), confirmLabel: 'Duplicate and open',
        body: source.kind === 'assembly' ? 'Copies this assembly document. Its source parts stay shared. To edit copied parts independently, duplicate the project instead. The original assembly stays unchanged.' : 'Creates an independently editable part in this project. Any referenced source documents stay shared. The original part stays unchanged.' });
      if (!name) return;
      const result = await run('documents:duplicate', { type: 'documents', params: { action: 'duplicate', documentId: source.documentId, projectId: source.projectId, name, expectedStorageVersion: source.storageVersion, requestId: crypto.randomUUID() } });
      if (result.status !== 'success') return;
      setMenu(undefined); onNavigate();
      const opened = await runtime.openDocument(result.createdDocumentId!);
      onNotice(opened.status === 'error' ? { kind: 'error', text: `Copy created, but could not open it. ${opened.error!.message}` } : { kind: 'info', text: result.warnings.join(' ') || 'Copy opened. The original part stays unchanged.' });
    } finally { setCopying(false); }
  };
  const current = documents.find(d=>d.documentId===documentId);
  const project = projects.find(p=>p.projectId===current?.projectId);
  const [menu, setMenu] = useState<{ x: number; y: number; document: DocumentSummary }>();
  const name = (d: { name?: string }) => d.name ?? 'Untitled part';

  const actions = (d: DocumentSummary): ContextEntry[] => {
    const main = project?.mainAssemblyId === d.documentId;
    const others = projects.filter(p => p.projectId !== d.projectId);
    return [
      { label: 'Open', icon: 'file', disabled: disabled || d.active, onSelect: () => { setMenu(undefined); onNavigate(); void runtime.openDocument(d.documentId); } },
      { label: 'Rename…', icon: 'rename', disabled, onSelect: async () => {
        const next = await dialogs.prompt({ title: 'Rename document', label: 'Document name', initial: name(d), confirmLabel: 'Rename' });
        if (next && next !== d.name) void run('documents:rename', { type: 'documents', params: { action: 'rename', documentId: d.documentId, name: next, expectedStorageVersion: d.storageVersion } });
      } },
      { label: 'Duplicate…', icon: 'duplicate', disabled: disabled || copying, onSelect: () => void duplicate(d) },
      ...(d.kind === 'assembly' && project ? [{ label: main ? 'Clear main assembly' : 'Make main assembly', icon: 'layers' as const, disabled, onSelect: () => void run('documents:set_main_assembly', { type: 'documents', params: { action: 'set_main_assembly', projectId: project.projectId, expectedStorageVersion: project.version, ...(main ? {} : { documentId: d.documentId }) } }) }] : []),
      ...(others.length ? ['separator' as const, ...others.slice(0, 8).map(p => ({ label: `Move to ${p.name}`, icon: 'folder' as const, disabled, onSelect: () => void run('documents:move', { type: 'documents', params: { action: 'move', documentId: d.documentId, projectId: p.projectId, expectedStorageVersion: d.storageVersion } }) }))] : []),
      'separator',
      ...(d.active?[{label:'Reset document…',icon:'delete' as const,danger:true,disabled,onSelect:async()=>{if(await dialogs.confirm({title:'Reset this document?',body:'Remove its features. Undo can restore them.',confirmLabel:'Reset document',danger:true}))void run('document_action:reset',{type:'document_action',params:{action:'reset',documentId:d.documentId,expectedRevision:d.revision,expectedStorageVersion:d.storageVersion}});}}]:[]),
      { label: 'Delete…', icon: 'delete', danger: true, disabled: disabled || documents.length <= 1, onSelect: async () => {
        if (!(await dialogs.confirm({ title: `Delete “${name(d)}”?`, body: 'This removes the document from local SQLite. Its audit revisions remain in the database. Export JSON first to keep a copy.', confirmLabel: 'Delete document', danger: true }))) return;
        // The open document cannot vanish under this tab: open a neighbour first, preferring the same project.
        if (d.active) {
          const others = documents.filter(o => o.documentId !== d.documentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const next = others.find(o => o.projectId === d.projectId) ?? others[0];
          if (!next) return;
          onNavigate();
          const opened = await runtime.openDocument(next.documentId);
          if (opened.status === 'error') { onNotice({ kind: 'error', text: opened.error!.message }); return; }
        }
        void run('documents:delete', { type: 'documents', params: { action: 'delete', documentId: d.documentId, expectedRevision: d.revision, expectedStorageVersion: d.storageVersion } });
      } },
    ];
  };
  const openActions = (event: MouseEvent, d: DocumentSummary) => {
    event.preventDefault(); event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: event.type === 'contextmenu' ? event.clientX : rect.right, y: event.type === 'contextmenu' ? event.clientY : rect.bottom, document: d });
  };

  if(!current)return null;
  return <>
    <button type="button" className="icon-button quiet document-actions" aria-label={`Actions for ${current.name}`} disabled={disabled} title="Rename, duplicate, move, delete" onClick={event=>openActions(event,current)}><span aria-hidden="true">⋯</span></button>
    {menu&&<ContextMenu x={menu.x} y={menu.y} title={name(menu.document)} items={actions(menu.document)} onClose={()=>setMenu(undefined)}/>}
  </>;
}
