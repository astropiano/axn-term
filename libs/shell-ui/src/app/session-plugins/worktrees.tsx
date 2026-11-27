import { GitFork } from 'lucide-react';
import { StatusChip } from '../StatusChip';
import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import type {
  PluginApi,
  RepoMenuItem,
  SessionViewContext,
  SessionViewPlugin,
} from './plugin';
import type { SessionBanner, Workspace } from '../../types';
import { sh, shellQuote, shellRaw } from '../../shellQuote';
import type { ShellSession } from '../../types';
import type { PluginSettings } from '../pluginSettings';
import { localCheckouts, parseRepoRoots } from '../repoDirectory';
import { pickFromList } from '../pickerHost';
import type { TargetActionContext, TicketTarget } from '../textTargets';

type Ctx = SessionViewContext & PluginApi;

/** Per-session pluginState for sessions living in a plugin-created worktree. */
interface WorktreeState {
  worktree?: { repoRoot: string; path: string; branch: string };
  /** The user answered "don't ask again" on the isolation banner. */
  dismissed?: boolean;
  /** This plugin's session banner (merged by `setBanner`). */
  banner?: SessionBanner | null;
}

interface WorktreesSettings {
  /** Comma-separated foreground-process names that trigger the nudge. */
  agents?: string;
  /** Agent command used by "New worktree with agent". */
  defaultAgent?: string;
  /** Agent asked to suggest a worktree name for an MR or ticket (`<agent> -p <prompt>`). */
  nameAgent?: string;
  /** Parent dir for new worktrees (default: `<repo-parent>/worktrees`). */
  worktreeRoot?: string;
  /** Raise the "agent in main checkout" banner. */
  suggestIsolation?: boolean;
}

/** `x` → a filesystem/branch-safe slug; '' when nothing usable remains. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Default: `<dirname(repoRoot)>/worktrees/<repoBase>-<slug>` — the same
 * sibling-`worktrees/` convention axn-dev uses, so the CLI discovers
 * plugin-created worktrees via plain `git worktree list`. A `rootOverride`
 * replaces the whole `<parent>/worktrees` segment (`<override>/<repo>-<slug>`).
 */
export function worktreeDirFor(
  repoRoot: string,
  slug: string,
  rootOverride?: string,
): string {
  const base =
    rootOverride?.trim() ||
    `${repoRoot.replace(/\/+$/, '').replace(/\/[^/]+$/, '')}/worktrees`;
  const repoName = repoRoot.replace(/\/+$/, '').split('/').pop() ?? 'repo';
  return `${base}/${repoName}-${slug}`;
}

/** Branch created for a worktree — `wt/` keeps them greppably namespaced. */
export function worktreeBranchFor(slug: string): string {
  return `wt/${slug}`;
}

export function parseAgentList(raw: unknown): string[] {
  if (typeof raw !== 'string') return ['claude', 'devin', 'codex', 'agy', 'vibe'];
  const agents = raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return agents.length ? agents : ['claude', 'devin', 'codex', 'agy', 'vibe'];
}

/**
 * `<agent> -p '<prompt>'` asking for a worktree slug for an MR. The agent is
 * the user's own `nameAgent` setting (a command, may carry flags) and goes in
 * as-is; the MR reference and title come from the forge, so the prompt is one
 * single-quoted word — no `$(…)`, backtick or `\` in a title can run.
 */
export function nameAgentCmd(agent: string, ref: string, title: string): string {
  return sh`${shellRaw(agent)} -p ${`reply with only a short kebab-case git branch slug for merge request ${ref}: ${title}`}`;
}

/** How an agent resumes its last conversation, when it supports one. */
export function agentResumeCommand(agent: string): string | null {
  switch (agent.toLowerCase()) {
    case 'claude':
      return 'claude -c';
    case 'devin':
      return 'devin -c';
    case 'codex':
      return 'codex resume --last';
    case 'agy':
    case 'antigravity':
      return 'agy -c';
    case 'vibe':
      return 'vibe -r';
    default:
      return null;
  }
}


export function addWorktreeCmd(repoRoot: string, dir: string, branch: string): string {
  return `git -C ${shellQuote(repoRoot)} worktree add ${shellQuote(dir)} -b ${shellQuote(branch)}`;
}

export function removeWorktreeCmd(repoRoot: string, dir: string, force = false): string {
  return `git -C ${shellQuote(repoRoot)} worktree remove ${force ? '--force ' : ''}${shellQuote(dir)}`;
}

