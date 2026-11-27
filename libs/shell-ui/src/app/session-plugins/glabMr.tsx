import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { PublishPanelStatus } from '../PanelStatusSection';
import { ghostButtonClass } from '../chromeStyles';
import { PanelHeader, PanelHeaderButton, PanelHeaderChip, PanelHeaderSpacer } from '../PanelHeader';
import { usePluginSettingsOptional } from '../PluginSettingsProvider';
import { ForgeSetup, suggestForgeHost } from './forgeSetup';
import { appRuntime } from '../appRuntime';
import {
  GitMerge,
  Globe,
  MessageSquare,
  RefreshCw,
  Text,
  X,
  AlertTriangle,
  Check,
} from 'lucide-react';
import type {
  PluginApi,
  SessionIdentifier,
  SessionIdentifierContext,
  SessionViewContext,
  SessionViewPlugin,
} from './plugin';
import type { ShellSession, SessionAttention} from '../../types';
import {
  createMrPeopleCache,
  mrActionProviders,
  registerMrResolver,
  type MrRef,
  type MrRowEnv,
} from './mrActions';
import { CardChips } from './cardEnrichers';
import { MrStatusChip, worstTone, type MrTone } from './mrStatus';
import { MrDescription } from './mrDescription';
import {
  findMerged,
  mergedVerdict,
  repoSig,
  type MergedCandidate,
  type SessionMerged,
} from './mrMerged';
import { shellQuote } from '../../shellQuote';
import { sessionLastSelectedAt } from '../attention';
import { getSessionViewPlugins, isPluginEnabled } from './index';
import { PluginIcon } from '../SessionPanel';
import { RailItem } from '../RailItem';
import type { PluginSettings } from '../pluginSettings';
import {
  type MrPeople,
  authCommand,
  defaultHostNote,
  classifyCliError,
  compactCliError,
  assertNotTruncated,
  isAuthHintRelevant,
  forgeCheckouts,
  forgeCliCommand,
  forgeHost,
  forgeOfRemote,
  forgeRailMode,
  repoRootsSetting,
  splitByRole,
  type CliFailure,
} from './forge';
import { relativeAgo } from './relativeTime';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** One resolvable discussion thread on an MR (GraphQL shape, normalized). */
export interface MrDiscussion {
  resolvable: boolean;
  resolved: boolean;
  /** Note authors in chronological order. */
  notes: string[];
  /** When the newest note was posted (ISO), when known. */
  lastAt?: string;
}

export interface MrThreadSummary {
  waitingForMe: number;
  waitingForOther: number;
  /** The newest note across the open threads; `author` is `you` for mine. */
  lastComment?: { author: string; at: string };
}

/** An open merge request as tracked by the glab-mr plugin. */
export interface GlabMrItem {
  /** project fullPath + '!' + iid — unique across projects. */
  key: string;
  iid: number;
  /** e.g. `!75` */
  reference: string;
  title: string;
  /** MR body text (may be empty). */
  description: string;
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
  /** Unresolved threads as counted by GitLab; wins over `discussions` when set. */
  openThreadCount?: number;
  /** User (non-system) notes as counted by GitLab. */
  noteCount?: number;
  threadSummary?: MrThreadSummary;
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
  /** Unresolved resolvable threads; absent when the discussions fetch failed. */
  openThreads?: number;
  threadSummary?: MrThreadSummary;
  mergeStatus: string;
  pipeline: string | null;
}

// ---------------------------------------------------------------------------
// Classification helpers (pure — unit tested)
// ---------------------------------------------------------------------------

