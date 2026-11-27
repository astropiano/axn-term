import { describe, expect, it } from 'vitest';
import {
  findMerged,
  mergedProbeScript,
  mergedVerdict,
  parseMergedProbe,
  repoSig,
  type MergedCandidate,
} from './mrMerged';

const cand = (sha: string, mergedAt?: string): MergedCandidate => ({
  reference: `!${sha}`,
  title: 't',
  url: `https://x/${sha}`,
  sha,
  mergedAt,
});

describe('parseMergedProbe', () => {
  it('reads an ancestor head with new work', () => {
    expect(parseMergedProbe('ancestor 1\nafter 3\ndirty 2\nuntracked 1\n')).toEqual({
      ancestor: true,
      commitsAfter: 3,
      uncommitted: 2,
      untracked: 1,
    });
  });
  it('treats a head that is not an ancestor as unrelated', () => {
    expect(parseMergedProbe('ancestor 0\ndirty 0\nuntracked 0').ancestor).toBe(false);
  });
});

describe('mergedProbeScript', () => {
  it('quotes the sha', () => {
    expect(mergedProbeScript("a'b")).toContain("'a'\\''b'");
  });
});

describe('findMerged', () => {
  it('takes the newest candidate that is an ancestor, skipping reused-branch leftovers', async () => {
    const seen: string[] = [];
    const probe = async (script: string) => {
      seen.push(script);
      return script.includes("'new'") ? 'ancestor 1\nafter 0\ndirty 0\nuntracked 0' : 'ancestor 0';
    };
    const found = await findMerged(
      [cand('old', '2026-01-01T00:00:00Z'), cand('new', '2026-02-01T00:00:00Z'), cand('mid', '2026-01-15T00:00:00Z')],
      probe,
      '0/0/0',
    );
    expect(found?.sha).toBe('new');
    expect(found?.sig).toBe('0/0/0');
    expect(seen).toHaveLength(1);
  });

  it('finds nothing when no head is in the history, or the probe throws', async () => {
    expect(await findMerged([cand('a')], async () => 'ancestor 0', '')).toBeUndefined();
    expect(
      await findMerged([cand('a')], async () => {
        throw new Error('git missing');
      }, ''),
    ).toBeUndefined();
  });

  it('ignores candidates without a head sha', async () => {
    expect(await findMerged([cand('')], async () => 'ancestor 1', '')).toBeUndefined();
  });
});

describe('mergedVerdict', () => {
  it('is violet when HEAD is the merged head and the tree is clean', () => {
    expect(mergedVerdict({ ancestor: true, commitsAfter: 0, uncommitted: 0, untracked: 0 })).toEqual({
      tone: 'violet',
      reasons: ['merged'],
    });
  });
  it('is orange and says why when there is new work', () => {
    const v = mergedVerdict({ ancestor: true, commitsAfter: 2, uncommitted: 1, untracked: 3 });
    expect(v.tone).toBe('orange');
    expect(v.reasons).toEqual([
      'merged',
      '2 new commits since the merge',
      '1 uncommitted file',
      '3 untracked files',
    ]);
  });
});

describe('repoSig', () => {
  it('changes with ahead, dirty and untracked', () => {
    expect(repoSig({ ahead: 1, dirty: true, untracked: 2 })).toBe('1/1/2');
    expect(repoSig(undefined)).toBe('');
  });
});
