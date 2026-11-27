import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkoutsOf,
  localCheckouts,
  mergeCheckouts,
  parseRepoProbe,
  parseRepoRoots,
  remoteMatchesProject,
  remoteProjectPath,
  repoProbeScript,
  resetRepoDirectory,
  setRepoDirProviders,
} from './repoDirectory';

const sh = (script: string) => execFileSync('sh', ['-c', script], { encoding: 'utf-8' });

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** <base>/group/app (main, origin set) + <base>/wt/app-feat (linked worktree). */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'axn-repodir-')));
  const main = join(base, 'group', 'app');
  const wt = join(base, 'wt', 'app-feat');
  mkdirSync(join(base, 'group'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', main]);
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
  git(main, 'remote', 'add', 'origin', 'ssh://git@gitlab.example.com:9022/ps/ext/app.git');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  // A pruned subtree must not be searched.
  spawnSync('git', ['init', '-q', join(base, 'group', 'node_modules', 'dep')]);
  return { base, main, wt };
}

afterEach(() => {
  setRepoDirProviders([]);
  resetRepoDirectory();
});

describe('parseRepoRoots', () => {
  it('splits on newlines, commas and semicolons, trims and dedupes', () => {
    expect(parseRepoRoots(' ~/src, /a/b/ ;\n/a/b\n\n')).toEqual(['~/src', '/a/b']);
    expect(parseRepoRoots(['/x', '/y'])).toEqual(['/x', '/y']);
    expect(parseRepoRoots(undefined)).toEqual([]);
  });
});

describe('remote matching', () => {
  it('extracts the project path from ssh, scp and https remotes', () => {
    expect(remoteProjectPath('ssh://git@h:9022/ps/ext/app.git')).toBe('ps/ext/app');
    expect(remoteProjectPath('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(remoteProjectPath('https://gitlab.com/a/b/c/')).toBe('a/b/c');
    expect(remoteProjectPath(null)).toBeNull();
  });

  it('matches the exact project, not a prefix sibling', () => {
    expect(remoteMatchesProject('git@h:ps/ext/app.git', 'ps/ext/app')).toBe(true);
    expect(remoteMatchesProject('git@h:ps/ext/app-frontend.git', 'ps/ext/app')).toBe(false);
    expect(remoteMatchesProject('git@h:other/ps/ext/app.git', 'ps/ext/app')).toBe(false);
  });
});

describe('mergeCheckouts', () => {
  it('keeps one entry per path and fills unknown fields from duplicates', () => {
    const merged = mergeCheckouts(
      [{ path: '/r/a/', branch: null, remote: 'git@h:g/a.git' }],
      [
        { path: '/r/a', branch: 'main', remote: null },
        { path: '/r/b', branch: 'x', remote: null },
      ],
    );
    expect(merged).toEqual([
      { path: '/r/a', branch: 'main', remote: 'git@h:g/a.git' },
      { path: '/r/b', branch: 'x', remote: null },
    ]);
  });
});

describe('repoProbeScript (real git)', () => {
  it('finds each checkout once — main and linked worktree — with remote and branch', () => {
    const { base, main, wt } = fixture();
    const found = mergeCheckouts(parseRepoProbe(sh(repoProbeScript([base], []))));
    expect(found).toEqual([
      { path: main, branch: 'main', remote: 'ssh://git@gitlab.example.com:9022/ps/ext/app.git', isMain: true },
      { path: wt, branch: 'feat/x', remote: 'ssh://git@gitlab.example.com:9022/ps/ext/app.git' },
    ]);
  });

  it('resolves explicit repo paths, including a linked worktree, to the same repo', () => {
    const { main, wt } = fixture();
    const out = parseRepoProbe(sh(repoProbeScript([], [main, wt])));
    // Both inputs point at one repo: it is read once.
    expect(out.map((c) => c.path)).toEqual([main, wt]);
  });

  it('skips missing roots and quotes hostile names', () => {
    expect(sh(repoProbeScript(['/does/not/exist', "/tmp/$(touch pwned)'x"], []))).toBe('');
  });
});

describe('localCheckouts', () => {
  const exec = (cmd: string) => Promise.resolve(sh(cmd));

  it('adds provider repos to the root scan without duplicates', async () => {
    const { base, main, wt } = fixture();
    setRepoDirProviders([
      {
        id: 'p1',
        repoDirs: async () => [
          // spelled out by the provider — also found under the root
          { path: main, remote: 'ssh://git@gitlab.example.com:9022/ps/ext/app.git', worktrees: [{ path: main, branch: 'main' }] },
          { path: '/elsewhere/other', remote: 'git@h:g/other.git', worktrees: [{ path: '/elsewhere/other', branch: 'dev' }] },
        ],
      },
    ]);
    const all = await localCheckouts(exec, [base]);
    expect(all.map((c) => c.path).sort()).toEqual(['/elsewhere/other', main, wt].sort());
    expect(checkoutsOf(all, 'ps/ext/app').map((c) => c.path)).toEqual([main, wt]);
  });

  it('lists main checkouts first for a project', () => {
    const r = 'git@h:g/app.git';
    expect(
      checkoutsOf(
        [
          { path: '/wt', branch: 'x', remote: r },
          { path: '/other', branch: 'm', remote: 'git@h:g/other.git', isMain: true },
          { path: '/main', branch: 'm', remote: r, isMain: true },
        ],
        'g/app',
      ).map((c) => c.path),
    ).toEqual(['/main', '/wt']);
  });

  it('orders clones: provider path, then clone number, then worktrees', () => {
    const r = 'git@h:g/app.git';
    const c = (path: string, extra = {}) => ({ path, branch: 'm', remote: r, ...extra });
    const sorted = (list: ReturnType<typeof c>[]) => checkoutsOf(list, 'g/app').map((x) => x.path);
    // numeric, not lexicographic: -2 before -10
    expect(
      sorted([c('/g/app-10', { isMain: true }), c('/g/app-2', { isMain: true }), c('/wt', {})]),
    ).toEqual(['/g/app-2', '/g/app-10', '/wt']);
    // a provider's named path beats a lower-numbered clone
    expect(
      sorted([c('/g/app-1', { isMain: true }), c('/g/app-7', { isMain: true, preferred: true })]),
    ).toEqual(['/g/app-7', '/g/app-1']);
    // a clone without a number sorts after numbered ones
    expect(sorted([c('/g/app', { isMain: true }), c('/g/app-3', { isMain: true })])).toEqual([
      '/g/app-3',
      '/g/app',
    ]);
  });

  it('marks the path a provider names as preferred', async () => {
    setRepoDirProviders([
      {
        id: 'p',
        repoDirs: async () => [
          {
            path: '/g/app-1',
            remote: 'git@h:g/app.git',
            worktrees: [
              { path: '/g/app-1', branch: 'm', isMain: true },
              { path: '/g/wt', branch: 'x', isMain: false },
            ],
          },
        ],
      },
    ]);
    const all = await localCheckouts(async () => '');
    expect(all.find((x) => x.path === '/g/app-1')?.preferred).toBe(true);
    expect(all.find((x) => x.path === '/g/wt')?.preferred).toBeUndefined();
  });

  it('probes provider repos that list no worktrees', async () => {
    const { main, wt } = fixture();
    setRepoDirProviders([{ id: 'p', repoDirs: async () => [{ path: main }] }]);
    const all = await localCheckouts(exec);
    expect(all.map((c) => c.path)).toEqual([main, wt]);
  });

  it('caches per root set and shares a pending scan', async () => {
    const spy = vi.fn(async () => '');
    await Promise.all([localCheckouts(spy, ['/r']), localCheckouts(spy, ['/r'])]);
    await localCheckouts(spy, ['/r']);
    expect(spy).toHaveBeenCalledTimes(1);
    await localCheckouts(spy, ['/other']);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a failing provider does not hide the others', async () => {
    setRepoDirProviders([
      { id: 'bad', repoDirs: async () => Promise.reject(new Error('boom')) },
      { id: 'ok', repoDirs: async () => [{ path: '/x', worktrees: [{ path: '/x', branch: null }] }] },
    ]);
    expect((await localCheckouts(async () => '')).map((c) => c.path)).toEqual(['/x']);
  });
});
