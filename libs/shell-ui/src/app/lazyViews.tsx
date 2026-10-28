import { lazy, Suspense, type ComponentProps } from 'react';
import type { EditorView as EditorViewImpl } from './EditorView';
import type { GitInspectView as GitInspectViewImpl } from './GitInspectView';

// Monaco is ~3.8 MB of JS — keep it out of the startup bundle. Both views
// pull it in through ./monacoSetup, so they load on first use (or on idle,
// via preloadMonacoViews) instead of before the first terminal renders.
const loadEditor = () => import('./EditorView');
const loadGitInspect = () => import('./GitInspectView');

const LazyEditorView = lazy(() => loadEditor().then((m) => ({ default: m.EditorView })));
const LazyGitInspectView = lazy(() =>
  loadGitInspect().then((m) => ({ default: m.GitInspectView })),
);

export function EditorView(props: ComponentProps<typeof EditorViewImpl>) {
  return (
    <Suspense fallback={null}>
      <LazyEditorView {...props} />
    </Suspense>
  );
}

export function GitInspectView(props: ComponentProps<typeof GitInspectViewImpl>) {
  return (
    <Suspense fallback={null}>
      <LazyGitInspectView {...props} />
    </Suspense>
  );
}

/** Warm the Monaco chunks once the app is idle, so the first editor opens fast. */
export function preloadMonacoViews(): void {
  void loadEditor().catch(() => {});
  void loadGitInspect().catch(() => {});
}
