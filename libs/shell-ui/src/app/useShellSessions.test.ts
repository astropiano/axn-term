import { describe, expect, it } from 'vitest';
import { mergeMirrorSessions } from './useShellSessions';
import type { ShellSession } from '../types';

const session = (id: string, over: Partial<ShellSession> = {}): ShellSession => ({
  id,
  workspaceId: 'w1',
  name: id,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  cwd: '/repo',
  ...over,
});

const repo = { root: '/repo', name: 'repo', branch: 'main', ahead: 0, behind: 0, dirty: false, untracked: 0, remoteBranchMissing: false };

describe('mergeMirrorSessions', () => {
  it('keeps a locally probed repo across mirror reloads', () => {
    const prev = [session('s1', { repo })];
    const fresh = [session('s1')];
    expect(mergeMirrorSessions(prev, fresh)[0].repo).toBe(repo);
  });

  it('drops the repo when the session cwd moved', () => {
    const prev = [session('s1', { repo })];
    const fresh = [session('s1', { cwd: '/elsewhere' })];
    expect(mergeMirrorSessions(prev, fresh)[0].repo).toBeUndefined();
  });

  it('lets mirror data win when it carries a repo', () => {
    const other = { ...repo, branch: 'other' };
    const prev = [session('s1', { repo })];
    const fresh = [session('s1', { repo: other })];
    expect(mergeMirrorSessions(prev, fresh)[0].repo).toBe(other);
  });
});
