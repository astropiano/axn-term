// Pure helpers behind the scratchpad view: one flat list of drafts across the
// open sessions' repos, grouped/filtered/aged, and the trash script for the
// cleanup. No React, no IO — unit tested.

import { shellQuote } from '../../shellQuote';

export interface DraftEntry {
  /** Project the draft belongs to (the repo's remote name, else its folder name). */
  repo: string;
  /** The configured folder it was found in (repo-relative, or absolute). */
  dir: string;
  /** True for a folder inside the repo, false for a central (absolute) one. */
  inRepo: boolean;
  name: string;
  /** Absolute path. */
  path: string;
  /** Last modification, Unix ms — when known. */
  modifiedAt?: number;
  /** The session whose api found it: the one that opens its tabs. */
  sessionId: string;
}

const byRepo = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Newest first; drafts of unknown age last, then by name. */
function byAge(a: DraftEntry, b: DraftEntry): number {
  if (a.modifiedAt !== undefined && b.modifiedAt !== undefined && a.modifiedAt !== b.modifiedAt) {
    return b.modifiedAt - a.modifiedAt;
  }
  if ((a.modifiedAt === undefined) !== (b.modifiedAt === undefined)) {
    return a.modifiedAt === undefined ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

/** One entry per file path — several checkouts of one repo share a central folder. */
export function dedupeEntries(entries: DraftEntry[]): DraftEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
}

/** Repo names that have drafts, sorted. */
export function repoNames(entries: DraftEntry[]): string[] {
  return [...new Set(entries.map((e) => e.repo))].sort(byRepo);
}

/** Case-insensitive substring match on name, repo and folder; `repo` limits to one project. */
export function filterEntries(entries: DraftEntry[], query: string, repo: string | null): DraftEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (repo === null || e.repo === repo) &&
      (q === '' || [e.name, e.repo, e.dir].some((field) => field.toLowerCase().includes(q))),
  );
}

export interface RepoDrafts {
  repo: string;
  entries: DraftEntry[];
}

/** Groups sorted by repo name, drafts within a group newest first. */
export function groupByRepo(entries: DraftEntry[]): RepoDrafts[] {
  const groups = new Map<string, DraftEntry[]>();
  for (const e of entries) groups.set(e.repo, [...(groups.get(e.repo) ?? []), e]);
  return [...groups.entries()]
    .sort(([a], [b]) => byRepo(a, b))
    .map(([repo, list]) => ({ repo, entries: [...list].sort(byAge) }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ages the cleanup offers. */
export const CLEANUP_AGES: { label: string; ms: number }[] = [
  { label: '1 day', ms: DAY_MS },
  { label: '3 days', ms: 3 * DAY_MS },
  { label: '1 week', ms: 7 * DAY_MS },
  { label: '2 weeks', ms: 14 * DAY_MS },
  { label: '1 month', ms: 30 * DAY_MS },
  { label: '3 months', ms: 90 * DAY_MS },
];

/** Drafts last modified more than `ageMs` ago; those of unknown age are never picked. */
export function olderThan(entries: DraftEntry[], ageMs: number, now = Date.now()): DraftEntry[] {
  return entries.filter((e) => e.modifiedAt !== undefined && now - e.modifiedAt > ageMs);
}

/**
 * A `sh -c` script that moves `paths` to the trash: `gio trash` where it
 * exists, else a move into `~/.Trash` (macOS) or the XDG trash folder, with a
 * suffix when the name is taken. Paths are single-quoted. Prints how many
 * files were trashed.
 */
export function trashScript(paths: string[]): string {
  const calls = paths.map((p) => `trash_one ${shellQuote(p)}`).join('\n');
  return [
    'if [ "$(uname)" = Darwin ]; then d="$HOME/.Trash"; else d="${XDG_DATA_HOME:-$HOME/.local/share}/Trash/files"; fi',
    'n=0',
    'trash_one() {',
    '  [ -e "$1" ] || return 0',
    '  if [ "$(uname)" != Darwin ] && command -v gio >/dev/null 2>&1 && gio trash -- "$1" 2>/dev/null; then n=$((n+1)); return 0; fi',
    '  mkdir -p "$d" || return 1',
    '  b=$(basename "$1"); dest="$d/$b"; i=0',
    '  while [ -e "$dest" ]; do i=$((i+1)); dest="$d/$b.$(date +%s).$i"; done',
    '  mv -- "$1" "$dest" && n=$((n+1))',
    '}',
    calls,
    'echo "$n"',
  ].join('\n');
}
