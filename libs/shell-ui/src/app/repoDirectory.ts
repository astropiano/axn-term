import { shellQuote } from '../shellQuote';
import { axnLog } from './log';

/**
 * Local repo discovery — where the git checkouts on this machine live, so
 * MR/PR features can find a project's clone without an open session in it.
 *
 * Two sources, always combined (they add, never replace):
 *
 * - **Plugin-provided repo dirs**: enabled plugins declaring `repoDirs`
 *   (e.g. `axn-dev`, from `axn-dev git repos --json`). ShellApp hands the
 *   enabled set to `setRepoDirProviders`.
 * - **Repo roots** a consumer passes in — each forge plugin has its own
 *   `repo-roots` setting — searched a few levels deep for `.git`.
 *
 * Every repo expands into all of its checkouts (`git worktree list`), and the
 * result is deduplicated by checkout path: a repo named by a provider and
 * also found under a root, or reached once through its main checkout and
 * once through a linked worktree, appears exactly once.
 */

/** A repo as a plugin reports it. Without `worktrees` the host asks git. */
export interface RepoDir {
  path: string;
  name?: string;
  remote?: string | null;
  worktrees?: Array<{ path: string; branch: string | null; isMain?: boolean }>;
}

/** One checkout (main or linked worktree) of a local repo. */
export interface RepoCheckout {
  path: string;
  /** null when detached or unknown. */
  branch: string | null;
  /** The repo's `origin` URL, null when it has none. */
  remote: string | null;
  /** The repo's main checkout (not a linked worktree), when known. */
  isMain?: boolean;
  /** The path a provider named for the repo (e.g. axn-dev's `repos:` entry) — the user's "first" clone. */
  preferred?: boolean;
}

export interface RepoDirsContext {
  exec(command: string, cwd?: string): Promise<string>;
}

export type RepoDirsProvider = {
  id: string;
  repoDirs: (ctx: RepoDirsContext) => Promise<RepoDir[]>;
};

let providers: RepoDirsProvider[] = [];

/** ShellApp publishes the enabled plugins that declare `repoDirs`. */
export function setRepoDirProviders(next: RepoDirsProvider[]): void {
  const changed =
    next.length !== providers.length || next.some((p, i) => p.id !== providers[i]?.id);
  providers = next;
  if (changed) cache.clear();
}

export function repoDirProviderIds(): string[] {
  return providers.map((p) => p.id);
}

/** How deep below a root a `.git` may sit (root/a/b/c/repo/.git = 5). */
export const REPO_SCAN_DEPTH = 5;
/** Directories never descended into while searching a root. */
const SCAN_PRUNE = ['node_modules', 'target', 'dist', 'build', '.venv', 'venv', '.gradle', '.cache'];
const CACHE_TTL_MS = 5 * 60_000;

/** Parse a `repo-roots` setting: newline, comma or semicolon separated. */
export function parseRepoRoots(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,;]/)) {
    const root = normPath(part.trim());
    if (root && !seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }
  return out;
}

function normPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** A root as a shell word: `~` expands, everything else stays quoted. */
function rootWord(root: string): string {
  if (root === '~') return '"$HOME"';
  if (root.startsWith('~/')) return `"$HOME"/${shellQuote(root.slice(2))}`;
  return shellQuote(root);
}

/**
 * One `sh -c` script that reports every checkout of the given repo paths and
 * of every `.git` found below `roots`. It reads git's metadata files instead
 * of running git — on a slow volume two git calls per repo cost ~40 s for
 * 140 repos, the file reads well under a second:
 *
 * 1. each candidate resolves to its repo's *main* git dir (a linked
 *    worktree's `.git` file → `gitdir:` → `commondir`), deduplicated, so a
 *    repo reached through several of its worktrees is read once;
 * 2. per main git dir it prints `@repo<TAB><gitdir><TAB><origin url>`, then
 *    porcelain-style `worktree <path>` / `branch refs/heads/<b>` blocks for
 *    the main checkout and every `worktrees/<id>` entry.
 *
 * Bare repos (git dir not named `.git`) have no main checkout and only
 * report their linked worktrees.
 */