export function deleteBranchCmd(repoRoot: string, branch: string): string {
  return `git -C ${shellQuote(repoRoot)} branch -D ${shellQuote(branch)}`;
}

/**
 * Prints `main` or `worktree` — compares `--git-dir` with `--git-common-dir`
 * (equal in the main checkout, different inside a linked worktree). Exits 1
 * outside a repo.
 */
export const WORKTREE_KIND_CMD = `d=$(git rev-parse --git-dir) && c=$(git rev-parse --git-common-dir) || exit 1
[ "$d" = "$c" ] && echo main || echo worktree`;

/** Worktree path → what to seed/set on the session that opens in it. */
const pendingWorktrees = new Map<
  string,
  { repoRoot: string; branch: string; seed?: string }
>();
/** Isolation-check result per session — never re-run for a session. */
const kindChecks = new Map<string, Promise<'main' | 'worktree' | 'none'>>();
/** Sessions already nudged — the banner's ✕ is transient, so don't re-raise. */
const nudged = new Set<string>();
/**
 * The last removed worktree per session — pluginState.worktree is already
 * cleared when the post-remove banner's "Delete branch" action fires.
 */
const removedWorktrees = new Map<
  string,
  { repoRoot: string; path: string; branch: string }
>();

export function normPath(p?: string): string {
  return (p ?? '').replace(/\/+$/, '');
}

/**
 * The repo a worktree should be created from: the session's own repo first
 * (covers worktree-inside-worktree), then the workspace `defaultFolder`,
 * then the session's live cwd.
 */
async function resolveRepoRoot(ctx: Ctx): Promise<string | null> {
  const repo = ctx.getSession().repo?.root;
  if (repo) return repo;
  const folder = ctx.getWorkspace?.()?.defaultFolder;
  if (folder) {
    try {
      const root = await ctx.exec('git rev-parse --show-toplevel', folder);
      if (root) return root;
    } catch {
      /* not a repo */
    }
  }
  const cwd = await ctx.getCwd();
  if (cwd) {
    try {
      const root = await ctx.exec('git rev-parse --show-toplevel', cwd);
      if (root) return root;
    } catch {
      /* not a repo */
    }
  }
  return null;
}

/** `main` when the session's live cwd is a repo's primary checkout. */
function sessionKind(ctx: Ctx): Promise<'main' | 'worktree' | 'none'> {
  const id = ctx.session.id;
  const cached = kindChecks.get(id);
  if (cached) return cached;
  const p = (async (): Promise<'main' | 'worktree' | 'none'> => {
    const cwd = await ctx.getCwd();
    if (!cwd) return 'none';
    try {
      const kind = await ctx.exec(WORKTREE_KIND_CMD, cwd);
      return kind === 'main' ? 'main' : kind === 'worktree' ? 'worktree' : 'none';
    } catch {
      return 'none';
    }
  })();
  kindChecks.set(id, p);
  return p;
}

function settingsOf(ctx: Ctx): WorktreesSettings {
  return (ctx.pluginSettings ?? {}) as WorktreesSettings;
}

/**
 * Create worktree + branch off the repo's HEAD, then open a session rooted
 * at it. `seed` (e.g. an agent resume line) is written to the new session's
 * PTY once it opens.
 */
async function createWorktreeSession(
  ctx: Ctx,
  repoRoot: string,
  name?: string,
  seed?: string,
): Promise<void> {
  const slug = slugify(name ?? '') || `w-${Date.now().toString(36)}`;
  // One scheme for every worktree: `<repo>-<name>` on `wt/<name>`.
  const branch = worktreeBranchFor(slug);
  const dir = worktreeDirFor(repoRoot, slug, settingsOf(ctx).worktreeRoot);
  try {
    await ctx.exec(addWorktreeCmd(repoRoot, dir, branch), repoRoot);
  } catch (e) {
    ctx.setBanner({ level: 'error', message: `worktree add failed: ${String(e)}` });
    return;
  }
  pendingWorktrees.set(dir, { repoRoot, branch, seed });
  ctx.openSession(dir, slug);
}

// ── Ticket worktrees ─────────────────────────────────────────────────
// One naming scheme for every worktree the app creates:
// `<parent>/worktrees/<repo>-<name>` on branch `wt/<name>`. A ticket's name is
// `<KEY>-<slug>` (the slug from its summary, or the `name-agent`'s
// suggestion), so the kanban's Start and the hover card's "Start worktree"
// land on the same checkout.

