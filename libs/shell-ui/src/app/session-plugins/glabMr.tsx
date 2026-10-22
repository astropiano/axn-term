import { useEffect, useSyncExternalStore } from 'react';
import { appRuntime } from '../appRuntime';
import {
  GitMerge,
  MessageSquare,
  RefreshCw,
  X,
  AlertTriangle,
  Check,
} from 'lucide-react';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import { mrActionProviders, type MrRef, type MrRowEnv } from './mrActions';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** One resolvable discussion thread on an MR (GraphQL shape, normalized). */
export interface MrDiscussion {
  resolvable: boolean;
  resolved: boolean;
  /** Note authors in chronological order. */
  notes: string[];
}

/** An open merge request as tracked by the glab-mr plugin. */
export interface GlabMrItem {
  /** project fullPath + '!' + iid — unique across projects. */
  key: string;
  iid: number;
  /** e.g. `!75` */
  reference: string;
  title: string;
  url: string;
  /** e.g. `mygroup/dev/axn-dev-cli` */
  project: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  conflicts: boolean;
  /** detailed_merge_status, lowercased (e.g. `mergeable`, `ci_still_running`). */
  mergeStatus: string;
  /** head pipeline status, lowercased; null when no pipeline exists. */
  pipeline: string | null;
  /** Fully approved (all required approvals). */
  approved: boolean;
  /** usernames that approved. */
  approvedBy: string[];
  author: string;
  assignees: string[];
  reviewers: string[];
  updatedAt: string;
  discussions: MrDiscussion[];
}

/** Per-session MR summary stored in pluginState (`glab-mr.mrs`). */
interface SessionMr {
  iid: number;
  reference: string;
  title: string;
  url: string;
  draft: boolean;
  conflicts: boolean;
  discussionsResolved: boolean;
  mergeStatus: string;
  pipeline: string | null;
}

// ---------------------------------------------------------------------------
// Classification helpers (pure — unit tested)
// ---------------------------------------------------------------------------

/** Number of unresolved resolvable discussion threads. */
export function openThreads(mr: Pick<GlabMrItem, 'discussions'>): number {
  return mr.discussions.filter((d) => d.resolvable && !d.resolved).length;
}

/**
 * Unresolved threads I participate in — i.e. resolvable, unresolved
 * discussions that contain at least one note by `me`.
 */
export function myOpenThreads(
  mr: Pick<GlabMrItem, 'discussions'>,
  me: string,
): MrDiscussion[] {
  return mr.discussions.filter(
    (d) => d.resolvable && !d.resolved && d.notes.includes(me),
  );
}

/**
 * A thread I participate in got an answer: the last note in an unresolved
 * thread of mine is not mine.
 */
export function myThreadsAnswered(
  mr: Pick<GlabMrItem, 'discussions'>,
  me: string,
): boolean {
  return myOpenThreads(mr, me).some((d) => d.notes[d.notes.length - 1] !== me);
}

/**
 * "Needs action" for an MR I own (assignee, or author without assignee):
 * merge conflicts, open threads, already approved (ready to merge), or a
 * failing pipeline.
 */
export function mrNeedsAction(
  mr: Pick<GlabMrItem, 'conflicts' | 'approved' | 'pipeline' | 'discussions'>,
): boolean {
  return (
    mr.conflicts ||
    mr.approved ||
    mr.pipeline === 'failed' ||
    openThreads(mr) > 0
  );
}

/**
 * "Waiting for me" as a reviewer: I have not approved yet and either I have
 * left no open thread (fresh review), or a thread I posted has been answered.
 * When all my open threads end with my own note the ball is with the author.
 */
export function mrWaitingForMe(
  mr: Pick<GlabMrItem, 'approvedBy' | 'discussions'>,
  me: string,
): boolean {
  if (mr.approvedBy.includes(me)) return false;
  return myOpenThreads(mr, me).length === 0 || myThreadsAnswered(mr, me);
}

// ---------------------------------------------------------------------------
// Session MRs — `glab mr list` in the session's repo
// ---------------------------------------------------------------------------

