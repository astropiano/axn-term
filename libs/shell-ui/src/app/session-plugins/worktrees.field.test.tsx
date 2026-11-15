// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { findSessionField, createPluginApi, type PluginApiDeps } from './plugin';
import { worktreesPlugin } from './worktrees';
import type { RepoInfo, ShellSession } from '../../types';
import type { SessionBackend } from '@axn-term/session-backend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backend = {
  createSession: () => Promise.resolve(false),
  write: () => {},
  resize: () => {},
  close: () => {},
  onOutput: () => () => {},
} as unknown as SessionBackend;

const repo = (branch: string | null, root = '/wt/fix'): RepoInfo => ({
  name: 'axn-term-wt-fix',
  branch,
  ahead: 0,
  behind: 0,
  dirty: false,
  untracked: 0,
  remoteBranchMissing: false,
  root,
});

const session = (over: Partial<ShellSession> = {}): ShellSession => ({
  id: 's1',
  workspaceId: 'w1',
  name: 's1',
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  cwd: '/wt/fix',
  pluginState: {
    worktrees: {
      worktree: { repoRoot: '/main/repo', path: '/wt/fix', branch: 'wt/fix' },
    },
  },
  ...over,
});

const deps: PluginApiDeps = {
  backend,
  updateSession: () => {},
  mergePluginState: () => {},
  pluginSettings: {},
  plugins: [worktreesPlugin],
  openBrowser: () => {},
  openTab: () => {},
  openSubShell: () => undefined,
  openSession: () => {},
  pluginData: {},
  mergePluginData: () => {},
};

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function textOf(node: unknown): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<>{node as React.ReactNode}</>));
  return container.textContent ?? '';
}

const field = () => findSessionField(worktreesPlugin, 'worktree')!;

it('shows the live branch once repo probe lands', async () => {
  const ctx = createPluginApi(session({ repo: repo('fix-2') }), worktreesPlugin, deps);
  expect(await textOf(field().value!(ctx))).toContain('fix-2');
});

it('falls back to the creation branch before any repo probe', async () => {
  const ctx = createPluginApi(session({ repo: undefined }), worktreesPlugin, deps);
  expect(await textOf(field().value!(ctx))).toContain('fix');
});

it('keeps the creation branch when the session moved to another repo', async () => {
  const ctx = createPluginApi(
    session({ repo: repo('other-branch', '/elsewhere') }),
    worktreesPlugin,
    deps,
  );
  expect(await textOf(field().value!(ctx))).toContain('fix');
});

it('shows detached when the worktree HEAD detached', async () => {
  const ctx = createPluginApi(session({ repo: repo(null) }), worktreesPlugin, deps);
  expect(await textOf(field().value!(ctx))).toContain('(detached)');
});
