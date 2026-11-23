// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import type { ShellSession, Workspace } from '../types';
import { useSessionCommands, type SessionCommandDeps } from './useSessionCommands';
import { echoReply } from '../shellQuote';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (id: string): ShellSession => ({
  id,
  workspaceId: 'ws-1',
  name: id,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
});

let root: Root | undefined;
let dispatch: ReturnType<typeof useSessionCommands>['handleSessionCommand'];

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

async function mount(sessions: ShellSession[], tearOffSession?: SessionCommandDeps['tearOffSession']) {
  const deps: SessionCommandDeps = {
    backend: { write: vi.fn() } as unknown as SessionBackend,
    platform: {} as ShellPlatform,
    sessionsRef: { current: sessions },
    workspacesRef: { current: [{ id: 'ws-1', name: 'api' } as Workspace] },
    enabledPluginsRef: { current: [] },
    buildPluginApi: vi.fn() as unknown as SessionCommandDeps['buildPluginApi'],
    openSession: vi.fn(),
    openSubShell: vi.fn(),
    addWorkspace: vi.fn(() => 'ws-2'),
    moveSessionToWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
    activateSessionTab: vi.fn(),
    renameSession: vi.fn(),
    updateSession: vi.fn(),
    pathDeps: { listDir: async () => [], homeDir: async () => '/home/u' } as unknown as SessionCommandDeps['pathDeps'],
    tearOffSession,
  };
  function Harness() {
    dispatch = useSessionCommands(deps).handleSessionCommand;
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
}

it('axn-session-window tears the session off instead of typing it into the shell', async () => {
  const tearOff = vi.fn(async () => null);
  await mount([session('s-1'), session('s-2')], tearOff);
  await expect(Promise.resolve(dispatch('s-2', 'axn-session-window'))).resolves.toBe(false);
  expect(tearOff).toHaveBeenCalledWith('s-2');
});

it('axn-session-window explains itself for the only session in a window', async () => {
  const tearOff = vi.fn(async () => null);
  await mount([session('s-1')], tearOff);
  await expect(Promise.resolve(dispatch('s-1', 'axn-session-window'))).resolves.toBe(
    echoReply('axn-session-window: this is the only session in its window'),
  );
  expect(tearOff).not.toHaveBeenCalled();
});

it('axn-session-window says so where new windows are not available (web)', async () => {
  await mount([session('s-1'), session('s-2')]);
  await expect(Promise.resolve(dispatch('s-1', 'axn-session-window'))).resolves.toBe(
    echoReply('axn-session-window: new windows are not available here'),
  );
});
