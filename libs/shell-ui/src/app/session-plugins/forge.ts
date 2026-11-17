/**
 * Shared helpers for the forge plugins (glab-mr for GitLab, gh-pr for
 * GitHub). Both are on by default, so each must stay quiet where it does not
 * apply: on a repo hosted by the other forge, and when its CLI is not
 * installed or not signed in.
 */

import { appRuntime } from '../appRuntime';
import { localCheckouts, parseRepoRoots, REPO_SCAN_DEPTH, type RepoCheckout } from '../repoDirectory';
import type { PluginSettingField } from './plugin';

export type Forge = 'github' | 'gitlab';
export type ForgeCli = 'gh' | 'glab';

export interface RemoteLocation {
  /** Lowercased host, without user or port. */
  host: string;
  /** Repository path without leading slash or `.git` (e.g. `owner/repo`). */
  path: string;
}

/**
 * Host and path of a git remote URL: `https://host/owner/repo(.git)`,
 * `ssh://git@host:22/owner/repo.git` and scp-like `git@host:owner/repo.git`.
 * Local paths and anything unparseable yield undefined.
 */
export function parseRemote(remote: string | undefined): RemoteLocation | undefined {
  const v = remote?.trim();
  if (!v) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(v);
  if (url) {
    host = url[1];
    path = url[2];
  } else {
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(v);
    if (scp) {
      host = scp[1];
      path = scp[2];
    }
  }
  if (!host || !path) return undefined;
  return {
    host: host.toLowerCase(),
    path: path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, ''),
  };
}

/** Owner (first path segment) of a remote URL — the GitHub user/org. */
export function remoteOwner(remote: string | undefined): string | undefined {
  return parseRemote(remote)?.path.split('/')[0]?.toLowerCase() || undefined;
}

/**
 * Which forge hosts a remote: an explicitly configured hostname (the
 * plugins' `hostname` setting, for GHES / self-hosted GitLab) wins, then the
 * obvious `github`/`gitlab` in the host name. Unknown hosts yield undefined —
 * callers treat that as "might be mine" and try their CLI.
 */
export function forgeOfRemote(
  remote: string | undefined,
  hosts: Partial<Record<Forge, unknown>> = {},
): Forge | undefined {
  const host = parseRemote(remote)?.host;
  if (!host) return undefined;
  for (const forge of ['github', 'gitlab'] as const) {
    const configured = hosts[forge];
    if (typeof configured === 'string' && configured.trim().toLowerCase() === host) return forge;
  }
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return undefined;
}

/** The plugin's `hostname` setting, trimmed; `undefined` = the CLI's default host. */
export function forgeHost(hostname: unknown): string | undefined {
  return typeof hostname === 'string' && hostname.trim() ? hostname.trim() : undefined;
}

/**
 * The `<cli> auth login|status` line to suggest to the user, naming the host
 * the plugin actually queried — a bare hint checks the CLI's default host,
 * which says nothing about a self-hosted instance (display text, not executed).
 */
export function authCommand(cli: ForgeCli, verb: 'login' | 'status', host?: string): string {
  return host ? `${cli} auth ${verb} --hostname ${host}` : `${cli} auth ${verb}`;
}

/** Shown when no `hostname` is set: the CLI fell back to its default host. */
export const defaultHostNote = (cli: ForgeCli, forgeName: string) =>
  `No hostname is configured, so ${cli} queried its default host — set the ${forgeName} hostname in Settings → Plugins for a self-hosted instance.`;

/** The plain-text "check your auth" hint for tooltips, naming the queried host. */
export function authStatusHint(cli: ForgeCli, forgeName: string, host?: string): string {
  const check = `Check \`${authCommand(cli, 'status', host)}\` in a shell.`;
  return host ? check : `${check}\n${defaultHostNote(cli, forgeName)}`;
}

/** Lead of the message `compactCliError` makes from a GraphQL timeout dump. */
export const GRAPHQL_TIMEOUT_SUMMARY = 'the server timed out answering the query';

