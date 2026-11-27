import { describe, it, expect, afterEach } from 'vitest';
import { findSessionField } from './plugin';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindAppRuntime } from '../appRuntime';
import {
  currentMrOverview,
  mrListCommand,
  mrDiscussionsCommand,
  mrOverviewCommand,
  refreshMrOverview,
  resetMrOverview,
  glabMrPlugin,
  extractTicketFromTitle,
  glabMrIdentifiers,
  openThreads,
  countOpenThreads,
  mergedMrListCommand,
  normalizeRestDiscussions,
  myOpenThreads,
  myThreadsAnswered,
  summarizeOpenThreads,
  mrAwaitingOthers,
  threadSummaryTip,
  relativeAgo,
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

describe('ticket identifiers', () => {
  it('extracts a capture group and normalizes it', () => {
    expect(extractTicketFromTitle('[mgnl-42] improve search', '([A-Z]+-\\d+)')).toBe('MGNL-42');
    expect(extractTicketFromTitle('unrelated', '([A-Z]+-\\d+)')).toBeUndefined();
    expect(extractTicketFromTitle('MGNL-42', '[')).toBeUndefined();
  });

  it('publishes unique ticket identifiers from MR titles', () => {
    expect(
      glabMrIdentifiers({
        session: {} as never,
        pluginSettings: { ticketRegex: '([A-Z]+-\\d+)' },
        pluginState: { mrs: [mr({ title: 'MGNL-1 first' }), mr({ title: 'mgnl-1 second' }), mr({ title: 'AIACC-2' })] },
      }),
    ).toEqual([
      { value: 'MGNL-1', source: 'glab-mr', label: 'MR' },
      { value: 'AIACC-2', source: 'glab-mr', label: 'MR' },
    ]);
  });
});

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

describe('summarizeOpenThreads', () => {
  it('counts the last author for unresolved resolvable threads', () => {
    const m = mr({
      discussions: [
        thread(['me']),
        thread(['other', 'me']),
        thread(['me', 'other']),
        thread(['other'], true),
        { resolvable: false, resolved: false, notes: ['other'] },
      ],
    });
    expect(summarizeOpenThreads(m, 'me')).toEqual({ waitingForMe: 1, waitingForOther: 2 });
  });

  it('leaves threads without a known author out of the responsibility counts', () => {
    expect(summarizeOpenThreads(mr({ discussions: [thread([])] }), 'me')).toEqual({
      waitingForMe: 0,
      waitingForOther: 0,
    });
  });
});

describe('mrNeedsAction with a thread summary', () => {
  const sum = (waitingForMe: number, waitingForOther: number) => ({ waitingForMe, waitingForOther });
  it('is red only when a thread waits on me', () => {
    expect(mrNeedsAction(mr({ openThreadCount: 2, threadSummary: sum(1, 1) }))).toBe(true);
    expect(mrNeedsAction(mr({ openThreadCount: 2, threadSummary: sum(0, 2) }))).toBe(false);
  });

  it('approved but waiting on others to resolve my threads is not an action, unless mergeable', () => {
    const base = { approved: true, openThreadCount: 1, threadSummary: sum(0, 1) };
    expect(mrNeedsAction(mr({ ...base, mergeStatus: 'discussions_not_resolved' }))).toBe(false);
    expect(mrNeedsAction(mr({ ...base, mergeStatus: 'mergeable' }))).toBe(true);
    expect(mrAwaitingOthers(mr(base))).toBe(true);
  });

  it('without a summary any open thread still counts', () => {
    expect(mrNeedsAction(mr({ openThreadCount: 1 }))).toBe(true);
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
    expect(findSessionField(glabMrPlugin, 'mrs')!.value(ctx(undefined))).not.toBeNull();
    expect(findSessionField(glabMrPlugin, 'mrs')!.value(ctx({}))).not.toBeNull();
    expect(findSessionField(glabMrPlugin, 'mr')!.value(ctx({}))).not.toBeNull();
  });

  it('hides the panel when showInPanel is false', () => {
    expect(findSessionField(glabMrPlugin, 'mrs')!.value(ctx({ showInPanel: false }))).toBeNull();
    expect(findSessionField(glabMrPlugin, 'mr')!.value(ctx({ showInPanel: false }))).not.toBeNull();
  });

  it('keeps the legacy showInHeader key hiding the panel', () => {
    expect(findSessionField(glabMrPlugin, 'mrs')!.value(ctx({ showInHeader: false }))).toBeNull();
  });

  it('hides the title indicator when showInTitle is false', () => {
    expect(findSessionField(glabMrPlugin, 'mr')!.value(ctx({ showInTitle: false }))).toBeNull();
    expect(findSessionField(glabMrPlugin, 'mrs')!.value(ctx({ showInTitle: false }))).not.toBeNull();
  });
});

describe('rowTip', () => {
  it('explains the MR badge', () => {
    expect(findSessionField(glabMrPlugin, 'mr')!.tip!(ctx({}))).toBe(
      '!1: open merge request on this branch — mr',
    );
    const two = [mr(), mr({ key: 'a/b!2', iid: 2, reference: '!2' })];
    expect(findSessionField(glabMrPlugin, 'mr')!.tip!(ctx({}, two))).toBe(
      '!1 +1: open merge requests on this branch — mr',
    );
  });

  it('mirrors the badge visibility gate', () => {
    expect(findSessionField(glabMrPlugin, 'mr')!.tip!(ctx({ showInTitle: false }))).toBeNull();
    expect(findSessionField(glabMrPlugin, 'mr')!.tip!(ctx({}, []))).toBeNull();
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

  it('keeps discussions out of the list query and batches them with variables', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'axn-glab-cwd-'));
    const list = argvOf(mrOverviewCommand('gitlab.acme.io'), cwd)[5];
    expect(list).toContain('reviewRequestedMergeRequests');
    expect(list).toContain('resolvableDiscussionsCount');
    expect(list).not.toContain('discussions(');
    const argv = argvOf(
      mrDiscussionsCommand('gitlab.acme.io', [
        { project: 'grp/$(touch pwned)', iid: 7 },
        { project: 'g/q', iid: '9' },
      ]),
      cwd,
    );
    expect(argv.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'gitlab.acme.io']);
    expect(argv[5]).toContain('m0: project(fullPath: $p0)');
    expect(argv[5]).toContain('m1: project(fullPath: $p1)');
    expect(argv[5]).toContain('notes(last: 20)');
    expect(argv[5]).toContain('pageInfo');
    expect(argv[5]).not.toContain('pwned');
    expect(argv.slice(6)).toEqual(['-f', 'p0=grp/$(touch pwned)', '-f', 'i0=7', '-f', 'p1=g/q', '-f', 'i1=9']);
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
  });

  it('adds a discussion cursor only when requesting a later page', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'axn-glab-cwd-'));
    const argv = argvOf(
      mrDiscussionsCommand('gitlab.acme.io', [{ project: 'g/q', iid: 9, after: 'cursor-1' }]),
      cwd,
    );
    expect(argv[5]).toContain('after: $a0');
    expect(argv.slice(6)).toEqual(['-f', 'p0=g/q', '-f', 'i0=9', '-f', 'a0=cursor-1']);
  });
});

