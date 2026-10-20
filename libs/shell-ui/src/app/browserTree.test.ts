import { describe, it, expect } from 'vitest';
import type { DirEntry } from '@axn-term/session-backend';
import { flattenTree, sortEntries, type ChildListing } from './browserTree';

const dir = (name: string) => ({ name, isDirectory: true, isFile: false, isSymlink: false }) as DirEntry;
const file = (name: string) => ({ name, isDirectory: false, isFile: true, isSymlink: false }) as DirEntry;

const summary = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'entry' ? r.path : `(${r.text})`}`);

describe('flattenTree', () => {
  const root = [dir('src'), dir('.git'), file('README.md')];

  it('lists only the root when nothing is expanded', () => {
    expect(summary(flattenTree('/repo', root, new Set(), new Map(), false))).toEqual([
      '/repo/src',
      '/repo/README.md',
    ]);
  });

  it('nests expanded folders depth-first, recursively', () => {
    const children = new Map<string, ChildListing>([
      ['/repo/src', { entries: [dir('app'), file('main.ts')] }],
      ['/repo/src/app', { entries: [file('view.tsx')] }],
    ]);
    const rows = flattenTree('/repo/', root, new Set(['/repo/src', '/repo/src/app']), children, false);
    expect(summary(rows)).toEqual([
      '/repo/src',
      '  /repo/src/app',
      '    /repo/src/app/view.tsx',
      '  /repo/src/main.ts',
      '/repo/README.md',
    ]);
    expect(rows[1]).toMatchObject({ kind: 'entry', parentPath: '/repo/src', expanded: true });
  });

  it('shows loading, error and empty states under an expanded folder', () => {
    const expanded = new Set(['/repo/src']);
    expect(summary(flattenTree('/repo', [dir('src')], expanded, new Map(), false))).toEqual([
      '/repo/src',
      '  (loading...)',
    ]);
    const failed = new Map<string, ChildListing>([['/repo/src', { error: 'forbidden path' }]]);
    expect(summary(flattenTree('/repo', [dir('src')], expanded, failed, false))[1]).toBe(
      '  (forbidden path)',
    );
    const empty = new Map<string, ChildListing>([['/repo/src', { entries: [] }]]);
    expect(summary(flattenTree('/repo', [dir('src')], expanded, empty, false))[1]).toBe('  (empty)');
  });

  it('hides dotfiles at every depth unless showHidden', () => {
    const children = new Map<string, ChildListing>([['/repo/src', { entries: [file('.env'), file('a.ts')] }]]);
    const expanded = new Set(['/repo/src']);
    expect(summary(flattenTree('/repo', root, expanded, children, false))).not.toContain('  /repo/src/.env');
    expect(summary(flattenTree('/repo', root, expanded, children, true))).toContain('  /repo/src/.env');
  });
});

describe('sortEntries', () => {
  it('puts folders first, then sorts by name', () => {
    expect(sortEntries([file('b'), dir('z'), file('a'), dir('c')]).map((e) => e.name)).toEqual([
      'c',
      'z',
      'a',
      'b',
    ]);
  });
});
