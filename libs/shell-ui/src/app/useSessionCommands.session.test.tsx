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
let commands: ReturnType<typeof useSessionCommands>;
let deps: SessionCommandDeps;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

async function mount(sessions: ShellSession[]) {
  deps = {
    backend: {
      write: vi.fn(),
      getCwd: vi.fn(async () => '/home/u/proj'),
      statPath: vi.fn(async (_pty: string, _cwd: string, path: string) =>
        path === 'src' || path === 'my dir'
          ? { path: `/home/u/proj/${path}`, isDir: true }
          : null,
      ),
    } as unknown as SessionBackend,
    platform: {} as ShellPlatform,
    sessionsRef: { current: sessions },
    workspacesRef: {
      current: [
        { id: 'ws-1', name: 'api' } as Workspace,
        { id: 'ws-2', name: 'vlavla' } as Workspace,
      ],
    },
    enabledPluginsRef: { current: [] },
    buildPluginApi: vi.fn() as unknown as SessionCommandDeps['buildPluginApi'],
    openSession: vi.fn(),
    openSubShell: vi.fn(),
    addWorkspace: vi.fn(() => 'ws-3'),
    moveSessionToWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
    activateSessionTab: vi.fn(),
    renameSession: vi.fn(),
    updateSession: vi.fn(),
    pathDeps: { listDir: async () => [], homeDir: async () => '/home/u' } as unknown as SessionCommandDeps['pathDeps'],
  };
  function Harness() {
    commands = useSessionCommands(deps);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
}

const dispatch = (sessionId: string, line: string) =>
  Promise.resolve(commands.handleSessionCommand(sessionId, line));

it('axn-session opens a session in the current workspace at the live cwd', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session')).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'api\' at /home/u/proj"');
  expect(deps.openSession).toHaveBeenCalledWith('ws-1', '/home/u/proj', undefined, undefined);
});

it('axn-session still opens at a directory path', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session src')).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'api\' at /home/u/proj/src"');
  expect(deps.openSession).toHaveBeenCalledWith('ws-1', '/home/u/proj/src', undefined, undefined);
});

it('axn-session -w opens the session in a named workspace', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session -w vlavla')).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'vlavla\' at /home/u/proj"');
  expect(deps.openSession).toHaveBeenCalledWith('ws-2', '/home/u/proj', undefined, undefined);
});

it('axn-session --workspace errors on a missing workspace without --create-ws', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session --workspace "fresh ws"')).resolves.toBe(
    'echo "axn-session: no such workspace: fresh ws (use --create-ws to create it)"',
  );
  expect(deps.addWorkspace).not.toHaveBeenCalled();
  expect(deps.openSession).not.toHaveBeenCalled();
});

it('axn-session --workspace --create-ws creates a missing workspace', async () => {
  await mount([session('s-1')]);
  await expect(
    dispatch('s-1', 'axn-session --workspace "fresh ws" --create-ws'),
  ).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'ws-3\' at /home/u/proj"');
  expect(deps.addWorkspace).toHaveBeenCalledWith('fresh ws');
  expect(deps.openSession).toHaveBeenCalledWith('ws-3', '/home/u/proj', undefined, undefined);
});

it('axn-session -n names the new session and combines with -w and a path', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session -w vlavla -n "fix the bug" src')).resolves.toBe('echo "axn-session: opened \'fix the bug\' in workspace \'vlavla\' at /home/u/proj/src"');
  expect(deps.openSession).toHaveBeenCalledWith('ws-2', '/home/u/proj/src', 'fix the bug', undefined);
});

it('axn-session keeps unquoted multi-word paths working', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session my dir')).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'api\' at /home/u/proj/my dir"');
  expect(deps.backend.statPath).toHaveBeenCalledWith('s-1', '/home/u/proj', 'my dir');
});

it('axn-session --background passes background through to openSession', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session -w vlavla --background')).resolves.toBe('echo "axn-session: opened \'session\' in workspace \'vlavla\' at /home/u/proj"');
  expect(deps.openSession).toHaveBeenCalledWith('ws-2', '/home/u/proj', undefined, true);
});

it('axn-session -w without a value echoes an error', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session -w')).resolves.toBe(
    'echo "axn-session: -w needs a value"',
  );
  expect(deps.openSession).not.toHaveBeenCalled();
});

it('axn-session completes workspace names after -w', async () => {
  await mount([session('s-1')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session -w vla')).resolves.toEqual([
    'axn-session -w vlavla',
  ]);
});

it('axn-session completes flag names on a dash', async () => {
  await mount([session('s-1')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session -')).resolves.toEqual([
    'axn-session -w ',
    'axn-session --workspace ',
    'axn-session -n ',
    'axn-session --name ',
    'axn-session --background ',
    'axn-session --create-ws ',
    'axn-session --summary ',
  ]);
});

