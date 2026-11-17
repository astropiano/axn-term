import { describe, it, expect } from 'vitest';
import {
  assignLanes,
  parseLog,
  parseNameStatusZ,
  parsePorcelainZ,
  splitStatus,
  LOG_FORMAT,
} from './gitClient';
import type { GitCommit } from './gitClient';

const F = '\x1f';
const R = '\x1e';

describe('parsePorcelainZ', () => {
  it('parses staged, unstaged and untracked entries', () => {
    const out = ['M  staged.ts', ' M unstaged.ts', 'A  added.ts', '?? new.ts', ''].join('\0');
    const files = parsePorcelainZ(out);
    expect(files).toEqual([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'unstaged.ts' },
      { index: 'A', worktree: ' ', path: 'added.ts' },
      { index: '?', worktree: '?', path: 'new.ts' },
    ]);
  });

  it('consumes the source path of rename records', () => {
    const out = ['R  new.ts', 'old.ts', 'M  other.ts', ''].join('\0');
    const files = parsePorcelainZ(out);
    expect(files[0]).toEqual({
      index: 'R',
      worktree: ' ',
      path: 'new.ts',
      oldPath: 'old.ts',
    });
    expect(files[1]).toEqual({ index: 'M', worktree: ' ', path: 'other.ts' });
  });

  it('skips the --branch header and malformed entries', () => {
    const out = ['## main...origin/main', 'M  f.ts', 'x', ''].join('\0');
    const files = parsePorcelainZ(out);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('f.ts');
  });
});

describe('splitStatus', () => {
  it('sorts files into staged/unstaged/untracked/conflicted', () => {
    const s = splitStatus([
      { index: 'M', worktree: ' ', path: 'a' },
      { index: ' ', worktree: 'M', path: 'b' },
      { index: 'M', worktree: 'M', path: 'both' },
      { index: '?', worktree: '?', path: 'u' },
      { index: 'U', worktree: 'U', path: 'conflict' },
      { index: '!', worktree: '!', path: 'ignored' },
    ]);
    expect(s.staged.map((f) => f.path)).toEqual(['a', 'both']);
    expect(s.unstaged.map((f) => f.path)).toEqual(['b', 'both']);
    expect(s.untracked.map((f) => f.path)).toEqual(['u']);
    expect(s.conflicted.map((f) => f.path)).toEqual(['conflict']);
  });
});

describe('parseLog', () => {
  const rec = (h: string, p: string, extra: Partial<GitCommit> = {}) =>
    [h, p, extra.author ?? 'Dev', extra.time ?? 1700000000, (extra.refs ?? []).join(','), extra.subject ?? 'subj'].join(F) + R;

  it('parses commit records', () => {
    const out = rec('aaa', 'bbb', { subject: 'first' }) + rec('bbb', '', { subject: 'root' });
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: 'aaa', parents: ['bbb'], subject: 'first' });
    expect(commits[1].parents).toEqual([]);
  });

  it('parses decorations', () => {
    const out = rec('aaa', '', { refs: ['HEAD -> main', 'tag: v1', 'origin/main'] });
    expect(parseLog(out)[0].refs).toEqual(['HEAD -> main', 'tag: v1', 'origin/main']);
  });

  it('ignores empty output', () => {
    expect(parseLog('')).toEqual([]);
    expect(parseLog('\n')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses simple and rename entries', () => {
    const out = ['M', 'a.ts', 'A', 'b.ts', 'R100', 'old.ts', 'new.ts', 'D', 'gone.ts', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
      { status: 'R100', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'D', path: 'gone.ts' },
    ]);
  });
});

function commit(hash: string, parents: string[] = []): GitCommit {
  return { hash, parents, author: 'd', time: 0, refs: [], subject: hash };
}

describe('assignLanes', () => {
  it('puts a linear history on one lane', () => {
    const { rows, laneCount } = assignLanes([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a'),
    ]);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].forks).toEqual([]);
    expect(rows[0].merges).toEqual([]);
  });

  it('forks merge parents into a new lane', () => {
    // M merges B into A; A and B share parent R.
    const { rows, laneCount } = assignLanes([
      commit('M', ['A', 'B']),
      commit('B', ['R']),
      commit('A', ['R']),
      commit('R'),
    ]);
    expect(laneCount).toBe(2);
    // M on lane 0 (continues via first parent A), B forked to lane 1.
    expect(rows[0].lane).toBe(0);
    expect(rows[0].forks).toEqual([1]);
    expect(rows[1].commit.hash).toBe('B');
    expect(rows[1].lane).toBe(1);
    // B's lane continues to R; A also expects R on lane 0 → both lanes reach
    // R's row where lane 1 merges into the dot.
    expect(rows[1].forks).toEqual([]);
    expect(rows[2].lane).toBe(0);
    expect(rows[3].lane).toBe(0);
    expect(rows[3].merges).toEqual([1]);
  });

  it('collapses two lanes expecting the same commit (merge fan-in)', () => {
    // Two heads H1, H2 both merging into base B.
    const { rows } = assignLanes([
      commit('H1', ['B']),
      commit('H2', ['B']),
      commit('B'),
    ]);
    // H2 claims a second lane; at B both lanes converge → lane 1 merges.
    expect(rows[2].merges).toEqual([1]);
    expect(rows[2].lane).toBe(0);
  });

  it('handles multiple branch heads', () => {
    const { rows, laneCount } = assignLanes([
      commit('h1', ['b1']),
      commit('h2', ['b1']),
      commit('b1', ['r']),
      commit('r'),
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
  });
});

describe('LOG_FORMAT', () => {
  it('uses the separators parseLog understands', () => {
    expect(LOG_FORMAT).toContain('%x1f');
    expect(LOG_FORMAT).toContain('%x1e');
  });
});

describe('historyRefs', () => {
  it('walks every ref without a compare base', async () => {
    const { historyRefs } = await import('./gitClient');
    expect(historyRefs()).toEqual(['--all', 'HEAD']);
    expect(historyRefs(null)).toEqual(['--all', 'HEAD']);
  });

  it('walks only HEAD and the base for a review tab', async () => {
    const { historyRefs } = await import('./gitClient');
    expect(historyRefs('origin/develop')).toEqual(['HEAD', 'origin/develop']);
  });
});
