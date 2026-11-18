import type { SessionBackend } from '@axn-term/session-backend';
import type { RepoInfo } from '../types';

/**
 * Thin client over the backend's git exec port: `git` with an explicit
 * argv (no shell quoting), run off the UI thread. Plus the pure parsers and
 * the lane-assignment algorithm the git inspect view renders — kept separate
 * from React so they stay unit-testable.
 *
 * The backend handle is bound once by the app (ShellApp) — git calls carry
 * a session id so remote backends route to the right session host.
 */

let gitBackend: SessionBackend | null = null;

/** Called once by the app at mount. */
export function bindGitBackend(backend: SessionBackend | null): void {
  gitBackend = backend;
}

/** The bound backend, for helpers that need direct fs access. */
export function gitBackendHandle(): SessionBackend {
  if (!gitBackend) throw new Error('git backend is not bound');
  return gitBackend;
}

/**
 * Run `git <args>`. Paths are always literal (`--literal-pathspecs`): file
 * names like `app/[id]/page.tsx` or `:x` must not act as globs or magic
 * pathspecs, or a restore/stage would hit other files too.
 */
export function git(sessionId: string, cwd: string, args: string[]): Promise<string> {
  const backend = gitBackend;
  if (!backend?.execGit) {
    return Promise.reject(new Error('git is not available in this environment'));
  }
  return backend.execGit(sessionId, cwd, ['--literal-pathspecs', ...args]);
}

/**
 * RepoInfo for `cwd` — pure client-side composition over `git` argv calls
 * (same commands and parsing as the desktop `get_git_repo` command), so it
 * works identically on local and remote backends.
 */
export async function repoInfo(sessionId: string, cwd: string): Promise<RepoInfo | null> {
  if (!gitBackend?.execGit) return null;
  const toplevel = await git(sessionId, cwd, ['rev-parse', '--show-toplevel'])
    .then((s) => s.trim())
    .catch(() => '');
  if (!toplevel) return null;
  const name = toplevel.split('/').filter(Boolean).pop() ?? '';
  const remote = await git(sessionId, cwd, ['remote', 'get-url', 'origin'])
    .then((s) => s.trim())
    .catch(() => undefined);
  const group = remote ? parseGitRemote(remote)?.[0] : undefined;
  const statusOutput = await git(sessionId, cwd, [
    'status',
    '--porcelain',
    '--branch',
    '--untracked-files=all',
  ]).catch(() => null);
  if (statusOutput === null) return null;
  return parseGitStatus(statusOutput, name, group, toplevel, remote);
}

/** `(group, name)` for ssh/https git remote URLs — mirrors the Rust parser. */
function parseGitRemote(url: string): [string, string] | null {
  const trimmed = url.trim();
  const withoutGit = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  let path: string;
  const at = withoutGit.indexOf('@');
  const scheme = withoutGit.indexOf('://');
  if (at !== -1) {
    const afterHost = withoutGit.slice(at + 1);
    const i = afterHost.search(/[:/]/);
    if (i === -1) return null;
    path = afterHost.slice(i + 1);
  } else if (scheme !== -1) {
    const afterScheme = withoutGit.slice(scheme + 3);
    const i = afterScheme.indexOf('/');
    if (i === -1) return null;
    path = afterScheme.slice(i + 1);
  } else {
    path = withoutGit;
  }
  const idx = path.lastIndexOf('/');
  if (idx === -1) return null;
  return [path.slice(0, idx), path.slice(idx + 1)];
}

