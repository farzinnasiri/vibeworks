import type { DocumentSummary, Project } from '../shared/protocol';

export const PROJECT_SORTS = {
  newest: 'Updated, newest first',
  oldest: 'Updated, oldest first',
  az: 'Name, A to Z',
  za: 'Name, Z to A',
} as const;
export type ProjectSort = keyof typeof PROJECT_SORTS;

const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const byUpdate = (a: DocumentSummary, b: DocumentSummary) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.documentId.localeCompare(b.documentId);

/** Opening a project follows the same destination from home and the workspace switcher. */
export function projectDocument(project: Project, documents: DocumentSummary[]) {
  const contents = documents.filter(document => document.projectId === project.projectId);
  return contents.find(document => document.documentId === project.mainAssemblyId && document.kind === 'assembly')
    ?? contents.sort(byUpdate)[0];
}

export function projectCatalog(projects: Project[], documents: DocumentSummary[]) {
  return projects.map(project => {
    const contents = documents.filter(document => document.projectId === project.projectId).sort(byUpdate);
    return {
      ...project, documents: contents,
      updatedAt: contents.find(document => timestamp(document.updatedAt))?.updatedAt,
      parts: contents.filter(document => document.kind !== 'assembly').length,
      assemblies: contents.filter(document => document.kind === 'assembly').length,
      destination: projectDocument(project, contents),
    };
  });
}
export type ProjectEntry = ReturnType<typeof projectCatalog>[number];

export function sortProjects(projects: ProjectEntry[], sort: ProjectSort) {
  return [...projects].sort((a, b) => {
    const name = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    if (sort === 'az' || sort === 'za') return (sort === 'az' ? name : -name) || a.projectId.localeCompare(b.projectId);
    // Empty projects have no saved-document date and stay after dated projects in either direction.
    if (!a.updatedAt || !b.updatedAt) return Number(!!b.updatedAt) - Number(!!a.updatedAt) || name;
    const date = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    return (sort === 'oldest' ? -date : date) || name || a.projectId.localeCompare(b.projectId);
  });
}
