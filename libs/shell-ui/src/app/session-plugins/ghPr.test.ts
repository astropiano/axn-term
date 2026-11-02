import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentPrOverview,
  ghPrPlugin,
  overviewCommand,
  ownPrs,
  prListCommand,
  prNeedsAction,
  refreshPrOverview,
  resetPrOverview,
  rollupStatus,
  normalizePr,
  threadsCommand,
  type GhPrItem,
  type RawPrListItem,
} from './ghPr';
import { openThreads } from './glabMr';
import { bindAppRuntime } from '../appRuntime';
import type { MrDiscussion } from './glabMr';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';

const thread = (notes: string[], resolved = false): MrDiscussion => ({
  resolvable: true,
  resolved,
  notes,
});

function pr(partial: Partial<GhPrItem> = {}): GhPrItem {
  return {
    key: 'a/b#1',
    iid: 1,
    reference: '#1',
    title: 'pr',
    description: '',
    url: 'https://github.com/a/b/pull/1',
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
    reviewDecision: '',
    ...partial,
  };
}

describe('rollupStatus', () => {
  it('maps the GraphQL rollup enum', () => {
    expect(rollupStatus('SUCCESS')).toBe('success');
    expect(rollupStatus('FAILURE')).toBe('failed');
    expect(rollupStatus('ERROR')).toBe('failed');
    expect(rollupStatus('PENDING')).toBe('pending');
    expect(rollupStatus('EXPECTED')).toBe('pending');
  });

  it('aggregates the gh pr list statusCheckRollup array', () => {
    expect(
      rollupStatus([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ]),
    ).toBe('success');
    expect(
      rollupStatus([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toBe('pending');
    expect(
      rollupStatus([
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failed');
    expect(
      rollupStatus([
        { __typename: 'StatusContext', state: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' },
      ]),
    ).toBe('canceled');
  });

  it('returns null for empty/unknown input', () => {
    expect(rollupStatus([])).toBeNull();
    expect(rollupStatus(null)).toBeNull();
    expect(rollupStatus(undefined)).toBeNull();
  });
});

describe('normalizePr', () => {
  it('maps the graphql node to the shared MR shape', () => {
    const item = normalizePr({
      number: 42,
      title: 'feat',
      url: 'https://github.com/a/b/pull/42',
      isDraft: true,
      mergeable: 'CONFLICTING',
      headRefName: 'feat/x',
      baseRefName: 'main',
      updatedAt: '2026-02-01',
      reviewDecision: 'CHANGES_REQUESTED',
      author: { login: 'bob' },
      assignees: { nodes: [{ login: 'me' }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'carol' } }] },
      repository: { nameWithOwner: 'a/b' },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
      reviewThreads: {
        nodes: [
          { isResolved: false, comments: { nodes: [{ author: { login: 'bob' } }] } },
          { isResolved: true, comments: { nodes: [] } },
        ],
      },
      reviews: { nodes: [{ author: { login: 'dave' } }] },
    });
    expect(item.key).toBe('a/b#42');
    expect(item.reference).toBe('#42');
    expect(item.project).toBe('a/b');
    expect(item.draft).toBe(true);
    expect(item.conflicts).toBe(true);
    expect(item.pipeline).toBe('failed');
    expect(item.reviewDecision).toBe('changes_requested');
    expect(item.approved).toBe(false);
    expect(item.approvedBy).toEqual(['dave']);
    expect(item.assignees).toEqual(['me']);
    expect(item.reviewers).toEqual(['carol']);
    expect(item.sourceBranch).toBe('feat/x');
    expect(item.targetBranch).toBe('main');
    // unresolved thread survives, resolved is kept (parity with glab side)
    expect(item.discussions).toHaveLength(2);
    expect(item.discussions[0]).toEqual({
      resolvable: true,
      resolved: false,
      notes: ['bob'],
    });
  });

  it('treats APPROVED decision as approved', () => {
    const item = normalizePr({ number: 1, reviewDecision: 'APPROVED' });
    expect(item.approved).toBe(true);
    expect(item.reviewDecision).toBe('approved');
  });
});

describe('prNeedsAction', () => {
  it('is false for a clean PR', () => {
    expect(prNeedsAction(pr())).toBe(false);
  });

  it('is true on changes requested even with no open threads', () => {
    expect(prNeedsAction(pr({ reviewDecision: 'changes_requested' }))).toBe(true);
  });

  it('keeps the gitlab rules: conflicts, approved, failing checks, threads', () => {
    expect(prNeedsAction(pr({ conflicts: true }))).toBe(true);
    expect(prNeedsAction(pr({ approved: true }))).toBe(true);
    expect(prNeedsAction(pr({ pipeline: 'failed' }))).toBe(true);
    expect(prNeedsAction(pr({ discussions: [thread(['bob'])] }))).toBe(true);
  });
});

function ctx(
  pluginSettings: unknown,
  prs = [
    {
      number: 1,
      reference: '#1',
      title: 'pr',
      url: 'https://github.com/a/b/pull/1',
      draft: false,
      conflicts: false,
      discussionsResolved: true,
      mergeStatus: 'clean',
      checks: 'success',
      reviewDecision: '',
    },
  ],
): SessionViewContext & PluginApi {
  return {
    session: { id: 's1' } as ShellSession,
    pluginSettings,
    pluginState: { prs },
  } as SessionViewContext & PluginApi;
}

describe('visibility settings', () => {
  it('renders the panel and title indicator by default', () => {
    expect(ghPrPlugin.render?.(ctx(undefined))).not.toBeNull();
    expect(ghPrPlugin.render?.(ctx({}))).not.toBeNull();
    expect(ghPrPlugin.renderRow?.(ctx({}))).not.toBeNull();
  });

  it('hides the panel when showInPanel is false', () => {
    expect(ghPrPlugin.render?.(ctx({ showInPanel: false }))).toBeNull();
    expect(ghPrPlugin.renderRow?.(ctx({ showInPanel: false }))).not.toBeNull();
  });

  it('keeps the legacy showInHeader key hiding the panel', () => {
    expect(ghPrPlugin.render?.(ctx({ showInHeader: false }))).toBeNull();
  });

  it('hides the title indicator when showInTitle is false', () => {
    expect(ghPrPlugin.renderRow?.(ctx({ showInTitle: false }))).toBeNull();
    expect(ghPrPlugin.render?.(ctx({ showInTitle: false }))).not.toBeNull();
  });
});

describe('rowTip', () => {
  it('explains the PR badge', () => {
    expect(ghPrPlugin.rowTip?.(ctx({}))).toBe(
      '#1: open pull request on this branch — pr',
    );
  });

  it('mirrors the badge visibility gate', () => {
    expect(ghPrPlugin.rowTip?.(ctx({ showInTitle: false }))).toBeNull();
    expect(ghPrPlugin.rowTip?.(ctx({}, []))).toBeNull();
  });
});

// Real `gh` output shapes (github.com, 2026-10), trimmed and anonymized.
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/github.json', import.meta.url), 'utf8'),
) as {
  overviewNode: Parameters<typeof normalizePr>[0];
  prListMaster: RawPrListItem[];
  prListSameRepo: RawPrListItem[];
};

/**
 * Run a built command line through a real `sh` with a stub `gh` first on
 * PATH that prints the argv it received (NUL-separated) — proves what the
 * shell actually hands to the CLI.
 */
function argvOf(command: string, cwd?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'axn-gh-stub-'));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd: cwd ?? dir,
    env: { PATH: `${dir}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  return res.stdout.split('\0').slice(0, -1);
}

describe('gh command lines', () => {
  it('passes a hostile branch name through as one literal argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axn-gh-cwd-'));
    const branch = '$(touch${IFS}pwned)`touch pwned2`\'x';
    const argv = argvOf(prListCommand(branch), dir);
    expect(argv.slice(0, 4)).toEqual(['pr', 'list', '--head', branch]);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(existsSync(join(dir, 'pwned2'))).toBe(false);
  });

  it('asks gh pr list for the fork owner', () => {
    const argv = argvOf(prListCommand('main'));
    expect(argv[argv.indexOf('--json') + 1]).toContain('isCrossRepository,headRepositoryOwner');
  });

  it('asks the overview query for the PR body text', () => {
    const argv = argvOf(overviewCommand());
    const query = argv.find((a) => a.startsWith('query='))!;
    expect(query).toContain('bodyText');
  });

  it('keeps the GraphQL $variables of the threads query intact', () => {
    const argv = argvOf(threadsCommand([12, 34]));
    const query = argv.find((a) => a.startsWith('query='))!;
    expect(query).toContain('query($owner: String!, $name: String!, $n0: Int!, $n1: Int!)');
    expect(query).toContain('repository(owner: $owner, name: $name)');
    expect(argv).toEqual(expect.arrayContaining(['-F', 'n0=12', '-F', 'n1=34', '-F', 'owner={owner}']));
  });

  it('sends the overview query as one argument, sized under the node limit', () => {
    const argv = argvOf(overviewCommand('ghe.acme.io'));
    expect(argv.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'ghe.acme.io']);
    const query = argv.find((a) => a.startsWith('query='))!;
    expect(query).not.toContain('\n');
    expect(query).toContain('reviewThreads(first: 50)');
    expect(query).toContain('comments(last: 20)');
  });
});

describe('ownPrs', () => {
  it('drops fork PRs that merely share the branch name (real ripgrep `--head master`)', () => {
    expect(fixture.prListMaster.every((p) => p.isCrossRepository)).toBe(true);
    expect(ownPrs(fixture.prListMaster, ['burntsushi'])).toEqual([]);
  });

  it('keeps same-repo PRs and fork PRs from my own fork', () => {
    expect(ownPrs(fixture.prListSameRepo, ['someone-else'])).toHaveLength(1);
    const mine = fixture.prListMaster[1].headRepositoryOwner!.login!;
    expect(ownPrs(fixture.prListMaster, ['burntsushi', mine.toUpperCase()]).map((p) => p.number)).toEqual([
      fixture.prListMaster[1].number,
    ]);
  });
});

describe('normalizePr on a real overview node', () => {
  it('maps unresolved review threads and the checks rollup', () => {
    const pr = normalizePr(fixture.overviewNode);
    expect(pr.reference).toBe('#3488');
    expect(pr.project).toBe('BurntSushi/ripgrep');
    expect(pr.pipeline).toBe('success');
    expect(openThreads(pr)).toBe(3);
    expect(prNeedsAction(pr)).toBe(true);
    expect(pr.reviewDecision).toBe('');
  });
});

describe('refreshPrOverview', () => {
  afterEach(() => {
    bindAppRuntime(null);
    resetPrOverview();
  });

  const runtime = (exec: () => Promise<string>) =>
    bindAppRuntime({ exec, statPath: async () => null, resolveSessionId: () => null });

  it('loads mine/review from a graphql answer', async () => {
    const node = fixture.overviewNode;
    runtime(async () =>
      JSON.stringify({
        data: {
          viewer: { login: 'user9' },
          assigned: { nodes: [] },
          authored: { nodes: [node] },
          review: { nodes: [node, null] },
        },
      }),
    );
    await refreshPrOverview();
    const o = currentPrOverview();
    expect(o.status).toBe('ready');
    expect(o.failure).toBeUndefined();
    expect(o.mine.map((p) => p.reference)).toEqual(['#3488']);
    expect(o.review).toHaveLength(1);
  });

  it.each([
    ['axn-term: gh is not installed', 'missing'],
    ['To get started with GitHub CLI, please run:  gh auth login', 'signed-out'],
    ['error connecting to api.github.com', 'error'],
  ] as const)('classifies %j as %s and keeps it while reloading', async (message, failure) => {
    runtime(async () => {
      throw new Error(message);
    });
    await refreshPrOverview();
    expect(currentPrOverview()).toMatchObject({ status: 'error', failure });
    let release!: () => void;
    runtime(() => new Promise<string>((_, reject) => (release = () => reject(new Error(message)))));
    const pending = refreshPrOverview();
    expect(currentPrOverview()).toMatchObject({ status: 'loading', failure });
    release();
    await pending;
  });
});