describe('refreshMrOverview failures', () => {
  afterEach(() => {
    bindAppRuntime(null);
    resetMrOverview();
  });

  const runtime = (exec: (command?: string) => Promise<string>) =>
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

  const gqlMr = (iid: string, extra: object = {}) => ({
    iid, reference: `!${iid}`, title: `t${iid}`, webUrl: `u${iid}`, draft: false, conflicts: false,
    detailedMergeStatus: 'mergeable', sourceBranch: 'b', targetBranch: 'main', updatedAt: '2026-11-03T00:00:00Z',
    approved: false, approvedBy: { nodes: [] }, author: { username: 'me' }, assignees: { nodes: [] },
    reviewers: { nodes: [] }, project: { fullPath: 'g/p' }, headPipeline: null,
    ...extra,
  });
  const thread = (...authors: string[]) => ({
    resolvable: true, resolved: false, notes: { nodes: authors.map((username) => ({ author: { username } })) },
  });
  /** An MR with no open threads: its discussions are never fetched. */
  const quietMr = (iid: string, extra: object = {}) =>
    gqlMr(iid, { resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, ...extra });
  const lists = (review: object[], mine: object[] = [quietMr('1'), quietMr('2')]) =>
    JSON.stringify({ data: { currentUser: {
      username: 'me',
      assignedMergeRequests: { nodes: [quietMr('1', { assignees: { nodes: [{ username: 'me' }] } })] },
      authoredMergeRequests: { nodes: mine },
      reviewRequestedMergeRequests: { nodes: review },
    } } });
  const reviewMr = (iid: string, notes = 1) =>
    gqlMr(iid, { author: { username: 'other' }, userNotesCount: notes, resolvableDiscussionsCount: 1, resolvedDiscussionsCount: 0 });
  /** iids of a batched discussions command, in alias order; empty for the lists query. */
  const iidsOf = (cmd: string) => [...cmd.matchAll(/'i\d+=(\d+)'/g)].map((m) => m[1]);
  const discussionsAnswer = (iids: string[], authors: (iid: string) => string[]) =>
    JSON.stringify({ data: Object.fromEntries(iids.map((iid, i) => [
      `m${i}`, { mergeRequest: { discussions: { nodes: [thread(...authors(iid))] } } },
    ])) });

  it('fetches discussions only for MRs with open threads, in one batch', async () => {
    const calls: string[][] = [];
    runtime(async (cmd = '') => {
      const iids = iidsOf(cmd);
      calls.push(iids);
      if (!iids.length) {
        return lists([reviewMr('3'), reviewMr('4')], [quietMr('1'), gqlMr('2', { resolvableDiscussionsCount: 3, resolvedDiscussionsCount: 1 })]);
      }
      return discussionsAnswer(iids, (iid) => ['me', `r${iid}`]);
    });
    await refreshMrOverview({ hostname: 'gitlab.acme.io' });
    expect(calls).toEqual([[], ['2', '3', '4']]);
    const o = currentMrOverview();
    expect(o.status).toBe('ready');
    expect(o.mine.map((m) => m.iid).sort()).toEqual([1, 2]);
    const two = o.mine.find((m) => m.iid === 2)!;
    expect(openThreads(two)).toBe(2);
    expect(mrNeedsAction(two)).toBe(true);
    expect(o.review.map((m) => m.iid)).toEqual([3, 4]);
    expect(o.review[0].discussions).toEqual([{ resolvable: true, resolved: false, notes: ['me', 'r3'] }]);
  });

  it('refetches only MRs whose note/thread counters changed', async () => {
    let notesOn4 = 1;
    const calls: string[][] = [];
    runtime(async (cmd = '') => {
      const iids = iidsOf(cmd);
      calls.push(iids);
      if (!iids.length) return lists([reviewMr('3'), reviewMr('4', notesOn4)]);
      return discussionsAnswer(iids, (iid) => ['me', `r${iid}`]);
    });
    await refreshMrOverview();
    await refreshMrOverview();
    expect(calls).toEqual([[], ['3', '4'], []]); // a quiet poll is one call
    notesOn4 = 2;
    await refreshMrOverview();
    expect(calls.slice(3)).toEqual([[], ['4']]);
    expect(currentMrOverview().review.map((m) => m.discussions.length)).toEqual([1, 1]);
  });

  it('follows every discussion page before classifying the thread owners', async () => {
    let page = 0;
    runtime(async (cmd = '') => {
      const iids = iidsOf(cmd);
      if (!iids.length) return lists([reviewMr('3')]);
      page += 1;
      if (page === 1) {
        return JSON.stringify({ data: {
          m0: { mergeRequest: {
            discussions: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              nodes: [thread('me')],
            },
          } },
        } });
      }
      expect(cmd).toContain('after: $a0');
      return JSON.stringify({ data: {
        m0: { mergeRequest: {
          discussions: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [thread('reviewer')],
          },
        } },
      } });
    });
    await refreshMrOverview();
    expect(currentMrOverview().review[0].discussions).toHaveLength(2);
    expect(currentMrOverview().review[0].threadSummary).toEqual({
      waitingForMe: 1,
      waitingForOther: 1,
    });
  });

  it('splits discussions into batches of eight', async () => {
    const review = Array.from({ length: 10 }, (_, i) => reviewMr(String(10 + i)));
    const batches: string[][] = [];
    runtime(async (cmd = '') => {
      const iids = iidsOf(cmd);
      if (!iids.length) return lists(review);
      batches.push(iids);
      return discussionsAnswer(iids, () => ['x']);
    });
    await refreshMrOverview();
    expect(batches.map((b) => b.length).sort()).toEqual([2, 8]);
    expect(currentMrOverview().review.every((m) => m.discussions.length === 1)).toBe(true);
  });

  it('keeps the previous discussions of a failed batch and retries it next refresh', async () => {
    let notes = 1;
    let fail = false;
    const calls: string[][] = [];
    runtime(async (cmd = '') => {
      const iids = iidsOf(cmd);
      calls.push(iids);
      if (!iids.length) return lists([reviewMr('3', notes)]);
      if (fail) throw new Error('glab: Timeout on BaseNoteInterface.author');
      return discussionsAnswer(iids, () => [`n${notes}`]);
    });
    await refreshMrOverview();
    notes = 2;
    fail = true;
    // The only batch failed → the refresh reports the error, the list keeps its data.
    await refreshMrOverview();
    expect(currentMrOverview().review[0].discussions[0].notes).toEqual(['n1']);
    fail = false;
    await refreshMrOverview();
    expect(calls.filter((c) => c.length)).toEqual([['3'], ['3'], ['3']]);
    expect(currentMrOverview()).toMatchObject({ status: 'ready' });
    expect(currentMrOverview().review[0].discussions[0].notes).toEqual(['n2']);
  });

  it('fails the refresh when every discussion batch fails', async () => {
    runtime(async (cmd = '') => {
      if (!iidsOf(cmd).length) return lists([reviewMr('3')]);
      throw new Error('glab: 502 Bad Gateway');
    });
    await refreshMrOverview();
    expect(currentMrOverview()).toMatchObject({ status: 'error', error: 'glab: 502 Bad Gateway' });
  });

  it('shows a compact message when GitLab times out, without the auth hint cause', async () => {
    runtime(async () => {
      throw new Error('glab: ' + 'Timeout on BaseNoteInterface.author '.repeat(300));
    });
    await refreshMrOverview({ hostname: 'gitlab.acme.io' });
    const o = currentMrOverview();
    expect(o).toMatchObject({ status: 'error', failure: 'error' });
    expect(o.error).toBe('glab: the server timed out answering the query (300 fields: BaseNoteInterface.author ×300)');
  });

  it('treats an anonymous answer (currentUser null) as signed out', async () => {
    runtime(async () => JSON.stringify({ data: { currentUser: null } }));
    await refreshMrOverview();
    expect(currentMrOverview()).toMatchObject({ status: 'error', failure: 'signed-out' });
  });
});

