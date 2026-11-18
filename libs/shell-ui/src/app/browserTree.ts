import type { DirEntry } from '@axn-term/session-backend';

/**
 * Tree model for the axn-browse view: the current directory's listing plus
 * the listings of folders expanded in place, flattened into the rows the
 * view renders and the arrow keys walk.
 */

/** Children of an expanded folder — absent while its listing loads. */
export interface ChildListing {
  entries?: DirEntry[];
  error?: string;
}

export type TreeRow =
  | {
      kind: 'entry';
      entry: DirEntry;
      /** Absolute path of the entry. */
      path: string;
      /** Absolute path of the folder listing it. */
      parentPath: string;
      depth: number;
      expanded: boolean;
    }
  | { kind: 'status'; path: string; depth: number; text: string };

export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, '')}/${name}`;
}

/** Folders first, then files, each alphabetically. */
export function sortEntries(list: DirEntry[]): DirEntry[] {
  return list.slice().sort((a, b) => {
    if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
    return a.isDirectory ? -1 : 1;
  });
}

/**
 * Depth-first rows: each expanded folder is followed by its children, or by
 * a status row while they load or when listing them failed. Dotfiles are
 * dropped unless `showHidden` — filtering here keeps the toggle free of
 * reloads.
 */
export function flattenTree(
  rootPath: string,
  rootEntries: DirEntry[],
  expanded: ReadonlySet<string>,
  children: ReadonlyMap<string, ChildListing>,
  showHidden: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, entries: DirEntry[], depth: number) => {
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue;
      const path = childPath(dir, entry.name);
      const isOpen = entry.isDirectory && expanded.has(path);
      rows.push({ kind: 'entry', entry, path, parentPath: dir, depth, expanded: isOpen });
      if (!isOpen) continue;
      const listing = children.get(path);
      if (listing?.error) {
        rows.push({ kind: 'status', path: `${path}#error`, depth: depth + 1, text: listing.error });
      } else if (!listing?.entries) {
        rows.push({ kind: 'status', path: `${path}#loading`, depth: depth + 1, text: 'loading...' });
      } else if (listing.entries.length === 0) {
        rows.push({ kind: 'status', path: `${path}#empty`, depth: depth + 1, text: 'empty' });
      } else {
        walk(path, listing.entries, depth + 1);
      }
    }
  };
  walk(rootPath, rootEntries, 0);
  return rows;
}

/** One tree-search result — an entry whose path matches the query. */
export interface SearchHit {
  /** Absolute path of the matching entry. */
  path: string;
  isDir: boolean;
}

export interface SearchTreeOptions {
  /** Skip dot-entries (mirrors the view's hidden-files toggle). */
  showHidden?: boolean;
  /** Bound on directories listed — guards huge trees like $HOME. */
  maxDirs?: number;
  /** Bound on returned matches. */
  maxResults?: number;
  /** Checked between listings — lets the caller abort stale searches. */
  isCancelled?: () => boolean;
}

/**
 * Breadth-first name search under `root` through repeated `listDir` calls —
 * the backend has no recursive find, so the tree is walked lazily like the
 * view's own expansion does. Directories and files match alike, on their
 * path relative to `root` (so `src/but` finds `src/button.tsx`). Bounded
 * by `maxDirs`/`maxResults`; `truncated` reports a hit limit, never an
 * error — unreadable folders are skipped.
 */
export async function searchTree(
  listDir: (dir: string) => Promise<DirEntry[]>,
  root: string,
  query: string,
  opts: SearchTreeOptions = {},
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const { showHidden = true, maxDirs = 400, maxResults = 200, isCancelled } = opts;
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], truncated: false };
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const hits: SearchHit[] = [];
  const queue = [root];
  let dirs = 0;
  let truncated = false;
  while (queue.length > 0 && dirs < maxDirs && hits.length < maxResults) {
    if (isCancelled?.()) break;
    const dir = queue.shift()!;
    dirs += 1;
    let entries: DirEntry[];
    try {
      entries = sortEntries(await listDir(dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue;
      const path = childPath(dir, entry.name);
      const rel = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
      if (rel.toLowerCase().includes(q)) {
        hits.push({ path, isDir: entry.isDirectory });
        if (hits.length >= maxResults) { truncated = true; break; }
      }
      if (entry.isDirectory) queue.push(path);
    }
    if (hits.length >= maxResults) truncated = true;
  }
  if (queue.length > 0 && dirs >= maxDirs) truncated = true;
  return { hits: hits.slice(0, maxResults), truncated };
}