/** Parse `git status --porcelain --branch` — mirrors the Rust parser. */
function parseGitStatus(
  output: string,
  name: string,
  group: string | undefined,
  root: string,
  remote: string | undefined,
): RepoInfo | null {
  const lines = output.split('\n');
  const branchLine = lines.shift();
  if (!branchLine?.startsWith('## ')) return null;
  const rest = branchLine.slice(3);

  let branch: string | null = null;
  let remoteBranchMissing = false;
  let ahead = 0;
  let behind = 0;

  if (rest.startsWith('HEAD')) {
    branch = null;
  } else {
    const dots = rest.indexOf('...');
    if (dots !== -1) {
      branch = rest.slice(0, dots);
      const tracking = rest.slice(dots + 3);
      if (tracking.includes('[gone]')) remoteBranchMissing = true;
      const aheadMatch = /ahead (\d+)/.exec(tracking);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10) || 0;
      const behindMatch = /behind (\d+)/.exec(tracking);
      if (behindMatch) behind = parseInt(behindMatch[1], 10) || 0;
    } else {
      branch = rest.split(/\s+/)[0] ?? null;
      remoteBranchMissing = true;
    }
  }

  let dirty = false;
  let untracked = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('??')) untracked += 1;
    else dirty = true;
  }

  return { name, group, branch, ahead, behind, dirty, untracked, remoteBranchMissing, root, remote };
}

// ---------------------------------------------------------------------------
// git status --porcelain -z
// ---------------------------------------------------------------------------

export interface StatusFile {
  /** Path as reported by git (rename target for renames). */
  path: string;
  /** Source path for staged renames/copies. */
  oldPath?: string;
  /** Index column (X): ' ', M, A, D, R, C, U, '?' or '!' */
  index: string;
  /** Worktree column (Y), same alphabet. */
  worktree: string;
}

/**
 * Parse `git status --porcelain -z` output. Records are `XY <path>\0`;
 * rename/copy records carry a second NUL-terminated field with the source
 * path (with `-z` the `from -> to` arrow is dropped and the order is
 * `to\0from`).
 */
export function parsePorcelainZ(out: string): StatusFile[] {
  const fields = out.split('\0');
  const files: StatusFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4 || rec.startsWith('##')) continue;
    const file: StatusFile = { index: rec[0], worktree: rec[1], path: rec.slice(3) };
    if ('RC'.includes(rec[0]) || 'RC'.includes(rec[1])) {
      file.oldPath = fields[++i] ?? '';
    }
    files.push(file);
  }
  return files;
}

/** `git show` spec for the index (stage 0) copy of a path. */
export function indexBlob(path: string): string {
  // explicit stage, so a file named `1:x` is not read as stage 1 of `x`
  return `:0:${path}`;
}

/**
 * Where the "working tree" diff of an unstaged row starts: the index copy of
 * the file under its current name (after a staged rename the old name is
 * gone from the index), else HEAD (conflicts have no stage-0 entry).
 */
export function unstagedBaseSpecs(f: StatusFile): string[] {
  return [indexBlob(f.path), `HEAD:${f.oldPath ?? f.path}`];
}

export interface WorktreeStatus {
  staged: StatusFile[];
  unstaged: StatusFile[];
  untracked: StatusFile[];
  conflicted: StatusFile[];
}

function isUnmerged(index: string, worktree: string): boolean {
  return (
    index === 'U' ||
    worktree === 'U' ||
    (index === 'A' && worktree === 'A') ||
    (index === 'D' && worktree === 'D')
  );
}

export function splitStatus(files: StatusFile[]): WorktreeStatus {
  const staged: StatusFile[] = [];
  const unstaged: StatusFile[] = [];
  const untracked: StatusFile[] = [];
  const conflicted: StatusFile[] = [];
  for (const f of files) {
    if (f.index === '?') {
      untracked.push(f);
      continue;
    }
    if (f.index === '!') continue;
    if (isUnmerged(f.index, f.worktree)) {
      conflicted.push(f);
      continue;
    }
    if (f.index !== ' ') staged.push(f);
    if (f.worktree !== ' ') unstaged.push(f);
  }
  return { staged, unstaged, untracked, conflicted };
}

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  time: number;
  /** Decorations (%D): `HEAD -> branch`, `tag: v1`, `origin/main`, … */
  refs: string[];
  subject: string;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** `--format=` for `git log` matching `parseLog`. */