describe('search', () => {
  it('offers MR refs and titles, gated like the badge', () => {
    const terms = findSessionField(glabMrPlugin, 'mr')!.search!(ctx({})) as string[];
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.some((t) => t.startsWith('!'))).toBe(true);
    expect(findSessionField(glabMrPlugin, 'mr')!.search!(ctx({ showInTitle: false }))).toBeNull();
  });
});

import { restMrPeople } from './glabMr';

describe('restMrPeople', () => {
  it('reads author, assignees and reviewers from the REST MR resource', () => {
    expect(
      restMrPeople({
        author: { username: 'sebastian' },
        assignees: [{ username: 'sebastian' }],
        reviewers: [{ username: 'alex' }, { username: '' }],
      }),
    ).toEqual({ author: 'sebastian', assignees: ['sebastian'], reviewers: ['alex'] });
    expect(restMrPeople({})).toEqual({ author: '', assignees: [], reviewers: [] });
  });
});

describe('threadSummaryTip', () => {
  it('names who commented last and any remainder', () => {
    expect(threadSummaryTip(10, { waitingForMe: 3, waitingForOther: 5 })).toBe(
      [
        '10 open threads',
        '• 3 last answered by someone else — your move',
        '• 5 last answered by you — waiting on others',
        '• 2 without a loaded last comment',
      ].join('\n'),
    );
  });
  it('omits empty parts and the remainder when the parts add up', () => {
    expect(threadSummaryTip(1, { waitingForMe: 0, waitingForOther: 1 })).toBe(
      '1 open thread\n• 1 last answered by you — waiting on others',
    );
  });
  it('says so when the split is unavailable', () => {
    expect(threadSummaryTip(4)).toBe('4 open threads · last commenter unavailable');
  });
});

