// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShellApp } from './ShellApp';
import { storyPlatform } from './storyMocks';
import { SettingsProvider } from '../SettingsProvider';
import type { ShellPlatform } from '../platform';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellSession } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BRANCH_BEFORE = 'branch-before';
const BRANCH_AFTER = 'branch-after';

interface FakeBackend {
  backend: SessionBackend;
  emit: (ptyId: string, text: string) => void;
  setBranch: (branch: string) => void;
}

function makeBackend(): FakeBackend {
  const outputCbs = new Map<string, Set<(data: Uint8Array) => void>>();
  let branch = BRANCH_BEFORE;
  const encoder = new TextEncoder();
  const backend = {
    createSession: () => Promise.resolve(true),
    write: () => {},
    resize: () => {},
    close: () => {},
    onOutput: (id: string, cb: (data: Uint8Array) => void) => {
      let set = outputCbs.get(id);
      if (!set) outputCbs.set(id, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
    onSessionExit: () => () => {},
    onSubshellExit: () => () => {},
    setSubshellParent: () => {},
    getCwd: () => Promise.resolve('/repo'),
    getForegroundProcess: () => Promise.resolve(null),
    getDefaultShell: () => Promise.resolve('zsh'),
    exec: () => Promise.resolve(''),
    execGit: (_id: string, _cwd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve('/repo\n');
      if (args.includes('remote')) return Promise.resolve('https://gitlab.com/grp/repo.git\n');
      if (args.includes('status')) {
        return Promise.resolve(`## ${branch}...origin/${branch}\n`);
      }
      return Promise.resolve('');
    },
  } as unknown as SessionBackend;
  return {
    backend,
    emit: (ptyId, text) => {
      for (const cb of outputCbs.get(ptyId) ?? []) cb(encoder.encode(text));
    },
    setBranch: (b) => {
      branch = b;
    },
  };
}

const session: ShellSession = {
  id: 's-1',
  workspaceId: 'w1',
  name: 'worktree',
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  cwd: '/repo',
  repo: {
    name: 'repo',
    group: 'grp',
    branch: BRANCH_BEFORE,
    ahead: 0,
    behind: 0,
    dirty: false,
    untracked: 0,
    remoteBranchMissing: false,
    root: '/repo',
    remote: 'https://gitlab.com/grp/repo.git',
  },
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
});

it('updates the session card branch after PTY output', async () => {
  const { backend, emit, setBranch } = makeBackend();
  const platform: ShellPlatform = {
    ...storyPlatform,
    stateStore: {
      load: () =>
        Promise.resolve({
          id: 'main',
          workspaces: [{ id: 'w1', name: 'ws' }],
          sessions: [session],
          selectedWorkspaceId: 'w1',
          selectedSessionId: 's-1',
        }),
      save: () => Promise.resolve(),
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellApp
          backend={backend}
          services={{ copyText: () => Promise.resolve(), openExternal: () => {} }}
          platform={platform}
          fileReader={() => undefined}
        />
      </SettingsProvider>,
    ),
  );
  // Let the PTY spawn, plugin settings load and onSessionOpen's refresh settle.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(container.textContent).toContain(BRANCH_BEFORE);

  // The user checks out another branch; the shell echoes output.
  setBranch(BRANCH_AFTER);
  emit('s-1', '$ git checkout ' + BRANCH_AFTER);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });

  expect(container.textContent).toContain(BRANCH_AFTER);
});
