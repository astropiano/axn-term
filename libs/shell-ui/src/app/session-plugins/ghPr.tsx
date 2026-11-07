import { useEffect, useRef, useSyncExternalStore } from 'react';
import { appRuntime } from '../appRuntime';
import {
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Text,
  X,
  AlertTriangle,
  Check,
  GitPullRequestClosed,
} from 'lucide-react';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import type { ShellSession, SessionAttention} from '../../types';
import { sessionLastSelectedAt } from '../attention';
import { getSessionViewPlugins, isPluginEnabled } from './index';
import { PluginIcon } from '../SessionPanel';
import type { PluginSettings } from '../pluginSettings';
import { mrActionProviders, type MrRef, type MrRowEnv } from './mrActions';
import { MrDescription } from './mrDescription';
import { shellQuote } from '../../shellQuote';
import {
  authCommand,
  authStatusHint,
  defaultHostNote,
  classifyCliError,
  compactCliError,
  forgeCheckouts,
  forgeCliCommand,
  forgeHost,
  forgeOfRemote,
  forgeRailMode,
  remoteOwner,
  repoRootsSetting,
  type CliFailure,
} from './forge';
import {
  mergeMine,
  mrNeedsAction,
  mrWaitingForMe,
  openThreads,
  type GlabMrItem,
} from './glabMr';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * An open pull request as tracked by the gh-pr plugin. Same model fields as
 * the GitLab side (so the shared classification helpers apply verbatim) plus
 * GitHub's reviewDecision — CHANGES_REQUESTED carries its own "needs action"
 * signal that GitLab folds into open threads.
 */
export type GhPrItem = GlabMrItem & {
  /** Lowercased PullRequestReviewDecision (approved|changes_requested|review_required|''). */
  reviewDecision: string;
};

/** Per-session PR summary stored in pluginState (`gh-pr.prs`). */
interface SessionPr {
  number: number;
  /** e.g. `#75` */
  reference: string;
  title: string;
  url: string;
  draft: boolean;
  conflicts: boolean;
  /** true when no resolvable review thread is left open. */
  discussionsResolved: boolean;
  /** Unresolved review threads; absent when the threads fetch failed. */
  openThreads?: number;
  /** mergeStateStatus, lowercased (e.g. `clean`, `blocked`, `behind`). */
  mergeStatus: string;
  /** Aggregated statusCheckRollup, lowercased; null when no checks exist. */
  checks: string | null;
  reviewDecision: string;
}

// ---------------------------------------------------------------------------
// Classification helpers (pure — unit tested)
// ---------------------------------------------------------------------------

/**
 * "Needs action" for a PR I own: the GitLab rules plus CHANGES_REQUESTED,
 * which GitHub reports as a review decision rather than a thread flag.
 */
export function prNeedsAction(pr: Pick<GhPrItem, 'conflicts' | 'approved' | 'pipeline' | 'discussions' | 'reviewDecision'>): boolean {
  return pr.reviewDecision === 'changes_requested' || mrNeedsAction(pr);
}

/**
 * Aggregate a gh statusCheckRollup / GraphQL rollup state into the pipeline
 * vocabulary used by the shared chips (success|failed|pending|null).
 */
