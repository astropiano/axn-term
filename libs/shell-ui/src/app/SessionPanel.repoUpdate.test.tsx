// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import { gitStatusPlugin } from './session-plugins/gitStatus';
import type { SessionViewPlugin } from './session-plugins/plugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: Workspace[] = [{ id: 'ws-1', name: 'api', collapsed: false }];

const repo = (branch: string) => ({
  name: 'repo',
  branch,
  ahead: 0,
  behind: 0,
  dirty: false,
  untracked: 0,
  remoteBranchMissing: false,
  root: '/repo',
});

const session = (branch: string): ShellSession => ({
  id: 's-1',
  workspaceId: 'ws-1',
  name: 'server',
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  cwd: '/repo',
  repo: repo(branch),
});

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  localStorage.removeItem('axn-term:settings');
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(sessions: ShellSession[], plugins: SessionViewPlugin[]) {
  const noop = () => {};
  const props: ComponentProps<typeof SessionPanel> = {
    workspaces,
    sessions,
    selectedSessionId: 's-1',
    taskState: null,
    onSelectWorkspace: noop,
    onSelectSession: noop,
    onAddWorkspace: noop,
    onSaveWorkspaceSet: noop,
    onLoadWorkspaceSet: noop,
    onRenameWorkspace: noop,
    onDeleteWorkspace: noop,
    onToggleWorkspace: noop,
    updateWorkspace: noop,
    onAddSession: noop,
    onMoveSession: noop,
    onReorderWorkspace: noop,
    onMoveWorkspace: noop,
    onRenameSession: noop,
    onDuplicateSession: noop,
    onCloseSession: noop,
    updateSession: noop,
    mergePluginState: noop,
    plugins,
    onOpenBrowser: noop,
    onOpenTab: noop,
    onOpenSubShell: () => undefined,
    onTurnIntoWorkspace: noop,
    onOpenIde: noop,
    pluginData: {},
    mergePluginData: noop,
  };
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const r = root;
  await act(async () =>
    r.render(
      <StoryShellProviders>
        <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
          <SessionPanel {...props} />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
}

it('updates the card when session.repo changes', async () => {
  await render([session('main')], [gitStatusPlugin]);
  expect(container.textContent).toContain('main');
  await render([session('feature')], [gitStatusPlugin]);
  expect(container.textContent).toContain('feature');
});