/**
 * The main checkout behind `root`, given git's absolute common dir
 * (`git rev-parse --path-format=absolute --git-common-dir`). A linked
 * worktree's common dir is the main checkout's `.git`, so its parent is the
 * repo every worktree hangs off — without this, a review started from a
 * session in `…/worktrees/foo` nested its worktree at
 * `…/worktrees/worktrees/foo-mr-N`. Bare repos and unexpected output keep
 * `root`.
 */
export function mainCheckoutOf(root: string, commonDir: string): string {
  const dir = commonDir.trim().replace(/\/+$/, '');
  if (!dir.startsWith('/') || !dir.endsWith('/.git')) return root;
  return dir.slice(0, -'/.git'.length) || root;
}

/** `mainCheckoutOf` through git; any failure keeps `root`. */
export async function resolveMainCheckout(api: Pick<Ctx, 'exec'>, root: string): Promise<string> {
  const out = await api
    .exec(`git -C ${shellQuote(root)} rev-parse --path-format=absolute --git-common-dir`, root)
    .catch(() => '');
  return mainCheckoutOf(root, String(out ?? ''));
}

/** Most characters of a ticket worktree's slug — cut at a word boundary. */
const TICKET_SLUG_MAX = 40;

/** A ticket summary → its worktree slug ('' when nothing usable remains). */
export function ticketSlug(summary: string | undefined): string {
  const slug = slugify(summary ?? '').replace(/[._]+/g, '-').replace(/-{2,}/g, '-');
  if (slug.length <= TICKET_SLUG_MAX) return slug.replace(/-+$/, '');
  const cut = slug.slice(0, TICKET_SLUG_MAX + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : cut.slice(0, TICKET_SLUG_MAX)).replace(/-+$/, '');
}

/** `<KEY>-<slug>`, or the bare key when there is no slug. */
export function ticketWorktreeName(key: string, slug?: string): string {
  const s = ticketSlug(slug);
  return s ? `${key.toUpperCase()}-${s}` : key.toUpperCase();
}

/**
 * The existing worktree of ticket `key` in `git worktree list --porcelain`
 * output — matched by the key in the folder name or the branch, so the
 * older `<repo>-<KEY>` (kanban) and `<repo>-wt-<key>-…` (worktrees plugin)
 * layouts are reused instead of duplicated. The main checkout never counts.
 */
export function findTicketWorktree(
  porcelain: string,
  key: string,
): { path: string; branch?: string } | undefined {
  const re = new RegExp(`(?<![A-Za-z0-9])${key.replace(/[^A-Za-z0-9]/g, '\\$&')}(?!\\d)`, 'i');
  const blocks = porcelain.split(/\n\s*\n/).filter((b) => b.trim());
  for (const [i, block] of blocks.entries()) {
    if (i === 0) continue; // the main checkout
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim();
    const base = path.replace(/\/+$/, '').split('/').pop() ?? '';
    if (re.test(base) || (branch && re.test(branch))) return { path, branch };
  }
  return undefined;
}

/** Shell script: reuse or create the ticket worktree off the default branch. */
export function ticketWorktreeScript(root: string, dir: string, branch: string): string {
  const r = shellQuote(root);
  const d = shellQuote(dir);
  const b = shellQuote(branch);
  return [
    `if git -C ${d} rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi`,
    `git -C ${r} fetch origin >/dev/null 2>&1 || true`,
    `base=$(git -C ${r} symbolic-ref -q --short refs/remotes/origin/HEAD || echo HEAD)`,
    `if git -C ${r} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then`,
    `  git -C ${r} worktree add ${d} ${b}`,
    'else',
    `  git -C ${r} worktree add -b ${b} ${d} "$base"`,
    'fi',
  ].join('\n');
}

/**
 * `<agent> -p '<prompt>'` asking for a worktree slug for a ticket — like
 * `nameAgentCmd`, one single-quoted prompt word.
 */
export function ticketNameAgentCmd(agent: string, key: string, summary: string): string {
  return sh`${shellRaw(agent)} -p ${`reply with only a short kebab-case git branch slug (max 5 words) for ticket ${key}: ${summary}`}`;
}

/**
 * Main checkouts a ticket can start in: repo-dir providers (axn-dev) plus the
 * forge plugins' `repo-roots`, and the repos of open sessions that are not
 * themselves linked worktrees.
 */