const MAX_ERROR_CHARS = 600;

/**
 * Make a CLI error readable. GitLab answers a GraphQL request that runs
 * past its server-side limit with one "Timeout on <Type.field>" per
 * unresolved field — hundreds of them — so those collapse into a count per
 * field; anything else still over `MAX_ERROR_CHARS` is cut.
 */
export function compactCliError(message: string): string {
  const timeouts = message.match(/Timeout on [\w.]+/g);
  if (timeouts && timeouts.length > 1) {
    const counts = new Map<string, number>();
    for (const t of timeouts) {
      const field = t.slice('Timeout on '.length);
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    const fields = [...counts].map(([f, n]) => (n > 1 ? `${f} ×${n}` : f)).join(', ');
    const lead = message.slice(0, message.indexOf('Timeout on')).trim();
    return `${lead ? `${lead} ` : ''}${GRAPHQL_TIMEOUT_SUMMARY} (${timeouts.length} fields: ${fields})`;
  }
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/** Stderr line the guard in `forgeCliCommand` prints when the CLI is absent. */
export const cliMissingMarker = (cli: ForgeCli) => `axn-term: ${cli} is not installed`;

/**
 * Prefix a `sh -c` command line with a presence check for the CLI, so a
 * missing tool fails with one known marker instead of a shell-specific
 * "command not found" text (bash, dash and the web session host differ).
 */
export function forgeCliCommand(cli: ForgeCli, args: string): string {
  return `command -v ${cli} >/dev/null 2>&1 || { echo '${cliMissingMarker(cli)}' >&2; exit 127; }; ${cli} ${args}`;
}

export type CliFailure = 'missing' | 'signed-out' | 'error';

/**
 * What a forge rail teaser shows for an overview state:
 * - `hidden` — the CLI is not installed, or the first refresh is still
 *   pending (so users without the CLI never see the icon flash up);
 * - `signed-out` — a muted icon with a sign-in hint, never a red alert;
 * - `error` — the red warning triangle (network/API failures);
 * - `counts` — the usual x/y counters.
 */
export function forgeRailMode(state: {
  failure?: CliFailure;
  fetchedAt?: number;
}): 'hidden' | 'signed-out' | 'error' | 'counts' {
  if (state.failure === 'missing') return 'hidden';
  if (state.failure === 'signed-out') return 'signed-out';
  if (state.failure === 'error') return 'error';
  return state.fetchedAt === undefined ? 'hidden' : 'counts';
}

const SIGNED_OUT: Record<ForgeCli, RegExp> = {
  // gh exits 4 with "To get started with GitHub CLI, please run: gh auth login".
  gh: /gh auth login|GH_TOKEN|HTTP 401|Bad credentials|not logged in/i,
  // glab without a valid token: "glab: Invalid token" / 401; an anonymous
  // GraphQL call succeeds with currentUser null ("no currentUser").
  glab: /glab auth login|Invalid token|401 Unauthorized|HTTP 401|no currentUser|not logged in/i,
};

/**
 * Classify a forge CLI failure (the rejected exec message): `missing` — the
 * CLI is not installed; `signed-out` — installed but no usable login;
 * `error` — anything else (network, API errors), which is worth surfacing.
 */
export function classifyCliError(cli: ForgeCli, message: string): CliFailure {
  if (
    message.includes(cliMissingMarker(cli)) ||
    new RegExp(`\\b${cli}: (?:command )?not found|\\b${cli}: No such file`).test(message)
  ) {
    return 'missing';
  }
  if (SIGNED_OUT[cli].test(message)) return 'signed-out';
  return 'error';
}

/**
 * The `repo-roots` setting each forge plugin declares separately: folders
 * searched for local clones of the forge's projects (MR/PR review without
 * an open session in the repo). It adds to the repos enabled plugins report
 * (e.g. axn-dev), so users with axn-dev configured need not set it at all.
 */
export function repoRootsSetting(forge: 'GitLab' | 'GitHub'): PluginSettingField {
  return {
    key: 'repoRoots',
    label: 'Repo roots',
    description:
      `Folders searched (${REPO_SCAN_DEPTH} levels deep) for local clones of ${forge} projects, comma separated — ` +
      'e.g. ~/src, /Volumes/dev/git. Adds to the repos plugins such as axn-dev report.',
    type: 'string',
  };
}

/** Local checkouts for a forge plugin: providers + its own repo roots. */
export function forgeCheckouts(settings: { repoRoots?: unknown } | undefined): Promise<RepoCheckout[]> {
  const rt = appRuntime();
  if (!rt) return Promise.resolve([]);
  return localCheckouts(rt.exec, parseRepoRoots(settings?.repoRoots));
}

// ---------------------------------------------------------------------------
// The viewer's role on a merge/pull request
// ---------------------------------------------------------------------------

/**
 * How the viewer relates to an MR/PR — what dev-workflow's `when: { role }`
 * on a `kind: mr` var matches:
 * - `author`: you drive it — an assignee, or the creator while nobody is
 *   assigned (the "mine" list's rule, `mergeMine`)
 * - `reviewer`: a requested reviewer, or anyone on an MR nobody claimed yet
 *   (no assignee, no reviewer)
 * - `other`: someone else drives it and you are not a reviewer
 */
export type MrRole = 'author' | 'reviewer' | 'other';

export const MR_ROLES: readonly MrRole[] = ['author', 'reviewer', 'other'];

/** Who is on an MR/PR — usernames (GitLab) or logins (GitHub). */
export interface MrPeople {
  author: string;
  assignees: string[];
  /** Requested reviewers; for GitHub also those who already reviewed. */
  reviewers: string[];
}

/** `me`'s role on the MR; undefined when `me` is unknown. Case-insensitive. */
export function mrRole(people: MrPeople, me: string | undefined): MrRole | undefined {
  const self = me?.trim().toLowerCase();
  if (!self) return undefined;
  const is = (u: string) => u.trim().toLowerCase() === self;
  if (people.assignees.some(is)) return 'author';
  if (people.reviewers.some(is)) return 'reviewer';
  if (people.assignees.length === 0) {
    if (is(people.author)) return 'author';
    if (people.reviewers.length === 0) return 'reviewer';
  }
  return 'other';
}

/**
 * Splits fetched MRs/PRs by the viewer's role so each lands in one section:
 * `author` → mine, `reviewer` → review; `other` is dropped. `people` maps an
 * item to its `MrPeople` when the item's own fields are not the whole story.
 */
export function splitByRole<T extends { key: string } & MrPeople>(
  mine: T[],
  review: T[],
  me: string,
  people: (item: T) => MrPeople = (item) => item,
): { mine: T[]; review: T[] } {
  const byKey = new Map<string, T>();
  for (const item of [...mine, ...review]) byKey.set(item.key, item);
  const inRole = (role: MrRole) => [...byKey.values()].filter((m) => mrRole(people(m), me) === role);
  return { mine: inRole('author'), review: inRole('reviewer') };
}

export interface MrUrl {
  forge: Forge;
  /** Lowercased host. */
  host: string;
  /** `group/sub/project` (GitLab) or `owner/repo` (GitHub). */
  project: string;
  iid: number;
}

/** A GitLab MR or GitHub PR web URL; anything else yields undefined. */
export function parseMrUrl(url: string | undefined): MrUrl | undefined {
  const v = url?.trim() ?? '';
  const gl = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(v);
  if (gl) return { forge: 'gitlab', host: gl[1].toLowerCase(), project: gl[2], iid: Number(gl[3]) };
  const gh = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(v);
  if (gh) return { forge: 'github', host: gh[1].toLowerCase(), project: gh[2], iid: Number(gh[3]) };
  return undefined;
}

/** Cache key for one MR/PR: host, project and number — case-insensitive. */
export function mrKey(u: Pick<MrUrl, 'host' | 'project' | 'iid'>): string {
  return `${u.host.toLowerCase()}/${u.project.toLowerCase()}#${u.iid}`;
}
