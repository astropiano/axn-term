import { useEffect, useSyncExternalStore } from 'react';
import { appRuntime } from '../appRuntime';
import {
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  X,
  AlertTriangle,
  Check,
  GitPullRequestClosed,
} from 'lucide-react';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import { mrActionProviders, type MrRef, type MrRowEnv } from './mrActions';
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

interface RawPrListItem {
  number?: number;
  title?: string;
  isDraft?: boolean;
  url?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: unknown;
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
 * Unresolved-thread flag per PR number, one batched graphql call — `gh pr
 * list`/`view` don't expose reviewThreads (resolution is GraphQL-only) and
 * placeholders only substitute in `-F` values, so the numbers ride as
 * variables. On any failure the map stays empty → threads read as resolved.
 */
async function fetchThreadsResolved(
  ctx: SessionViewContext & PluginApi,
  root: string,
  numbers: number[],
): Promise<Map<number, boolean>> {
  const resolved = new Map<number, boolean>();
  if (numbers.length === 0) return resolved;
  try {
    const vars = numbers.map((_, i) => `$n${i}: Int!`).join(', ');
    const body = numbers
      .map(
        (_, i) =>
          `p${i}: pullRequest(number: $n${i}) { reviewThreads(first: 100) { nodes { isResolved } } }`,
      )
      .join(' ');
    const varArgs = numbers.map((n, i) => `-F n${i}=${n}`).join(' ');
    const query = `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${body} } }`;
    const out = await ctx.exec(
      `gh api graphql -F 'owner={owner}' -F 'name={repo}' ${varArgs} -f query=${JSON.stringify(query)}`,
      root,
    );
    const repo = (JSON.parse(out) as RawThreadsResponse).data?.repository ?? {};
    numbers.forEach((n, i) => {
      const nodes = repo[`p${i}`]?.reviewThreads?.nodes;
      if (nodes) resolved.set(n, nodes.every((t) => t.isResolved));
    });
  } catch {
    // gh missing/unauth'd/non-GitHub — threads read as resolved
  }
  return resolved;
}

async function refreshSessionPrs(ctx: SessionViewContext & PluginApi) {
  const session = ctx.getSession();
  const root = session.repo?.root;
  const branch = session.repo?.branch;
  const had =
    (((ctx.pluginState as { prs?: SessionPr[] } | undefined)?.prs?.length) ?? 0) > 0;
  if (!root || !branch) {
    if (had) ctx.updatePluginState({ prs: [] });
    return;
  }

  sessionLastFetch.set(session.id, Date.now());
  sessionLastKey.set(session.id, `${root}@${branch}`);

  let list: RawPrListItem[];
  try {
    const out = await ctx.exec(
      `gh pr list --head ${JSON.stringify(branch)} --json number,title,url,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup -L 10`,
      root,
    );
    const parsed = JSON.parse(out || '[]') as unknown;
    list = Array.isArray(parsed) ? (parsed as RawPrListItem[]) : [];
  } catch {
    // gh missing, not authenticated, or the repo is not on GitHub — leave
    // the previous state untouched.
    return;
  }

  // Review threads come from one batched graphql call (list/view JSON
  // doesn't carry them; see fetchThreadsResolved).
  const top = list.slice(0, 5);
  const threadsResolved = await fetchThreadsResolved(
    ctx,
    root,
    top.map((i) => i.number ?? 0).filter(Boolean),
  );
  const prs = top.map(
    (item): SessionPr => ({
      number: item.number ?? 0,
      reference: `#${item.number}`,
      title: item.title ?? '',
      url: item.url ?? '',
      draft: item.isDraft ?? false,
      conflicts: item.mergeable === 'CONFLICTING',
      discussionsResolved: threadsResolved.get(item.number ?? 0) ?? true,
      mergeStatus: (item.mergeStateStatus ?? '').toLowerCase(),
      checks: rollupStatus(item.statusCheckRollup),
      reviewDecision: (item.reviewDecision ?? '').toLowerCase(),
    }),
  );

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
// PR overview — `gh api graphql` search for assigned/authored/review PRs
// ---------------------------------------------------------------------------

const PR_FRAGMENT = `... on PullRequest { number title url isDraft mergeable headRefName baseRefName updatedAt reviewDecision author { login } assignees(first: 20) { nodes { login } } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } reviewThreads(first: 100) { nodes { isResolved comments(first: 50) { nodes { author { login } } } } } reviews(last: 30, states: APPROVED) { nodes { author { login } } } }`;

const PR_OVERVIEW_QUERY = `query {
  viewer { login }
  assigned: search(type: ISSUE, first: 40, query: "is:pr is:open assignee:@me") { nodes { ${PR_FRAGMENT} } }
  authored: search(type: ISSUE, first: 40, query: "is:pr is:open author:@me") { nodes { ${PR_FRAGMENT} } }
  review: search(type: ISSUE, first: 40, query: "is:pr is:open review-requested:@me") { nodes { ${PR_FRAGMENT} } }
}`;

export interface PrOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
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

export function refreshPrOverview(settings?: {
  hostname?: unknown;
}): Promise<void> {
  refreshInFlight ??= (async () => {
    setOverview({ ...overview, status: 'loading' });
    try {
      const hostname =
        typeof settings?.hostname === 'string' && settings.hostname
          ? ` --hostname ${JSON.stringify(settings.hostname)}`
          : '';
      // plugin_exec runs `sh -c`: collapse the query to one line so the
      // double-quoted argument carries no literal newlines.
      const query = PR_OVERVIEW_QUERY.replace(/\s+/g, ' ');
      const rt = appRuntime();
      if (!rt) throw new Error('no session available for gh');
      const out = await rt.exec(
        `gh api graphql${hostname} -f query=${JSON.stringify(query)}`,
      );
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
        username: user.login ?? '',
        mine: mergeMine(nodes(parsed.data?.assigned), nodes(parsed.data?.authored)),
        review: nodes(parsed.data?.review),
        fetchedAt: Date.now(),
      });
    } catch (e) {
      setOverview({
        ...overview,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
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
  success: 'text-emerald-500',
  failed: 'text-red-500',
  pending: 'text-yellow-500',
  running: 'text-blue-500',
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
        {prs.map((pr) => (
          <div key={pr.number} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="truncate font-semibold text-[var(--accent)] hover:underline"
                data-tip={pr.title}
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
                <span className="rounded bg-red-500/20 px-1 text-red-600">conflicts</span>
              )}
              {pr.reviewDecision === 'changes_requested' && (
                <span className="flex items-center gap-0.5 text-red-500">
                  <GitPullRequestClosed className="h-3 w-3" />
                  changes requested
                </span>
              )}
              {!pr.discussionsResolved && (
                <span className="flex items-center gap-0.5 text-[var(--orange)]">
                  <MessageSquare className="h-3 w-3" />
                  open threads
                </span>
              )}
              {pr.checks && <ChecksChip status={pr.checks} />}
            </div>
          </div>
        ))}
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
}: {
  pluginSettings: unknown;
  viewActive: boolean;
  toggleView: () => void;
}) {
  const data = usePrOverview();
  const settings = pluginSettings as
    | { hostname?: string; refreshIntervalSeconds?: number }
    | undefined;
  const intervalSec = settings?.refreshIntervalSeconds ?? 120;

  useEffect(() => {
    void refreshPrOverview(settings);
    const timer = window.setInterval(
      () => void refreshPrOverview(settings),
      Math.max(15, intervalSec) * 1000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalSec, settings?.hostname]);

  const me = data.username ?? '';
  const mineAction = data.mine.filter((m) => prNeedsAction(m)).length;
  const reviewWaiting = data.review.filter((m) => mrWaitingForMe(m, me)).length;

  const title =
    data.status === 'error'
      ? `pull requests unavailable\ngh: ${data.error ?? 'unknown error'}\nCheck \`gh auth status\` in a shell.`
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
      <GitPullRequest className="h-3.5 w-3.5" />
      {data.status === 'error' ? (
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
              reviewWaiting > 0 ? 'text-cyan-500' : ''
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
    <span className="flex shrink-0 items-center gap-0.5 pr-1">
      {providers.map((Provider, i) => (
        <Provider key={i} mr={pr} env={env} />
      ))}
    </span>
  );
}

function PrRow({ pr, badge, env }: { pr: GhPrItem; badge?: string; env: MrRowEnv }) {
  const threads = openThreads(pr);
  return (
    <div className="flex items-center gap-1">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface)]"
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
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-red-500">
            <AlertTriangle className="h-3 w-3" />
            conflicts
          </span>
        )}
        {pr.reviewDecision === 'changes_requested' && (
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-red-500">
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
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-emerald-500">
            <Check className="h-3 w-3" />
            approved
          </span>
        )}
      </a>
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
}: {
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
            <PrRow key={pr.key} pr={pr} badge={marker?.(pr) ?? undefined} env={env} />
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

function GhPrView({ close, env }: { close: () => void; env: MrRowEnv }) {
  const data = usePrOverview();
  const me = data.username ?? '';

  useEffect(() => {
    if (data.status === 'idle') void refreshPrOverview();
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
        <button
          type="button"
          onClick={() => void refreshPrOverview()}
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
        {data.status === 'error' ? (
          <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold text-red-500">failed to load pull requests</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            <div className="text-[var(--text-secondary)]">
              Check <code className="text-[var(--accent)]">gh auth status</code> in a shell.
            </div>
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
            />
            <PrSection
              title="review requested"
              prs={review}
              count={reviewWaiting}
              total={review.length}
              marker={(m) => (mrWaitingForMe(m, me) ? 'waiting' : null)}
              env={env}
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
  title: 'pull requests',
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
      key: 'hostname',
      label: 'GitHub hostname (GHES)',
      description: 'Overrides the gh api --hostname default.',
      type: 'string',
    },
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
        data-tip={prs.map((m) => `${m.reference} ${m.title}`).join('\n')}
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
  renderRail: ({ pluginSettings, viewActive, toggleView }) => (
    <GhPrRail
      pluginSettings={pluginSettings}
      viewActive={viewActive}
      toggleView={toggleView}
    />
  ),
  renderView: ({ close, sessions, workspaces, selectSession, sessionApi }) => (
    <GhPrView
      close={close}
      env={{ sessions, workspaces, apiFor: sessionApi, selectSession }}
    />
  ),
};
