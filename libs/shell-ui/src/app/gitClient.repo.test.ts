import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionBackend } from '@axn-term/session-backend';
import { bindGitBackend, git, parsePorcelainZ, unstagedBaseSpecs } from './gitClient';

// Real git in a temp repo, through the same `git()` entry point the git
// inspect view uses.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function execGit(_id: string, cwd: string, args: string[]): Promise<string> {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return r.status === 0 ? Promise.resolve(r.stdout) : Promise.reject(new Error(r.stderr));
}

let dir = '';
const write = (p: string, text: string) => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), text);
};
const read = (p: string) => readFileSync(join(dir, p), 'utf8');
const run = (...args: string[]) => git('s1', dir, args);

beforeAll(() => {
  bindGitBackend({ execGit } as unknown as SessionBackend);
});

async function initRepo(files: Record<string, string>): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'axn-git-'));
  await run('init', '-q');
  for (const [p, text] of Object.entries(files)) write(p, text);
  await run('add', '-A');
  await run('commit', '-q', '-m', 'init');
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('git() treats file names literally', () => {
  it('restoring a deleted file with glob chars leaves look-alike files alone', async () => {
    await initRepo({ 'app/[id]/page.tsx': 'id v1\n', 'app/d/page.tsx': 'd v1\n' });
    unlinkSync(join(dir, 'app/[id]/page.tsx'));
    write('app/d/page.tsx', 'd edited\n');
    // "Restore deleted file" on an unstaged deletion
    await run('restore', '--', 'app/[id]/page.tsx');
    expect(read('app/[id]/page.tsx')).toBe('id v1\n');
    expect(read('app/d/page.tsx')).toBe('d edited\n');

    // staged deletion: restore --source=HEAD --worktree
    await run('rm', '-q', '--', 'app/[id]/page.tsx');
    await run('restore', '--source=HEAD', '--worktree', '--', 'app/[id]/page.tsx');
    expect(read('app/[id]/page.tsx')).toBe('id v1\n');
    expect(read('app/d/page.tsx')).toBe('d edited\n');
  });

  it('stage/unstage touch only the named file', async () => {
    await initRepo({ 'app/[id]/page.tsx': 'id\n', 'app/i/page.tsx': 'i\n', foo: 'foo\n' });
    write('app/[id]/page.tsx', 'id 2\n');
    write('app/i/page.tsx', 'i 2\n');
    write(':foo', 'colon file\n');
    write('foo', 'foo 2\n');
    await run('add', '--', 'app/[id]/page.tsx');
    await run('add', '--', ':foo');
    const staged = (await run('diff', '--cached', '--name-only')).trim().split('\n');
    expect(staged.sort()).toEqual([':foo', 'app/[id]/page.tsx']);

    await run('add', '--', 'app/i/page.tsx');
    await run('restore', '--staged', '--', 'app/[id]/page.tsx');
    const after = (await run('diff', '--cached', '--name-only')).trim().split('\n');
    expect(after.sort()).toEqual([':foo', 'app/i/page.tsx']);
  });

  it('per-file diff and show do not pick up matching files', async () => {
    await initRepo({ 'a[b].txt': '1\n', 'ab.txt': '1\n' });
    write('a[b].txt', '2\n');
    write('ab.txt', '2\n');
    const diff = await run('diff', '--', 'a[b].txt');
    expect(diff).toContain('a[b].txt');
    expect(diff).not.toContain('ab.txt');
  });
});

describe('unstagedBaseSpecs', () => {
  it('diffs a staged rename with unstaged edits against the index copy (RM)', async () => {
    const body = 'line\n'.repeat(20);
    await initRepo({ 'a.txt': body });
    await run('mv', 'a.txt', 'c.txt');
    write('c.txt', `${body}staged\n`);
    await run('add', 'c.txt');
    write('c.txt', `${body}staged\nunstaged\n`);
    const [f] = parsePorcelainZ(await run('status', '--porcelain', '-z'));
    expect(f).toMatchObject({ index: 'R', worktree: 'M', path: 'c.txt', oldPath: 'a.txt' });
    const [spec] = unstagedBaseSpecs(f);
    // the base already holds the staged edit; only "unstaged" is new
    expect(await run('show', spec, '--')).toBe(`${body}staged\n`);
  });

  it('reads index names that look like stage specs', async () => {
    await initRepo({ '1:x': 'literal\n' });
    write('1:x', 'changed\n');
    const [spec] = unstagedBaseSpecs({ index: ' ', worktree: 'M', path: '1:x' });
    expect(await run('show', spec, '--')).toBe('literal\n');
  });

  it('falls back to HEAD under the old name', () => {
    expect(unstagedBaseSpecs({ index: 'R', worktree: 'M', path: 'c', oldPath: 'a' })).toEqual([
      ':0:c',
      'HEAD:a',
    ]);
  });
});