it('axn-session completes the subcommands on the first token', async () => {
  await mount([session('s-1')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session c')).resolves.toContain(
    'axn-session create ',
  );
  await expect(commands.handleCompleteInput('s-1', 'axn-session se')).resolves.toEqual([
    'axn-session set ',
    'axn-session select ',
  ]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session l')).resolves.toEqual([
    'axn-session list ',
  ]);
});

it('axn-session set completes only its own flags', async () => {
  await mount([session('s-1')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session set -')).resolves.toEqual([
    'axn-session set --summary ',
    'axn-session set --name ',
    'axn-session set --title ',
    'axn-session set -n ',
  ]);
});

it('axn-session create behaves like the implicit form', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session create src -n "fix the bug"')).resolves.toBe(
    'echo "axn-session: opened \'fix the bug\' in workspace \'api\' at /home/u/proj/src"',
  );
  expect(deps.openSession).toHaveBeenCalledWith('ws-1', '/home/u/proj/src', 'fix the bug', undefined);
});

it('axn-session --summary sets the summary on the new session', async () => {
  await mount([session('s-1')]);
  (deps.openSession as ReturnType<typeof vi.fn>).mockReturnValue('s-2');
  await dispatch('s-1', 'axn-session create src --summary "the fix"');
  expect(deps.updateSession).toHaveBeenCalledWith('s-2', { summary: 'the fix' });
});

it('axn-session set --summary updates the session summary', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session set --summary "wip on api"')).resolves.toBe(
    'echo "axn-session: summary updated"',
  );
  expect(deps.updateSession).toHaveBeenCalledWith('s-1', { summary: 'wip on api' });
});

it('axn-session set --name and --title rename the session', async () => {
  await mount([session('s-1')]);
  await dispatch('s-1', 'axn-session set --name "api work"');
  expect(deps.renameSession).toHaveBeenCalledWith('s-1', 'api work');
  await dispatch('s-1', 'axn-session set --title "other"');
  expect(deps.renameSession).toHaveBeenCalledWith('s-1', 'other');
});

it('axn-session set without flags echoes usage', async () => {
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-session set')).resolves.toBe(
    'echo "axn-session: usage: axn-session set [--summary <text>] [--name|--title <name>]"',
  );
});

it('axn-broadcast writes the line to every marked session', async () => {
  const { broadcastSet } = await import('./broadcastSet');
  broadcastSet.clear();
  await mount([session('s-1'), session('s-2'), session('s-3')]);
  broadcastSet.mark('s-1');
  broadcastSet.mark('s-3');
  await expect(dispatch('s-1', 'axn-broadcast ls -la')).resolves.toBe(
    'echo "axn-broadcast: sent to 2 sessions"',
  );
  const write = deps.backend.write as ReturnType<typeof vi.fn>;
  expect(write).toHaveBeenCalledWith('s-1', 'ls -la\r');
  expect(write).toHaveBeenCalledWith('s-3', 'ls -la\r');
  expect(write).not.toHaveBeenCalledWith('s-2', expect.anything());
  broadcastSet.clear();
});

it('axn-broadcast-add/-rm/-clear manage the set, axn-broadcasts lists it', async () => {
  const { broadcastSet } = await import('./broadcastSet');
  broadcastSet.clear();
  await mount([session('s-1'), session('s-2')]);
  await expect(dispatch('s-1', 'axn-broadcast-add s-2')).resolves.toBe(
    'echo "axn-broadcast-add: marked \'s-2\'"',
  );
  expect(broadcastSet.has('s-2')).toBe(true);
  await expect(dispatch('s-1', 'axn-broadcasts')).resolves.toContain('s-2');
  await expect(dispatch('s-1', 'axn-broadcast-rm s-2')).resolves.toBe(
    'echo "axn-broadcast-rm: unmarked \'s-2\'"',
  );
  expect(broadcastSet.size()).toBe(0);
  await expect(dispatch('s-1', 'axn-broadcast-add')).resolves.toBe(
    'echo "axn-broadcast-add: marked \'s-1\'"',
  );
  await expect(dispatch('s-1', 'axn-broadcast-clear')).resolves.toBe(
    'echo "axn-broadcast-clear: 1 session unmarked"',
  );
});

it('axn-broadcast with an empty set explains how to mark', async () => {
  const { broadcastSet } = await import('./broadcastSet');
  broadcastSet.clear();
  await mount([session('s-1')]);
  await expect(dispatch('s-1', 'axn-broadcast hi')).resolves.toBe(
    'echo "axn-broadcast: broadcast set is empty (axn-broadcast-add marks sessions)"',
  );
  expect(deps.backend.write).not.toHaveBeenCalled();
});

it('axn-session list shows every session, * on the one that ran it', async () => {
  await mount([session('s-1'), session('s-2'), { ...session('s-3'), workspaceId: 'ws-2' }]);
  await expect(dispatch('s-1', 'axn-session list')).resolves.toBe(
    'echo "* s-1 (api)\\n  s-2 (api)\\n  s-3 (vlavla)"',
  );
});

