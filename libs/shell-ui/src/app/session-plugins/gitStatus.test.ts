import { describe, it, expect } from 'vitest';
import { gitStatusPlugin } from './gitStatus';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';

const repo = {
  name: 'axn-term',
  branch: 'main',
  ahead: 0,
  behind: 0,
  dirty: false,
  untracked: 0,
  remoteBranchMissing: false,
  root: '/repo',
};

function ctx(
  pluginSettings: unknown,
  sessionRepo: typeof repo | null = repo,
): SessionViewContext & PluginApi {
  return {
    session: { id: 's1', repo: sessionRepo ?? undefined } as ShellSession,
    pluginSettings,
  } as SessionViewContext & PluginApi;
}

describe('git-status visibility settings', () => {
  it('renders the panel and title indicator by default', () => {
    expect(gitStatusPlugin.render?.(ctx(undefined))).not.toBeNull();
    expect(gitStatusPlugin.render?.(ctx({}))).not.toBeNull();
    expect(gitStatusPlugin.renderRow?.(ctx(undefined))).not.toBeNull();
    expect(gitStatusPlugin.renderRow?.(ctx({}))).not.toBeNull();
  });

  it('hides the panel when showInPanel is false', () => {
    expect(gitStatusPlugin.render?.(ctx({ showInPanel: false }))).toBeNull();
    expect(gitStatusPlugin.renderRow?.(ctx({ showInPanel: false }))).not.toBeNull();
  });

  it('keeps the legacy showInHeader key hiding the panel', () => {
    expect(gitStatusPlugin.render?.(ctx({ showInHeader: false }))).toBeNull();
  });

  it('hides the title indicator when showInTitle is false', () => {
    expect(gitStatusPlugin.renderRow?.(ctx({ showInTitle: false }))).toBeNull();
    expect(gitStatusPlugin.render?.(ctx({ showInTitle: false }))).not.toBeNull();
  });
});

describe('rowTip', () => {
  it('explains the clean repo marker', () => {
    expect(gitStatusPlugin.rowTip?.(ctx(undefined))).toBe(
      '⎇ axn-term @ main — ✓: clean',
    );
  });

  it('decodes the indicator glyphs', () => {
    const dirty = {
      ...repo,
      remoteBranchMissing: true,
      ahead: 2,
      behind: 1,
      dirty: true,
      untracked: 3,
    };
    expect(gitStatusPlugin.rowTip?.(ctx(undefined, dirty))).toBe(
      '⎇ axn-term @ main — ×: remote branch missing, ↑2: ahead of origin, ↓1: behind origin, ~: uncommitted changes, ?3: untracked files',
    );
  });

  it('mirrors the badge visibility gate', () => {
    expect(gitStatusPlugin.rowTip?.(ctx({ showInTitle: false }))).toBeNull();
    expect(gitStatusPlugin.rowTip?.(ctx(undefined, null))).toBeNull();
  });
});