/** Number of unresolved resolvable discussion threads. */
export function openThreads(mr: Pick<GlabMrItem, 'discussions' | 'openThreadCount'>): number {
  return mr.openThreadCount ?? mr.discussions.filter((d) => d.resolvable && !d.resolved).length;
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

export function summarizeOpenThreads(
  mr: Pick<GlabMrItem, 'discussions'>,
  me: string,
): MrThreadSummary {
  const summary: MrThreadSummary = { waitingForMe: 0, waitingForOther: 0 };
  for (const discussion of mr.discussions) {
    if (!discussion.resolvable || discussion.resolved) continue;
    const last = discussion.notes[discussion.notes.length - 1];
    if (!last) continue;
    if (last === me) summary.waitingForOther += 1;
    else summary.waitingForMe += 1;
    const at = discussion.lastAt;
    if (at && (!summary.lastComment || Date.parse(at) > Date.parse(summary.lastComment.at))) {
      summary.lastComment = { author: last === me ? 'you' : last, at };
    }
  }
  return summary;
}

import { extractTicketFromTitle } from '../ticketKeys';
export { extractTicketFromTitle };

/** Publishes ticket keys spotted in the session's merge request titles via ticketRegex. */
export function glabMrIdentifiers(ctx: SessionIdentifierContext): SessionIdentifier[] {
  const settings = ctx.pluginSettings as { ticketRegex?: string } | undefined;
  if (!settings?.ticketRegex) return [];
  const mrs = (ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs;
  if (!Array.isArray(mrs) || mrs.length === 0) return [];

  const out: SessionIdentifier[] = [];
  const seen = new Set<string>();
  for (const mr of mrs) {
    const ticket = extractTicketFromTitle(mr.title, settings.ticketRegex);
    if (ticket && !seen.has(ticket)) {
      seen.add(ticket);
      out.push({
        value: ticket,
        source: 'glab-mr',
        label: 'MR',
      });
    }
  }
  return out;
}

/**
 * "Needs action" for an MR I own (assignee, or author without assignee):
 * merge conflicts, a failing pipeline, a thread someone else answered last,
 * or approved (ready to merge). The thread *count* is every open thread, but
 * only threads waiting on me make it an action: when each open thread was
 * last answered by me, only others can resolve them — an approved MR that GitLab
 * will not merge yet then stays yellow rather than red, as in mr-inbox. Without a
 * thread summary (discussions unavailable) any open thread counts, to be safe.
 */
export function mrNeedsAction(
  mr: Pick<GlabMrItem, 'conflicts' | 'approved' | 'pipeline' | 'discussions' | 'openThreadCount'> &
    Partial<Pick<GlabMrItem, 'threadSummary' | 'mergeStatus'>>,
): boolean {
  if (mr.conflicts || mr.pipeline === 'failed') return true;
  const summary = mr.threadSummary;
  const open = openThreads(mr);
  if (!summary) return mr.approved || open > 0;
  if (summary.waitingForMe > 0) return true;
  return mr.approved && !(open > 0 && mr.mergeStatus !== 'mergeable');
}

/** Open threads that only others can resolve (every one was last answered by me). */
export function mrAwaitingOthers(
  mr: Pick<GlabMrItem, 'discussions' | 'openThreadCount'> & Partial<Pick<GlabMrItem, 'threadSummary'>>,
): boolean {
  return !!mr.threadSummary && mr.threadSummary.waitingForMe === 0 && openThreads(mr) > 0;
}

/** What the header chip needs from an MR/PR — the GitLab and GitHub session state both fit. */
export interface MrStatusFacts {
  draft: boolean;
  conflicts: boolean;
  /** head pipeline / aggregated checks, lowercased; null when none. */
  pipeline: string | null;
  /** `detailed_merge_status` (GitLab) or `mergeStateStatus` (GitHub), lowercased. */
  mergeStatus: string;
  /** Unresolved threads; undefined when the fetch failed. */
  openThreads?: number;
  discussionsResolved?: boolean;
  threadSummary?: MrThreadSummary;
  /** GitHub `reviewDecision === changes_requested`. */
  changesRequested?: boolean;
}

/** The chip for a branch whose MR/PR already merged (see `mrMerged.ts`). */
export function SessionMergedChip({
  forge,
  icon,
  merged,
}: {
  forge: 'GitLab' | 'GitHub';
  icon: ReactNode;
  merged: SessionMerged;
}) {
  const { tone, reasons } = mergedVerdict(merged);
  const tip = [forge, `${merged.reference} ${merged.title}`, `  ${reasons.join(' · ')}`].join('\n');
  return (
    <MrStatusChip tone={tone} href={merged.url} tip={tip} icon={icon}>
      {merged.reference} {tone === 'violet' ? 'merged' : 'merged+'}
    </MrStatusChip>
  );
}

const PIPELINE_RUNNING = ['running', 'pending', 'created', 'preparing', 'scheduled', 'waiting_for_resource'];

/**
 * The chip colour, shared by the GitLab and GitHub plugins (same thread
 * colours as `ThreadIndicator`): red = your move — failing pipeline, conflicts,
 * changes requested, a thread someone else answered last, or all green and
 * ready to merge; orange = blocked on something outside the MR (a dependency
 * MR, a rebase) or threads we could not load; yellow = waiting on others
 * (pipeline running, every open thread last answered by you); green = nothing
 * to do; gray = draft with nothing wrong. Highest severity wins; `reasons`
 * explain it in the tooltip.
 */
export function mrStatusTone(f: MrStatusFacts): { tone: MrTone; reasons: string[] } {
  const red: string[] = [];
  const orange: string[] = [];
  const yellow: string[] = [];
  if (f.conflicts) red.push('merge conflicts');
  if (f.pipeline === 'failed') red.push('pipeline failed');
  if (f.changesRequested) red.push('changes requested');
  const mine = f.threadSummary?.waitingForMe ?? 0;
  if (mine > 0) red.push(`${mine} open thread${mine === 1 ? '' : 's'} waiting on you`);
  const ready = f.mergeStatus === 'mergeable' || f.mergeStatus === 'clean';
  if (ready && !f.draft && f.pipeline !== 'failed' && !f.conflicts) red.push('ready to merge — your move');

  if (f.mergeStatus === 'blocked_status') orange.push('blocked by another merge request');
  if (f.mergeStatus === 'need_rebase' || f.mergeStatus === 'behind') orange.push('needs a rebase');
  const unknownThreads = f.openThreads === undefined && f.discussionsResolved === false;
  if (unknownThreads) orange.push('open threads (details unavailable)');

  if (f.pipeline && PIPELINE_RUNNING.includes(f.pipeline)) yellow.push(`pipeline ${f.pipeline}`);
  const theirs = f.threadSummary?.waitingForOther ?? 0;
  if (theirs > 0) yellow.push(`${theirs} open thread${theirs === 1 ? '' : 's'} waiting on others`);
  if ((f.openThreads ?? 0) > 0 && !f.threadSummary && !unknownThreads) yellow.push('open threads');

  if (red.length) return { tone: 'red', reasons: red };
  if (orange.length) return { tone: 'orange', reasons: orange };
  if (yellow.length) return { tone: 'yellow', reasons: yellow };
  if (f.draft) return { tone: 'gray', reasons: ['draft'] };
  return { tone: 'green', reasons: ['nothing to do'] };
}

/** The shared header chip for a session's MRs/PRs: first ref (+N), worst tone, reasons per item. */
export function SessionMrChip({
  forge,
  icon,
  items,
}: {
  forge: 'GitLab' | 'GitHub';
  icon: ReactNode;
  items: Array<MrStatusFacts & { reference: string; title: string; url: string }>;
}) {
  const verdicts = items.map((m) => ({ m, v: mrStatusTone(m) }));
  const tone = worstTone(verdicts.map((x) => x.v.tone));
  const tip = [
    forge,
    ...verdicts.map(({ m, v }) => `${m.reference} ${m.title}\n  ${v.reasons.join(' · ')}`),
  ].join('\n');
  const first = items[0];
  return (
    <MrStatusChip tone={tone} href={first.url} tip={tip} icon={icon}>
      {first.reference}
      {items.length > 1 ? `+${items.length - 1}` : ''}
    </MrStatusChip>
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
const sessionMe = new Map<string, string>();
const sessionMeInFlight = new Map<string, Promise<string | undefined>>();
const hostArg = (host: string) => `--hostname ${shellQuote(host)}`;

async function currentMrUser(ctx: SessionViewContext & PluginApi, hostname: unknown): Promise<string | undefined> {
  const host = forgeHost(hostname) ?? 'gitlab.com';
  const cached = sessionMe.get(host);
  if (cached) return cached;
  const running = sessionMeInFlight.get(host);
  if (running) return running;
  const request = ctx
    .exec(forgeCliCommand('glab', `api ${hostArg(host)} user`))
    .then((out) => {
      const username = (JSON.parse(out) as { username?: string }).username;
      if (username) sessionMe.set(host, username);
      return username;
    })
    .catch(() => undefined)
    .finally(() => sessionMeInFlight.delete(host));
  sessionMeInFlight.set(host, request);
  return request;
}

interface RawMrListItem {
  iid?: number;
  sha?: string;
  merged_at?: string;
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
  web_url?: string;
  author?: { username?: string } | null;
  assignees?: { username?: string }[] | null;
  reviewers?: { username?: string }[] | null;
}

/** People on an MR from the REST resource (`projects/:id/merge_requests/:iid`). */
export function restMrPeople(raw: RawMrDetail): MrPeople {
  const names = (list?: { username?: string }[] | null) =>
    (list ?? []).map((u) => u.username ?? '').filter(Boolean);
  return {
    author: raw.author?.username ?? '',
    assignees: names(raw.assignees),
    reviewers: names(raw.reviewers),
  };
}

interface RawMrDiscussion {
  notes?: {
    resolvable?: boolean;
    resolved?: boolean | null;
    /** GitLab's own bookkeeping ("changed the description", …) — never a reply. */
    system?: boolean;
    created_at?: string;
    author?: { username?: string };
  }[];
}

/**
 * Open threads in the REST `…/discussions` shape: a discussion counts as
 * open while it holds an unresolved resolvable note (GitLab has no
 * unresolved-thread counter on the MR resource itself).
 */
export function countOpenThreads(discussions: RawMrDiscussion[]): number {
  return discussions.filter((d) =>
    (d.notes ?? []).some((n) => n.resolvable === true && n.resolved !== true),
  ).length;
}

/**
 * REST discussions → the shared thread shape. A thread is resolved when none
 * of its resolvable notes is open — a system note inside it (`resolved: null`)
 * must neither keep it open nor count as the last word, or a finished thread
 * reads as "waiting on you" (same rule as `countOpenThreads`).
 */
export function normalizeRestDiscussions(discussions: RawMrDiscussion[]): MrDiscussion[] {
  return discussions.map((discussion) => {
    const notes = discussion.notes ?? [];
    const replies = notes.filter((note) => note.system !== true);
    return {
      resolvable: notes.some((note) => note.resolvable === true),
      resolved: !notes.some((note) => note.resolvable === true && note.resolved !== true),
      notes: replies.map((note) => note.author?.username ?? '').filter(Boolean),
      lastAt: replies[replies.length - 1]?.created_at,
    };
  });
}

async function fetchAllRestDiscussions(
  ctx: SessionViewContext & PluginApi,
  root: string,
  iid: number,
): Promise<RawMrDiscussion[]> {
  const discussions: RawMrDiscussion[] = [];
  for (let page = 1; ; page += 1) {
    const out = await ctx.exec(
      `glab api "projects/:fullpath/merge_requests/${iid}/discussions?per_page=100&page=${page}"`,
      root,
    );
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) break;
    discussions.push(...(parsed as RawMrDiscussion[]));
    if (parsed.length < 100) break;
  }
  return discussions;
}

async function refreshSessionMrs(ctx: SessionViewContext & PluginApi) {
  const session = ctx.getSession();
  const root = session.repo?.root;
  const branch = session.repo?.branch;
  const had =
    (((ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs?.length) ?? 0) > 0 ||
    !!(ctx.pluginState as { merged?: SessionMerged | null } | undefined)?.merged;
  const hostname = (ctx.pluginSettings as { hostname?: unknown } | undefined)?.hostname;
  // A repo on GitHub is gh-pr's — don't spawn glab for it on every refresh.
  if (!root || !branch || forgeOfRemote(session.repo?.remote, { gitlab: hostname }) === 'github') {
    if (had) ctx.updatePluginState({ mrs: [], merged: null });
    return;
  }

  sessionLastFetch.set(session.id, Date.now());
  sessionLastKey.set(session.id, `${root}@${branch}`);

  let list: RawMrListItem[];
  try {
    const out = await ctx.exec(mrListCommand(branch), root);
    const parsed = JSON.parse(out || '[]') as unknown;
    list = Array.isArray(parsed) ? (parsed as RawMrListItem[]) : [];
  } catch {
    // glab missing, not authenticated, or the repo is not on GitLab — leave
    // the previous state untouched.
    return;
  }

  // Per-MR detail calls add the head pipeline status and the open-thread
  // count (both absent from list output).
  const me = await currentMrUser(ctx, hostname);
  const mrs = await Promise.all(
    list.slice(0, 5).map(async (item): Promise<SessionMr> => {
      const iid = Math.trunc(Number(item.iid));
      let pipeline: string | null = null;
      let threadCount: number | undefined;
      let threadSummary: MrThreadSummary | undefined;
      try {
        const detail = await ctx.exec(
          `glab api "projects/:fullpath/merge_requests/${iid}"`,
          root,
        );
        const parsed = JSON.parse(detail) as RawMrDetail;
        pipeline = parsed.head_pipeline?.status?.toLowerCase() ?? null;
        // the same resource carries the people — feeds the role lookup
        const url = parsed.web_url ?? item.web_url;
        if (url) mrPeople.fill(url, restMrPeople(parsed));
      } catch {
        // pipeline stays unknown
      }
      try {
        const discussions = await fetchAllRestDiscussions(ctx, root, iid);
        threadCount = countOpenThreads(discussions);
        if (me) {
          threadSummary = summarizeOpenThreads(
            { discussions: normalizeRestDiscussions(discussions) },
            me,
          );
        }
      } catch {
        // thread count stays unknown — the panel falls back to the boolean chip
      }
      return {
        iid: item.iid ?? 0,
        reference: item.references?.short ?? `!${item.iid}`,
        title: item.title ?? '',
        url: item.web_url ?? '',
        draft: item.draft ?? false,
        conflicts: item.has_conflicts ?? false,
        discussionsResolved: item.blocking_discussions_resolved ?? true,
        openThreads: threadCount,
        threadSummary,
        mergeStatus: (item.detailed_merge_status ?? '').toLowerCase(),
        pipeline,
      };
    }),
  );

  ctx.updatePluginState({ mrs, merged: mrs.length === 0 ? await mergedFor(ctx, root, branch) : null });
}

/** The branch's merged MR when no open one exists and HEAD continues it. */
async function mergedFor(
  ctx: SessionViewContext & PluginApi,
  root: string,
  branch: string,
): Promise<SessionMerged | null> {
  let list: RawMrListItem[];
  try {
    const parsed = JSON.parse((await ctx.exec(mergedMrListCommand(branch), root)) || '[]') as unknown;
    list = Array.isArray(parsed) ? (parsed as RawMrListItem[]) : [];
  } catch {
    return null;
  }
  const candidates: MergedCandidate[] = list.flatMap((item) =>
    item.sha
      ? [
          {
            reference: item.references?.short ?? `!${item.iid}`,
            title: item.title ?? '',
            url: item.web_url ?? '',
            sha: item.sha,
            mergedAt: item.merged_at,
          },
        ]
      : [],
  );
  return (
    (await findMerged(candidates, (script) => ctx.exec(script, root), repoSig(ctx.getSession().repo))) ?? null
  );
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
        // a merged branch: new commits/edits since the last probe change the chip
        const merged = (ctx.pluginState as { merged?: SessionMerged | null } | undefined)?.merged;
        const moved = !!merged && merged.sig !== repoSig(session.repo);
        if (key !== sessionLastKey.get(id) || stale || moved) {
          void refreshSessionMrs(ctx);
        }
      },
      immediate ? 0 : MR_REFRESH_DELAY_MS,
    ),
  );
}

// ---------------------------------------------------------------------------
// MR watch (opt-in) — attention on sessions whose tracked MR changed
// ---------------------------------------------------------------------------

/** Per session-MR snapshot, persisted in appState.mrWatch. */
interface MrWatchEntry {
  pipeline: string | null;
  unresolved: number;
  notes: number;
  /** Why attention was raised — cleared once the session is viewed. */
  flag?: string;
  flagAt?: number;
}

function overviewWatchEntry(mr: GlabMrItem): MrWatchEntry {
  return {
    pipeline: mr.pipeline,
    unresolved: openThreads(mr),
    notes: mr.noteCount ?? mr.discussions.reduce((n, d) => n + d.notes.length, 0),
  };
}

function raiseMrWatch(
  api: SessionViewContext & PluginApi,
  entry: MrWatchEntry,
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

/** "Go to session" buttons for every session with this MR checked out,
 * else a "create worktree" action when the worktrees plugin is enabled. */
function mrWatchActions(
  mr: SessionMr,
  sessions: ShellSession[],
  api: SessionViewContext & PluginApi,
): SessionAttention['actions'] {
  const holders = sessions.filter((s) =>
    ((s.pluginState?.['glab-mr'] as { mrs?: SessionMr[] } | undefined)?.mrs ?? []).some(
      (m) => m.url === mr.url,
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
      label: `Create worktree for ${mr.reference}`,
    });
  }
  return actions.length ? actions : undefined;
}

/**
 * Diff every session's tracked MRs (`pluginState glab-mr.mrs`) against the
 * freshest data and flag the owning session when its MR regressed or gained
 * activity: pipeline -> failed, a new unresolved thread, or a new note.
 * MRs covered by the overview poll cost nothing extra; the rest get one
 * light `glab api` detail call each — the same request refreshSessionMrs
 * already makes. Runs from the rail component after each overview refresh.
 */
async function mrWatchTick(args: {
  sessions: ShellSession[];
  data: MrOverview;
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  sessionApi: (id: string) => (SessionViewContext & PluginApi) | undefined;
}) {
  const watch = {
    ...((args.appState as { mrWatch?: Record<string, MrWatchEntry> } | undefined)
      ?.mrWatch ?? {}),
  };
  const overviewByUrl = new Map<string, GlabMrItem>(
    [...args.data.mine, ...args.data.review].map((m) => [m.url, m]),
  );
  const seen = new Set<string>();
  for (const session of args.sessions) {
    const mrs =
      (session.pluginState?.['glab-mr'] as { mrs?: SessionMr[] } | undefined)
        ?.mrs ?? [];
    const api = args.sessionApi(session.id);
    for (const mr of mrs) {
      const key = `${session.id}|${mr.url}`;
      seen.add(key);
      const prev = watch[key];
      let entry: MrWatchEntry | undefined;
      const overview = overviewByUrl.get(mr.url);
      if (overview) {
        entry = overviewWatchEntry(overview);
      } else if (api && session.repo?.root) {
        // Not one of my overview MRs — one detail call per watched session MR.
        try {
          const d = JSON.parse(
            await api.exec(
              `glab api "projects/:fullpath/merge_requests/${mr.iid}"`,
              session.repo.root,
            ),
          ) as {
            head_pipeline?: { status?: string } | null;
            user_notes_count?: number;
            blocking_discussions_resolved?: boolean;
          };
          entry = {
            pipeline: d.head_pipeline?.status?.toLowerCase() ?? null,
            unresolved: d.blocking_discussions_resolved === false ? 1 : 0,
            notes: d.user_notes_count ?? 0,
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
        const actions = mrWatchActions(mr, args.sessions, api);
        const data = { mr: { url: mr.url, iid: mr.iid, title: mr.title, reference: mr.reference } };
        if (prev.pipeline !== 'failed' && entry.pipeline === 'failed')
          raiseMrWatch(api, e, `pipeline failed on ${mr.reference}`, true, actions, data);
        else if (entry.unresolved > prev.unresolved)
          raiseMrWatch(api, e, `new unresolved thread on ${mr.reference}`, false, actions, data);
        else if (entry.notes > prev.notes)
          raiseMrWatch(api, e, `new comment on ${mr.reference}`, false, actions, data);
      }
    }
  }
  for (const key of Object.keys(watch)) if (!seen.has(key)) delete watch[key];
  args.updateAppState({ mrWatch: watch });
}

// ---------------------------------------------------------------------------
// MR overview — `glab api graphql` for assigned/authored/review-requested MRs
// ---------------------------------------------------------------------------

/**
 * GitLab gives a GraphQL request ~30 s server-side; one query carrying every
 * list *with* its discussions took 16–28 s against gitlab.magnolia-platform.com
 * and timed out ("Timeout on BaseNoteInterface.author …") — resolving each
 * note's author is the expensive part. So:
 *
 * 1. One query for the three lists, with GitLab's own thread/note counters
 *    instead of discussions (2–6 s). That covers everything "mine" needs.
 * 2. Discussions (who wrote last in open threads) for every displayed MR
 *    with open threads — `DISCUSSION_BATCH` MRs per aliased query
 *    (8 took ~7 s), following each connection's cursor until complete, and
 *    only for MRs whose counters changed since the last refresh
 *    (`discussionCache`). A quiet poll is a single glab call.
 *
 * `updatedAt` is no change signal: a comment can land after it unchanged.
 */
const MR_OVERVIEW_FIELDS = `iid reference title description webUrl draft conflicts detailedMergeStatus sourceBranch targetBranch updatedAt approved userNotesCount resolvableDiscussionsCount resolvedDiscussionsCount approvedBy { nodes { username } } author { username } assignees { nodes { username } } reviewers { nodes { username } } project { fullPath } headPipeline { status }`;

const MR_OVERVIEW_QUERY = `query { currentUser { username
  assignedMergeRequests(state: opened, first: 40) { nodes { ${MR_OVERVIEW_FIELDS} } }
  authoredMergeRequests(state: opened, first: 40) { nodes { ${MR_OVERVIEW_FIELDS} } }
  reviewRequestedMergeRequests(state: opened, first: 40) { nodes { ${MR_OVERVIEW_FIELDS} } }
} }`;

// notes(last: 20): only a thread's newest notes matter — `mrWaitingForMe`
// reads who wrote last — the same window as gh-pr's `comments(last: 20)`.
const mrDiscussionsFields = (afterVar?: string) =>
  `discussions(first: 100${afterVar ? `, after: $${afterVar}` : ''}) { pageInfo { hasNextPage endCursor } nodes { resolvable resolved notes(last: 20) { nodes { createdAt system author { username } } } } }`;

/** MRs per discussions query, and how many such queries run at once. */
const DISCUSSION_BATCH = 8;
const DISCUSSION_BATCHES_AT_ONCE = 3;

/** Review MR key → its discussions and the counters they were fetched at. */
const discussionCache = new Map<string, { stamp: string; discussions: MrDiscussion[] }>();

export interface MrOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Host the last refresh queried (`hostname` setting); `undefined` = the CLI's default host. */
  host?: string;
  error?: string;
  /** Why the last refresh failed; kept through `loading` so the rail doesn't flicker. */
  failure?: CliFailure;
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

/** The GitLab host a URL host stands for in the overview (`undefined` = gitlab.com). */
const overviewHost = () => (overview.host ?? 'gitlab.com').toLowerCase();

/**
 * Per-MR people cache behind dev-workflow's role lookup (`MrResolver`):
 * filled by the overview poll and the per-session detail fetch, one
 * `glab api` call on a miss.
 */
const mrPeople = createMrPeopleCache({
  forge: 'gitlab',
  knownMe: (host) => (host === overviewHost() ? overview.username || undefined : undefined),
  fetchOne: async ({ host, project, iid }) => {
    const rt = appRuntime();
    if (!rt) return undefined;
    const out = await rt.exec(
      forgeCliCommand(
        'glab',
        `api ${hostArg(host)} ${shellQuote(`projects/${encodeURIComponent(project)}/merge_requests/${iid}`)}`,
      ),
    );
    return restMrPeople(JSON.parse(out) as RawMrDetail);
  },
  fetchMe: async (host) => {
    const rt = appRuntime();
    if (!rt) return undefined;
    const out = await rt.exec(forgeCliCommand('glab', `api ${hostArg(host)} user`));
    return (JSON.parse(out) as { username?: string }).username || undefined;
  },
});
registerMrResolver('glab-mr', mrPeople);

/** Test seam: forget every cached MR's people. */
export function resetMrPeople(): void {
  mrPeople.clear();
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
  description?: string;
  webUrl?: string;
  draft?: boolean;
  conflicts?: boolean;
  detailedMergeStatus?: string;
  sourceBranch?: string;
  targetBranch?: string;
  updatedAt?: string;
  approved?: boolean;
  userNotesCount?: number;
  resolvableDiscussionsCount?: number;
  resolvedDiscussionsCount?: number;
  approvedBy?: { nodes?: { username?: string }[] };
  author?: { username?: string };
  assignees?: { nodes?: { username?: string }[] };
  reviewers?: { nodes?: { username?: string }[] };
  project?: { fullPath?: string };
  headPipeline?: { status?: string } | null;
  discussions?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: {
      resolvable?: boolean;
      resolved?: boolean;
      notes?: { nodes?: { createdAt?: string; system?: boolean; author?: { username?: string } }[] };
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
    description: raw.description ?? '',
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
    discussions: normalizeDiscussions(raw.discussions),
    openThreadCount:
      raw.resolvableDiscussionsCount === undefined
        ? undefined
        : Math.max(0, raw.resolvableDiscussionsCount - (raw.resolvedDiscussionsCount ?? 0)),
    noteCount: raw.userNotesCount,
  };
}

function normalizeDiscussions(raw: RawGqlMr['discussions']): MrDiscussion[] {
  return (raw?.nodes ?? []).map((d) => {
    const replies = (d.notes?.nodes ?? []).filter((n) => n.system !== true);
    return {
      resolvable: d.resolvable ?? false,
      resolved: d.resolved ?? false,
      notes: replies.map((n) => n.author?.username ?? ''),
      lastAt: replies[replies.length - 1]?.createdAt,
    };
  });
}

/** The same key `normalizeMr` gives the item. */
const rawKey = (raw: RawGqlMr) => `${raw.project?.fullPath ?? ''}!${Number(raw.iid ?? 0)}`;

/** Changes whenever a note is added or a thread (un)resolved — the refetch trigger. */
const discussionStamp = (raw: RawGqlMr) =>
  `${raw.userNotesCount ?? '?'}|${raw.resolvableDiscussionsCount ?? '?'}|${raw.resolvedDiscussionsCount ?? '?'}`;

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


/** `glab mr list` for the MRs whose source is `branch` (single-quoted: git allows `$(…)` in names). */
export function mrListCommand(branch: string): string {
  return forgeCliCommand('glab', `mr list -s ${shellQuote(branch)} -F json -P 10`);
}

/** `glab mr list --merged` for the branch: its merged MRs with the head they merged at. */
export function mergedMrListCommand(branch: string): string {
  return forgeCliCommand('glab', `mr list -s ${shellQuote(branch)} --merged -F json -P 5`);
}

/** The app-wide overview command (`--hostname` for self-hosted GitLab). */
function graphqlCommand(hostname: unknown, query: string, vars: Record<string, string> = {}): string {
  const name = forgeHost(hostname);
  const host = name ? ` --hostname ${shellQuote(name)}` : '';
  // glab passes every -f field other than `query` as a GraphQL variable.
  const args = Object.entries(vars)
    .map(([k, v]) => ` -f ${shellQuote(`${k}=${v}`)}`)
    .join('');
  // One line, single-quoted: no literal newlines or shell expansion inside.
  return forgeCliCommand('glab', `api graphql${host} -f query=${shellQuote(query.replace(/\s+/g, ' '))}${args}`);
}

/** The app-wide overview command: the three MR lists, without discussions. */
export function mrOverviewCommand(hostname?: unknown): string {
  return graphqlCommand(hostname, MR_OVERVIEW_QUERY);
}

/**
 * Several MRs' discussions in one query: one alias `m<i>` per MR, project
 * and iid passed as variables so nothing user-controlled is spliced into
 * the query text.
 */
export function mrDiscussionsCommand(
  hostname: unknown,
  mrs: { project: string; iid: number | string; after?: string }[],
): string {
  const decl = mrs
    .map((mr, i) => `$p${i}: ID!, $i${i}: String!${mr.after ? `, $a${i}: String!` : ''}`)
    .join(', ');
  const body = mrs
    .map((mr, i) => `m${i}: project(fullPath: $p${i}) { mergeRequest(iid: $i${i}) { ${mrDiscussionsFields(mr.after ? `a${i}` : undefined)} } }`)
    .join(' ');
  const vars: Record<string, string> = {};
  mrs.forEach((mr, i) => {
    vars[`p${i}`] = mr.project;
    vars[`i${i}`] = String(mr.iid);
    if (mr.after) vars[`a${i}`] = mr.after;
  });
  return graphqlCommand(hostname, `query(${decl}) { ${body} }`, vars);
}

/** Parse `glab api graphql` output into its `data`; throws on any failure. */
function parseGraphql<T>(out: string): T | undefined {
  assertNotTruncated('glab', out);
  const parsed = JSON.parse(out) as { data?: T; errors?: { message?: string }[] };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message ?? 'graphql error').join(' '));
  }
  return parsed.data;
}