it('axn-session select completes session names', async () => {
  await mount([session('s-1'), session('s-2'), session('s-3')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-session select s-')).resolves.toEqual([
    'axn-session select s-1',
    'axn-session select s-2',
    'axn-session select s-3',
  ]);
});

it('axn-broadcast --to sends the line verbatim to one named session', async () => {
  await mount([session('s-1'), session('s-2'), session('s-3')]);
  await expect(dispatch('s-1', 'axn-broadcast --to s-2 make -j')).resolves.toBe(
    'echo "axn-broadcast: sent to \'s-2\'"',
  );
  const write = deps.backend.write as ReturnType<typeof vi.fn>;
  expect(write).toHaveBeenCalledWith('s-2', 'make -j\r');
  expect(write).toHaveBeenCalledTimes(1);
});

it('axn-broadcast -t is the short flag', async () => {
  await mount([session('s-1'), session('s-2')]);
  await dispatch('s-1', 'axn-broadcast -t s-2 ls');
  expect(deps.backend.write).toHaveBeenCalledWith('s-2', 'ls\r');
});

it('axn-broadcast --to errors on a missing target or unknown session', async () => {
  await mount([session('s-1'), session('s-2')]);
  await expect(dispatch('s-1', 'axn-broadcast --to')).resolves.toBe(
    'echo "axn-broadcast: --to needs a session (name or id)"',
  );
  await expect(dispatch('s-1', 'axn-broadcast --to nobody hi')).resolves.toBe(
    'echo "axn-broadcast: no such session: nobody"',
  );
  expect(deps.backend.write).not.toHaveBeenCalled();
});

it('axn-broadcast completes the -t/--to flags and session names', async () => {
  await mount([session('s-1'), session('s-2')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-broadcast -')).resolves.toEqual([
    'axn-broadcast -t ',
    'axn-broadcast --to ',
  ]);
  await expect(commands.handleCompleteInput('s-1', 'axn-broadcast --to s-')).resolves.toEqual([
    'axn-broadcast --to s-1',
    'axn-broadcast --to s-2',
  ]);
});

it('axn-tell wraps the message with the sender session name', async () => {
  await mount([session('s-1'), session('s-2')]);
  (deps.backend as { getForegroundProcess?: unknown }).getForegroundProcess = vi.fn(
    async () => 'claude',
  );
  await expect(dispatch('s-1', 'axn-tell s-2 review the diff')).resolves.toBe(
    'echo "axn-tell: sent to \'s-2\'"',
  );
  expect(deps.backend.write).toHaveBeenCalledWith(
    's-2',
    '[axn-tell from "s-1"] review the diff\r',
  );
});

it('axn-tell comments the envelope when the target is a shell', async () => {
  await mount([session('s-1'), session('s-2')]);
  (deps.backend as { getForegroundProcess?: unknown }).getForegroundProcess = vi.fn(
    async () => 'zsh',
  );
  await dispatch('s-1', 'axn-tell s-2 ping me back');
  // A `#` line lands in scrollback/history instead of failing as a command.
  expect(deps.backend.write).toHaveBeenCalledWith(
    's-2',
    '# [axn-tell from "s-1"] ping me back\r',
  );
});

it('axn-tell resolves quoted and prefix session names', async () => {
  await mount([session('s-1'), { ...session('s-2'), name: 'my bot' }, session('other')]);
  (deps.backend as { getForegroundProcess?: unknown }).getForegroundProcess = vi.fn(
    async () => 'claude',
  );
  await dispatch('s-1', 'axn-tell "my bot" hi');
  expect(deps.backend.write).toHaveBeenCalledWith(
    's-2',
    '[axn-tell from "s-1"] hi\r',
  );
  await dispatch('s-1', 'axn-tell oth yo');
  expect(deps.backend.write).toHaveBeenCalledWith(
    'other',
    '[axn-tell from "s-1"] yo\r',
  );
});

it('axn-tell echoes usage/errors without writing', async () => {
  await mount([session('s-1'), session('s-2')]);
  await expect(dispatch('s-1', 'axn-tell')).resolves.toBe(
    'echo "usage: axn-tell <session> <message>"',
  );
  await expect(dispatch('s-1', 'axn-tell s-2')).resolves.toBe(
    'echo "usage: axn-tell <session> <message>"',
  );
  await expect(dispatch('s-1', 'axn-tell nobody hi')).resolves.toBe(
    'echo "axn-tell: no such session: nobody"',
  );
  expect(deps.backend.write).not.toHaveBeenCalled();
});

it('axn-tell completes session names for the target', async () => {
  await mount([session('s-1'), session('s-2'), session('s-3')]);
  await expect(commands.handleCompleteInput('s-1', 'axn-tell s-')).resolves.toEqual([
    'axn-tell s-1',
    'axn-tell s-2',
    'axn-tell s-3',
  ]);
  // After the target, the message is freeform — no completions.
  await expect(commands.handleCompleteInput('s-1', 'axn-tell s-2 hi')).resolves.toEqual([]);
});
