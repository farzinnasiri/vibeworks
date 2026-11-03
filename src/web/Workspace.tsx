import { lazy, Suspense, useSyncExternalStore } from 'react';
import { ProjectPicker } from './ProjectPicker';
import type { RemoteRuntime } from './remote-runtime';
import { LoadingField } from './LoadingField';

// Project discovery should not wait for Three.js, the viewport or modeling tools to load.
const Editor = lazy(() => import('./App').then(module => ({ default: module.App })));

export function Workspace({ runtime }: { runtime: RemoteRuntime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  if (state.workspaceHome) return <ProjectPicker runtime={runtime} state={state} />;
  return <Suspense fallback={<main className="workspace-opening"><LoadingField label="Opening workspace" /></main>}>
    <Editor runtime={runtime} />
  </Suspense>;
}
