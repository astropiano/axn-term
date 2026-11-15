import { GitFork } from 'lucide-react';
import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import type {
  PluginApi,
  RepoMenuItem,
  SessionViewContext,
  SessionViewPlugin,
} from './plugin';
import type { SessionBanner, Workspace } from '../../types';
import { shellQuote } from '../../shellQuote';

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
  /** Agent asked to suggest a worktree name for an MR (`<agent> -p <prompt>`). */
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
  const branch = worktreeBranchFor(slug);
  // Dir suffix is the slugified branch — axn-dev's <repo>-<branch-slug> shape.
  const dir = worktreeDirFor(repoRoot, slugify(branch), settingsOf(ctx).worktreeRoot);
  try {
    await ctx.exec(addWorktreeCmd(repoRoot, dir, branch), repoRoot);
  } catch (e) {
    ctx.setBanner({ level: 'error', message: `worktree add failed: ${String(e)}` });
    return;
  }
  pendingWorktrees.set(dir, { repoRoot, branch, seed });
  ctx.openSession(dir, slug);
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
        'Agent command asked to suggest a worktree name for an MR (e.g. claude, devin — run as `<agent> -p <prompt>`). Empty derives it from the MR reference.',
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
          .exec(
            `${agent} -p "reply with only a short kebab-case git branch slug for merge request ${ref}: ${(mr.title ?? '').replace(/"/g, '')}"`,
            root,
          )
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
          <span
            className="flex shrink-0 items-center gap-0.5 font-mono text-[9px] leading-none text-[var(--violet)]"
            data-tip={`worktree ${branch}\n${wt.path}`}
          >
            <GitFork className="h-2.5 w-2.5 shrink-0" />
            <span className="max-w-16 truncate">{branch.replace(/^wt\//, '')}</span>
          </span>
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
