import { describe, it, expect } from 'vitest';
import { findSessionField } from './plugin';
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
    expect(findSessionField(gitStatusPlugin, 'repo')!.value(ctx(undefined))).not.toBeNull();
    expect(findSessionField(gitStatusPlugin, 'repo')!.value(ctx({}))).not.toBeNull();
    expect(findSessionField(gitStatusPlugin, 'branch')!.value(ctx(undefined))).not.toBeNull();
    expect(findSessionField(gitStatusPlugin, 'branch')!.value(ctx({}))).not.toBeNull();
  });

  it('hides the panel when showInPanel is false', () => {
    expect(findSessionField(gitStatusPlugin, 'repo')!.value(ctx({ showInPanel: false }))).toBeNull();
    expect(findSessionField(gitStatusPlugin, 'branch')!.value(ctx({ showInPanel: false }))).not.toBeNull();
  });

  it('keeps the legacy showInHeader key hiding the panel', () => {
    expect(findSessionField(gitStatusPlugin, 'repo')!.value(ctx({ showInHeader: false }))).toBeNull();
  });

  it('hides the title indicator when showInTitle is false', () => {
    expect(findSessionField(gitStatusPlugin, 'branch')!.value(ctx({ showInTitle: false }))).toBeNull();
    expect(findSessionField(gitStatusPlugin, 'repo')!.value(ctx({ showInTitle: false }))).not.toBeNull();
  });
});

describe('rowTip', () => {
  it('explains the clean repo marker', () => {
    expect(findSessionField(gitStatusPlugin, 'branch')!.tip!(ctx(undefined))).toBe(
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
    expect(findSessionField(gitStatusPlugin, 'branch')!.tip!(ctx(undefined, dirty))).toBe(
      '⎇ axn-term @ main — ×: remote branch missing, ↑2: ahead of origin, ↓1: behind origin, ~: uncommitted changes, ?3: untracked files',
    );
  });

  it('mirrors the badge visibility gate', () => {
    expect(findSessionField(gitStatusPlugin, 'branch')!.tip!(ctx({ showInTitle: false }))).toBeNull();
    expect(findSessionField(gitStatusPlugin, 'branch')!.tip!(ctx(undefined, null))).toBeNull();
  });
});

describe('search', () => {
  it('offers branch + repo name, gated like the badge', () => {
    const terms = findSessionField(gitStatusPlugin, 'branch')!.search!(ctx(undefined)) as string[];
    expect(terms.length).toBe(2);
    expect(findSessionField(gitStatusPlugin, 'branch')!.search!(ctx({ showInTitle: false }))).toBeNull();
    expect(findSessionField(gitStatusPlugin, 'repo')!.search!(ctx({ showInPanel: false }))).toBeNull();
  });
});