async function fetchDiscussionBatch(
  exec: (command: string) => Promise<string>,
  hostname: unknown,
  batch: RawGqlMr[],
): Promise<Map<string, MrDiscussion[]>> {
  const discussions = new Map<string, MrDiscussion[]>();
  const cursors = new Map<string, string | undefined>();
  let pending = batch;
  while (pending.length > 0) {
    type Gql = { mergeRequest?: { discussions?: RawGqlMr['discussions'] } | null } | null;
    const data = parseGraphql<Record<string, Gql>>(
      await exec(
        mrDiscussionsCommand(
          hostname,
          pending.map((raw) => ({
            project: raw.project?.fullPath ?? '',
            iid: raw.iid ?? '',
            after: cursors.get(rawKey(raw)),
          })),
        ),
      ),
    );
    const next: RawGqlMr[] = [];
    pending.forEach((raw, i) => {
      const page = data?.[`m${i}`]?.mergeRequest?.discussions;
      const key = rawKey(raw);
      discussions.set(key, [
        ...(discussions.get(key) ?? []),
        ...normalizeDiscussions(page),
      ]);
      if (page?.pageInfo?.hasNextPage && page.pageInfo.endCursor) {
        cursors.set(key, page.pageInfo.endCursor);
        next.push(raw);
      }
    });
    pending = next;
  }
  return discussions;
}