describe('last comment', () => {
  const at = (iso: string) => Date.parse(iso);
  it('summarizeOpenThreads keeps the newest note of the open threads', () => {
    const m = mr({
      discussions: [
        { ...thread(['other']), lastAt: '2026-11-20T10:00:00Z' },
        { ...thread(['other', 'me']), lastAt: '2026-11-22T10:00:00Z' },
        { ...thread(['x'], true), lastAt: '2026-11-23T10:00:00Z' },
      ],
    });
    expect(summarizeOpenThreads(m, 'me').lastComment).toEqual({ author: 'you', at: '2026-11-22T10:00:00Z' });
  });
  it('relativeAgo formats minutes, hours and days', () => {
    const now = at('2026-11-23T12:00:00Z');
    expect(relativeAgo('2026-11-23T11:59:40Z', now)).toBe('just now');
    expect(relativeAgo('2026-11-23T11:15:00Z', now)).toBe('45m ago');
    expect(relativeAgo('2026-11-23T07:00:00Z', now)).toBe('5h ago');
    expect(relativeAgo('2026-11-18T12:00:00Z', now)).toBe('5d ago');
    expect(relativeAgo('nope', now)).toBeNull();
  });
  it('the tooltip ends with the last commenter and how long ago', () => {
    const tip = threadSummaryTip(
      2,
      { waitingForMe: 1, waitingForOther: 1, lastComment: { author: 'alice', at: '2026-11-23T09:00:00Z' } },
      at('2026-11-23T12:00:00Z'),
    );
    expect(tip.split('\n').pop()).toBe('Last comment by alice · 3h ago');
  });
});

