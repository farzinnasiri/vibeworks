import { useMemo, useState,useRef } from 'react';
import {createPortal} from 'react-dom';
import {useModalFocus} from './useModalFocus';
import type { RuntimeClient, RuntimeState } from '../cad/runtime';
import { countLabel } from '../shared/format';
import { createProject, duplicateProject } from './DocumentSwitcher';
import { DialogHost } from './Dialogs';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';
import { projectCatalog, sortProjects, PROJECT_SORTS, type ProjectEntry, type ProjectSort } from './projects';
import { Brand } from './Brand';
import {ServiceMonitor} from './ServiceMonitor';
import {MiddleTruncate} from './MiddleTruncate';

const updated = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, {
  month: 'short', day: 'numeric', year: 'numeric',
}) : 'No saved documents';
const fullDate = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) : 'No saved documents';
const sortKey = 'vibeworks.view.projectSort';
function savedSort(): ProjectSort {
  try { const value = localStorage.getItem(sortKey); if (value && Object.hasOwn(PROJECT_SORTS, value)) return value as ProjectSort; } catch {}
  return 'newest';
}

export function ProjectPicker({ runtime, state,onOpen,onClose,onBeforeChange }: { runtime: RuntimeClient; state: RuntimeState;onOpen?:(id:string)=>Promise<void>;onClose?:()=>void;onBeforeChange?:()=>Promise<boolean> }) {
  const [projectId, setProjectId] = useState<string>();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>(savedSort);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const ready = state.phase === 'ready';
  const catalog = useMemo(() => projectCatalog(state.projects, state.documents), [state.projects, state.documents]);
  const recent = sortProjects(catalog.filter(project => project.updatedAt), 'newest').slice(0, 3);
  const recentIds = new Set(recent.map(project => project.projectId));
  const matches = (project: ProjectEntry) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const recentMatches = recent.filter(matches);
  const others = sortProjects(catalog.filter(project => !recentIds.has(project.projectId) && matches(project)), sort);
  const project = catalog.find(project => project.projectId === projectId);
  const documents = [...(project?.documents ?? [])].sort((a, b) => Number(b.documentId === project?.mainAssemblyId) - Number(a.documentId === project?.mainAssemblyId));
  const changeSort = (value: ProjectSort) => { setSort(value); try { localStorage.setItem(sortKey, value); } catch {} };
  const newProject = async () => {
    if(onBeforeChange&&!await onBeforeChange())return;
    const previous=runtime.getSnapshot().document.documentId;
    setCreating(true); setError(undefined);
    try {
      await createProject(runtime, async (_operation, command) => {
        const result = await runtime.execute(command);
        if (result.status === 'error') setError(result.error!.message);
        return result;
      }, setProjectId);
      if(runtime.getSnapshot().document.documentId!==previous)onClose?.();
    } catch (error) { setError(String(error)); } finally { setCreating(false); }
  };
  const copyProject = async () => {
    if (!project || creating) return;
    setCreating(true); setError(undefined);
    try {
      const result = await duplicateProject(async (_operation, command) => {
        const result = await runtime.execute(command);
        if (result.status === 'error') setError(result.error!.message);
        return result;
      }, project, state.documents);
      if (result?.status === 'success') { setQuery(''); setProjectId(result.duplication!.projectId); }
    } catch (error) { setError(String(error)); } finally { setCreating(false); }
  };
  const open = async (documentId: string) => {
    setError(undefined); setOpening(true);
    try {
      if(onOpen){await onOpen(documentId);return;}
      const result = await runtime.openDocument(documentId);
      if (result.status === 'error') setError(result.error!.message);
    } catch (error) { setError(String(error)); } finally { setOpening(false); }
  };
  const newDocument = async (kind: 'part' | 'assembly') => {
    const result = await runtime.execute({ type: 'documents', params: { action: 'create', projectId, kind } });
    if (result.status === 'error') setError(result.error!.message);
    else await open(result.documentId!);
  };
  const projectRow = (item: ProjectEntry) => {
    const detail = `${countLabel(item.parts, 'part')} · ${countLabel(item.assemblies, 'assembly', 'assemblies')}`;
    return <button key={item.projectId} type="button" className="picker-project" aria-pressed={item.projectId === projectId}
      title={`${item.name}\n${detail}\nLast document update: ${fullDate(item.updatedAt)}${item.destination ? `\nOpens: ${item.destination.name}` : ''}`}
      onClick={() => { setProjectId(item.projectId); setError(undefined); }}>
      <Icon name="folder" size={20} />
      <span><strong><MiddleTruncate text={item.name}/></strong><small>{countLabel(item.documents.length, 'document')}</small>
        <small className="picker-project-date">{item.updatedAt ? <time dateTime={item.updatedAt}>{updated(item.updatedAt)}</time> : 'No saved documents'}</small></span>
      <Icon name="chevron" size={15} />
    </button>;
  };
  return <div className="app project-picker">
    <header className="topbar">
      <Brand />
      {onClose&&<button type="button" className="bar-button" onClick={onClose}><Icon name="chevron-left" size={16}/>Return to workspace</button>}
<div className="picker-service"><ServiceMonitor/></div>
    </header>
    <main className="picker-main">
      <div className="picker-heading">
        <div><h1>Projects</h1><p>Open a project or browse its parts and assemblies.</p></div>
        <button type="button" className="primary-button" disabled={!ready || creating} onClick={() => void newProject()}>
          <Icon name="plus" size={16} />New project
        </button>
      </div>
      {(error || state.error) && <div className="picker-error" role="alert">
        <span>{error ?? state.error}</span>
        {state.phase === 'error' && <button type="button" className="bar-button" onClick={() => void runtime.retryInitialization()}>Reconnect</button>}
      </div>}
      <div className="picker-browser">
        <section className="picker-projects" aria-label="Projects">
          <label className="picker-search"><Icon name="search" size={17} />
            <input type="search" aria-label="Find a project" placeholder="Find a project" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <div className="picker-sort-toolbar"><span>{PROJECT_SORTS[sort]}</span>
            <Menu id="project-sort" open={menu === 'project-sort'} onToggle={setMenu} icon="sort" label={<span className="sr-only">Sort projects</span>} ariaLabel="Sort projects" title={`Sort other projects: ${PROJECT_SORTS[sort]}`}>
              <div className="menu-label">Sort other projects</div>
              {Object.entries(PROJECT_SORTS).map(([value, label]) => <MenuItem key={value} icon={sort === value ? 'check' : undefined} label={label} onClick={() => changeSort(value as ProjectSort)} />)}
            </Menu>
          </div>
          <div className="picker-project-list">
            {!!recentMatches.length && <section aria-label="Recently updated projects"><h2 className="picker-list-heading"><Icon name="history" size={14} />Recently updated</h2>{recentMatches.map(projectRow)}</section>}
            {!!others.length && <section aria-label="Other projects">
              <h2 className="picker-list-heading">{recent.length ? 'Other projects' : 'All projects'}</h2>
              {others.map(projectRow)}
            </section>}
            {!recentMatches.length && !others.length && ready && <p className="picker-empty">{query ? 'No matching projects.' : 'Create a project to start a design.'}</p>}
          </div>
        </section>
        <section className="picker-documents" aria-label={project ? `Documents in ${project.name}` : 'Project documents'}>
          {project ? <>
            <div className="picker-project-heading"><div><h2>{project.name}</h2><p>{countLabel(project.parts, 'part')} · {countLabel(project.assemblies, 'assembly', 'assemblies')}</p>
              <p className="picker-project-last-update">{project.updatedAt ? <>Updated <time dateTime={project.updatedAt} title={fullDate(project.updatedAt)}>{updated(project.updatedAt)}</time></> : 'No saved documents'}</p></div>
              <button type="button" className="bar-button" disabled={!ready || creating || opening} onClick={() => void copyProject()}><Icon name="duplicate" size={16} />Duplicate project…</button>
              {!!project.destination && <div className="picker-project-action"><button type="button" className="primary-button" disabled={!ready || opening} onClick={() => void open(project.destination!.documentId)}><Icon name="folder-open" size={17} />{opening ? 'Opening…' : 'Open project'}</button>
                <small>Opens {project.destination.documentId === project.mainAssemblyId ? 'the main assembly' : 'the last updated document'}</small></div>}
            </div>
            <div className="picker-document-list">
              {documents.map(document => <button key={document.documentId} type="button" className="picker-document" disabled={!ready || opening}
                title={`${document.name}\n${document.kind === 'assembly' ? 'Assembly' : 'Part'} · Revision ${document.revision}\nUpdated ${fullDate(document.updatedAt)}`}
                onClick={() => void open(document.documentId)}>
                <Icon name={document.kind === 'assembly' ? 'layers' : 'box'} size={20} />
                <span className="picker-document-name"><strong>{document.name}</strong><small>{document.kind === 'assembly' ? 'Assembly' : 'Part'}{document.documentId === project.mainAssemblyId ? ' · Main assembly' : ''} · {countLabel(document.features, 'feature')}</small></span>
                <time className="picker-updated" dateTime={document.updatedAt} title={fullDate(document.updatedAt)}>{updated(document.updatedAt)}</time>
                <span className="picker-open">Open<Icon name="chevron" size={14} /></span>
              </button>)}
              {!documents.length && <div className="picker-empty"><p>This project has no documents yet.</p>
                <button type="button" className="bar-button" disabled={!ready || state.busy} onClick={() => void newDocument('part')}><Icon name="box" size={16} />New part</button>
                <button type="button" className="bar-button" disabled={!ready || state.busy} onClick={() => void newDocument('assembly')}><Icon name="layers" size={16} />New assembly</button>
              </div>}
            </div>
          </> : <div className="picker-placeholder"><Icon name="folder" size={32} /><h2>Choose a project</h2><p>See its documents and last update, then open the project.</p></div>}
        </section>
      </div>
    </main>
    {!onClose&&<DialogHost />}
  </div>;
}

/** Browsing is a reversible overlay; the editor, camera, drafts and render jobs stay mounted. */
export function ProjectBrowser(props:Parameters<typeof ProjectPicker>[0]&{onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null);useModalFocus(ref);
 return createPortal(<div ref={ref} className="project-browser-overlay" role="dialog" aria-modal="true" aria-label="Browse projects" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();props.onClose();}}}><ProjectPicker {...props}/></div>,document.body);
}
