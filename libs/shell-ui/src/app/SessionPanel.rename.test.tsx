// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';

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
          onOpenIde={noop}
          {...props}
        />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
}

function nameSpan(name: string): HTMLElement {
  const span = [...container.querySelectorAll('span')].find(
    (s) => s.textContent === name && s.className.includes('font-medium'),
  );
  if (!span) throw new Error(`no name span for ${name}`);
  return span as HTMLElement;
}

async function typeAndPress(input: HTMLInputElement, value: string, key: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

it('renames a session inline after a double-click on its name', async () => {
  const onRenameSession = vi.fn();
  await render({ onRenameSession });
  await act(async () => {
    nameSpan('tests').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  const input = container.querySelector('input[aria-label="Rename session"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await typeAndPress(input, 'SERVDEMO-683 board', 'Enter');
  expect(onRenameSession).toHaveBeenCalledWith('s-2', 'SERVDEMO-683 board');
  expect(container.querySelector('input[aria-label="Rename session"]')).toBeNull();
});

it('Escape cancels the inline rename without saving', async () => {
  const onRenameSession = vi.fn();
  await render({ onRenameSession });
  await act(async () => {
    nameSpan('server').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  const input = container.querySelector('input[aria-label="Rename session"]') as HTMLInputElement;
  await typeAndPress(input, 'something else', 'Escape');
  expect(onRenameSession).not.toHaveBeenCalled();
});

it('F2 starts renaming the selected session, but not while a terminal has focus', async () => {
  await render({});
  const term = document.createElement('div');
  term.className = 'xterm';
  const helper = document.createElement('textarea');
  term.appendChild(helper);
  document.body.appendChild(term);
  await act(async () => {
    helper.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  });
  expect(container.querySelector('input[aria-label="Rename session"]')).toBeNull();
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  });
  const input = container.querySelector('input[aria-label="Rename session"]') as HTMLInputElement;
  expect(input?.value).toBe('server');
  term.remove();
});

it('the actions button opens the session menu with the rename shortcut', async () => {
  await render({});
  const btn = container.querySelectorAll('button[aria-label="Session actions"]')[1] as HTMLButtonElement;
  await act(async () => btn.click());
  const text = document.body.textContent ?? '';
  expect(text).toContain('Rename…');
  expect(text).toContain('F2 · double-click');
});
