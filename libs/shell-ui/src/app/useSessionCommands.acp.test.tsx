// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import type { ShellSession, Workspace } from '../types';
import { useSessionCommands, type SessionCommandDeps } from './useSessionCommands';

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
let openAcpTab: ReturnType<typeof vi.fn>;
let openSession: ReturnType<typeof vi.fn>;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

async function mount(sessions: ShellSession[]) {
  openAcpTab = vi.fn();
  openSession = vi.fn();
  const deps: SessionCommandDeps = {
    backend: { write: vi.fn() } as unknown as SessionBackend,
    platform: {} as ShellPlatform,
    sessionsRef: { current: sessions },
    workspacesRef: { current: [{ id: 'ws-1', name: 'api' } as Workspace] },
    enabledPluginsRef: { current: [] },
    buildPluginApi: vi.fn() as unknown as SessionCommandDeps['buildPluginApi'],
    openSession,
    openSubShell: vi.fn(),
    openAcpTab,
    addWorkspace: vi.fn(() => 'ws-2'),
    moveSessionToWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
    activateSessionTab: vi.fn(),
    renameSession: vi.fn(),
    updateSession: vi.fn(),
    pathDeps: {
      listDir: async () => [],
      homeDir: async () => '/home/u',
    } as unknown as SessionCommandDeps['pathDeps'],
  };
  function Harness() {
    dispatch = useSessionCommands(deps).handleSessionCommand;
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
}

it('axn-acp opens an agent-chat tab and swallows the line', async () => {
  await mount([session('s-1')]);
  await expect(Promise.resolve(dispatch('s-1', 'axn-acp claude-agent-acp'))).resolves.toBe(false);
  expect(openAcpTab).toHaveBeenCalledWith('s-1', ['claude-agent-acp']);
});

it('axn-acp splits extra args into the agent argv', async () => {
  await mount([session('s-1')]);
  await Promise.resolve(dispatch('s-1', 'axn-acp npx -y @agentclientprotocol/claude-agent-acp'));
  expect(openAcpTab).toHaveBeenCalledWith('s-1', [
    'npx',
    '-y',
    '@agentclientprotocol/claude-agent-acp',
  ]);
});

it('axn-acp with no command echoes usage instead of opening a tab', async () => {
  await mount([session('s-1')]);
  await expect(Promise.resolve(dispatch('s-1', 'axn-acp'))).resolves.toMatch(/^echo "usage: axn-acp/);
  expect(openAcpTab).not.toHaveBeenCalled();
});

it('axn-acp-session opens an agent-first session with the agent argv', async () => {
  await mount([session('s-1')]);
  await expect(
    Promise.resolve(dispatch('s-1', 'axn-acp-session claude-agent-acp')),
  ).resolves.toBe(false);
  expect(openSession).toHaveBeenCalledWith('ws-1', undefined, undefined, undefined, {
    mainView: 'agent',
    acpCommand: ['claude-agent-acp'],
  });
});

it('axn-acp-session with no command echoes usage', async () => {
  await mount([session('s-1')]);
  await expect(Promise.resolve(dispatch('s-1', 'axn-acp-session'))).resolves.toMatch(
    /^echo "usage: axn-acp-session/,
  );
  expect(openSession).not.toHaveBeenCalled();
});
