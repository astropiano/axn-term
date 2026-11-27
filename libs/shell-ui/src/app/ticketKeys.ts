/**
 * Ticket keys in text — the one matcher behind every place that spots a
 * ticket: the jira plugin's session identifiers (branch, MR titles, name),
 * the forge plugins' `ticket-regex` identifiers and the hover targets in
 * terminals and chips (`app/textTargets.ts`). Pure; no plugin imports.
 */

/** A ticket key found in a string, with its `[start, end)` range. */
export interface IssueKeyMatch {
  key: string;
  start: number;
  end: number;
}

function keyPattern(projectKeys: string[], flags: string): RegExp | undefined {
  const alt = projectKeys
    .map((k) => k.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
    .filter(Boolean)
    .join('|');
  if (!alt) return undefined;
  // Not glued to a longer word on the left (`XAIACC-1`), not a longer
  // number on the right — `_`/`/`/`-` around it are fine (branch names).
  return new RegExp(`(?<![A-Za-z0-9])(${alt})-(\\d+)(?!\\d)`, flags);
}

/** Every key of a configured project in `text`, in order, with its range (duplicates kept). */
export function scanIssueKeys(text: string | undefined, projectKeys: string[]): IssueKeyMatch[] {
  if (!text) return [];
  const re = keyPattern(projectKeys, 'gi');
  if (!re) return [];
  return [...text.matchAll(re)].map((m) => ({
    key: `${m[1].toUpperCase()}-${m[2]}`,
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

/** First issue key of a configured project in `text` (case-insensitive, uppercased). */
export function findIssueKey(text: string | undefined, projectKeys: string[]): string | undefined {
  return scanIssueKeys(text, projectKeys)[0]?.key;
}

/** Every distinct issue key of a configured project in `text`, in order. */
export function findIssueKeys(text: string | undefined, projectKeys: string[]): string[] {
  return [...new Set(scanIssueKeys(text, projectKeys).map((m) => m.key))];
}

/**
 * The key a tracker URL points at: `<baseUrl>/browse/KEY` (also with a
 * query or fragment), or a Jira board/list URL carrying `selectedIssue=KEY`.
 * Only URLs on `baseUrl`'s host count, only keys of `projectKeys`.
 */
export function issueKeyFromUrl(
  url: string,
  baseUrl: string,
  projectKeys: string[],
): string | undefined {
  let u: URL;
  let base: URL;
  try {
    u = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (u.host.toLowerCase() !== base.host.toLowerCase()) return undefined;
  const browse = /\/browse\/([^/?#]+)/.exec(u.pathname)?.[1];
  const candidate = browse ?? u.searchParams.get('selectedIssue') ?? undefined;
  const match = scanIssueKeys(candidate, projectKeys)[0];
  // The whole segment must be the key — `/browse/AIACC-1x` is not AIACC-1.
  return match && match.start === 0 && match.end === candidate?.length ? match.key : undefined;
}

/**
 * A ticket key from free text via a user regex (the forge plugins'
 * `ticket-regex`): the first capture group, else the whole match,
 * uppercased. Undefined when nothing matches or the pattern is invalid.
 */
export function extractTicketFromTitle(
  title: string | undefined,
  pattern: unknown,
): string | undefined {
  if (!title || typeof pattern !== 'string') return undefined;
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  try {
    const m = new RegExp(trimmed, 'i').exec(title);
    if (!m) return undefined;
    const raw = (m[1] ?? m[0]).trim();
    return raw ? raw.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}
