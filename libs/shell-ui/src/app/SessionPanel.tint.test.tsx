// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
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

const colourPlugin = (id: string, over: Partial<SessionViewPlugin>): SessionViewPlugin => ({
  id,
  title: id,
  ...over,
});

const cards = () => [...container.querySelectorAll<HTMLElement>('div.relative.cursor-pointer')];
const header = () => container.querySelector<HTMLElement>('[data-tip$="right-click for options)"]')!;

it('tints the selected card strongly and the other faintly', async () => {
  await render({ plugins: [colourPlugin('c', { sessionColors: () => ['#ff0000'] })] });
  const [selected, idle] = cards();
  expect(selected.style.backgroundImage).toContain('#ff0000 30%');
  expect(idle.style.backgroundImage).toContain('#ff0000 12%');
});

it('tints a workspace header faintly even when it holds the selected session', async () => {
  const workspaceColors = vi.fn(() => ['#00ff00']);
  await render({ plugins: [colourPlugin('c', { workspaceColors })] });
  expect(header().style.backgroundImage).toContain('#00ff00 12%');
  expect(workspaceColors).toHaveBeenCalledWith(expect.objectContaining({ workspace: workspaces[0] }));
});

it('combines colours of several plugins in plugin order', async () => {
  await render({
    plugins: [
      colourPlugin('a', { sessionColors: () => ['#ff0000'] }),
      colourPlugin('b', { sessionColors: () => ['#00ff00'] }),
    ],
  });
  const css = cards()[0].style.backgroundImage;
  expect(css.indexOf('#ff0000')).toBeGreaterThan(-1);
  expect(css.indexOf('#ff0000')).toBeLessThan(css.indexOf('#00ff00'));
});

it('ignores a throwing hook and non-hex colours', async () => {
  await render({
    plugins: [
      colourPlugin('a', {
        sessionColors: () => {
          throw new Error('boom');
        },
        workspaceColors: () => {
          throw new Error('boom');
        },
      }),
      colourPlugin('b', { sessionColors: () => ['red', 'url(x)'] }),
    ],
  });
  expect(cards()).toHaveLength(2);
  for (const card of cards()) expect(card.style.backgroundImage).toBe('');
  expect(header().style.backgroundImage).toBe('');
});

it('adds no background-image without colour hooks', async () => {
  await render({ plugins: [] });
  for (const card of cards()) expect(card.style.backgroundImage).toBe('');
  expect(header().style.backgroundImage).toBe('');
});
