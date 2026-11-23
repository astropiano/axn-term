// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import { agentsPlugin } from './session-plugins/agents';

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

/** A drag event with a writable dataTransfer (happy-dom has none). */
function dragEvent(type: string, init: { clientX?: number; clientY?: number; dropEffect?: string } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 10,
    clientY: init.clientY ?? 10,
  });
  const data = new Map<string, string>();
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      dropEffect: init.dropEffect ?? 'none',
      effectAllowed: 'all',
      types: [],
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
    },
  });
  return event;
}

const rows = () => [...container.querySelectorAll<HTMLElement>('[draggable="true"]')].filter((el) =>
  sessions.some((s) => el.textContent?.includes(s.name)),
);
const rowNamed = (name: string) => rows().find((el) => el.textContent?.includes(name))!;

it('renders configured agent workspace menus without queuing app-state saves', async () => {
  const mergePluginData = vi.fn();
  const workspaceMenuItems = vi.fn((ctx, workspace) =>
    agentsPlugin.workspaceMenuItems!({
      ...ctx,
      pluginSettings: { personas: { implementer: 'claude' } },
    }, workspace),
  );
  await render({ plugins: [{ ...agentsPlugin, workspaceMenuItems }], mergePluginData });
  expect(workspaceMenuItems).toHaveBeenCalled();
  expect(mergePluginData).not.toHaveBeenCalled();
  expect(container.textContent).toContain('server');
  await act(async () => rowNamed('server').click());
  expect(mergePluginData).not.toHaveBeenCalled();
});

it('reports a drag that ended outside the window, for a tear-off', async () => {
  const onSessionDragStart = vi.fn();
  const onSessionDragEnd = vi.fn();
  await render({ onSessionDragStart, onSessionDragEnd });
  const row = rowNamed('tests');

  await act(async () => {
    row.dispatchEvent(dragEvent('dragstart'));
  });
  expect(onSessionDragStart).toHaveBeenCalledWith('s-2');

  // The pointer leaves the window: a lone dragleave, no dragenter with it.
  await act(async () => {
    row.dispatchEvent(dragEvent('dragleave'));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    row.dispatchEvent(dragEvent('dragend', { clientX: 5, clientY: 5, dropEffect: 'none' }));
  });
  expect(onSessionDragEnd).toHaveBeenCalledWith('s-2', {
    dropEffect: 'none',
    outside: true,
    placement: expect.objectContaining({ width: window.innerWidth, height: window.innerHeight }),
  });
});

it('does not call a drop inside the window a tear-off', async () => {
  const onSessionDragEnd = vi.fn();
  await render({ onSessionDragEnd });
  const row = rowNamed('tests');
  await act(async () => {
    row.dispatchEvent(dragEvent('dragstart'));
    // Moving onto another element: enter + leave in the same task.
    rowNamed('server').dispatchEvent(dragEvent('dragenter'));
    row.dispatchEvent(dragEvent('dragleave'));
  });
  await act(async () => {
    row.dispatchEvent(dragEvent('dragend', { clientX: 20, clientY: 20, dropEffect: 'none' }));
  });
  expect(onSessionDragEnd.mock.calls[0][1].outside).toBe(false);
});

it('accepts a session dragged in from another window at the row it is dropped on', async () => {
  const onForeignDrop = vi.fn(() => true);
  const onMoveSession = vi.fn();
  await render({ foreignDrag: { sessionId: 'other-1', name: 'remote' }, onForeignDrop, onMoveSession });
  const target = rowNamed('tests').parentElement!;

  const over = dragEvent('dragover');
  await act(async () => {
    target.dispatchEvent(over);
  });
  expect(over.defaultPrevented).toBe(true);
  expect(target.className).toContain('before:bg-[var(--accent)]');

  const drop = dragEvent('drop');
  await act(async () => {
    target.dispatchEvent(drop);
  });
  expect(onForeignDrop).toHaveBeenCalledWith('ws-1', 's-2');
  expect(drop.defaultPrevented).toBe(true);
  expect(onMoveSession).not.toHaveBeenCalled();
});

it('appends a foreign session dropped on the workspace block', async () => {
  const onForeignDrop = vi.fn(() => true);
  await render({ foreignDrag: { sessionId: 'other-1', name: 'remote' }, onForeignDrop });
  const block = container.querySelector<HTMLElement>('.mb-3.rounded')!;
  await act(async () => {
    block.dispatchEvent(dragEvent('dragover'));
    block.dispatchEvent(dragEvent('drop'));
  });
  expect(onForeignDrop).toHaveBeenCalledWith('ws-1', null);
});

it('ignores drops when no session is being dragged anywhere', async () => {
  const onForeignDrop = vi.fn(() => true);
  await render({ foreignDrag: null, onForeignDrop });
  const over = dragEvent('dragover');
  await act(async () => {
    rowNamed('tests').parentElement!.dispatchEvent(over);
    rowNamed('tests').parentElement!.dispatchEvent(dragEvent('drop'));
  });
  expect(over.defaultPrevented).toBe(false);
  expect(onForeignDrop).not.toHaveBeenCalled();
});

it('offers "Move to new window" in the session menu', async () => {
  const onMoveToNewWindow = vi.fn();
  await render({ onMoveToNewWindow });
  await act(async () => {
    rowNamed('tests').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  });
  const item = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Move to new window'));
  expect(item).toBeDefined();
  await act(async () => item!.click());
  expect(onMoveToNewWindow).toHaveBeenCalledWith('s-2');
});

it('hides "Move to new window" for the only session in the window', async () => {
  await render({ onMoveToNewWindow: vi.fn(), sessions: [sessions[0]] });
  await act(async () => {
    rowNamed('server').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  });
  const labels = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '');
  expect(labels.some((l) => l.includes('Move to workspace') || l.includes('Close session'))).toBe(true);
  expect(labels.some((l) => l.includes('Move to new window'))).toBe(false);
});
