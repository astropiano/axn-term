// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useShellSessions } from './useShellSessions';
import type { ShellStateStore } from '../platform';
import type { WindowState } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved: WindowState = {
  id: 'w1',
  workspaces: [{ id: 'ws', name: 'workspace-1', collapsed: false }],
  sessions: [
    { id: 's1', workspaceId: 'ws', name: 'one', topic: '', summary: '', tasks: [], progress: 0, output: '' },
  ],
  selectedWorkspaceId: 'ws',
  selectedSessionId: 's1',
};

/** Store whose saves stay pending until the test settles them. */
function controlledStore() {
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const store: ShellStateStore = {
    load: () => Promise.resolve(saved),
    save: vi.fn(
      () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
    ),
    delete: () => Promise.resolve(),
  };
  return { store, pending };
}

let root: Root;
let hook: ReturnType<typeof useShellSessions>;

async function mount(store: ShellStateStore) {
  function Harness() {
    hook = useShellSessions('w1', store);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
}

/** Run the 2 s dirty flush and settle any work it starts. */
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
});

it('keeps state dirty when a change lands while a save is in flight', async () => {
  const { store, pending } = controlledStore();
  await mount(store);
  // Initial load marks dirty → first flush; once it lands nothing is dirty.
  await tick();
  expect(store.save).toHaveBeenCalledTimes(1);
  await act(async () => pending.shift()!.resolve());
  await tick();
  expect(store.save).toHaveBeenCalledTimes(1);

  // A structural change saves eagerly; a runtime change lands mid-save.
  await act(async () => hook.renameSession('s1', 'renamed'));
  expect(store.save).toHaveBeenCalledTimes(2);
  await act(async () => hook.updateSession('s1', { status: 'running' }));
  await act(async () => pending.shift()!.resolve());

  // The in-flight save did not include the status change: still dirty.
  await tick();
  expect(store.save).toHaveBeenCalledTimes(3);
  const last = vi.mocked(store.save).mock.calls[2][1] as WindowState;
  expect(last.sessions[0].status).toBe('running');
});

it('keeps state dirty and retries when a save fails', async () => {
  const { store, pending } = controlledStore();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await mount(store);
  await tick();
  expect(store.save).toHaveBeenCalledTimes(1);
  await act(async () => pending.shift()!.reject(new DOMException('full', 'QuotaExceededError')));

  await tick();
  expect(store.save).toHaveBeenCalledTimes(2);
  await act(async () => pending.shift()!.resolve());
  await tick();
  expect(store.save).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it('does not persist plugin banners — stripped on save, stripped on load', async () => {
  const { store, pending } = controlledStore();
  await mount(store);
  await tick();
  await act(async () => pending.shift()!.resolve());

  await act(async () =>
    hook.mergePluginState('s1', 'worktrees', {
      worktree: { path: '/x' },
      banner: { level: 'warning', message: 'devin is running in the main checkout' },
    }),
  );
  await tick();

  const last = vi.mocked(store.save).mock.calls.at(-1)![1] as WindowState;
  const slice = last.sessions[0].pluginState?.worktrees as Record<string, unknown>;
  // The rest of the slice persists; the runtime banner does not.
  expect(slice.worktree).toEqual({ path: '/x' });
  expect(slice).not.toHaveProperty('banner');
  // In memory the banner stays — only the persisted copy is stripped.
  const live = hook.sessions[0].pluginState?.worktrees as Record<string, unknown>;
  expect(live.banner).toBeTruthy();
});

it('strips banners persisted by older versions on load', async () => {
  const legacy: WindowState = {
    ...saved,
    sessions: [
      {
        ...saved.sessions[0],
        pluginState: {
          worktrees: {
            worktree: { path: '/x' },
            banner: { level: 'warning', message: 'devin is running' },
          },
        },
      },
    ],
  };
  const store: ShellStateStore = {
    load: () => Promise.resolve(legacy),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  await mount(store);
  const slice = hook.sessions[0].pluginState?.worktrees as Record<string, unknown>;
  expect(slice.worktree).toEqual({ path: '/x' });
  expect(slice).not.toHaveProperty('banner');
});

it('keeps a name given to addSession when the terminal reports its own title', async () => {
  const store: ShellStateStore = {
    load: () => Promise.resolve(saved),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  await mount(store);
  let named = '';
  let plain = '';
  await act(async () => {
    named = hook.addSession('ws', '/repo/worktrees/repo-mr-753', '!753 fix the thing') ?? '';
    plain = hook.addSession('ws', '/tmp') ?? '';
  });
  await act(async () => {
    hook.applySessionAutoName(named, 'me@host:/repo/worktrees/repo-mr-753');
    hook.applySessionAutoName(plain, 'me@host:/tmp');
  });
  const byId = (id: string) => hook.sessions.find((s) => s.id === id)!;
  expect(byId(named).name).toBe('!753 fix the thing');
  expect(byId(named).autoName).toBe('/repo/worktrees/repo-mr-753');
  // Without a chosen name the terminal title still names the session.
  expect(byId(plain).name).toBe('/tmp');
});
