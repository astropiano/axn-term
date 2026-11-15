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

  it('keeps locally derived runtime state across mirror reloads', () => {
    const prev = [
      session('s1', {
        output: 'retained pty text',
        tasks: [{ id: 't1', title: 'do it', status: 'active' }],
        progress: 42,
        summary: 'agent summary',
        topic: 'investigate',
        agentInput: 'devin',
        activeTab: 'sh-1',
      }),
    ];
    const fresh = [session('s1')];
    const merged = mergeMirrorSessions(prev, fresh)[0];
    expect(merged.output).toBe('retained pty text');
    expect(merged.tasks).toHaveLength(1);
    expect(merged.progress).toBe(42);
    expect(merged.summary).toBe('agent summary');
    expect(merged.topic).toBe('investigate');
    expect(merged.agentInput).toBe('devin');
    expect(merged.activeTab).toBe('sh-1');
  });

  it('keeps the authority-owned fields from the mirror', () => {
    const prev = [
      session('s1', { name: 'old', status: 'idle', process: 'zsh', cwd: '/a' }),
    ];
    const fresh = [
      session('s1', { name: 'new', status: 'running', process: 'devin', cwd: '/b' }),
    ];
    const merged = mergeMirrorSessions(prev, fresh)[0];
    expect(merged.name).toBe('new');
    expect(merged.status).toBe('running');
    expect(merged.process).toBe('devin');
    expect(merged.cwd).toBe('/b');
  });

  it('merges pluginState — mirror keys win, device-local keys survive', () => {
    const prev = [
      session('s1', {
        pluginState: {
          'dev-workflow': { state: 'review', banner: { level: 'info' } },
          'local-only': { a: 1 },
        },
      }),
    ];
    const fresh = [
      session('s1', {
        pluginState: { 'dev-workflow': { state: 'verdict' } },
      }),
    ];
    const merged = mergeMirrorSessions(prev, fresh)[0].pluginState as Record<
      string,
      Record<string, unknown>
    >;
    expect(merged['dev-workflow'].state).toBe('verdict');
    expect(merged['dev-workflow'].banner).toEqual({ level: 'info' });
    expect(merged['local-only'].a).toBe(1);
  });
});
