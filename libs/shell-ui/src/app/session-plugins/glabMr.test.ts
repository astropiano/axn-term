import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindAppRuntime } from '../appRuntime';
import {
  currentMrOverview,
  mrListCommand,
  mrOverviewCommand,
  refreshMrOverview,
  resetMrOverview,
  glabMrPlugin,
  openThreads,
  countOpenThreads,
  myOpenThreads,
  myThreadsAnswered,
  mrNeedsAction,
  mrWaitingForMe,
  mergeMine,
  type GlabMrItem,
  type MrDiscussion,
} from './glabMr';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';

const thread = (notes: string[], resolved = false): MrDiscussion => ({
  resolvable: true,
  resolved,
  notes,
});

function mr(partial: Partial<GlabMrItem> = {}): GlabMrItem {
  return {
    key: 'a/b!1',
    iid: 1,
    reference: '!1',
    title: 'mr',
    description: '',
    url: 'https://gitlab.com/a/b/-/merge_requests/1',
    project: 'a/b',
    sourceBranch: 'feat',
    targetBranch: 'main',
    draft: false,
    conflicts: false,
    mergeStatus: 'mergeable',
    pipeline: 'success',
    approved: false,
    approvedBy: [],
    author: 'bob',
    assignees: [],
    reviewers: [],
    updatedAt: '2026-01-01',
    discussions: [],
    ...partial,
  };
}

describe('openThreads', () => {
  it('counts only unresolved resolvable discussions', () => {
    const m = mr({
      discussions: [
        thread(['bob']),
        thread(['bob'], true),
        { resolvable: false, resolved: false, notes: ['bob'] },
      ],
    });
    expect(openThreads(m)).toBe(1);
  });
});

describe('countOpenThreads', () => {
  it('counts REST discussions holding an unresolved resolvable note', () => {
    expect(
      countOpenThreads([
        { notes: [{ resolvable: true, resolved: false }] },
        { notes: [{ resolvable: true, resolved: true }] },
        { notes: [{ resolvable: false, resolved: null }] },
        {
          notes: [
            { resolvable: true, resolved: true },
            { resolvable: false },
          ],
        },
        {
          notes: [
            { resolvable: true, resolved: true },
            { resolvable: true, resolved: false },
          ],
        },
        {},
      ]),
    ).toBe(2);
  });
});

describe('myOpenThreads / myThreadsAnswered', () => {
  it('finds only unresolved threads containing a note by me', () => {
    const m = mr({
      discussions: [
        thread(['bob', 'me']),
        thread(['me'], true),
        thread(['bob', 'carol']),
      ],
    });
    expect(myOpenThreads(m, 'me')).toHaveLength(1);
  });

  it('is answered when the last note is not mine', () => {
    const m = mr({ discussions: [thread(['me', 'bob'])] });
    expect(myThreadsAnswered(m, 'me')).toBe(true);
  });

  it('is not answered when the last note is mine', () => {
    const m = mr({ discussions: [thread(['bob', 'me'])] });
    expect(myThreadsAnswered(m, 'me')).toBe(false);
  });
});

describe('mrNeedsAction', () => {
  it('is false for a clean MR', () => {
    expect(mrNeedsAction(mr())).toBe(false);
  });

  it('is true on conflicts', () => {
    expect(mrNeedsAction(mr({ conflicts: true }))).toBe(true);
  });

  it('is true when approved', () => {
    expect(mrNeedsAction(mr({ approved: true }))).toBe(true);
  });

  it('is true on a failing pipeline', () => {
    expect(mrNeedsAction(mr({ pipeline: 'failed' }))).toBe(true);
  });

  it('is true with open threads', () => {
    expect(mrNeedsAction(mr({ discussions: [thread(['bob'])] }))).toBe(true);
  });

  it('is false when only non-resolvable notes exist', () => {
    expect(
      mrNeedsAction(
        mr({ discussions: [{ resolvable: false, resolved: false, notes: ['bob'] }] }),
      ),
    ).toBe(false);
  });
});

describe('mrWaitingForMe', () => {
  it('is false once I approved', () => {
    expect(mrWaitingForMe(mr({ approvedBy: ['me'] }), 'me')).toBe(false);
  });

  it('is true for a fresh review (no threads, not approved)', () => {
    expect(mrWaitingForMe(mr(), 'me')).toBe(true);
  });

  it('is false while waiting on the author (my open thread, last note mine)', () => {
    const m = mr({ discussions: [thread(['bob', 'me'])] });
    expect(mrWaitingForMe(m, 'me')).toBe(false);
  });

  it('is true when my thread got an answer', () => {
    const m = mr({ discussions: [thread(['me', 'bob'])] });
    expect(mrWaitingForMe(m, 'me')).toBe(true);
  });

  it('is true with open threads I am not part of', () => {
    const m = mr({ discussions: [thread(['bob', 'carol'])] });
    expect(mrWaitingForMe(m, 'me')).toBe(true);
  });
});

