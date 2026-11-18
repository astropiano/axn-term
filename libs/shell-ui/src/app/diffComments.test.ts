import { describe, expect, it } from 'vitest';
import {
  buildCommentsPrompt,
  captureAnchor,
  nextCommentId,
  reanchor,
  reanchorComments,
} from './diffComments';
import { fnv1a } from './gitReview';
import type { DiffComment } from '../types';

const FILE = [
  'import a',
  'import b',
  '',
  'function f() {',
  '  const x = 1;',
  '  if (!x) return null;',
  '  return x;',
  '}',
  '',
  'f();',
];

function makeComment(over: Partial<DiffComment> = {}): DiffComment {
  const range: [number, number] = over.range ?? [6, 6];
  return {
    id: over.id ?? nextCommentId(),
    path: 'src/f.ts',
    side: 'new',
    range,
    anchor: over.anchor ?? captureAnchor(FILE, range[0], range[1]),
    body: over.body ?? 'handle the error',
    status: over.status ?? 'active',
    resolution: over.resolution ?? 'open',
    createdAt: over.createdAt ?? 1,
    ...over,
  };
}

describe('captureAnchor', () => {
  it('keeps line text plus two context lines', () => {
    const a = captureAnchor(FILE, 6, 6);
    expect(a.text).toBe('  if (!x) return null;');
    expect(a.before).toEqual(['function f() {', '  const x = 1;']);
    expect(a.after).toEqual(['  return x;', '}']);
    expect(a.diffId).toBe(fnv1a(FILE.join('\n')));
  });

  it('captures multi-line ranges and clamps context at file edges', () => {
    const a = captureAnchor(FILE, 1, 2);
    expect(a.text).toBe('import a\nimport b');
    expect(a.before).toEqual([]);
    const tail = captureAnchor(FILE, 9, 10);
    expect(tail.after).toEqual([]);
  });
});

describe('reanchor', () => {
  it('keeps an unchanged anchor active', () => {
    const c = makeComment();
    const diffId = fnv1a(FILE.join('\n'));
    expect(reanchor(c, FILE, diffId)).toEqual({ status: 'active', range: [6, 6] });
  });

  it('skips work when the content fingerprint is unchanged', () => {
    const c = makeComment({ status: 'moved' });
    const diffId = c.anchor.diffId!;
    // Position drifted in the stored range but the fingerprint matches.
    expect(reanchor({ ...c, range: [3, 3] }, FILE, diffId)).toEqual({
      status: 'active',
      range: [3, 3],
    });
  });

  it('follows the line when content is inserted above', () => {
    const c = makeComment();
    const edited = ['// new header', '', ...FILE];
    const r = reanchor(c, edited, fnv1a(edited.join('\n')));
    expect(r).toEqual({ status: 'moved', range: [8, 8] });
  });

  it('follows the line when content is removed above', () => {
    const c = makeComment();
    const edited = FILE.slice(2);
    const r = reanchor(c, edited, fnv1a(edited.join('\n')));
    expect(r).toEqual({ status: 'moved', range: [4, 4] });
  });

  it('uses context to pick the right occurrence of a repeated line', () => {
    const dup = ['  if (!x) return null;'];
    const edited = [...FILE.slice(0, 2), ...dup, ...FILE.slice(2, 8), ...dup, ...FILE.slice(8)];
    // Original anchor at line 6 now has a duplicate at line 3 and 9.
    const c = makeComment();
    const r = reanchor(c, edited, fnv1a(edited.join('\n')));
    // The original (now at index 6, line 7) has matching context; line 3 doesn't.
    expect(r).toEqual({ status: 'moved', range: [7, 7] });
  });

  it('marks the comment stale when its line is deleted', () => {
    const c = makeComment();
    const edited = FILE.filter((l) => l !== '  if (!x) return null;');
    const r = reanchor(c, edited, fnv1a(edited.join('\n')));
    expect(r.status).toBe('stale');
    expect(r.range).toEqual([6, 6]);
  });

  it('recovers to moved when a stale anchor reappears', () => {
    const c = makeComment({ status: 'stale' });
    const edited = ['x', ...FILE];
    const r = reanchor(c, edited, fnv1a(edited.join('\n')));
    expect(r.status).toBe('moved');
    expect(r.range).toEqual([7, 7]);
  });

  it('keeps the position when the side content is unavailable', () => {
    const c = makeComment({ status: 'moved' });
    expect(reanchor(c, null, 'x').range).toEqual([6, 6]);
  });
});

describe('reanchorComments', () => {
  it('only touches comments on the given path and reports no-change', () => {
    const mine = makeComment();
    const other = makeComment({ path: 'src/other.ts' });
    const modified = FILE.join('\n');
    const out = reanchorComments([mine, other], 'src/f.ts', { modified });
    expect(out).toBeNull(); // same content — nothing to update
    const moved = reanchorComments([mine, other], 'src/f.ts', {
      modified: ['// hdr', ...FILE].join('\n'),
    });
    expect(moved).not.toBeNull();
    expect(moved![0].range).toEqual([7, 7]);
    expect(moved![0].status).toBe('moved');
    expect(moved![1]).toBe(other); // untouched
  });

  it('anchors old-side comments against the original content', () => {
    const c = makeComment({ side: 'old', range: [2, 2], anchor: captureAnchor(FILE, 2, 2) });
    const out = reanchorComments([c], 'src/f.ts', {
      original: ['inserted', ...FILE].join('\n'),
    });
    expect(out![0].range).toEqual([3, 3]);
  });
});

describe('buildCommentsPrompt', () => {
  it('formats location, quoted lines and body; lists deferred separately', () => {
    const open = makeComment();
    const defer = makeComment({ resolution: 'deferred', body: 'later: rename it' });
    const done = makeComment({ resolution: 'done' });
    const p = buildCommentsPrompt('worktree diff', [open, defer, done])!;
    expect(p).toContain('Review comments on worktree diff');
    expect(p).toContain('src/f.ts:6');
    expect(p).toContain('>   if (!x) return null;');
    expect(p).toContain('handle the error');
    expect(p).toContain('Deferred from an earlier review');
    expect(p).toContain('later: rename it');
  });

  it('flags stale and moved comments', () => {
    const stale = makeComment({ status: 'stale' });
    const p = buildCommentsPrompt('diff', [stale])!;
    expect(p).toContain('original text quoted');
  });

  it('returns null when nothing is sendable', () => {
    expect(buildCommentsPrompt('d', [makeComment({ resolution: 'done' })])).toBeNull();
    expect(buildCommentsPrompt('d', [])).toBeNull();
  });
});