/** `fn` over `items`, at most `limit` at a time; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The current overview snapshot (outside React). */
export function currentMrOverview(): MrOverview {
  return overview;
}

/** Test seam: drop the cached overview. */
export function resetMrOverview(): void {
  discussionCache.clear();
  setOverview({ status: 'idle', mine: [], review: [] });
}

export function refreshMrOverview(settings?: {
  hostname?: unknown;
}): Promise<void> {
  refreshInFlight ??= (async () => {
    const host = forgeHost(settings?.hostname);
    setOverview({ ...overview, host, status: 'loading' });
    try {
      const rt = appRuntime();
      if (!rt) throw new Error('no session available for glab');
      const data = parseGraphql<{
        currentUser?: {
          username?: string;
          assignedMergeRequests?: { nodes?: RawGqlMr[] };
          authoredMergeRequests?: { nodes?: RawGqlMr[] };
          reviewRequestedMergeRequests?: { nodes?: RawGqlMr[] };
        } | null;
      }>(await rt.exec(mrOverviewCommand(settings?.hostname)));
      const user = data?.currentUser;
      if (!user) throw new Error('no currentUser — run `glab auth login`');
      const assignedRaw = user.assignedMergeRequests?.nodes ?? [];
      const authoredRaw = user.authoredMergeRequests?.nodes ?? [];
      const reviewRaw = user.reviewRequestedMergeRequests?.nodes ?? [];

      // Step two: paginate discussions for every displayed MR whose counters moved.
      // The overview counters are authoritative for the total; the discussions
      // pages provide the latest author needed for responsibility classification.
      const allRaw = [...assignedRaw, ...authoredRaw, ...reviewRaw];
      const allKeys = new Set(allRaw.map(rawKey));
      for (const key of discussionCache.keys()) if (!allKeys.has(key)) discussionCache.delete(key);
      const stale = new Map<string, RawGqlMr>();
      for (const raw of allRaw) {
        const hasOpen =
          raw.resolvableDiscussionsCount === undefined ||
          raw.resolvedDiscussionsCount === undefined ||
          raw.resolvableDiscussionsCount > raw.resolvedDiscussionsCount;
        if (hasOpen && discussionCache.get(rawKey(raw))?.stamp !== discussionStamp(raw)) {
          stale.set(rawKey(raw), raw);
        } else if (!hasOpen) {
          discussionCache.delete(rawKey(raw));
        }
      }
      const batches: RawGqlMr[][] = [];
      const pending = [...stale.values()];
      for (let i = 0; i < pending.length; i += DISCUSSION_BATCH) batches.push(pending.slice(i, i + DISCUSSION_BATCH));
      let failed = 0;
      let firstError: unknown;
      await mapLimit(batches, DISCUSSION_BATCHES_AT_ONCE, async (batch) => {
        try {
          const discussions = await fetchDiscussionBatch(
            (command) => rt.exec(command),
            settings?.hostname,
            batch,
          );
          batch.forEach((raw) => {
            discussionCache.set(rawKey(raw), {
              stamp: discussionStamp(raw),
              discussions: discussions.get(rawKey(raw)) ?? [],
            });
          });
        } catch (e) {
          // A slow batch must not blank the list: its MRs keep their cached
          // discussions and stay stale, so the next refresh retries them.
          failed += 1;
          firstError ??= e;
        }
      });
      if (batches.length > 0 && failed === batches.length) throw firstError;
      const toItem = (raw: RawGqlMr): GlabMrItem => {
        const cached = discussionCache.get(rawKey(raw));
        return {
          ...normalizeMr(raw),
          discussions: cached?.discussions ?? [],
          threadSummary: cached
            ? summarizeOpenThreads({ discussions: cached.discussions }, user.username ?? '')
            : undefined,
        };
      };
      const assigned = assignedRaw.map(toItem);
      const authored = authoredRaw.map(toItem);
      const review = reviewRaw.map(toItem);
      for (const mr of [...assigned, ...authored, ...review]) {
        if (mr.url) mrPeople.fill(mr.url, mr);
      }
      setOverview({
        status: 'ready',
        host,
        username: user.username ?? '',
        ...splitByRole(mergeMine(assigned, authored), review, user.username ?? ''),
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
        failure: classifyCliError('glab', raw),
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
  success: 'text-[var(--green)]',
  failed: 'text-[var(--red)]',
  running: 'text-[var(--blue)]',
  pending: 'text-[var(--yellow)]',
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

export { relativeAgo };

export function threadSummaryTip(open: number, summary?: MrThreadSummary, now = Date.now()): string {
  const plural = (n: number) => `${n} open thread${n === 1 ? '' : 's'}`;
  if (!summary) return `${plural(open)} · last commenter unavailable`;
  const lines = [plural(open)];
  if (summary.waitingForMe > 0) lines.push(`• ${summary.waitingForMe} last answered by someone else — your move`);
  if (summary.waitingForOther > 0) lines.push(`• ${summary.waitingForOther} last answered by you — waiting on others`);
  const unknown = open - summary.waitingForMe - summary.waitingForOther;
  if (unknown > 0) lines.push(`• ${unknown} without a loaded last comment`);
  if (summary.lastComment) {
    const ago = relativeAgo(summary.lastComment.at, now);
    lines.push(`Last comment by ${summary.lastComment.author}${ago ? ` · ${ago}` : ''}`);
  }
  return lines.join('\n');
}

function threadSummaryColor(summary?: MrThreadSummary): string {
  if (!summary) return 'var(--orange)';
  if (summary.waitingForMe > 0) return 'var(--red)';
  if (summary.waitingForOther > 0) return 'var(--yellow)';
  return 'var(--orange)';
}

export function ThreadIndicator({
  open,
  summary,
  children,
}: {
  open: number;
  summary?: MrThreadSummary;
  children: ReactNode;
}) {
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      data-tip={threadSummaryTip(open, summary)}
      style={{ color: threadSummaryColor(summary) }}
    >
      <MessageSquare className="h-3 w-3" />
      {children}
    </span>
  );
}

function sessionThreadLabel(mr: SessionMr): string | null {
  if (mr.openThreads === undefined) return mr.discussionsResolved ? null : 'open threads';
  return mr.openThreads > 0
    ? `${mr.openThreads} open thread${mr.openThreads === 1 ? '' : 's'}`
    : null;
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
    selectedSessionId: ctx.session.id,
    apiFor: (id) => (id === ctx.session.id ? ctx : undefined),
    selectSession: () => {},
  };

  return (
    <div className="mb-2">
      <div className="flex flex-col gap-1 text-[11px]">
        {mrs.map((mr) => {
          const threadLabel = sessionThreadLabel(mr);
          return (
            <div key={mr.iid} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <a
                  href={mr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-semibold text-[var(--accent)] hover:underline"
                  data-tip={`GitLab · ${mr.title}`}
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
                  <span className="rounded bg-[color-mix(in_srgb,var(--red)_20%,transparent)] px-1 text-[var(--red)]">conflicts</span>
                )}
                {threadLabel && (
                  <ThreadIndicator open={mr.openThreads ?? 0} summary={mr.threadSummary}>
                    {threadLabel}
                  </ThreadIndicator>
                )}
                {mr.pipeline && <PipelineChip status={mr.pipeline} />}
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

function GlabMrRail({
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
  const data = useMrOverview();
  const settings = pluginSettings as
    | { hostname?: string; refreshIntervalSeconds?: number; watchMrChanges?: boolean }
    | undefined;
  const intervalSec = settings?.refreshIntervalSeconds ?? 120;
  const watchEnabled = settings?.watchMrChanges === true;

  useEffect(() => {
    void refreshMrOverview(settings);
    const timer = window.setInterval(
      () => void refreshMrOverview(settings),
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
    void mrWatchTick({ ...watchRef.current, updateAppState, data });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, watchEnabled]);

  const me = data.username ?? '';
  const mineAction = data.mine.filter((m) => mrNeedsAction(m)).length;
  const reviewWaiting = data.review.filter((m) => mrWaitingForMe(m, me)).length;
  const mode = forgeRailMode(data);
  // No glab (or nothing fetched yet): a GitHub-only user sees no GitLab icon.
  if (mode === 'hidden') return null;

  const waiting = mineAction + reviewWaiting;
  return (
    <>
      <RailItem
        title="Merge requests"
        // One short line only where it matters; the numbers are in the
        // tool's accordion in the session panel.
        status={
          mode === 'signed-out'
            ? 'not signed in'
            : mode === 'error'
              ? 'unavailable'
              : waiting > 0
                ? `${waiting} waiting for you`
                : undefined
        }
        onClick={toggleView}
        active={viewActive}
        muted={mode === 'signed-out'}
        // One number: what waits for the user. Orange when own work needs
        // action, accent when only reviews are waiting.
        badge={mode === 'counts' && waiting > 0 ? waiting : undefined}
        badgeTone={mineAction > 0 ? 'warning' : 'accent'}
        pip={mode === 'signed-out' ? 'setup' : mode === 'error' ? 'attention' : undefined}
      >
        <PluginIcon plugin={glabMrPlugin} />
      </RailItem>
      <PublishPanelStatus
        source={glabMrPlugin.id}
        group={
          mode === 'counts' && data.mine.length + data.review.length > 0
            ? {
                title: 'Merge requests',
                meters: [
                  {
                    label: 'Mine',
                    value: `${mineAction}/${data.mine.length}`,
                    detail: 'assigned or authored, need action',
                    level: mineAction > 0 ? 2 : 0,
                    color: 'var(--orange)',
                    tip: `${mineAction} of ${data.mine.length} assigned/authored MRs need action (open threads, conflicts, failing pipeline or approved)`,
                  },
                  {
                    label: 'Reviews',
                    value: `${reviewWaiting}/${data.review.length}`,
                    detail: 'review requests waiting for you',
                    tip: `${reviewWaiting} of ${data.review.length} review requests waiting for you`,
                  },
                ],
              }
            : null
        }
      />
    </>
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
    <span className="flex shrink-0 items-center gap-0.5 pr-1 pt-1.5">
      {providers.map((Provider, i) => (
        <Provider key={i} mr={mr} env={env} />
      ))}
    </span>
  );
}

function MrRow({ mr, badge, env, showDescription = true }: { showDescription?: boolean; mr: GlabMrItem; badge?: string; env: MrRowEnv }) {
  const threads = openThreads(mr);
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1 rounded px-2 py-1.5 text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface)]">
        <a
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2"
          data-tip={`${mr.project}\n${mr.sourceBranch} → ${mr.targetBranch}`}
        >
          <span className="shrink-0 font-semibold text-[var(--accent)]">{mr.reference}</span>
          <span className="max-w-44 shrink-0 truncate text-[var(--text-secondary)]">
            {projectShort(mr.project)}
          </span>
          <span className="min-w-0 flex-1 truncate">{mr.title}</span>
          {badge && (
            <span className="shrink-0 rounded bg-[var(--accent)]/15 px-1 text-[10px] font-semibold text-[var(--accent)]">
              {badge}
            </span>
          )}
          {mr.draft && (
            <span className="shrink-0 rounded bg-slate-500/20 px-1 text-[10px] text-slate-500">
              draft
            </span>
          )}
          {mr.conflicts && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--red)]">
              <AlertTriangle className="h-3 w-3" />
              conflicts
            </span>
          )}
          {threads > 0 && (
            <ThreadIndicator open={threads} summary={mr.threadSummary}>
              {threads}
            </ThreadIndicator>
          )}
          {mr.pipeline && (
            <span className="shrink-0 text-[10px]">
              <PipelineChip status={mr.pipeline} />
            </span>
          )}
          {mr.approved && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--green)]">
              <Check className="h-3 w-3" />
              approved
            </span>
          )}
        </a>
        <CardChips subject={{ mr }} className="mt-0.5" />
        {showDescription && mr.description && <MrDescription markdown={mr.description} />}
      </div>
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
  showDescriptions,
}: {
  showDescriptions: boolean;
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
      <div className="mb-1 flex items-baseline gap-2 px-2 text-[11px] text-[var(--text-secondary)]">
        <span>{title}</span>
        <span className={count > 0 ? 'font-semibold text-[var(--orange)]' : ''}>
          {count}/{total}
        </span>
      </div>
      {mrs.length === 0 ? (
        <div className="px-2 py-1 text-xs italic text-[var(--text-secondary)]">none</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {mrs.map((mr) => (
            <MrRow key={mr.key} mr={mr} badge={marker?.(mr) ?? undefined} env={env} showDescription={showDescriptions} />
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

function GlabMrView({
  close,
  env,
  settings,
  selectedSessionId,
  showDescriptions = true,
  onToggleDescriptions,
}: {
  showDescriptions?: boolean;
  onToggleDescriptions?: () => void;
  close: () => void;
  env: MrRowEnv;
  /** The plugin's settings — carries `hostname`; without it the CLI queries its default host. */
  settings?: { hostname?: unknown };
  /** The session selected in the panel — hosts the sign-in shell of the onboarding. */
  selectedSessionId?: string;
}) {
  const data = useMrOverview();
  const me = data.username ?? '';
  // Onboarding helpers: write the `hostname` setting, run the sign-in in a
  // shell tab of the selected (else first) session.
  const pluginSettingsCtx = usePluginSettingsOptional();
  const settingsKey = glabMrPlugin.settingsKey ?? glabMrPlugin.id;
  const loginSession = env.sessions.find((s) => s.id === selectedSessionId) ?? env.sessions[0];

  useEffect(() => {
    if (data.status === 'idle') void refreshMrOverview(settings);
    // Warm local repo discovery so a review click finds the clone at once.
    void env.checkouts?.().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = sortMine(data.mine);
  const review = sortReview(data.review, me);
  const mineAction = mine.filter((m) => mrNeedsAction(m)).length;
  const reviewWaiting = review.filter((m) => mrWaitingForMe(m, me)).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <PanelHeader
        icon={<GitMerge />}
        title="Merge requests"
        meta={
          <PanelHeaderChip title={data.host ? 'Host the glab CLI asks' : 'Host the glab CLI asks — its default'}>
            <Globe className="h-3 w-3 shrink-0" />
            {data.host ?? 'gitlab.com'}
          </PanelHeaderChip>
        }
      >
        {data.fetchedAt && (
          <span className="text-[11px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <PanelHeaderSpacer />
        {onToggleDescriptions && (
          <PanelHeaderButton
            title={showDescriptions ? 'Hide descriptions' : 'Show descriptions'}
            onClick={onToggleDescriptions}
            active={showDescriptions}
            pressed={showDescriptions}
          >
            <Text className="h-3.5 w-3.5" />
          </PanelHeaderButton>
        )}
        <button
          type="button"
          onClick={() => void refreshMrOverview(settings)}
          data-tip="Refresh"
          aria-label="Refresh"
          className={ghostButtonClass}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${data.status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={close}
          data-tip="Close"
          aria-label="Close"
          className={ghostButtonClass}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.status === 'error' && data.failure !== 'error' ? (
          <ForgeSetup
            cli="glab"
            forgeName="GitLab"
            defaultHost="gitlab.com"
            installUrl="https://gitlab.com/gitlab-org/cli"
            failure={data.failure === 'missing' ? 'missing' : 'signed-out'}
            host={data.host}
            suggestedHost={suggestForgeHost('gitlab', env.sessions, selectedSessionId)}
            icon={<GitMerge />}
            onUseHost={
              pluginSettingsCtx
                ? (host) => pluginSettingsCtx.updatePluginSection(settingsKey, { hostname: host })
                : undefined
            }
            onRunLogin={
              loginSession
                ? (command) => {
                    env.apiFor(loginSession.id)?.openSubShell(command, undefined, 'glab login');
                    env.selectSession(loginSession.id);
                  }
                : undefined
            }
            onRetry={() => void refreshMrOverview(settings)}
          />
        ) : data.status === 'error' ? (
          <div className="rounded-[var(--radius-lg)] bg-[var(--raised)] p-3.5 text-xs leading-relaxed text-[var(--text-primary)] shadow-[0_0_0_1px_var(--hairline)]">
            <div className="mb-1 font-semibold text-[var(--red)]">Failed to load merge requests</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            {isAuthHintRelevant('glab', data.error) && (
              <div className="text-[var(--text-secondary)]">
                Check <code className="text-[var(--accent)]">{authCommand('glab', 'status', data.host)}</code> in a shell.
              </div>
            )}
            {!data.host && (
              <div className="mt-1 text-[var(--text-secondary)]">{defaultHostNote('glab', 'GitLab')}</div>
            )}
          </div>
        ) : (
          <>
            <MrSection
              title="Assigned to me / authored without assignee"
              mrs={mine}
              count={mineAction}
              total={mine.length}
              marker={(m) => (mrNeedsAction(m) ? 'action' : null)}
              env={env}
              showDescriptions={showDescriptions}
            />
            <MrSection
              title="Review requested"
              mrs={review}
              count={reviewWaiting}
              total={review.length}
              marker={(m) => (mrWaitingForMe(m, me) ? 'waiting' : null)}
              env={env}
              showDescriptions={showDescriptions}
            />
            {data.status === 'loading' && (
              <div className="px-2 text-[11px] text-[var(--text-tertiary)]">Refreshing…</div>
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
  title: 'GitLab merge requests',
  logo: 'GitMerge',
  version: '0.1.0',
  sessionIdentifiers: glabMrIdentifiers,
  settings: [
    {
      key: 'ticketRegex',
      label: 'Ticket regex',
      description:
        'Regex for spotting ticket keys in merge request titles (e.g. `[A-Z][A-Z0-9_]+-\\d+`). When set, spotted tickets are advertised as session identifiers.',
      type: 'string',
    },
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
      key: 'watchMrChanges',
      label: 'Flag sessions on MR changes',
      description:
        'Attention dot on a session when its tracked merge request gets a failed pipeline, a new thread or a new comment.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'hostname',
      label: 'GitLab hostname',
      description: 'Overrides the glab api --hostname default.',
      type: 'string',
    },
    repoRootsSetting('GitLab'),
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
  sessionFields: [
    {
      id: 'mr',
      label: 'GitLab merge request',
      kind: 'inline',
      zone: 'title',
      // Searchable: the refs (`!622`/`#82`) and titles.
      search: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const items = (ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs ?? [];
        return items.flatMap((m) => [m.reference, m.title]);
      },
      value: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const state = ctx.pluginState as { mrs?: SessionMr[] } | undefined;
        const mrs = state?.mrs ?? [];
        if (mrs.length === 0) {
          const merged = (ctx.pluginState as { merged?: SessionMerged | null } | undefined)?.merged;
          return merged ? (
            <SessionMergedChip forge="GitLab" icon={<GitMerge className="h-2.5 w-2.5" />} merged={merged} />
          ) : null;
        }
        return <SessionMrChip forge="GitLab" icon={<GitMerge className="h-2.5 w-2.5" />} items={mrs} />;
      },
      tip: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const mrs =
          (ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs ?? [];
        if (mrs.length === 0) {
          const merged = (ctx.pluginState as { merged?: SessionMerged | null } | undefined)?.merged;
          return merged ? `${merged.reference}: merged — ${merged.title}` : null;
        }
        const first = mrs[0];
        return `${first.reference}${mrs.length > 1 ? ` +${mrs.length - 1}` : ''}: open merge request${mrs.length > 1 ? 's' : ''} on this branch — ${first.title}`;
      },
    },
    {
      id: 'mrs',
      label: 'GitLab merge requests',
      kind: 'block',
      zone: 'selected',
      search: (ctx) => {
        const settings = ctx.pluginSettings as
          | { showInPanel?: boolean; showInHeader?: boolean }
          | undefined;
        if ((settings?.showInPanel ?? settings?.showInHeader) === false) return null;
        const items = (ctx.pluginState as { mrs?: SessionMr[] } | undefined)?.mrs ?? [];
        return items.flatMap((m) => [m.reference, m.title]);
      },
      value: (ctx) => {
        const settings = ctx.pluginSettings as
          | { showInPanel?: boolean; showInHeader?: boolean }
          | undefined;
        // `showInHeader` is the legacy key so existing plugins.yaml values apply.
        if ((settings?.showInPanel ?? settings?.showInHeader) === false) return null;
        return <SessionMrs ctx={ctx} />;
      },
    },
  ],
  renderRail: ({
    pluginSettings,
    viewActive,
    toggleView,
    sessions,
    appState,
    updateAppState,
    sessionApi,
  }) => (
    <GlabMrRail
      pluginSettings={pluginSettings}
      viewActive={viewActive}
      toggleView={toggleView}
      sessions={sessions}
      appState={appState}
      updateAppState={updateAppState}
      sessionApi={sessionApi}
    />
  ),
  renderView: ({ pluginSettings, close, sessions, workspaces, selectSession, selectedSessionId, sessionApi, appState, updateAppState }) => (
    <GlabMrView
      close={close}
      showDescriptions={(appState as { showDescriptions?: boolean } | undefined)?.showDescriptions !== false}
      onToggleDescriptions={() =>
        updateAppState({
          showDescriptions: (appState as { showDescriptions?: boolean } | undefined)?.showDescriptions === false,
        })
      }
      settings={pluginSettings as { hostname?: unknown } | undefined}
      selectedSessionId={selectedSessionId}
      env={{
        sessions,
        workspaces,
        selectedSessionId,
        apiFor: sessionApi,
        selectSession,
        checkouts: () => forgeCheckouts(pluginSettings as { repoRoots?: unknown } | undefined),
      }}
    />
  ),
};