export async function ticketRepoCandidates(
  host: Pick<Ctx, 'exec'>,
  sessions: ShellSession[],
  settings: PluginSettings,
): Promise<string[]> {
  const roots = [
    ...parseRepoRoots(settings['glab-mr']?.repoRoots),
    ...parseRepoRoots(settings['gh-pr']?.repoRoots),
  ];
  const found = await localCheckouts((c, cwd) => host.exec(c, cwd), roots).catch(() => []);
  const paths = new Set<string>();
  for (const c of found) if (c.isMain !== false) paths.add(normPath(c.path));
  for (const s of sessions) {
    const root = s.repo?.root;
    if (root && !/\/worktrees\//.test(root)) paths.add(normPath(root));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Reuse or create ticket `key`'s worktree under main checkout `root`. An
 * existing one (any layout, see `findTicketWorktree`) wins; otherwise
 * `<repo>-<KEY>-<slug>` on `wt/<KEY>-<slug>` off origin's default branch.
 * The slug is the `nameAgent`'s answer when set, else the summary's.
 */
export async function prepareTicketWorktree(
  host: Pick<Ctx, 'exec'>,
  root: string,
  ticket: { key: string; summary?: string },
  opts: { worktreeRoot?: string; nameAgent?: string } = {},
): Promise<{ dir: string; branch: string; reused: boolean }> {
  const list = await host
    .exec(`git -C ${shellQuote(root)} worktree list --porcelain`, root)
    .catch(() => '');
  const found = findTicketWorktree(String(list ?? ''), ticket.key);
  if (found) return { dir: normPath(found.path), branch: found.branch ?? '', reused: true };
  let slug = ticketSlug(ticket.summary);
  const agent = opts.nameAgent?.trim();
  if (agent) {
    const suggestion = await host
      .exec(ticketNameAgentCmd(agent, ticket.key, ticket.summary ?? ''), root)
      .then((out) => ticketSlug(String(out ?? '').trim().split('\n')[0]))
      .catch(() => '');
    if (suggestion) slug = suggestion;
  }
  const name = ticketWorktreeName(ticket.key, slug);
  const dir = worktreeDirFor(root, name, opts.worktreeRoot);
  const branch = worktreeBranchFor(name);
  await host.exec(ticketWorktreeScript(root, dir, branch), root);
  return { dir, branch, reused: false };
}

/**
 * The hover card's "Start worktree" on a ticket: pick a main checkout (the
 * hovered session's repo first), reuse or create the ticket worktree and
 * open — or select — a session there.
 */
async function startTicketWorktree(target: TicketTarget, tctx: TargetActionContext): Promise<void> {
  const origin = tctx.api();
  if (!origin) return;
  const fail = (message: string) =>
    origin.setBanner({ level: 'error', message: `${target.key}: ${message}` });
  const own = (tctx.pluginSettings ?? {}) as WorktreesSettings;
  let candidates = await ticketRepoCandidates(origin, tctx.sessions, tctx.settings);
  const originRoot = origin.getSession().repo?.root;
  if (originRoot) {
    const main = normPath(await resolveMainCheckout(origin, originRoot));
    candidates = [main, ...candidates.filter((c) => c !== main)];
  }
  if (candidates.length === 0) {
    fail('no local repo found — open a session in the repo, or set repo-roots on glab-mr/gh-pr');
    return;
  }
  const root =
    candidates.length === 1
      ? candidates[0]
      : await pickFromList({
          title: t`Start ${target.key} in…`,
          placeholder: t`Repository`,
          items: candidates.map((p) => ({ key: p, label: p.split('/').pop() ?? p, detail: p })),
        });
  if (!root) return;
  const summary = target.summary ?? (await target.resolveSummary?.().catch(() => undefined));
  let prepared: Awaited<ReturnType<typeof prepareTicketWorktree>>;
  try {
    prepared = await prepareTicketWorktree(origin, root, { key: target.key, summary }, own);
  } catch (e) {
    fail(`worktree failed: ${String(e).split('\n')[0].slice(0, 200)}`);
    return;
  }
  const open = tctx.sessions.find(
    (s) => normPath(s.repo?.root ?? s.cwd) === normPath(prepared.dir),
  );
  if (open) {
    tctx.selectSession(open.id);
    return;
  }
  pendingWorktrees.set(normPath(prepared.dir), { repoRoot: root, branch: prepared.branch });
  origin.openSession(prepared.dir, `${target.key} ${summary ?? ''}`.trim().slice(0, 80));
}

function stateOf(ctx: Ctx): WorktreeState {
  return (ctx.pluginState ?? {}) as WorktreeState;
}

/**
 * The branch the worktree badge shows: the probed repo branch when `repo`
 * describes this worktree (git-status keeps it live — `git checkout` moves
 * it), else the branch recorded when the session opened.
 */
function worktreeBranch(ctx: Ctx): string {
  const wt = stateOf(ctx).worktree;
  const repo = ctx.session.repo;
  if (wt && repo && normPath(repo.root) === normPath(wt.path)) {
    return repo.branch ?? '(detached)';
  }
  return wt?.branch ?? '';
}

function worktreeItems(ctx: Ctx, sourceDir?: string): RepoMenuItem[] {
  const agent = settingsOf(ctx).defaultAgent?.trim() || 'claude';
  const items: RepoMenuItem[] = [
    {
      label: 'New worktree session',
      onClick: () => {
        void (async () => {
          const root = sourceDir
            ? await ctx.exec('git rev-parse --show-toplevel', sourceDir).catch(() => null)
            : await resolveRepoRoot(ctx);
          if (!root) {
            ctx.setBanner({ level: 'error', message: 'worktrees: not inside a git repository' });
            return;
          }
          await createWorktreeSession(ctx, root);
        })();
      },
    },
    {
      label: `New worktree with ${agent}`,
      onClick: () => {
        void (async () => {
          const root = sourceDir
            ? await ctx.exec('git rev-parse --show-toplevel', sourceDir).catch(() => null)
            : await resolveRepoRoot(ctx);
          if (!root) {
            ctx.setBanner({ level: 'error', message: 'worktrees: not inside a git repository' });
            return;
          }
          await createWorktreeSession(ctx, root, undefined, agent);
        })();
      },
    },
  ];
  return items;
}

export const worktreesPlugin: SessionViewPlugin = {
  id: 'worktrees',
  title: 'worktrees',
  version: '0.1.0',
  settingsKey: 'worktrees',
  stateKey: 'worktrees',
  defaultEnabled: false,
  settings: [
    {
      key: 'nameAgent',
      label: 'Worktree name agent',
      description:
        'Agent command asked to suggest a worktree name for an MR or a ticket (e.g. claude, devin — run as `<agent> -p <prompt>`). Empty derives it from the MR reference or the ticket summary.',
      type: 'string',
      default: '',
    },
    {
      key: 'agents',
      label: 'Agent process names',
      description:
        'Comma-separated foreground processes that trigger the isolation banner (e.g. claude, devin, codex, agy).',
      type: 'string',
      default: 'claude, devin, codex, agy',
    },
    {
      key: 'defaultAgent',
      label: 'Default agent',
      description: 'Agent command seeded into "New worktree with agent" sessions.',
      type: 'string',
      default: 'claude',
    },
    {
      key: 'worktreeRoot',
      label: 'Worktree parent dir',
      description: 'New worktrees go under <dir>/<repo>-<slug>. Empty: <repo-parent>/worktrees.',
      type: 'string',
      default: '',
    },
    {
      key: 'suggestIsolation',
      label: 'Suggest worktree isolation',
      description: 'Warn when an agent runs in a main checkout instead of a worktree.',
      type: 'boolean',
      default: true,
    },
  ],

  targetActions: (target, tctx) =>
    target.kind === 'ticket'
      ? [
          {
            id: 'start-worktree',
            label: t`Start worktree`,
            tip: t`Create or reuse this ticket's worktree and open a session in it`,
            icon: <GitFork className="h-3 w-3" />,
            run: () => startTicketWorktree(target, tctx),
          },
        ]
      : [],

  onSessionOpen: (ctx) => {
    clearStaleIsolationBanner(ctx);
    const dir = normPath(ctx.session.cwd);
    const pending = pendingWorktrees.get(dir);
    if (pending) {
      pendingWorktrees.delete(dir);
      ctx.updatePluginState({
        worktree: { repoRoot: pending.repoRoot, path: dir, branch: pending.branch },
      });
      if (pending.seed) {
        const seed = pending.seed;
        void ctx.waitForSessionOutput(5000).then(() => ctx.writeToSession(`${seed}\n`));
      }
      return;
    }
    // A session can open inside a worktree this plugin didn't create — e.g.
    // dev-workflow's MR review action. Probe once (kindChecks caches) so the
    // badge + retire actions still apply.
    void sessionKind(ctx).then(async (kind) => {
      if (kind !== 'worktree' || stateOf(ctx).worktree) return;
      const [branch, common] = await Promise.all([
        ctx.exec('git rev-parse --abbrev-ref HEAD', dir).catch(() => ''),
        ctx
          .exec('git rev-parse --path-format=absolute --git-common-dir', dir)
          .catch(() => ''),
      ]);
      const repoRoot = common.trim().endsWith('/.git')
        ? common.trim().slice(0, -'/.git'.length)
        : dir;
      ctx.updatePluginState({
        worktree: { repoRoot, path: dir, branch: branch.trim() },
      });
    });
  },

  onOutput: (ctx) => {
    // Nudge: an agent running in the main checkout. The git-dir probe is an
    // exec, so it runs once per session (kindChecks cache); the banner is
    // raised at most once per session (nudged) since its ✕ can't call back.
    if (settingsOf(ctx).suggestIsolation === false) return;
    clearStaleIsolationBanner(ctx);
    const s = stateOf(ctx);
    if (s.dismissed || s.worktree || nudged.has(ctx.session.id)) return;
    const proc = (ctx.session.process ?? '').toLowerCase();
    const agent = parseAgentList(settingsOf(ctx).agents).find((a) => proc.includes(a));
    if (!agent) return;
    nudged.add(ctx.session.id);
    void sessionKind(ctx).then((kind) => {
      if (kind !== 'main') return;
      const fresh = stateOf(ctx);
      if (fresh.dismissed || fresh.worktree) return;
      raiseIsolationBanner(ctx, agent);
    });
  },

  /**
   * `mr-worktree` (declared by the gh/glab MR-watch flags): create a
   * worktree for the flagged MR and open a session in it. The flag's ctx is
   * bound to the session that raised it — its repo.root is the repo.
   */
  onAttentionAction: (ctx, actionId, attention) => {
    if (actionId !== 'mr-worktree') return;
    const payload = (attention.data as
      | { mr?: { reference?: string; iid?: number; title?: string }
          pr?: { reference?: string; number?: number; title?: string } }
      | undefined);
    const mr = payload?.mr ?? payload?.pr;
    if (!mr) return;
    const ref = mr.reference ?? `mr-${(mr as { iid?: number; number?: number }).iid ?? (mr as { number?: number }).number ?? '?'}`;
    void (async () => {
      const root = ctx.session.repo?.root ?? (await resolveRepoRoot(ctx));
      if (!root) {
        ctx.setBanner({ level: 'error', message: 'worktrees: not inside a git repository' });
        return;
      }
      let name = `${ref.replace(/^[!#]/, '')}-${slugify(mr.title ?? '')}`;
      const agent = settingsOf(ctx).nameAgent?.trim();
      if (agent) {
        const suggestion = await ctx
          .exec(nameAgentCmd(agent, ref, mr.title ?? ''), root)
          .then((out) => slugify(out.split('\n')[0] ?? ''))
          .catch(() => '');
        if (suggestion) name = `${ref.replace(/^[!#]/, '')}-${suggestion}`;
      }
      await createWorktreeSession(ctx, root, name);
    })();
  },

  onBannerAction: (ctx, actionId) => {
    const wt = stateOf(ctx).worktree ?? removedWorktrees.get(ctx.session.id);
    if (actionId === 'isolate') {
      ctx.setBanner(null);
      const proc = (ctx.session.process ?? '').toLowerCase();
      const agent = parseAgentList(settingsOf(ctx).agents).find((a) => proc.includes(a)) ?? 'claude';
      const seed = agentResumeCommand(agent) ?? agent;
      void (async () => {
        const root = await resolveRepoRoot(ctx);
        if (!root) return;
        await createWorktreeSession(ctx, root, undefined, seed);
      })();
      return;
    }
    if (actionId === 'never-isolate') {
      ctx.updatePluginState({ dismissed: true });
      ctx.setBanner(null);
      return;
    }
    if (actionId === 'remove-force' && wt) {
      ctx.setBanner(null);
      void removeWorktree(ctx, wt, true);
      return;
    }
    if (actionId === 'remove-branch' && wt) {
      ctx.setBanner(null);
      removedWorktrees.delete(ctx.session.id);
      void ctx
        .exec(deleteBranchCmd(wt.repoRoot, wt.branch), wt.repoRoot)
        .catch((e) =>
          ctx.setBanner({ level: 'error', message: `branch delete failed: ${String(e)}` }),
        );
      return;
    }
  },

  sessionMenuItems: (ctx) => {
    const wt = stateOf(ctx).worktree;
    if (wt) {
      return [
        {
          label: i18n._(t`Review worktree changes`),
          onClick: () => ctx.openTab({ path: wt.path, kind: 'git' }),
        },
        {
          label: i18n._(t`Remove worktree`),
          onClick: () => void removeWorktree(ctx, wt, false),
        },
      ];
    }
    return worktreeItems(ctx);
  },

  workspaceMenuItems: (ctx, workspace: Workspace) => {
    if (!workspace.defaultFolder) return [];
    return worktreeItems(ctx, workspace.defaultFolder);
  },

  commands: [
    {
      name: 'axn-worktree',
      takesArg: true,
      run: async (ctx, arg) => {
        const root = await resolveRepoRoot(ctx);
        if (!root) return `echo 'axn-worktree: not inside a git repository'`;
        await createWorktreeSession(ctx, root, arg);
        return false;
      },
    },
  ],

  sessionFields: [
    {
      id: 'worktree',
      label: 'Worktree',
      kind: 'inline',
      zone: 'title',
      search: (ctx) => {
        const wt = stateOf(ctx).worktree;
        if (!wt) return null;
        return [wt.branch, worktreeBranch(ctx), wt.path.split('/').pop() ?? ''];
      },
      value: (ctx) => {
        const wt = stateOf(ctx).worktree;
        if (!wt) return null;
        const branch = worktreeBranch(ctx);
        return (
          <StatusChip
            color="violet"
            tip={`worktree ${branch}\n${wt.path}`}
            icon={<GitFork className="h-2.5 w-2.5 shrink-0" />}
          >
            <span className="max-w-16 truncate">{branch.replace(/^wt\//, '')}</span>
          </StatusChip>
        );
      },
      tip: (ctx) => {
        const wt = stateOf(ctx).worktree;
        return wt ? `⎇ ${worktreeBranch(ctx)}: linked worktree — ${wt.path}` : null;
      },
    },
  ],
  onClose: (ctx) => {
    kindChecks.delete(ctx.session.id);
    nudged.delete(ctx.session.id);
    removedWorktrees.delete(ctx.session.id);
  },
};

/**
 * The isolation banner persists in pluginState (across agent exits and app
 * restarts). Clear it once no configured agent is foreground — and un-nudge,
 * since an auto-clear is not a dismissal: a later agent run may nudge again.
 */
function clearStaleIsolationBanner(ctx: Ctx): void {
  const s = stateOf(ctx);
  if (!s.banner?.actions?.some((a) => a.id === 'isolate')) return;
  const proc = (ctx.session.process ?? '').toLowerCase();
  const agent = parseAgentList(settingsOf(ctx).agents).find((a) => proc.includes(a));
  if (agent) return;
  ctx.setBanner(null);
  nudged.delete(ctx.session.id);
}

function raiseIsolationBanner(ctx: Ctx, agent: string) {
  ctx.setBanner({
    level: 'warning',
    message: i18n._(t`${agent} is running in the main checkout — isolate it in a worktree?`),
    actions: [{ id: 'isolate', label: i18n._(t`New worktree session`) }],
    trailingActions: [{ id: 'never-isolate', label: i18n._(t`Don't ask again`) }],
  });
}

async function removeWorktree(
  ctx: Ctx,
  wt: { repoRoot: string; path: string; branch: string },
  force: boolean,
): Promise<void> {
  try {
    await ctx.exec(removeWorktreeCmd(wt.repoRoot, wt.path, force), wt.repoRoot);
  } catch (e) {
    ctx.setBanner({
      level: 'error',
      message: i18n._(t`worktree remove failed (dirty?): ${String(e)}`),
      actions: [{ id: 'remove-force', label: i18n._(t`Force remove`) }],
    });
    return;
  }
  ctx.updatePluginState({ worktree: null });
  removedWorktrees.set(ctx.session.id, wt);
  ctx.setBanner({
    level: 'info',
    message: i18n._(t`worktree removed — branch ${wt.branch} kept`),
    actions: [{ id: 'remove-branch', label: i18n._(t`Delete ${wt.branch}`) }],
  });
}