export function rollupStatus(raw: unknown): string | null {
  const states: string[] = [];
  if (Array.isArray(raw)) {
    // `gh pr list --json statusCheckRollup` — mixed CheckRun/StatusContext.
    for (const c of raw as Record<string, unknown>[]) {
      const s = String(c?.conclusion ?? c?.status ?? c?.state ?? '').toUpperCase();
      if (s) states.push(s);
    }
  } else if (typeof raw === 'string' && raw) {
    // GraphQL commits{statusCheckRollup{state}} — a single rollup enum.
    states.push(raw.toUpperCase());
  }
  if (states.length === 0) return null;
  if (states.some((s) => ['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)))
    return 'failed';
  if (states.some((s) => ['CANCELLED', 'CANCELED'].includes(s))) return 'canceled';
  if (states.some((s) => ['PENDING', 'EXPECTED', 'QUEUED', 'WAITING', 'REQUESTED', 'IN_PROGRESS'].includes(s)))
    return 'pending';
  return 'success';
}

// ---------------------------------------------------------------------------
// Session PRs — `gh pr list` in the session's repo
// ---------------------------------------------------------------------------

const PR_REFRESH_DELAY_MS = 1200;
const PR_STALE_MS = 300_000;
const sessionTimers = new Map<string, number>();
const sessionLastFetch = new Map<string, number>();
const sessionLastKey = new Map<string, string>();

export interface RawPrListItem {
  number?: number;
  title?: string;
  isDraft?: boolean;
  url?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: unknown;
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login?: string } | null;
}

const PR_LIST_FIELDS =
  'number,title,url,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,isCrossRepository,headRepositoryOwner';

/** `gh pr list` for the PRs whose head is `branch` (branch single-quoted: git allows `$(…)` in names). */
export function prListCommand(branch: string): string {
  return forgeCliCommand('gh', `pr list --head ${shellQuote(branch)} --json ${PR_LIST_FIELDS} -L 10`);
}

/**
 * `gh pr list --head <branch>` matches the branch *name* in any fork, so a
 * session on `main` of a popular repo would pick up strangers' fork PRs
 * whose branch is also called `main`. Keep same-repo PRs, and fork PRs only
 * when the head fork belongs to one of `owners` (the owners of the remotes
 * this checkout pushes to). Owners compare case-insensitively.
 */
export function ownPrs(list: RawPrListItem[], owners: Iterable<string>): RawPrListItem[] {
  const allowed = new Set([...owners].map((o) => o.toLowerCase()));
  return list.filter(
    (item) =>
      !item.isCrossRepository ||
      allowed.has((item.headRepositoryOwner?.login ?? '').toLowerCase()),
  );
}

/**
 * Owners of the remotes the session's branch can be pushed to: origin
 * (`repo.remote`) plus the branch's own tracking/push remote (a fork remote
 * in a triangular workflow). Only resolved when a fork PR needs checking.
 */
async function pushOwners(
  ctx: SessionViewContext & PluginApi,
  root: string,
  branch: string,
  origin: string | undefined,
): Promise<string[]> {
  const owners = [remoteOwner(origin)];
  const b = shellQuote(`branch.${branch}`);
  try {
    const url = await ctx.exec(
      `r=$(git config --get ${b}.pushRemote || git config --get remote.pushDefault || git config --get ${b}.remote) && git remote get-url "$r"`,
      root,
    );
    owners.push(remoteOwner(url));
  } catch {
    // no tracking remote — origin only
  }
  return owners.filter((o): o is string => !!o);
}

interface RawThreadsResponse {
  data?: {
    repository?: Record<
      string,
      { reviewThreads?: { nodes?: { isResolved?: boolean }[] } } | null
    >;
  };
}

/**
 * The batched review-threads query for `numbers`. The query is single-quoted:
 * it is full of GraphQL `$variables`, which `sh` would expand (to nothing)
 * inside double quotes.
 */
export function threadsCommand(numbers: number[]): string {
  const vars = numbers.map((_, i) => `$n${i}: Int!`).join(', ');
  const body = numbers
    .map(
      (_, i) =>
        `p${i}: pullRequest(number: $n${i}) { reviewThreads(first: 100) { nodes { isResolved } } }`,
    )
    .join(' ');
  const varArgs = numbers.map((n, i) => `-F n${i}=${Math.trunc(n)}`).join(' ');
  const query = `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${body} } }`;
  return forgeCliCommand(
    'gh',
    `api graphql -F 'owner={owner}' -F 'name={repo}' ${varArgs} -f query=${shellQuote(query)}`,
  );
}

/**
 * Unresolved-thread count per PR number, one batched graphql call — `gh pr
 * list`/`view` don't expose reviewThreads (resolution is GraphQL-only) and
 * placeholders only substitute in `-F` values, so the numbers ride as
 * variables. On any failure the map stays empty → threads read as resolved.
 */
async function fetchOpenThreads(
  ctx: SessionViewContext & PluginApi,
  root: string,
  numbers: number[],
): Promise<Map<number, number>> {
  const open = new Map<number, number>();
  if (numbers.length === 0) return open;
  try {
    const out = await ctx.exec(threadsCommand(numbers), root);
    const repo = (JSON.parse(out) as RawThreadsResponse).data?.repository ?? {};
    numbers.forEach((n, i) => {
      const nodes = repo[`p${i}`]?.reviewThreads?.nodes;
      if (nodes) open.set(n, nodes.filter((t) => !t.isResolved).length);
    });
  } catch {
    // gh missing/unauth'd/non-GitHub — threads read as resolved
  }
  return open;
}

async function refreshSessionPrs(ctx: SessionViewContext & PluginApi) {
  const session = ctx.getSession();
  const root = session.repo?.root;
  const branch = session.repo?.branch;
  const had =
    (((ctx.pluginState as { prs?: SessionPr[] } | undefined)?.prs?.length) ?? 0) > 0;
  const hostname = (ctx.pluginSettings as { hostname?: unknown } | undefined)?.hostname;
  // A repo on GitLab is glab-mr's — don't spawn gh for it on every refresh.
  if (!root || !branch || forgeOfRemote(session.repo?.remote, { github: hostname }) === 'gitlab') {
    if (had) ctx.updatePluginState({ prs: [] });
    return;
  }

  sessionLastFetch.set(session.id, Date.now());
  sessionLastKey.set(session.id, `${root}@${branch}`);

  let list: RawPrListItem[];
  try {
    const out = await ctx.exec(prListCommand(branch), root);
    const parsed = JSON.parse(out || '[]') as unknown;
    list = Array.isArray(parsed) ? (parsed as RawPrListItem[]) : [];
  } catch {
    // gh missing, not authenticated, or the repo is not on GitHub — leave
    // the previous state untouched.
    return;
  }
  if (list.some((item) => item.isCrossRepository)) {
    list = ownPrs(list, await pushOwners(ctx, root, branch, session.repo?.remote));
  }

  // Review threads come from one batched graphql call (list/view JSON
  // doesn't carry them; see fetchOpenThreads).
  const top = list.slice(0, 5);
  const openThreadCounts = await fetchOpenThreads(
    ctx,
    root,
    top.map((i) => i.number ?? 0).filter(Boolean),
  );
  const prs = top.map((item): SessionPr => {
    const openThreads = openThreadCounts.get(item.number ?? 0);
    return {
      number: item.number ?? 0,
      reference: `#${item.number}`,
      title: item.title ?? '',
      url: item.url ?? '',
      draft: item.isDraft ?? false,
      conflicts: item.mergeable === 'CONFLICTING',
      discussionsResolved: openThreads === undefined ? true : openThreads === 0,
      openThreads,
      mergeStatus: (item.mergeStateStatus ?? '').toLowerCase(),
      checks: rollupStatus(item.statusCheckRollup),
      reviewDecision: (item.reviewDecision ?? '').toLowerCase(),
    };
  });

  ctx.updatePluginState({ prs });
}

function scheduleSessionRefresh(
  ctx: SessionViewContext & PluginApi,
  immediate = false,
) {
  const id = ctx.session.id;
  const existing = sessionTimers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  sessionTimers.set(
    id,
    window.setTimeout(
      () => {
        sessionTimers.delete(id);
        const session = ctx.getSession();
        const root = session.repo?.root;
        const branch = session.repo?.branch;
        const key = root && branch ? `${root}@${branch}` : '';
        const stale = Date.now() - (sessionLastFetch.get(id) ?? 0) > PR_STALE_MS;
        if (key !== sessionLastKey.get(id) || stale) {
          void refreshSessionPrs(ctx);
        }
      },
      immediate ? 0 : PR_REFRESH_DELAY_MS,
    ),
  );
}

// ---------------------------------------------------------------------------
// PR watch (opt-in) — attention on sessions whose tracked PR changed
// ---------------------------------------------------------------------------

/** Per session-PR snapshot, persisted in appState.prWatch. */
interface PrWatchEntry {
  pipeline: string | null;
  unresolved: number;
  notes: number;
  /** Why attention was raised — cleared once the session is viewed. */
  flag?: string;
  flagAt?: number;
}

function overviewWatchEntry(pr: GhPrItem): PrWatchEntry {
  return {
    pipeline: pr.pipeline,
    unresolved: openThreads(pr),
    notes: pr.discussions.reduce((n, d) => n + d.notes.length, 0),
  };
}

function raisePrWatch(
  api: SessionViewContext & PluginApi,
  entry: PrWatchEntry,
  message: string,
  critical = false,
  actions?: SessionAttention['actions'],
  data?: unknown,
) {
  api.setAttention({
    level: critical ? 'critical' : 'warning',
    message,
    actions,
    data,
  });
  entry.flag = message;
  entry.flagAt = Date.now();
}

/** "Go to session" buttons for every session with this PR checked out,
 * else a "create worktree" action when the worktrees plugin is enabled. */
function prWatchActions(
  pr: SessionPr,
  sessions: ShellSession[],
  api: SessionViewContext & PluginApi,
): SessionAttention['actions'] {
  const holders = sessions.filter((s) =>
    ((s.pluginState?.['gh-pr'] as { prs?: SessionPr[] } | undefined)?.prs ?? []).some(
      (m) => m.url === pr.url,
    ),
  );
  const actions: SessionAttention['actions'] = holders.map((s) => ({
    id: `goto-session:${s.id}`,
    label: `Go to ${s.name}`,
  }));
  const all = getSessionViewPlugins();
  const wt = all.find((p) => p.id === 'worktrees');
  if (
    holders.length === 0 &&
    wt &&
    isPluginEnabled(
      wt,
      (api.pluginSettings ?? {}) as PluginSettings,
      all,
    )
  ) {
    actions.push({
      id: 'worktrees:mr-worktree',
      label: `Create worktree for PR #${pr.number}`,
    });
  }
  return actions.length ? actions : undefined;
}

/**
 * Diff every session's tracked PRs (`pluginState gh-pr.prs`) against the
 * freshest data and flag the owning session when its PR regressed or gained
 * activity: checks -> failed, a new unresolved thread, or a new comment.
 * PRs covered by the overview poll cost nothing extra; the rest get one
 * light `gh pr view` call each. Runs from the rail after each overview
 * refresh.
 */
async function prWatchTick(args: {
  sessions: ShellSession[];
  data: PrOverview;
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  sessionApi: (id: string) => (SessionViewContext & PluginApi) | undefined;
}) {
  const watch = {
    ...((args.appState as { prWatch?: Record<string, PrWatchEntry> } | undefined)
      ?.prWatch ?? {}),
  };
  const overviewByUrl = new Map<string, GhPrItem>(
    [...args.data.mine, ...args.data.review].map((m) => [m.url, m]),
  );
  const seen = new Set<string>();
  for (const session of args.sessions) {
    const prs =
      (session.pluginState?.['gh-pr'] as { prs?: SessionPr[] } | undefined)
        ?.prs ?? [];
    const api = args.sessionApi(session.id);
    for (const pr of prs) {
      const key = `${session.id}|${pr.url}`;
      seen.add(key);
      const prev = watch[key];
      let entry: PrWatchEntry | undefined;
      const overview = overviewByUrl.get(pr.url);
      if (overview) {
        entry = overviewWatchEntry(overview);
      } else if (api && session.repo?.root) {
        // Not one of my overview PRs — one detail call per watched session PR.
        try {
          const d = JSON.parse(
            await api.exec(
              `gh pr view ${shellQuote(pr.url)} --json statusCheckRollup,reviewThreads,comments`,
              session.repo.root,
            ),
          ) as {
            statusCheckRollup?: unknown;
            reviewThreads?: { isResolved?: boolean }[];
            comments?: unknown[];
          };
          entry = {
            pipeline: rollupStatus(d.statusCheckRollup),
            unresolved: (d.reviewThreads ?? []).filter((t) => t.isResolved === false).length,
            notes: (d.comments ?? []).length,
          };
        } catch {
          continue;
        }
      } else {
        continue;
      }
      watch[key] = { ...entry, flag: prev?.flag, flagAt: prev?.flagAt };
      if (!api) continue;
      const e = watch[key];
      // Clear a raised flag once the session was viewed since.
      if (e.flag && sessionLastSelectedAt(session.id) > (e.flagAt ?? 0)) {
        api.setAttention(null);
        delete e.flag;
        delete e.flagAt;
      } else if (prev && !e.flag) {
        const actions = prWatchActions(pr, args.sessions, api);
        const data = { pr: { url: pr.url, reference: pr.reference, title: pr.title } };
        if (prev.pipeline !== 'failed' && entry.pipeline === 'failed')
          raisePrWatch(api, e, `checks failed on ${pr.reference}`, true, actions, data);
        else if (entry.unresolved > prev.unresolved)
          raisePrWatch(api, e, `new unresolved thread on ${pr.reference}`, false, actions, data);
        else if (entry.notes > prev.notes)
          raisePrWatch(api, e, `new comment on ${pr.reference}`, false, actions, data);
      }
    }
  }
  for (const key of Object.keys(watch)) if (!seen.has(key)) delete watch[key];
  args.updateAppState({ prWatch: watch });
}

// ---------------------------------------------------------------------------
// PR overview — `gh api graphql` search for assigned/authored/review PRs
// ---------------------------------------------------------------------------

// Sized for GitHub's 500,000-node query limit (3 searches × 40 PRs × 50
// threads × 20 comments ≈ 120k nodes; threads(100) × comments(50) was 620k
// and failed every refresh). `comments(last:)`: mrWaitingForMe looks at the
// newest note of a thread.
const PR_FRAGMENT = `... on PullRequest { number title bodyText url isDraft mergeable headRefName baseRefName updatedAt reviewDecision author { login } assignees(first: 20) { nodes { login } } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviewThreads(first: 50) { nodes { isResolved comments(last: 20) { nodes { author { login } } } } } reviews(last: 30, states: APPROVED) { nodes { author { login } } } }`;

const PR_OVERVIEW_QUERY = `query {
  viewer { login }
  assigned: search(type: ISSUE, first: 40, query: "is:pr is:open assignee:@me") { nodes { ${PR_FRAGMENT} } }
  authored: search(type: ISSUE, first: 40, query: "is:pr is:open author:@me") { nodes { ${PR_FRAGMENT} } }
  review: search(type: ISSUE, first: 40, query: "is:pr is:open review-requested:@me") { nodes { ${PR_FRAGMENT} } }
}`;

export interface PrOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Host the last refresh queried (`hostname` setting); `undefined` = the CLI's default host. */
  host?: string;
  error?: string;
  /** Why the last refresh failed; kept through `loading` so the rail doesn't flicker. */
  failure?: CliFailure;
  username?: string;
  /** Assigned to me, or authored by me with no assignee yet. */
  mine: GhPrItem[];
  /** PRs requesting my review. */
  review: GhPrItem[];
  fetchedAt?: number;
}

let overview: PrOverview = { status: 'idle', mine: [], review: [] };
const overviewListeners = new Set<() => void>();

function setOverview(next: PrOverview) {
  overview = next;
  for (const listener of overviewListeners) listener();
}

export function usePrOverview(): PrOverview {
  return useSyncExternalStore(
    (listener) => {
      overviewListeners.add(listener);
      return () => overviewListeners.delete(listener);
    },
    () => overview,
  );
}

interface RawGqlPr {
  number?: number;
  title?: string;
  bodyText?: string;
  url?: string;
  isDraft?: boolean;
  mergeable?: string;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  reviewDecision?: string | null;
  author?: { login?: string };
  assignees?: { nodes?: { login?: string }[] };
  reviewRequests?: { nodes?: { requestedReviewer?: { login?: string } | null }[] };
  repository?: { nameWithOwner?: string };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
  reviewThreads?: {
    nodes?: {
      isResolved?: boolean;
      comments?: { nodes?: { author?: { login?: string } | null }[] };
    }[];
  };
  reviews?: { nodes?: { author?: { login?: string } | null }[] };
}

const logins = (conn?: { nodes?: ({ login?: string } | null)[] }) =>
  (conn?.nodes ?? []).map((n) => n?.login ?? '').filter(Boolean);

export function normalizePr(raw: RawGqlPr): GhPrItem {
  const project = raw.repository?.nameWithOwner ?? '';
  const number = Number(raw.number ?? 0);
  const reviews = (raw.reviews?.nodes ?? [])
    .map((r) => r?.author?.login ?? '')
    .filter(Boolean);
  const rollup =
    raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    key: `${project}#${number}`,
    iid: number,
    reference: `#${number}`,
    title: raw.title ?? '',
    description: raw.bodyText ?? '',
    url: raw.url ?? '',
    project,
    sourceBranch: raw.headRefName ?? '',
    targetBranch: raw.baseRefName ?? '',
    draft: raw.isDraft ?? false,
    conflicts: raw.mergeable === 'CONFLICTING',
    mergeStatus: (raw.mergeable ?? '').toLowerCase(),
    pipeline: rollupStatus(rollup),
    approved: raw.reviewDecision === 'APPROVED',
    approvedBy: reviews,
    author: raw.author?.login ?? '',
    assignees: logins(raw.assignees),
    reviewers: (raw.reviewRequests?.nodes ?? [])
      .map((n) => n?.requestedReviewer?.login ?? '')
      .filter(Boolean),
    updatedAt: raw.updatedAt ?? '',
    discussions: (raw.reviewThreads?.nodes ?? []).map((t) => ({
      resolvable: true,
      resolved: t.isResolved ?? false,
      notes: (t.comments?.nodes ?? []).map((n) => n?.author?.login ?? ''),
    })),
    reviewDecision: (raw.reviewDecision ?? '').toLowerCase(),
  };
}

