// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { broadcastSet } from './broadcastSet';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: Workspace[] = [{ id: 'ws-1', name: 'api', collapsed: false }];
const session = (id: string, name: string): ShellSession => ({
  id,
  workspaceId: 'ws-1',
  name,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
});
const sessions = [session('s-1', 'server'), session('s-2', 'tests')];

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => broadcastSet.replaceAll([]));
  localStorage.removeItem('axn-term:settings');
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(props: Partial<ComponentProps<typeof SessionPanel>>) {
  const noop = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
        <SessionPanel
          workspaces={workspaces}
          sessions={sessions}
          selectedSessionId="s-1"
          taskState={null}
          onSelectWorkspace={noop}
          onSelectSession={noop}
          onAddWorkspace={noop}
          onSaveWorkspaceSet={noop}
          onLoadWorkspaceSet={noop}
          onRenameWorkspace={noop}
          onDeleteWorkspace={noop}
          onToggleWorkspace={noop}
          updateWorkspace={noop}
          onAddSession={noop}
          onMoveSession={noop}
          onReorderWorkspace={noop}
          onMoveWorkspace={noop}
          onRenameSession={noop}
          onDuplicateSession={noop}
          onCloseSession={noop}
          updateSession={noop}
          mergePluginState={noop}
          plugins={[]}
          onOpenBrowser={noop}
          onOpenTab={noop}
          onOpenSubShell={() => undefined}
          onTurnIntoWorkspace={noop}
          pluginData={{}}
          mergePluginData={noop}
          {...props}
        />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
}

const rowOf = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[draggable="true"]')].find((el) => el.textContent?.includes(name))!;

const openSessionMenu = async (name: string) =>
  act(async () => {
    rowOf(name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  });

const clickMenu = async (label: string) => {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button.click());
};

it('hands a session menu hook just the clicked session as its target', async () => {
  const sessionMenuItems = vi.fn(() => [{ label: 'Probe', onClick: () => {} }]);
  await render({ plugins: [{ id: 'p', title: 'p', sessionMenuItems }] });
  await openSessionMenu('tests');
  const [ctx, scope] = sessionMenuItems.mock.calls.at(-1) as unknown as [
    { session: ShellSession },
    { targets: { session: ShellSession }[]; sessions: ShellSession[]; workspaces: Workspace[] },
  ];
  expect(ctx.session.id).toBe('s-2');
  expect(scope.targets.map((t) => t.session.id)).toEqual(['s-2']);
  expect(scope.sessions).toEqual(sessions);
  expect(scope.workspaces).toEqual(workspaces);
});

it('hands a session menu hook every multi-selected session as targets', async () => {
  const sessionMenuItems = vi.fn(() => [{ label: 'Probe', onClick: () => {} }]);
  await render({ plugins: [{ id: 'p', title: 'p', sessionMenuItems }] });
  await act(async () => broadcastSet.replaceAll(['s-1', 's-2']));
  await openSessionMenu('tests');
  const scope = sessionMenuItems.mock.calls.at(-1)![1] as unknown as { targets: { session: ShellSession }[] };
  expect(scope.targets.map((t) => t.session.id).sort()).toEqual(['s-1', 's-2']);
});

it('offers workspaceActions rows on a workspace with no sessions and merges state per plugin', async () => {
  const updateWorkspace = vi.fn();
  const empty: Workspace = { id: 'ws-2', name: 'empty', collapsed: false, pluginState: { other: { x: 1 } } };
  const workspaceActions = vi.fn((ctx: { updateWorkspaceState(p: Record<string, unknown>): void }) => [
    { label: 'Probe tag', onClick: () => ctx.updateWorkspaceState({ tags: ['a'] }) },
  ]);
  await render({
    workspaces: [workspaces[0], empty],
    updateWorkspace,
    plugins: [{ id: 'p', title: 'p', settingsKey: 'probe', workspaceActions }],
  });
  const header = [...container.querySelectorAll<HTMLElement>('[data-tip$="right-click for options)"]')].find((h) =>
    h.textContent?.includes('empty'),
  )!;
  await act(async () => {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  });
  await clickMenu('Probe tag');
  expect(updateWorkspace).toHaveBeenCalledWith('ws-2', {
    pluginState: { other: { x: 1 }, probe: { tags: ['a'] } },
  });
});
