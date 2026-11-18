import { describe, it, expect } from 'vitest';
import type { DirEntry } from '@axn-term/session-backend';
import { flattenTree, searchTree, sortEntries, type ChildListing } from './browserTree';

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

describe('searchTree', () => {
  const tree = new Map<string, DirEntry[]>([
    ['/repo', [dir('src'), dir('.git'), file('README.md')]],
    ['/repo/src', [dir('app'), file('main.ts'), file('button.tsx')]],
    ['/repo/src/app', [file('view.tsx'), file('buttonBar.tsx')]],
    ['/repo/.git', [file('config')]],
  ]);
  const listDir = (dir: string) => Promise.resolve(tree.get(dir) ?? []);

  it('matches files and folders by relative path, case-insensitively', async () => {
    const { hits } = await searchTree(listDir, '/repo', 'BUTTON');
    expect(hits).toEqual([
      { path: '/repo/src/button.tsx', isDir: false },
      { path: '/repo/src/app/buttonBar.tsx', isDir: false },
    ]);
  });

  it('matches a path segment, not just the name', async () => {
    const { hits } = await searchTree(listDir, '/repo', 'app/');
    expect(hits).toEqual([{ path: '/repo/src/app/buttonBar.tsx', isDir: false }, { path: '/repo/src/app/view.tsx', isDir: false }]);
  });

  it('returns folders as matches too', async () => {
    // 'src' is a path segment: the folder and everything under it matches.
    const { hits } = await searchTree(listDir, '/repo', 'src');
    expect(hits[0]).toEqual({ path: '/repo/src', isDir: true });
    expect(hits).toContainEqual({ path: '/repo/src/app', isDir: true });
    expect(hits).toContainEqual({ path: '/repo/src/app/view.tsx', isDir: false });
  });

  it('skips dot-entries when hidden files are off', async () => {
    const hidden = await searchTree(listDir, '/repo', 'config', { showHidden: false });
    expect(hidden.hits).toEqual([]);
    const shown = await searchTree(listDir, '/repo', 'config', { showHidden: true });
    expect(shown.hits).toEqual([{ path: '/repo/.git/config', isDir: false }]);
  });

  it('reports truncation at the result cap', async () => {
    const { hits, truncated } = await searchTree(listDir, '/repo', '', { maxResults: 1 });
    expect(hits).toEqual([]);
    expect(truncated).toBe(false);
    const r = await searchTree(listDir, '/repo', '.', { maxResults: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('skips unreadable folders instead of failing', async () => {
    const failing = (dir: string) =>
      dir === '/repo/src' ? Promise.reject(new Error('denied')) : listDir(dir);
    const { hits } = await searchTree(failing, '/repo', 'readme');
    expect(hits).toEqual([{ path: '/repo/README.md', isDir: false }]);
  });

  it('stops listing once cancelled', async () => {
    const listed: string[] = [];
    const tracking = async (dir: string) => {
      listed.push(dir);
      return listDir(dir);
    };
    let calls = 0;
    await searchTree(tracking, '/repo', 'x', { isCancelled: () => ++calls > 2 });
    expect(listed).toEqual(['/repo', '/repo/.git']);
  });
});