const MR_REFRESH_DELAY_MS = 1200;
const MR_STALE_MS = 300_000;
const sessionTimers = new Map<string, number>();
const sessionLastFetch = new Map<string, number>();
const sessionLastKey = new Map<string, string>();

interface RawMrListItem {
  iid?: number;
  title?: string;
  draft?: boolean;
  web_url?: string;
  references?: { short?: string };
  blocking_discussions_resolved?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
}

interface RawMrDetail {
  head_pipeline?: { status?: string } | null;
}

async function refreshSessionMrs(ctx: SessionViewContext & PluginApi) {
  const session = ctx.getSession();
  const root = session.repo?.root;
  const branch = session.repo?.branch;
  const had =
    (((ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs?.length) ?? 0) > 0;
  if (!root || !branch) {
    if (had) ctx.updatePluginState({ mrs: [] });
    return;
  }

  sessionLastFetch.set(session.id, Date.now());
  sessionLastKey.set(session.id, `${root}@${branch}`);

  let list: RawMrListItem[];
  try {
    const out = await ctx.exec(
      `glab mr list -s ${JSON.stringify(branch)} -F json -P 10`,
      root,
    );
    const parsed = JSON.parse(out || '[]') as unknown;
    list = Array.isArray(parsed) ? (parsed as RawMrListItem[]) : [];
  } catch {
    // glab missing, not authenticated, or the repo is not on GitLab — leave
    // the previous state untouched.
    return;
  }

  // Per-MR detail adds the head pipeline status (absent from list output).
  const mrs = await Promise.all(
    list.slice(0, 5).map(async (item): Promise<SessionMr> => {
      let pipeline: string | null = null;
      try {
        const detail = await ctx.exec(
          `glab api "projects/:fullpath/merge_requests/${item.iid}"`,
          root,
        );
        const parsed = JSON.parse(detail) as RawMrDetail;
        pipeline = parsed.head_pipeline?.status?.toLowerCase() ?? null;
      } catch {
        // pipeline stays unknown
      }
      return {
        iid: item.iid ?? 0,
        reference: item.references?.short ?? `!${item.iid}`,
        title: item.title ?? '',
        url: item.web_url ?? '',
        draft: item.draft ?? false,
        conflicts: item.has_conflicts ?? false,
        discussionsResolved: item.blocking_discussions_resolved ?? true,
        mergeStatus: (item.detailed_merge_status ?? '').toLowerCase(),
        pipeline,
      };
    }),
  );

  ctx.updatePluginState({ mrs });
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
        const stale = Date.now() - (sessionLastFetch.get(id) ?? 0) > MR_STALE_MS;
        if (key !== sessionLastKey.get(id) || stale) {
          void refreshSessionMrs(ctx);
        }
      },
      immediate ? 0 : MR_REFRESH_DELAY_MS,
    ),
  );
}

// ---------------------------------------------------------------------------
// MR overview — `glab api graphql` for assigned/authored/review-requested MRs
// ---------------------------------------------------------------------------

const MR_OVERVIEW_QUERY = `query {
  currentUser {
    username
    assignedMergeRequests(state: opened, first: 40) { nodes { iid reference title webUrl draft conflicts detailedMergeStatus sourceBranch targetBranch updatedAt approved approvedBy { nodes { username } } author { username } assignees { nodes { username } } reviewers { nodes { username } } project { fullPath } headPipeline { status } discussions(first: 100) { nodes { resolvable resolved notes(first: 50) { nodes { author { username } } } } } } }
    authoredMergeRequests(state: opened, first: 40) { nodes { iid reference title webUrl draft conflicts detailedMergeStatus sourceBranch targetBranch updatedAt approved approvedBy { nodes { username } } author { username } assignees { nodes { username } } reviewers { nodes { username } } project { fullPath } headPipeline { status } discussions(first: 100) { nodes { resolvable resolved notes(first: 50) { nodes { author { username } } } } } } }
    reviewRequestedMergeRequests(state: opened, first: 40) { nodes { iid reference title webUrl draft conflicts detailedMergeStatus sourceBranch targetBranch updatedAt approved approvedBy { nodes { username } } author { username } assignees { nodes { username } } reviewers { nodes { username } } project { fullPath } headPipeline { status } discussions(first: 100) { nodes { resolvable resolved notes(first: 50) { nodes { author { username } } } } } } }
  }
}`;