let refreshInFlight: Promise<void> | null = null;

/** The app-wide overview command (`--hostname` for GHES). */
export function overviewCommand(hostname?: unknown): string {
  const name = forgeHost(hostname);
  const host = name ? ` --hostname ${shellQuote(name)}` : '';
  // One line, single-quoted: no literal newlines or shell expansion inside.
  const query = PR_OVERVIEW_QUERY.replace(/\s+/g, ' ');
  return forgeCliCommand('gh', `api graphql${host} -f query=${shellQuote(query)}`);
}

/** The current overview snapshot (outside React). */
export function currentPrOverview(): PrOverview {
  return overview;
}

/** Test seam: drop the cached overview. */
export function resetPrOverview(): void {
  setOverview({ status: 'idle', mine: [], review: [] });
}

export function refreshPrOverview(settings?: {
  hostname?: unknown;
}): Promise<void> {
  refreshInFlight ??= (async () => {
    const host = forgeHost(settings?.hostname);
    setOverview({ ...overview, host, status: 'loading' });
    try {
      const rt = appRuntime();
      if (!rt) throw new Error('no session available for gh');
      const out = await rt.exec(overviewCommand(settings?.hostname));
      const parsed = JSON.parse(out) as {
        data?: {
          viewer?: { login?: string };
          assigned?: { nodes?: (RawGqlPr | null)[] };
          authored?: { nodes?: (RawGqlPr | null)[] };
          review?: { nodes?: (RawGqlPr | null)[] };
        };
        errors?: { message?: string }[];
      };
      if (parsed.errors?.length) {
        throw new Error(parsed.errors[0].message ?? 'graphql error');
      }
      const user = parsed.data?.viewer;
      if (!user) throw new Error('no viewer — run `gh auth login`');
      const nodes = (c?: { nodes?: (RawGqlPr | null)[] }) =>
        (c?.nodes ?? []).filter((n): n is RawGqlPr => !!n).map(normalizePr);
      setOverview({
        status: 'ready',
        host,
        username: user.login ?? '',
        mine: mergeMine(nodes(parsed.data?.assigned), nodes(parsed.data?.authored)),
        review: nodes(parsed.data?.review),
        fetchedAt: Date.now(),
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const error = compactCliError(raw);
      setOverview({
        ...overview,
        host,
        status: 'error',
        error,
        failure: classifyCliError('gh', raw),
      });
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const checksColor: Record<string, string> = {
  success: 'text-[var(--green)]',
  failed: 'text-[var(--red)]',
  pending: 'text-[var(--yellow)]',
  running: 'text-[var(--blue)]',
  canceled: 'text-[var(--text-secondary)]',
};

function ChecksChip({ status }: { status: string }) {
  return (
    <span className={`flex items-center gap-0.5 ${checksColor[status] ?? 'text-[var(--text-secondary)]'}`}>
      <span className="text-[8px]">●</span>
      {status === 'success' ? 'passed' : status}
    </span>
  );
}

function projectShort(nameWithOwner: string): string {
  const parts = nameWithOwner.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : nameWithOwner;
}

// ---------------------------------------------------------------------------
// Session view — PRs open on the session's current branch
// ---------------------------------------------------------------------------

function SessionPrs({ ctx }: { ctx: SessionViewContext & PluginApi }) {
  const state = ctx.pluginState as { prs?: SessionPr[] } | undefined;
  const prs = state?.prs ?? [];
  if (!ctx.session.repo?.branch || prs.length === 0) return null;
  // session-bound env: the session IS the PR's repo, its api drives the action
  const env: MrRowEnv = {
    sessions: [ctx.getSession()],
    workspaces: ctx.getWorkspaces?.() ?? [],
    apiFor: (id) => (id === ctx.session.id ? ctx : undefined),
    selectSession: () => {},
  };

  return (
    <div className="mb-2">
      <div className="flex flex-col gap-1 text-[10px]">
        {prs.map((pr) => {
          // `openThreads` is authoritative once fetched; snapshots without it
          // fall back to the boolean `discussionsResolved` chip.
          const threadLabel =
            pr.openThreads !== undefined
              ? pr.openThreads > 0
                ? `${pr.openThreads} open thread${pr.openThreads === 1 ? '' : 's'}`
                : null
              : pr.discussionsResolved
                ? null
                : 'open threads';
          return (
            <div key={pr.number} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-semibold text-[var(--accent)] hover:underline"
                  data-tip={`GitHub · ${pr.title}`}
                >
                  {pr.reference} {pr.title}
                </a>
                <PrActions
                  pr={{ iid: pr.number, reference: pr.reference, title: pr.title, url: pr.url }}
                  env={env}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {pr.draft && (
                  <span className="rounded bg-slate-500/20 px-1 text-slate-600">draft</span>
                )}
                {pr.conflicts && (
                  <span className="rounded bg-[color-mix(in_srgb,var(--red)_20%,transparent)] px-1 text-[var(--red)]">conflicts</span>
                )}
                {pr.reviewDecision === 'changes_requested' && (
                  <span className="flex items-center gap-0.5 text-[var(--red)]">
                    <GitPullRequestClosed className="h-3 w-3" />
                    changes requested
                  </span>
                )}
                {threadLabel && (
                  <span className="flex items-center gap-0.5 text-[var(--orange)]">
                    <MessageSquare className="h-3 w-3" />
                    {threadLabel}
                  </span>
                )}
                {pr.checks && <ChecksChip status={pr.checks} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail teaser — "mine x/y" + "review x/y"
// ---------------------------------------------------------------------------

function GhPrRail({
  pluginSettings,
  viewActive,
  toggleView,
  sessions,
  appState,
  updateAppState,
  sessionApi,
}: {
  pluginSettings: unknown;
  viewActive: boolean;
  toggleView: () => void;
  sessions: ShellSession[];
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  sessionApi: (id: string) => (SessionViewContext & PluginApi) | undefined;
}) {
  const data = usePrOverview();
  const settings = pluginSettings as
    | { hostname?: string; refreshIntervalSeconds?: number; watchPrChanges?: boolean }
    | undefined;
  const intervalSec = settings?.refreshIntervalSeconds ?? 120;
  const watchEnabled = settings?.watchPrChanges === true;

  useEffect(() => {
    void refreshPrOverview(settings);
    const timer = window.setInterval(
      () => void refreshPrOverview(settings),
      Math.max(15, intervalSec) * 1000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalSec, settings?.hostname]);

  // Latest ctx for the tick — the poll effect would otherwise close over a
  // stale sessions/appState snapshot from its mount render.
  const watchRef = useRef({ sessions, appState, sessionApi });
  watchRef.current = { sessions, appState, sessionApi };
  useEffect(() => {
    if (!watchEnabled || data.status !== 'ready') return;
    void prWatchTick({ ...watchRef.current, updateAppState, data });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, watchEnabled]);

  const me = data.username ?? '';
  const mineAction = data.mine.filter((m) => prNeedsAction(m)).length;
  const reviewWaiting = data.review.filter((m) => mrWaitingForMe(m, me)).length;
  const mode = forgeRailMode(data);
  // No gh (or nothing fetched yet): a GitLab-only user sees no GitHub icon.
  if (mode === 'hidden') return null;

  const title =
    mode === 'signed-out'
      ? `GitHub pull requests — not signed in.\nRun \`${authCommand('gh', 'login', data.host)}\` in a shell to see your PRs here.`
      : mode === 'error'
      ? `pull requests unavailable\ngh: ${data.error ?? 'unknown error'}\n${authStatusHint('gh', 'GitHub', data.host)}`
      : [
          `${mineAction}/${data.mine.length} assigned/authored PRs need action (open threads, conflicts, failing checks, changes requested or approved)`,
          `${reviewWaiting}/${data.review.length} review requests waiting for you`,
          data.status === 'loading' ? 'refreshing…' : null,
        ]
          .filter(Boolean)
          .join('\n');

  return (
    <button
      type="button"
      onClick={toggleView}
      data-tip={title}
      className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition ${
        viewActive
          ? 'bg-[var(--surface)] text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
      }`}
    >
      <PluginIcon
        plugin={ghPrPlugin}
        className={`h-3.5 w-3.5${mode === 'signed-out' ? ' opacity-50' : ''}`}
      />
      {mode === 'signed-out' ? null : mode === 'error' ? (
        <AlertTriangle className="h-3 w-3 text-[var(--red)]" />
      ) : (
        <>
          <span
            className={`select-none text-[8px] font-bold leading-none ${
              mineAction > 0 ? 'text-[var(--orange)]' : ''
            }`}
            data-tip="assigned / authored"
          >
            {mineAction}/{data.mine.length}
          </span>
          <span
            className={`select-none text-[8px] font-bold leading-none ${
              reviewWaiting > 0 ? 'text-[var(--cyan)]' : ''
            }`}
            data-tip="review requested"
          >
            {reviewWaiting}/{data.review.length}
          </span>
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Full plugin view — lists of my PRs and review requests
// ---------------------------------------------------------------------------

/**
 * Cross-plugin PR row actions (`mrActions.ts`) — e.g. dev-workflow's
 * 'review' button (it resolves `pull/<N>/head` for GitHub URLs already).
 */
function PrActions({ pr, env }: { pr: MrRef; env: MrRowEnv }) {
  const providers = mrActionProviders();
  if (providers.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5 pr-1 pt-1.5">
      {providers.map((Provider, i) => (
        <Provider key={i} mr={pr} env={env} />
      ))}
    </span>
  );
}

function PrRow({ pr, badge, env, showDescription = true }: { showDescription?: boolean; pr: GhPrItem; badge?: string; env: MrRowEnv }) {
  const threads = openThreads(pr);
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1 rounded px-2 py-1.5 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface)]">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2"
          data-tip={`${pr.project}\n${pr.sourceBranch} → ${pr.targetBranch}`}
        >
          <span className="shrink-0 font-semibold text-[var(--accent)]">{pr.reference}</span>
          <span className="max-w-44 shrink-0 truncate text-[var(--text-secondary)]">
            {projectShort(pr.project)}
          </span>
          <span className="min-w-0 flex-1 truncate">{pr.title}</span>
          {badge && (
            <span className="shrink-0 rounded bg-[var(--accent)]/15 px-1 text-[9px] font-semibold text-[var(--accent)]">
              {badge}
            </span>
          )}
          {pr.draft && (
            <span className="shrink-0 rounded bg-slate-500/20 px-1 text-[9px] text-slate-500">
              draft
            </span>
          )}
          {pr.conflicts && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--red)]">
              <AlertTriangle className="h-3 w-3" />
              conflicts
            </span>
          )}
          {pr.reviewDecision === 'changes_requested' && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--red)]">
              <GitPullRequestClosed className="h-3 w-3" />
              changes
            </span>
          )}
          {threads > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--orange)]">
              <MessageSquare className="h-3 w-3" />
              {threads}
            </span>
          )}
          {pr.pipeline && (
            <span className="shrink-0 text-[9px]">
              <ChecksChip status={pr.pipeline} />
            </span>
          )}
          {pr.approved && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--green)]">
              <Check className="h-3 w-3" />
              approved
            </span>
          )}
        </a>
        {showDescription && pr.description && <MrDescription markdown={pr.description} />}
      </div>
      <PrActions pr={pr} env={env} />
    </div>
  );
}

function PrSection({
  title,
  prs,
  count,
  total,
  marker,
  env,
  showDescriptions,
}: {
  showDescriptions: boolean;
  title: string;
  prs: GhPrItem[];
  count: number;
  total: number;
  /** Badge text for rows that need attention (e.g. `action`, `waiting`). */
  marker?: (pr: GhPrItem) => string | null;
  env: MrRowEnv;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline gap-2 px-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        <span>{title}</span>
        <span className={count > 0 ? 'font-semibold text-[var(--orange)]' : ''}>
          {count}/{total}
        </span>
      </div>
      {prs.length === 0 ? (
        <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">none</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {prs.map((pr) => (
            <PrRow key={pr.key} pr={pr} badge={marker?.(pr) ?? undefined} env={env} showDescription={showDescriptions} />
          ))}
        </div>
      )}
    </div>
  );
}

function sortMine(prs: GhPrItem[]): GhPrItem[] {
  return [...prs].sort(
    (a, b) =>
      Number(prNeedsAction(b)) - Number(prNeedsAction(a)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

function sortReview(prs: GhPrItem[], me: string): GhPrItem[] {
  return [...prs].sort(
    (a, b) =>
      Number(mrWaitingForMe(b, me)) - Number(mrWaitingForMe(a, me)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

function GhPrView({
  close,
  env,
  settings,
  showDescriptions = true,
  onToggleDescriptions,
}: {
  showDescriptions?: boolean;
  onToggleDescriptions?: () => void;
  close: () => void;
  env: MrRowEnv;
  /** The plugin's settings — carries `hostname`; without it the CLI queries its default host. */
  settings?: { hostname?: unknown };
}) {
  const data = usePrOverview();
  const me = data.username ?? '';

  useEffect(() => {
    if (data.status === 'idle') void refreshPrOverview(settings);
    // Warm local repo discovery so a review click finds the clone at once.
    void env.checkouts?.().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = sortMine(data.mine);
  const review = sortReview(data.review, me);
  const mineAction = mine.filter((m) => prNeedsAction(m)).length;
  const reviewWaiting = review.filter((m) => mrWaitingForMe(m, me)).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <GitPullRequest className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          pull requests
        </span>
        {data.fetchedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <div className="flex-1" />
        {onToggleDescriptions && (
          <button
            type="button"
            onClick={onToggleDescriptions}
            data-tip={showDescriptions ? 'Hide descriptions' : 'Show descriptions'}
            aria-label={showDescriptions ? 'Hide descriptions' : 'Show descriptions'}
            aria-pressed={showDescriptions}
            className={`flex h-6 w-6 items-center justify-center rounded transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)] ${
              showDescriptions ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] opacity-60'
            }`}
          >
            <Text className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void refreshPrOverview(settings)}
          data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${data.status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={close}
          data-tip="Close"
          aria-label="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.status === 'error' && data.failure !== 'error' ? (
          <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold">
              {data.failure === 'missing' ? 'GitHub CLI not installed' : 'Not signed in to GitHub'}
            </div>
            <div className="text-[var(--text-secondary)]">
              {data.failure === 'missing' ? (
                <>
                  Install <code className="text-[var(--accent)]">gh</code> (https://cli.github.com), then
                  run <code className="text-[var(--accent)]">{authCommand('gh', 'login', data.host)}</code>.
                </>
              ) : (
                <>
                  Run <code className="text-[var(--accent)]">{authCommand('gh', 'login', data.host)}</code> in a shell to see your
                  pull requests here.
                </>
              )}
            </div>
          </div>
        ) : data.status === 'error' ? (
          <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold text-[var(--red)]">failed to load pull requests</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            <div className="text-[var(--text-secondary)]">
              Check <code className="text-[var(--accent)]">{authCommand('gh', 'status', data.host)}</code> in a shell.
            </div>
            {!data.host && (
              <div className="mt-1 text-[var(--text-secondary)]">{defaultHostNote('gh', 'GitHub')}</div>
            )}
          </div>
        ) : (
          <>
            <PrSection
              title="assigned to me / authored without assignee"
              prs={mine}
              count={mineAction}
              total={mine.length}
              marker={(m) => (prNeedsAction(m) ? 'action' : null)}
              env={env}
              showDescriptions={showDescriptions}
            />
            <PrSection
              title="review requested"
              prs={review}
              count={reviewWaiting}
              total={review.length}
              marker={(m) => (mrWaitingForMe(m, me) ? 'waiting' : null)}
              env={env}
              showDescriptions={showDescriptions}
            />
            {data.status === 'loading' && (
              <div className="px-2 text-[10px] italic text-[var(--text-secondary)]">
                refreshing…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const ghPrPlugin: SessionViewPlugin = {
  id: 'gh-pr',
  title: 'GitHub pull requests',
  logo: 'GitPullRequest',
  version: '0.1.0',
  settings: [
    {
      key: 'showInPanel',
      label: 'Show pull requests in the session panel',
      description: 'Lists PRs for the session branch under the session.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'showInTitle',
      label: 'Show pull request in title',
      description: 'PR reference indicator in the session row.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (seconds)',
      description: 'How often the app-wide PR list is polled.',
      type: 'number',
      default: 120,
    },
    {
      key: 'watchPrChanges',
      label: 'Flag sessions on PR changes',
      description:
        'Attention dot on a session when its tracked pull request gets failed checks, a new thread or a new comment.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'hostname',
      label: 'GitHub hostname (GHES)',
      description: 'Overrides the gh api --hostname default.',
      type: 'string',
    },
    repoRootsSetting('GitHub'),
  ],
  onSessionOpen: (ctx) => {
    scheduleSessionRefresh(ctx, true);
  },
  onOutput: (ctx, text) => {
    if (!text) return;
    scheduleSessionRefresh(ctx);
  },
  onClose: (ctx) => {
    const timer = sessionTimers.get(ctx.session.id);
    if (timer !== undefined) window.clearTimeout(timer);
    sessionTimers.delete(ctx.session.id);
    sessionLastFetch.delete(ctx.session.id);
    sessionLastKey.delete(ctx.session.id);
  },
  render: (ctx) => {
    const settings = ctx.pluginSettings as
      | { showInPanel?: boolean; showInHeader?: boolean }
      | undefined;
    // `showInHeader` is the legacy key so existing plugins.yaml values apply.
    if ((settings?.showInPanel ?? settings?.showInHeader) === false) return null;
    return <SessionPrs ctx={ctx} />;
  },
  renderRow: (ctx) => {
    const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
    if (settings?.showInTitle === false) return null;
    const state = ctx.pluginState as { prs?: SessionPr[] } | undefined;
    const prs = state?.prs ?? [];
    if (prs.length === 0) return null;
    const first = prs[0];
    return (
      <a
        href={first.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        data-tip={['GitHub', ...prs.map((m) => `${m.reference} ${m.title}`)].join('\n')}
        className="flex shrink-0 items-center gap-0.5 font-mono text-[9px] leading-none text-[var(--accent)] hover:underline"
      >
        <GitPullRequest className="h-2.5 w-2.5" />
        {first.reference}
        {prs.length > 1 ? `+${prs.length - 1}` : ''}
      </a>
    );
  },
  rowTip: (ctx) => {
    const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
    if (settings?.showInTitle === false) return null;
    const prs =
      (ctx.pluginState as { prs?: SessionPr[] } | undefined)?.prs ?? [];
    if (prs.length === 0) return null;
    const first = prs[0];
    return `${first.reference}${prs.length > 1 ? ` +${prs.length - 1}` : ''}: open pull request${prs.length > 1 ? 's' : ''} on this branch — ${first.title}`;
  },
  renderRail: ({
    pluginSettings,
    viewActive,
    toggleView,
    sessions,
    appState,
    updateAppState,
    sessionApi,
  }) => (
    <GhPrRail
      pluginSettings={pluginSettings}
      viewActive={viewActive}
      toggleView={toggleView}
      sessions={sessions}
      appState={appState}
      updateAppState={updateAppState}
      sessionApi={sessionApi}
    />
  ),
  renderView: ({ pluginSettings, close, sessions, workspaces, selectSession, sessionApi, appState, updateAppState }) => (
    <GhPrView
      close={close}
      showDescriptions={(appState as { showDescriptions?: boolean } | undefined)?.showDescriptions !== false}
      onToggleDescriptions={() =>
        updateAppState({
          showDescriptions: (appState as { showDescriptions?: boolean } | undefined)?.showDescriptions === false,
        })
      }
      settings={pluginSettings as { hostname?: unknown } | undefined}
      env={{
        sessions,
        workspaces,
        apiFor: sessionApi,
        selectSession,
        checkouts: () => forgeCheckouts(pluginSettings as { repoRoots?: unknown } | undefined),
      }}
    />
  ),
};
