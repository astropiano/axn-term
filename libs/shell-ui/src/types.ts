export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'blocked' | 'completed';

export type AttentionLevel = 'warning' | 'critical';

/**
 * A "needs attention" flag raised by a session-view plugin. Stored in the
 * plugin's pluginState under the reserved key `attention`, so several plugins
 * can flag the same session independently.
 */
export interface SessionAttention {
  /** Short reason shown in the indicator tooltip. */
  message?: string;
  /** critical (default): red pulsing dot; warning: orange. */
  level?: AttentionLevel;
  /**
   * Declared action buttons shown in the attention modal. `id` is routed
   * back: `goto-session:<sessionId>` is handled by the app itself,
   * `<plugin>:<action>` to that plugin's `onAttentionAction`. `data` carries
   * the raiser's serializable payload (e.g. MR url/iid/title).
   */
  actions?: AttentionAction[];
  data?: unknown;
}

/** A button declared on an attention flag (see SessionAttention.actions). */
export interface AttentionAction {
  id: string;
  label: string;
}

export type BannerLevel = 'info' | 'warning' | 'error';

/**
 * A button declared on a session banner. Clicks are routed back to the
 * owning plugin's `onBannerAction` with the action's `id` — the data stays
 * JSON-serializable so it can live in pluginState.
 */
export interface SessionBannerAction {
  id: string;
  /** Built-in icon name; when absent `label` is rendered as text. */
  icon?: 'chevron-left' | 'chevron-right' | 'play' | 'trash';
  /** Optional text rendered after the icon. */
  label?: string;
  title?: string;
  /** Rendered but not clickable (e.g. a move action at a workflow's edge). */
  disabled?: boolean;
}

/**
 * A banner message raised by a session-view plugin. Stored in the plugin's
 * pluginState under the reserved key `banner`, so several plugins can show
 * one on the same session. Rendered as a strip on top of the session view.
 */
export interface SessionBanner {
  message: string;
  /**
   * Secondary text rendered after the message in a lighter tone —
   * truncates with an ellipsis, the tooltip shows it in full.
   */
  detail?: string;
  /** info (default): accent; warning: orange; error: red. */
  level?: BannerLevel;
  /** Default true. When false no ✕ is shown — the plugin clears the banner. */
  dismissible?: boolean;
  /** Optional buttons rendered before the message (leading slot). */
  actions?: SessionBannerAction[];
  /** Optional buttons rendered at the right end of the banner. */
  trailingActions?: SessionBannerAction[];
}

export interface RepoInfo {
  name: string;
  group?: string;
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  untracked: number;
  remoteBranchMissing: boolean;
  root: string;
  remote?: string;
}

export interface Workspace {
  id: string;
  name: string;
  collapsed?: boolean;
  /**
   * The workspace's anchor directory — new sessions created via "+" start
   * here instead of the default cwd, and plugins (e.g. worktrees) resolve
   * the workspace's repository from it. Set/cleared from the workspace
   * context menu.
   */
  defaultFolder?: string;
  /** Per-plugin state, keyed by plugin `settingsKey`; follows the workspace. */
  pluginState?: Record<string, unknown>;
}

/** Agent CLIs whose conversations a sub-shell tab can host and resume. */
export type AgentCli = 'devin' | 'claude' | 'agy' | 'codex' | 'opencode';

/**
 * Tab kinds that take terminal input — broadcast fan-out only targets
 * sessions whose *active* view is one of these. Any view that renders a
 * PTY (main shell 'shell' tab id, 'shell'-kind editor tabs) declares
 * itself here; views without a terminal (editor, browser, preview, git,
 * ide, broadcast) are not broadcast targets.
 */
export const TAB_ACCEPTS_INPUT = new Set(['shell']);
/** Whether the session's currently-active tab accepts broadcast input. */
export function activeTabAcceptsInput(session: {
  activeTab?: string;
  editors?: { id: string; kind?: string }[];
}): boolean {
  const active = session.activeTab ?? 'shell';
  const kind =
    active === 'shell'
      ? 'shell'
      : session.editors?.find((e) => e.id === active)?.kind;
  return !!kind && TAB_ACCEPTS_INPUT.has(kind);
}