export function repoProbeScript(roots: string[], paths: string[], depth = REPO_SCAN_DEPTH): string {
  const prune = SCAN_PRUNE.map((n) => `-name ${shellQuote(n)}`).join(' -o ');
  const sources: string[] = [];
  if (paths.length) {
    sources.push(`printf '%s/.git\n' ${paths.map((p) => shellQuote(normPath(p))).join(' ')}`);
  }
  if (roots.length) {
    sources.push(
      `for r in ${roots.map(rootWord).join(' ')}; do ` +
        `[ -d "$r" ] && find "$r" -maxdepth ${depth} \\( ${prune} \\) -prune -o -name .git -print -prune 2>/dev/null; ` +
        'done',
    );
  }
  if (!sources.length) return 'true';
  // .git (dir or file) → main git dir, absolute and symlink-free.
  const toMain =
    'while IFS= read -r g; do ' +
    'if [ -f "$g" ]; then ' +
    'w=$(sed -n \'s/^gitdir: //p\' "$g" | head -n 1); ' +
    'case "$w" in /*) ;; *) w="${g%/.git}/$w";; esac; ' +
    '[ -f "$w/commondir" ] && w="$w/$(cat "$w/commondir")"; ' +
    'g="$w"; ' +
    'fi; ' +
    '[ -d "$g" ] && (cd "$g" 2>/dev/null && pwd -P); ' +
    'done';
  const head = (f: string) => `sed -n 's|^ref: |branch |p' "${f}" 2>/dev/null`;
  const emit =
    'while IFS= read -r G; do ' +
    'url=$(sed -n \'/^\\[remote "origin"\\]/,/^\\[/s/^[[:space:]]*url[[:space:]]*=[[:space:]]*//p\' "$G/config" 2>/dev/null | head -n 1); ' +
    'printf \'@repo\\t%s\\t%s\\n\' "$G" "$url"; ' +
    'case "$G" in */.git) printf \'worktree %s\\nmain\\n\' "${G%/.git}"; ' + head('$G/HEAD') + '; echo;; esac; ' +
    'for w in "$G"/worktrees/*; do ' +
    '[ -f "$w/gitdir" ] || continue; ' +
    'p=$(head -n 1 "$w/gitdir"); ' +
    'case "$p" in /*) ;; *) p="$w/$p";; esac; ' +
    'p="${p%/.git}"; ' +
    '[ -d "$p" ] || continue; ' +
    'printf \'worktree %s\\n\' "$(cd "$p" && pwd -P)"; ' + head('$w/HEAD') + '; echo; ' +
    'done; ' +
    'done';
  return `{ ${sources.join('; ')}; } | ${toMain} | sort -u | ${emit}`;
}

