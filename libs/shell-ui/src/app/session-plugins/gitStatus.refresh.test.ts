// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bindGitBackend } from '../gitClient';
import { createPluginApi, type PluginApiDeps } from './plugin';
import { gitStatusPlugin } from './gitStatus';
import type { ShellSession } from '../../types';
import type { SessionBackend } from '@axn-term/session-backend';

const STATUS_MAIN = '## main...origin/main\n';
const STATUS_FEATURE = '## feature...origin/feature\n';

function makeBackend(): SessionBackend & { status: string; gitIds: string[] } {
  const backend = {
    status: STATUS_MAIN,
    gitIds: [] as string[],
    createSession: () => Promise.resolve(false),
    write: () => {},
    resize: () => {},
    close: () => {},
    onOutput: () => () => {},
    getCwd: () => Promise.resolve('/repo'),
    execGit: (id: string, _cwd: string, args: string[]) => {
      backend.gitIds.push(id);
      if (args.includes('rev-parse')) return Promise.resolve('/repo\n');
      if (args.includes('status')) return Promise.resolve(backend.status);
      return Promise.resolve('');
    },
  };
  return backend as unknown as SessionBackend & { status: string; gitIds: string[] };
}

function makeSession(repoBranch = 'main'): ShellSession {
  return {
    id: 's1',
    workspaceId: 'w1',
    name: 's1',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    cwd: '/repo',
    repo: {
      name: 'repo',
      branch: repoBranch,
      ahead: 0,
      behind: 0,
      dirty: false,
      untracked: 0,
      remoteBranchMissing: false,
      root: '/repo',
    },
  };
}

describe('git-status refresh on output', () => {
  let backend: ReturnType<typeof makeBackend>;
  let session: ShellSession;
  const updates: Partial<ShellSession>[] = [];

  function ctxFor(): PluginApiDeps {
    return {
      backend,
      updateSession: (_id, patch) => {
        updates.push(patch);
        session = { ...session, ...patch };
      },
      mergePluginState: () => {},
      pluginSettings: {},
      plugins: [gitStatusPlugin],
      openBrowser: () => {},
      openTab: () => {},
      openSubShell: () => undefined,
      openSession: () => {},
      pluginData: {},
      mergePluginData: () => {},
      getLiveSession: (id) => (session.id === id ? session : undefined),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    backend = makeBackend();
    bindGitBackend(backend);
    session = makeSession('main');
    updates.length = 0;
  });

  afterEach(() => {
    bindGitBackend(null);
    vi.useRealTimers();
  });

  it('patches session.repo after output settles', async () => {
    const ctx = createPluginApi(session, gitStatusPlugin, ctxFor());
    backend.status = STATUS_FEATURE; // user ran `git checkout feature`
    gitStatusPlugin.onOutput!(ctx, 'some output');
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates.some((p) => p.repo?.branch === 'feature')).toBe(true);
  });

  it('routes execGit through the session pty id, not the session id', async () => {
    session = { ...session, mainPtyId: 'pty-9' };
    const ctx = createPluginApi(session, gitStatusPlugin, ctxFor());
    gitStatusPlugin.onOutput!(ctx, 'some output');
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.gitIds.length).toBeGreaterThan(0);
    expect(backend.gitIds.every((id) => id === 'pty-9')).toBe(true);
  });
});