export interface MrOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  username?: string;
  /** Assigned to me, or authored by me with no assignee yet. */
  mine: GlabMrItem[];
  /** MRs requesting my review. */
  review: GlabMrItem[];
  fetchedAt?: number;
}

let overview: MrOverview = { status: 'idle', mine: [], review: [] };
const overviewListeners = new Set<() => void>();

function setOverview(next: MrOverview) {
  overview = next;
  for (const listener of overviewListeners) listener();
}

export function useMrOverview(): MrOverview {
  return useSyncExternalStore(
    (listener) => {
      overviewListeners.add(listener);
      return () => overviewListeners.delete(listener);
    },
    () => overview,
  );
}

interface RawGqlMr {
  iid?: string;
  reference?: string;
  title?: string;
  webUrl?: string;
  draft?: boolean;
  conflicts?: boolean;
  detailedMergeStatus?: string;
  sourceBranch?: string;
  targetBranch?: string;
  updatedAt?: string;
  approved?: boolean;
  approvedBy?: { nodes?: { username?: string }[] };
  author?: { username?: string };
  assignees?: { nodes?: { username?: string }[] };
  reviewers?: { nodes?: { username?: string }[] };
  project?: { fullPath?: string };
  headPipeline?: { status?: string } | null;
  discussions?: {
    nodes?: {
      resolvable?: boolean;
      resolved?: boolean;
      notes?: { nodes?: { author?: { username?: string } }[] };
    }[];
  };
}

const usernames = (conn?: { nodes?: { username?: string }[] }) =>
  (conn?.nodes ?? []).map((n) => n.username ?? '').filter(Boolean);

function normalizeMr(raw: RawGqlMr): GlabMrItem {
  const project = raw.project?.fullPath ?? '';
  const iid = Number(raw.iid ?? 0);
  return {
    key: `${project}!${iid}`,
    iid,
    reference: raw.reference ?? `!${iid}`,
    title: raw.title ?? '',
    url: raw.webUrl ?? '',
    project,
    sourceBranch: raw.sourceBranch ?? '',
    targetBranch: raw.targetBranch ?? '',
    draft: raw.draft ?? false,
    conflicts: raw.conflicts ?? false,
    mergeStatus: (raw.detailedMergeStatus ?? '').toLowerCase(),
    pipeline: raw.headPipeline?.status?.toLowerCase() ?? null,
    approved: raw.approved ?? false,
    approvedBy: usernames(raw.approvedBy),
    author: raw.author?.username ?? '',
    assignees: usernames(raw.assignees),
    reviewers: usernames(raw.reviewers),
    updatedAt: raw.updatedAt ?? '',
    discussions: (raw.discussions?.nodes ?? []).map((d) => ({
      resolvable: d.resolvable ?? false,
      resolved: d.resolved ?? false,
      notes: (d.notes?.nodes ?? []).map((n) => n.author?.username ?? ''),
    })),
  };
}

/** Mine = assigned to me ∪ authored by me with no assignee (deduped). */
export function mergeMine<T extends GlabMrItem>(
  assigned: T[],
  authored: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const mr of assigned) byKey.set(mr.key, mr);
  for (const mr of authored) {
    if (mr.assignees.length === 0) byKey.set(mr.key, mr);
  }
  return [...byKey.values()];
}

let refreshInFlight: Promise<void> | null = null;

const EXEC_TRUNCATED_MARKER = '[axn-term: output truncated';

/** Auth hint only fits errors glab itself raised, not output-size ones. */
const isAuthHintRelevant = (error?: string) =>
  !(error ?? '').startsWith('glab output too large');