/** Parse `repoProbeScript` output into checkouts (not yet deduplicated). */
export function parseRepoProbe(out: string): RepoCheckout[] {
  const result: RepoCheckout[] = [];
  let remote: string | null = null;
  let current: RepoCheckout | null = null;
  const flush = () => {
    if (current) result.push(current);
    current = null;
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('@repo\t')) {
      flush();
      const [, , origin] = line.split('\t');
      remote = origin?.trim() || null;
    } else if (line.startsWith('worktree ')) {
      flush();
      current = { path: normPath(line.slice('worktree '.length)), branch: null, remote };
    } else if (line === 'main' && current) {
      current.isMain = true;
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  return result;
}

/**
 * Deduplicate by checkout path. The first entry wins; a later duplicate only
 * fills fields the first one left unknown.
 */
export function mergeCheckouts(...lists: RepoCheckout[][]): RepoCheckout[] {
  const byPath = new Map<string, RepoCheckout>();
  for (const list of lists) {
    for (const c of list) {
      const key = normPath(c.path);
      if (!key) continue;
      const prev = byPath.get(key);
      if (!prev) {
        byPath.set(key, { ...c, path: key });
      } else {
        if (prev.branch === null && c.branch !== null) prev.branch = c.branch;
        if (prev.remote === null && c.remote !== null) prev.remote = c.remote;
        if (prev.isMain === undefined && c.isMain !== undefined) prev.isMain = c.isMain;
        if (prev.preferred === undefined && c.preferred !== undefined) prev.preferred = c.preferred;
      }
    }
  }
  return [...byPath.values()];
}

/** Checkouts a provider spelled out itself (no git call needed). */
function providedCheckouts(dirs: RepoDir[]): { known: RepoCheckout[]; probe: string[] } {
  const known: RepoCheckout[] = [];
  const probe: string[] = [];
  for (const d of dirs) {
    if (!d?.path) continue;
    if (d.worktrees?.length) {
      for (const w of d.worktrees) {
        known.push({
          path: w.path,
          branch: w.branch ?? null,
          remote: d.remote ?? null,
          ...(w.isMain !== undefined ? { isMain: w.isMain } : {}),
          ...(normPath(w.path) === normPath(d.path) ? { preferred: true } : {}),
        });
      }
    } else {
      probe.push(d.path);
    }
  }
  return { known, probe };
}

const cache = new Map<string, { at: number; value: Promise<RepoCheckout[]> }>();

/** Drop cached discovery results (tests; settings changes refresh by key). */
export function resetRepoDirectory(): void {
  cache.clear();
}

/**
 * All local checkouts known from enabled providers plus `roots`, deduplicated
 * by path. Cached per root set for a few minutes; concurrent callers share
 * one scan. `exec` runs `sh -c` in the app's environment.
 */
export function localCheckouts(
  exec: RepoDirsContext['exec'],
  roots: string[] = [],
  { force = false }: { force?: boolean } = {},
): Promise<RepoCheckout[]> {
  const key = `${repoDirProviderIds().join(',')}\n${roots.join('\n')}`;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = discover(exec, roots).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function discover(exec: RepoDirsContext['exec'], roots: string[]): Promise<RepoCheckout[]> {
  const fromProviders = await Promise.all(
    providers.map((p) =>
      p.repoDirs({ exec }).catch((e) => {
        axnLog('warn', 'repo-dirs', `${p.id}: ${String(e).split('\n')[0]}`);
        return [] as RepoDir[];
      }),
    ),
  );
  const { known, probe } = providedCheckouts(fromProviders.flat());
  let probed: RepoCheckout[] = [];
  if (probe.length || roots.length) {
    try {
      probed = parseRepoProbe(await exec(repoProbeScript(roots, probe)));
    } catch (e) {
      axnLog('warn', 'repo-dirs', `scan failed: ${String(e).split('\n')[0]}`);
    }
  }
  return mergeCheckouts(known, probed);
}

/**
 * The project path of a remote URL — `group/sub/repo` from
 * `git@host:group/sub/repo.git`, `ssh://git@host:9022/group/sub/repo.git`
 * or `https://host/group/sub/repo`.
 */
export function remoteProjectPath(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const r = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(r);
  if (url) return url[1];
  const scp = /^[^@\s/]+@[^:\s]+:(.+)$/.exec(r);
  if (scp) return scp[1];
  return null;
}

/** True when `remote` points at the forge project `project` (exact path, case-insensitive). */
export function remoteMatchesProject(remote: string | null | undefined, project: string): boolean {
  const path = remoteProjectPath(remote);
  return !!path && path.toLowerCase() === project.replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** Trailing number of a path's last segment (`ai-accelerator-10` → 10); Infinity when none. */
function cloneNumber(path: string): number {
  const m = /-(\d+)$/.exec(path.split('/').pop() ?? '');
  return m ? Number(m[1]) : Infinity;
}

/**
 * Checkouts of `project`, best first: the provider's named path (axn-dev's
 * `repos:` entry), then main checkouts by trailing clone number
 * (`p-2` before `p-10`) and name, then linked worktrees.
 */
export function checkoutsOf(checkouts: RepoCheckout[], project: string): RepoCheckout[] {
  return checkouts
    .filter((c) => remoteMatchesProject(c.remote, project))
    .sort(
      (a, b) =>
        Number(b.preferred === true) - Number(a.preferred === true) ||
        Number(b.isMain === true) - Number(a.isMain === true) ||
        cloneNumber(a.path) - cloneNumber(b.path) ||
        a.path.localeCompare(b.path),
    );
}