describe('normalizeRestDiscussions', () => {
  // !76 in the wild: a fully resolved thread holding a system note.
  const resolvedWithSystemNote = {
    notes: [
      { author: { username: 'bob' }, resolvable: true, resolved: true },
      { author: { username: 'me' }, system: true, resolvable: false, resolved: null },
      { author: { username: 'me' }, resolvable: true, resolved: true },
      { author: { username: 'bob' }, resolvable: true, resolved: true },
    ],
  };

  it('does not reopen a resolved thread because of a system note', () => {
    const [d] = normalizeRestDiscussions([resolvedWithSystemNote]);
    expect(d.resolved).toBe(true);
    expect(summarizeOpenThreads({ discussions: [d] }, 'me')).toEqual({ waitingForMe: 0, waitingForOther: 0 });
  });

  it('agrees with countOpenThreads', () => {
    const open = { notes: [{ author: { username: 'bob' }, resolvable: true, resolved: false }] };
    const all = [resolvedWithSystemNote, open];
    expect(normalizeRestDiscussions(all).filter((d) => d.resolvable && !d.resolved)).toHaveLength(
      countOpenThreads(all),
    );
  });

  it('ignores a trailing system note when deciding who spoke last', () => {
    const [d] = normalizeRestDiscussions([
      {
        notes: [
          { author: { username: 'bob' }, resolvable: true, resolved: false },
          { author: { username: 'me' }, resolvable: true, resolved: false },
          { author: { username: 'bob' }, system: true, resolvable: false, resolved: null },
        ],
      },
    ]);
    expect(summarizeOpenThreads({ discussions: [d] }, 'me')).toMatchObject({ waitingForOther: 1, waitingForMe: 0 });
  });
});

describe('mergedMrListCommand', () => {
  it('lists the branch\'s merged MRs, branch quoted', () => {
    const cmd = mergedMrListCommand('feat/$(x)');
    expect(cmd).toContain("mr list -s 'feat/$(x)' --merged -F json");
  });
});
