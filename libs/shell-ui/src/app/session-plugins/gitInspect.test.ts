import { describe, it, expect, vi } from 'vitest';
import type { RepoInfo, ShellSession } from '../../types';
import type { RepoMenuContext, SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';
import { gitInspectPlugin } from './gitInspect';
import { gitStatusPlugin } from './gitStatus';
import { isPluginEnabled } from './plugin';
import { bindGitBackend } from '../gitClient';
import type { SessionBackend } from '@axn-term/session-backend';

const gitExec = vi.fn();
bindGitBackend({ execGit: gitExec } as unknown as SessionBackend);

const repo: RepoInfo = {
  name: 'axn-term',
  branch: 'main',
  ahead: 0,
  behind: 0,
  dirty: true,
  untracked: 2,
  remoteBranchMissing: false,
  root: '/repo',
};

describe('git-inspect plugin', () => {
  it('depends on git-status >= 0.1.0', () => {
    expect(gitInspectPlugin.dependsOn).toEqual([
      { id: 'git-status', version: '>=0.1.0' },
    ]);
    const all = [gitStatusPlugin, gitInspectPlugin];
    expect(isPluginEnabled(gitInspectPlugin, {}, all)).toBe(true);
    expect(
      isPluginEnabled(gitInspectPlugin, { 'git-status': { enabled: false } }, all),
    ).toBe(false);
  });

  it('contributes a Git changes row opening a git tab for the repo root', () => {
    const opened: { path: string; kind: string }[] = [];
    const ctx = {
      session: { id: 's1' } as ShellSession,
      openTab: (tab: { path: string; kind: string }) => opened.push(tab),
    } as unknown as RepoMenuContext;
    const items = gitInspectPlugin.repoMenuItems?.(ctx, repo) ?? [];
    expect(items).toHaveLength(1);
    items[0].onClick();
    expect(opened).toEqual([{ path: '/repo', kind: 'git' }]);
  });

  describe('axn-git command', () => {
    const axnGit = () =>
      pluginCommands(gitInspectPlugin).find((c) => c.name === 'axn-git')!;

    function ctx(cwd: string, opened: { path: string; kind: string }[]) {
      return {
        session: { id: 's1', cwd } as ShellSession,
        getCwd: async () => cwd,
        openTab: (tab: { path: string; kind: string }) => opened.push(tab),
      } as unknown as SessionViewContext & PluginApi;
    }

    it('opens a git tab at the repo root and swallows the line', async () => {
      const opened: { path: string; kind: string }[] = [];
      // NOTE: clear mocks inline, not in beforeEach — when mockClear/mockReset
      // runs inside a hook, vitest mis-tracks a returned rejected promise and
      // reports it as an unhandled test error even though the plugin catches it.
      gitExec.mockClear();
      gitExec.mockResolvedValue('/repo\n');
      const out = await axnGit().run?.(ctx('/repo/sub', opened), undefined, 'axn-git');
      expect(gitExec).toHaveBeenCalledWith('s1', '/repo/sub', ['--literal-pathspecs', 'rev-parse', '--show-toplevel']);
      expect(opened).toEqual([{ path: '/repo', kind: 'git' }]);
      expect(out).toBe(false);
    });

    it('echoes an error outside a repository', async () => {
      gitExec.mockClear();
      gitExec.mockRejectedValue(new Error('not a repo'));
      const out = await axnGit().run?.(ctx('/tmp', []), undefined, 'axn-git');
      expect(out).toBe('echo "axn-git: not inside a git repository"');
    });
  });
});