export function refreshMrOverview(settings?: {
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
      const query = MR_OVERVIEW_QUERY.replace(/\s+/g, ' ');
      const rt = appRuntime();
      if (!rt) throw new Error('no session available for glab');
      const out = await rt.exec(
        `glab api graphql${hostname} -f query=${JSON.stringify(query)}`,
      );
      // plugin_exec caps output and appends a marker; JSON.parse would only
      // report "Expected '}'" — name the real cause instead.
      if (out.includes(EXEC_TRUNCATED_MARKER)) {
        throw new Error(`glab output too large: ${out.slice(out.lastIndexOf('[axn-term:'))}`);
      }
      const parsed = JSON.parse(out) as {
        data?: {
          currentUser?: {
            username?: string;
            assignedMergeRequests?: { nodes?: RawGqlMr[] };
            authoredMergeRequests?: { nodes?: RawGqlMr[] };
            reviewRequestedMergeRequests?: { nodes?: RawGqlMr[] };
          };
        };
        errors?: { message?: string }[];
      };
      if (parsed.errors?.length) {
        throw new Error(parsed.errors[0].message ?? 'graphql error');
      }
      const user = parsed.data?.currentUser;
      if (!user) throw new Error('no currentUser — run `glab auth login`');
      const assigned = (user.assignedMergeRequests?.nodes ?? []).map(normalizeMr);
      const authored = (user.authoredMergeRequests?.nodes ?? []).map(normalizeMr);
      const review = (user.reviewRequestedMergeRequests?.nodes ?? []).map(normalizeMr);
      setOverview({
        status: 'ready',
        username: user.username ?? '',
        mine: mergeMine(assigned, authored),
        review,
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

const pipelineColor: Record<string, string> = {
  success: 'text-emerald-500',
  failed: 'text-red-500',
  running: 'text-blue-500',
  pending: 'text-yellow-500',
  canceled: 'text-[var(--text-secondary)]',
};

function PipelineChip({ status }: { status: string }) {
  return (
    <span className={`flex items-center gap-0.5 ${pipelineColor[status] ?? 'text-[var(--text-secondary)]'}`}>
      <span className="text-[8px]">●</span>
      {status === 'success' ? 'passed' : status}
    </span>
  );
}

function projectShort(fullPath: string): string {
  const parts = fullPath.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : fullPath;
}

// ---------------------------------------------------------------------------
// Session view — MRs open on the session's current branch
// ---------------------------------------------------------------------------

function SessionMrs({ ctx }: { ctx: SessionViewContext & PluginApi }) {
  const state = ctx.pluginState as { mrs?: SessionMr[] } | undefined;
  const mrs = state?.mrs ?? [];
  if (!ctx.session.repo?.branch || mrs.length === 0) return null;
  // session-bound env: the session IS the MR's repo, its api drives the action
  const env: MrRowEnv = {
    sessions: [ctx.getSession()],
    workspaces: ctx.getWorkspaces?.() ?? [],
    apiFor: (id) => (id === ctx.session.id ? ctx : undefined),
    selectSession: () => {},
  };

  return (
    <div className="mb-2">
      <div className="flex flex-col gap-1 text-[10px]">
        {mrs.map((mr) => (
          <div key={mr.iid} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <a
                href={mr.url}
                target="_blank"
                rel="noreferrer"
                className="truncate font-semibold text-[var(--accent)] hover:underline"
                data-tip={mr.title}
              >
                {mr.reference} {mr.title}
              </a>
              <MrActions mr={mr} env={env} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mr.draft && (
                <span className="rounded bg-slate-500/20 px-1 text-slate-600">draft</span>
              )}
              {mr.conflicts && (
                <span className="rounded bg-red-500/20 px-1 text-red-600">conflicts</span>
              )}
              {!mr.discussionsResolved && (
                <span className="flex items-center gap-0.5 text-[var(--orange)]">
                  <MessageSquare className="h-3 w-3" />
                  open threads
                </span>
              )}
              {mr.pipeline && <PipelineChip status={mr.pipeline} />}
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

function GlabMrRail({
  pluginSettings,
  viewActive,
  toggleView,
}: {
  pluginSettings: unknown;
  viewActive: boolean;
  toggleView: () => void;
}) {
  const data = useMrOverview();
  const settings = pluginSettings as
    | { hostname?: string; refreshIntervalSeconds?: number }
    | undefined;
  const intervalSec = settings?.refreshIntervalSeconds ?? 120;

  useEffect(() => {
    void refreshMrOverview(settings);
    const timer = window.setInterval(
      () => void refreshMrOverview(settings),
      Math.max(15, intervalSec) * 1000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalSec, settings?.hostname]);

  const me = data.username ?? '';
  const mineAction = data.mine.filter((m) => mrNeedsAction(m)).length;
  const reviewWaiting = data.review.filter((m) => mrWaitingForMe(m, me)).length;

  const title =
    data.status === 'error'
      ? `merge requests unavailable\nglab: ${data.error ?? 'unknown error'}${isAuthHintRelevant(data.error) ? '\nCheck `glab auth status` in a shell.' : ''}`
      : [
          `${mineAction}/${data.mine.length} assigned/authored MRs need action (open threads, conflicts, failing pipeline or approved)`,
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
      <GitMerge className="h-3.5 w-3.5" />
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
// Full plugin view — lists of my MRs and review requests
// ---------------------------------------------------------------------------

/**
 * Cross-plugin MR row actions (`mrActions.ts`) — e.g. dev-workflow's
 * 'review' button that opens a worktree session bound to a review workflow.
 */
function MrActions({ mr, env }: { mr: MrRef; env: MrRowEnv }) {
  const providers = mrActionProviders();
  if (providers.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5 pr-1">
      {providers.map((Provider, i) => (
        <Provider key={i} mr={mr} env={env} />
      ))}
    </span>
  );
}

function MrRow({ mr, badge, env }: { mr: GlabMrItem; badge?: string; env: MrRowEnv }) {
  const threads = openThreads(mr);
  return (
    <div className="flex items-center gap-1">
      <a
        href={mr.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface)]"
        data-tip={`${mr.project}\n${mr.sourceBranch} → ${mr.targetBranch}`}
      >
        <span className="shrink-0 font-semibold text-[var(--accent)]">{mr.reference}</span>
        <span className="max-w-44 shrink-0 truncate text-[var(--text-secondary)]">
          {projectShort(mr.project)}
        </span>
        <span className="min-w-0 flex-1 truncate">{mr.title}</span>
        {badge && (
          <span className="shrink-0 rounded bg-[var(--accent)]/15 px-1 text-[9px] font-semibold text-[var(--accent)]">
            {badge}
          </span>
        )}
        {mr.draft && (
          <span className="shrink-0 rounded bg-slate-500/20 px-1 text-[9px] text-slate-500">
            draft
          </span>
        )}
        {mr.conflicts && (
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-red-500">
            <AlertTriangle className="h-3 w-3" />
            conflicts
          </span>
        )}
        {threads > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--orange)]">
            <MessageSquare className="h-3 w-3" />
            {threads}
          </span>
        )}
        {mr.pipeline && (
          <span className="shrink-0 text-[9px]">
            <PipelineChip status={mr.pipeline} />
          </span>
        )}
        {mr.approved && (
          <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-emerald-500">
            <Check className="h-3 w-3" />
            approved
          </span>
        )}
      </a>
      <MrActions mr={mr} env={env} />
    </div>
  );
}

function MrSection({
  title,
  mrs,
  count,
  total,
  marker,
  env,
}: {
  title: string;
  mrs: GlabMrItem[];
  count: number;
  total: number;
  /** Badge text for rows that need attention (e.g. `action`, `waiting`). */
  marker?: (mr: GlabMrItem) => string | null;
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
      {mrs.length === 0 ? (
        <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">none</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {mrs.map((mr) => (
            <MrRow key={mr.key} mr={mr} badge={marker?.(mr) ?? undefined} env={env} />
          ))}
        </div>
      )}
    </div>
  );
}

function sortMine(mrs: GlabMrItem[]): GlabMrItem[] {
  return [...mrs].sort(
    (a, b) =>
      Number(mrNeedsAction(b)) - Number(mrNeedsAction(a)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

function sortReview(mrs: GlabMrItem[], me: string): GlabMrItem[] {
  return [...mrs].sort(
    (a, b) =>
      Number(mrWaitingForMe(b, me)) - Number(mrWaitingForMe(a, me)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

function GlabMrView({ close, env }: { close: () => void; env: MrRowEnv }) {
  const data = useMrOverview();
  const me = data.username ?? '';

  useEffect(() => {
    if (data.status === 'idle') void refreshMrOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = sortMine(data.mine);
  const review = sortReview(data.review, me);
  const mineAction = mine.filter((m) => mrNeedsAction(m)).length;
  const reviewWaiting = review.filter((m) => mrWaitingForMe(m, me)).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <GitMerge className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          merge requests
        </span>
        {data.fetchedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refreshMrOverview()}
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
            <div className="mb-1 font-semibold text-red-500">failed to load merge requests</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            {isAuthHintRelevant(data.error) && (
              <div className="text-[var(--text-secondary)]">
                Check <code className="text-[var(--accent)]">glab auth status</code> in a shell.
              </div>
            )}
          </div>
        ) : (
          <>
            <MrSection
              title="assigned to me / authored without assignee"
              mrs={mine}
              count={mineAction}
              total={mine.length}
              marker={(m) => (mrNeedsAction(m) ? 'action' : null)}
              env={env}
            />
            <MrSection
              title="review requested"
              mrs={review}
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

export const glabMrPlugin: SessionViewPlugin = {
  id: 'glab-mr',
  title: 'merge requests',
  version: '0.1.0',
  settings: [
    {
      key: 'showInPanel',
      label: 'Show merge requests in the session panel',
      description: 'Lists MRs for the session branch under the session.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'showInTitle',
      label: 'Show merge request in title',
      description: 'MR reference indicator in the session row.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (seconds)',
      description: 'How often the app-wide MR list is polled.',
      type: 'number',
      default: 120,
    },
    {
      key: 'hostname',
      label: 'GitLab hostname',
      description: 'Overrides the glab api --hostname default.',
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
    return <SessionMrs ctx={ctx} />;
  },
  renderRow: (ctx) => {
    const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
    if (settings?.showInTitle === false) return null;
    const state = ctx.pluginState as { mrs?: SessionMr[] } | undefined;
    const mrs = state?.mrs ?? [];
    if (mrs.length === 0) return null;
    const first = mrs[0];
    return (
      <a
        href={first.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        data-tip={mrs.map((m) => `${m.reference} ${m.title}`).join('\n')}
        className="flex shrink-0 items-center gap-0.5 font-mono text-[9px] leading-none text-[var(--accent)] hover:underline"
      >
        <GitMerge className="h-2.5 w-2.5" />
        {first.reference}
        {mrs.length > 1 ? `+${mrs.length - 1}` : ''}
      </a>
    );
  },
  rowTip: (ctx) => {
    const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
    if (settings?.showInTitle === false) return null;
    const mrs =
      (ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs ?? [];
    if (mrs.length === 0) return null;
    const first = mrs[0];
    return `${first.reference}${mrs.length > 1 ? ` +${mrs.length - 1}` : ''}: open merge request${mrs.length > 1 ? 's' : ''} on this branch — ${first.title}`;
  },
  renderRail: ({ pluginSettings, viewActive, toggleView }) => (
    <GlabMrRail
      pluginSettings={pluginSettings}
      viewActive={viewActive}
      toggleView={toggleView}
    />
  ),
  renderView: ({ close, sessions, workspaces, selectSession, sessionApi }) => (
    <GlabMrView
      close={close}
      env={{ sessions, workspaces, apiFor: sessionApi, selectSession }}
    />
  ),
};