export const LOG_FORMAT = `%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e`;

/**
 * Refs the history strip walks. Without a compare base it is every ref
 * (`--all`) plus HEAD. With one (a review tab: `axn-git origin/develop`) it is
 * HEAD and that base only — a worktree shares every ref of its clone, so
 * `--all` would put unrelated branches (a local integration branch, other
 * reviews) at the top of the graph and make their changes look like the MR's.
 */
export function historyRefs(base?: string | null): string[] {
  return base ? ['HEAD', base] : ['--all', 'HEAD'];
}

export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of out.split(RECORD)) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [hash = '', parents = '', author = '', time = '', refs = '', ...rest] =
      trimmed.split(FIELD);
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      author,
      time: parseInt(time, 10) || 0,
      refs: refs
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      subject: rest.join(FIELD),
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// git diff --name-status -z (commit file lists)
// ---------------------------------------------------------------------------

export interface CommitFile {
  /** Single letter status (M/A/D/…) or letter+score for renames (R100). */
  status: string;
  path: string;
  /** Source path for renames/copies. */
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -z` / `git diff-tree --name-status -z` output:
 * `STATUS\0path\0`, renames `R<score>\0from\0to\0`.
 */
export function parseNameStatusZ(out: string): CommitFile[] {
  const fields = out.split('\0');
  const files: CommitFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[++i] ?? '';
      const path = fields[++i] ?? '';
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: fields[++i] ?? '' });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Lane assignment for the history graph (GitKraken-style)
// ---------------------------------------------------------------------------

export interface GraphRow {
  commit: GitCommit;
  /** Column the commit dot occupies. */
  lane: number;
  /** Expected-hash per lane entering this row from above. */
  entering: (string | null)[];
  /** Expected-hash per lane leaving this row below. */
  leaving: (string | null)[];
  /** Lanes whose line merges into this row's dot (fan-in). */
  merges: number[];
  /** Lanes forked off this row's dot toward secondary parents. */
  forks: number[];
}

/**
 * Assign each commit a lane (column) for the graph. Commits must be in
 * `git log --topo-order` order (children before parents). Every lane tracks
 * the hash it expects next; a commit claims the first lane expecting it,
 * surplus lanes expecting it merge into the dot, the first parent continues
 * the lane, and further parents fork into the lane already expecting them or
 * a fresh one.
 */
export function assignLanes(commits: GitCommit[]): {
  rows: GraphRow[];
  laneCount: number;
} {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const entering = [...lanes];
    const claiming = lanes.flatMap((h, l) => (h === commit.hash ? [l] : []));
    let lane: number;
    const merges: number[] = [];
    if (claiming.length === 0) {
      // Nothing above expects this commit → it is a branch head: new lane.
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    } else {
      lane = claiming[0];
      for (const l of claiming.slice(1)) {
        lanes[l] = null;
        merges.push(l);
      }
    }
    lanes[lane] = null;
    const forks: number[] = [];
    let firstRouted = false;
    for (const p of commit.parents) {
      const existing = lanes.indexOf(p);
      if (!firstRouted) {
        // The first parent continues this lane — even when another lane
        // already expects it: both keep expecting p so that lane merges into
        // p's row instead of this lane bending over (the first-parent chain
        // stays straight).
        lanes[lane] = p;
        firstRouted = true;
        continue;
      }
      if (existing !== -1) {
        // Secondary parent already expected elsewhere → edge joins that lane.
        forks.push(existing);
        continue;
      }
      let free = lanes.indexOf(null);
      if (free === -1) {
        free = lanes.length;
        lanes.push(p);
      } else {
        lanes[free] = p;
      }
      forks.push(free);
    }
    rows.push({ commit, lane, entering, leaving: [...lanes], merges, forks });
  }
  return { rows, laneCount: lanes.length };
}