export interface EditorTab {
  id: string;
  path: string;
  dirty?: boolean;
  /**
   * 'browser' is a directory tree, 'shell' a sub-shell PTY, 'preview' a
   * read-only file preview rendered by a preview plugin, 'git' the repo
   * inspect view (`path` is the repo root), 'ide' a tree+editor composite
   * (`path` is the tree's root dir); default is a file editor.
   */
  kind?: 'editor' | 'browser' | 'shell' | 'preview' | 'git' | 'ide';
  /** For kind 'shell': the `sh -c` command; absent means an interactive sub-shell. */
  command?: string;
  /**
   * For kind 'shell': agent whose conversation this tab hosts (git-inspect
   * "talk" tabs, workflow `agent:` sub-shells). Once the tab has run,
   * re-spawns resume the conversation instead of re-running the seed
   * `command`.
   */
  agent?: AgentCli;
  /**
   * For kind 'shell': command run in place of `command` on every spawn after
   * the first — the agent resume line (`devin -r <name>` once the session
   * name was captured, `devin -c`/`claude -c`/`agy -c`/
   * `codex resume --last` before that).
   */
  resumeCommand?: string;
  /**
   * For kind 'shell': agent running in this tab right now (from the
   * sub-shell's foreground process) — kept when the app's close stops it,
   * cleared when it exits on its own. A tab whose agent was running when the
   * app went away resumes it on the next spawn (`subShellAgents.ts`).
   */
  agentActive?: 'claude' | 'devin';
  /**
   * For kind 'shell': the exact resume line captured from that agent's exit
   * hint (`claude --resume <id>`, `devin -r <name>`); absent → the agent's
   * "continue latest" fallback.
   */
  agentResume?: string;
  /**
   * For kind 'shell': status reported by the hooks of the agent running in
   * this tab (`app/subShellHooks.ts`) — the tab-level counterpart of
   * `session.status`. 'completed' outlives the agent; anything else clears
   * when it exits.
   */
  hookStatus?: SessionStatus;
  /** For kind 'shell': the tab agent's hook-raised flag — rolls up into the session's attention. */
  hookAttention?: SessionAttention | null;
  /**
   * For kind 'shell': the task list of the agent running in this tab, read
   * from the tab's screen (`app/subShellTasks.ts`), and its done share 0–100.
   */
  tasks?: Task[];
  progress?: number;
  /** For kind 'shell': working directory override; defaults to the session's live cwd. */
  cwd?: string;
  /** For kind 'shell': custom tab label; absent falls back to the command/dir default. */
  label?: string;
  /**
   * For kind 'git': compare ref — the inspect view adds a "Changes vs
   * `<base>`" section diffing merge-base(base, HEAD) against HEAD (three-dot
   * semantics), e.g. `origin/develop` for a merge-request review worktree.
   */
  base?: string;
  /**
   * For kind 'git': anchored review comments on the diff — re-anchored by
   * content on each refresh (`app/diffComments.ts`), sent to an agent tab
   * as a review prompt.
   */
  comments?: DiffComment[];
}

/** An anchored review comment on a git-inspect diff. */
export interface DiffComment {
  id: string;
  /** Repo-relative path (new name for renames). */
  path: string;
  /** Repo-relative source path for renames/copies. */
  oldPath?: string;
  /** Which diff side the comment anchors: 'new' = post-image/worktree. */
  side: 'old' | 'new';
  /** File-space line range at capture time (1-based, end inclusive). */
  range: [number, number];
  anchor: {
    /** Exact text of `range`'s lines at capture time. */
    text: string;
    /** Context lines above/below `range`, for fuzzy re-anchoring. */
    before: string[];
    after: string[];
    /** fnv1a of the side's file content when last verified — refresh skip. */
    diffId?: string;
  };
  body: string;
  /** Anchor health after the latest re-anchor pass. */
  status: 'active' | 'moved' | 'stale';
  /** Triage: 'deferred' = should be done, just not now — stays loud. */
  resolution: 'open' | 'done' | 'deferred';
  /** Epoch ms. */
  createdAt: number;
}

/**
 * Tabs hosted by a plugin's full-area view (plugins declaring `hostsTabs`).
 * `activeTab` is a hosted EditorTab id, or unset/'view' for the plugin's own
 * renderView (the pinned first tab).
 */
export interface PluginTabSet {
  editors: EditorTab[];
  activeTab?: string;
}

export interface ShellSession {
  id: string;
  workspaceId: string;
  /**
   * Backend PTY backing the pinned "shell" view when it differs from `id` —
   * set when a sub-shell was promoted to the session's main shell (the
   * demoted main shell keeps its own PTY as a `kind: 'shell'` editor tab).
   * All PTY-bound operations (writes, cwd/foreground polling, plugin
   * `writeToSession`/`getCwd`) target this id; session identity — names,
   * pluginState, accumulated output — stays on `id`.
   */
  mainPtyId?: string;
  name: string;
  customName?: string;
  autoName?: string;
  topic: string;
  /**
   * Short user/agent-settable annotation for the session — set via
   * `axn-session-summary`, `axn-session set --summary`, or the session
   * context menu's "Edit summary…" (cap: SESSION_SUMMARY_MAX chars),
   * rendered clamped to 3 lines in the panel behind the
   * `sessionSummaries` setting.
   */
  summary: string;
  status?: SessionStatus;
  tasks: Task[];
  progress: number;
  output: string;
  cwd?: string;
  /**
   * Id of the plugin whose `agentInput` agent is running in the session —
   * set from the foreground process or the terminal title. Runtime only.
   */
  agentInput?: string;
  process?: string;
  repo?: RepoInfo;
  editors?: EditorTab[];
  activeTab?: string;
  pluginState?: Record<string, unknown>;
}

/** The backend PTY id that currently serves as the session's main shell. */
export function ptyIdOf(session: ShellSession): string {
  return session.mainPtyId ?? session.id;
}

/**
 * Display name — `session.name` can be empty (no custom name, no detected
 * process title yet); fall back to the running process, then a label, so
 * panels/tiles/broadcast headers never render a blank row.
 */
export function sessionDisplayName(session: {
  name?: string;
  process?: string;
}): string {
  return session.name?.trim() || '…';
}

export interface WindowState {
  id: string;
  name?: string;
  workspaces: Workspace[];
  sessions: ShellSession[];
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  /**
   * Set by the backend when state.json was unreadable and the last-good
   * backup (state.json.bak) was loaded instead.
   */
  restoredFromBackup?: boolean;
  /** Name of the preserved failed state file, when one exists. */
  failedStateFile?: string;
  /**
   * Detached sub-view tabs hosted by plugin views, keyed by plugin id. Only
   * plugins declaring `hostsTabs` collect entries; sub-shell tabs are never
   * hosted (their PTY stays bound to the owning session).
   */
  pluginTabs?: Record<string, PluginTabSet>;
  /**
   * App-level persisted plugin data keyed by settingsKey — the plugin-view
   * counterpart of per-session `pluginState` (e.g. awesome-list bookmarks).
   */
  pluginData?: Record<string, unknown>;
}