describe('mergeMine', () => {
  it('unions assigned and authored-without-assignee, deduped', () => {
    const assigned = [mr({ key: 'a/b!1', iid: 1 })];
    const authored = [
      mr({ key: 'a/b!1', iid: 1, assignees: ['me'] }),
      mr({ key: 'a/b!2', iid: 2 }),
      mr({ key: 'a/b!3', iid: 3, assignees: ['carol'] }),
    ];
    const mine = mergeMine(assigned, authored);
    expect(mine.map((m) => m.key).sort()).toEqual(['a/b!1', 'a/b!2']);
  });
});

function ctx(
  pluginSettings: unknown,
  mrs = [mr({ key: 'a/b!1', iid: 1 })],
): SessionViewContext & PluginApi {
  return {
    session: { id: 's1' } as ShellSession,
    pluginSettings,
    pluginState: { mrs },
  } as SessionViewContext & PluginApi;
}

describe('visibility settings', () => {
  it('renders the panel and title indicator by default', () => {
    expect(glabMrPlugin.render?.(ctx(undefined))).not.toBeNull();
    expect(glabMrPlugin.render?.(ctx({}))).not.toBeNull();
    expect(glabMrPlugin.renderRow?.(ctx({}))).not.toBeNull();
  });

  it('hides the panel when showInPanel is false', () => {
    expect(glabMrPlugin.render?.(ctx({ showInPanel: false }))).toBeNull();
    expect(glabMrPlugin.renderRow?.(ctx({ showInPanel: false }))).not.toBeNull();
  });

  it('keeps the legacy showInHeader key hiding the panel', () => {
    expect(glabMrPlugin.render?.(ctx({ showInHeader: false }))).toBeNull();
  });

  it('hides the title indicator when showInTitle is false', () => {
    expect(glabMrPlugin.renderRow?.(ctx({ showInTitle: false }))).toBeNull();
    expect(glabMrPlugin.render?.(ctx({ showInTitle: false }))).not.toBeNull();
  });
});

describe('rowTip', () => {
  it('explains the MR badge', () => {
    expect(glabMrPlugin.rowTip?.(ctx({}))).toBe(
      '!1: open merge request on this branch — mr',
    );
    const two = [mr(), mr({ key: 'a/b!2', iid: 2, reference: '!2' })];
    expect(glabMrPlugin.rowTip?.(ctx({}, two))).toBe(
      '!1 +1: open merge requests on this branch — mr',
    );
  });

  it('mirrors the badge visibility gate', () => {
    expect(glabMrPlugin.rowTip?.(ctx({ showInTitle: false }))).toBeNull();
    expect(glabMrPlugin.rowTip?.(ctx({}, []))).toBeNull();
  });
});

describe('glab command lines', () => {
  /** Run through a real sh with a stub `glab` that prints its argv. */
  function argvOf(command: string, cwd: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'axn-glab-stub-'));
    writeFileSync(join(dir, 'glab'), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n');
    chmodSync(join(dir, 'glab'), 0o755);
    const res = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    return res.stdout.split('\0').slice(0, -1);
  }

  it('passes a hostile branch name (valid in git) as one literal argument', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'axn-glab-cwd-'));
    const branch = '$(touch${IFS}pwned)';
    expect(argvOf(mrListCommand(branch), cwd).slice(0, 3)).toEqual(['mr', 'list', '-s']);
    expect(argvOf(mrListCommand(branch), cwd)[3]).toBe(branch);
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
  });

  it('sends the overview query and hostname as single arguments', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'axn-glab-cwd-'));
    const argv = argvOf(mrOverviewCommand('gitlab.acme.io'), cwd);
    expect(argv.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'gitlab.acme.io']);
    expect(argv[5]).toMatch(/^query=query \{ currentUser \{/);
    expect(argv[5]).toContain('description');
  });
});

describe('refreshMrOverview failures', () => {
  afterEach(() => {
    bindAppRuntime(null);
    resetMrOverview();
  });

  const runtime = (exec: () => Promise<string>) =>
    bindAppRuntime({ exec, statPath: async () => null, resolveSessionId: () => null });

  it.each([
    ['axn-term: glab is not installed', 'missing'],
    ['{"errors":[{"message":"Invalid token"}]}glab: Invalid token', 'signed-out'],
    ['glab: 502 Bad Gateway', 'error'],
  ] as const)('classifies %j as %s', async (message, failure) => {
    runtime(async () => {
      throw new Error(message);
    });
    await refreshMrOverview();
    expect(currentMrOverview()).toMatchObject({ status: 'error', failure });
  });

  it('records the host it queried, so hints can name it', async () => {
    runtime(async () => {
      throw new Error('glab: 502 Bad Gateway');
    });
    await refreshMrOverview({ hostname: ' gitlab.acme.io ' });
    expect(currentMrOverview()).toMatchObject({ status: 'error', host: 'gitlab.acme.io' });
    await refreshMrOverview();
    expect(currentMrOverview().host).toBeUndefined();
  });

  it('treats an anonymous answer (currentUser null) as signed out', async () => {
    runtime(async () => JSON.stringify({ data: { currentUser: null } }));
    await refreshMrOverview();
    expect(currentMrOverview()).toMatchObject({ status: 'error', failure: 'signed-out' });
  });
});
