// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useShellSessions, type UseShellSessionsOptions } from './useShellSessions';
import type { ShellStateStore } from '../platform';
import type { WindowState } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let hook: ReturnType<typeof useShellSessions>;

function store(saved: WindowState | null): ShellStateStore {
  return {
    load: () => Promise.resolve(saved),
    save: vi.fn(() => Promise.resolve()),
    delete: () => Promise.resolve(),
  };
}

async function mount(s: ShellStateStore, options?: UseShellSessionsOptions) {
  function Harness() {
    hook = useShellSessions('w-7', s, options);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

it('boots a tear-off window empty, in a workspace named after the source', async () => {
  await mount(store(null), { startEmpty: { workspaceName: 'api' } });
  expect(hook.loaded).toBe(true);
  expect(hook.startedEmpty).toBe(true);
  expect(hook.sessions).toEqual([]);
  expect(hook.workspaces.map((w) => w.name)).toEqual(['api']);
  expect(hook.selectedSessionId).toBe('');
});

it('adopts the handed-over session into that workspace', async () => {
  await mount(store(null), { startEmpty: {} });
  const ws = hook.workspaces[0];
  expect(ws.name).toBe('workspace-1');
  await act(async () => hook.adoptSession(ws.id, { id: 'pty-1', name: 'build' }));
  expect(hook.sessions.map((s) => [s.id, s.workspaceId])).toEqual([['pty-1', ws.id]]);
});

it('ignores the tear-off boot when the window already has saved state (a reload)', async () => {
  const saved: WindowState = {
    id: 'w-7',
    workspaces: [{ id: 'ws', name: 'api', collapsed: false }],
    sessions: [{ id: 's1', workspaceId: 'ws', name: 'one', topic: '', summary: '', tasks: [], progress: 0, output: '' }],
  };
  await mount(store(saved), { startEmpty: { workspaceName: 'other' } });
  expect(hook.startedEmpty).toBe(false);
  expect(hook.sessions.map((s) => s.id)).toEqual(['s1']);
  expect(hook.workspaces.map((w) => w.name)).toEqual(['api']);
});

it('still opens a default session for a normal new window', async () => {
  await mount(store(null));
  expect(hook.startedEmpty).toBe(false);
  expect(hook.sessions).toHaveLength(1);
});
