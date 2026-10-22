import { describe, it, expect } from 'vitest';
import {
  ghPrPlugin,
  prNeedsAction,
  rollupStatus,
  normalizePr,
  type GhPrItem,
} from './ghPr';
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
