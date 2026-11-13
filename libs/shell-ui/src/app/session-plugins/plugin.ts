import type { SessionZone } from '../sessionCardLayout';
import type { ReactNode } from 'react';
import type { DirEntry, PathStat, SessionBackend } from '@axn-term/session-backend';
import type { AgentHookSpec } from '@axn-term/plugin-sdk';
import { ptyIdOf } from '../../types';
import type { AgentCli, RepoInfo, SessionAttention, SessionBanner, ShellSession, Task, Workspace } from '../../types';
import type { PluginSettings } from '../pluginSettings';
import type { RepoDir, RepoDirsContext } from '../repoDirectory';
import { backendFileService, resolvePath } from '../fileService';
import { getScreenLines } from '../../terminalRegistry';
import { setSessionRestoring } from '../restoring';
import { axnLog } from '../log';

export interface SessionViewContext {
  session: ShellSession;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
}

export interface PluginApi {
  writeToSession: (data: string) => Promise<void>;
  updatePluginState: (patch: unknown) => void;
  pluginState: unknown;
  pluginSettings: unknown;
  /**
   * Returns the latest session object from the live state. Use this when a
   * plugin needs the current output or cwd after asynchronous work, because
   * the `ctx.session` captured at hook time may be stale.
   */
  getSession: () => ShellSession;
  /**
   * Returns the number of currently open sessions, so a plugin can scale
   * expensive operations (e.g. per-session close timeouts) to the total load.
   */
  getSessionCount: () => number;
  /**
   * Run a shell command (`sh -c`) and resolve with trimmed stdout.
   * Intended for external plugins that need to query local CLIs.
   */
  exec: (command: string, cwd?: string) => Promise<string>;
  /**
   * Resolves `true` once the session's PTY emits output (e.g. the first shell
   * prompt after spawn), `false` on timeout. Useful for timing injected input.
   */
  waitForSessionOutput: (timeoutMs?: number) => Promise<boolean>;
  /**
   * Poll the live session's foreground process (`session.process`, argv
   * basename — e.g. /^devin/i) until it matches or `timeoutMs` elapses.
   * Shared "agent really running" wait — restore overlays must clear on
   * this, not on command injection (agentInput flags the typed line while
   * the process poll has not seen the agent yet).
   */
  waitForProcess: (pattern: RegExp, timeoutMs?: number) => Promise<boolean>;
  /**
   * Resolves the session's *actual* current working directory by asking the
   * backend for the shell process' cwd. Unlike `session.cwd` — which is only
   * refreshed while the session is visible and can be stale or missing for
   * background/restored sessions — this always reflects the live PTY. Resolves
   * `null` when the cwd cannot be determined.
   */
  getCwd: () => Promise<string | null>;
  /**
   * The session PTY's controlling terminal (`/dev/ttysNNN`, `/dev/pts/N`) —
   * lets a plugin correlate out-of-band events written by processes running
   * in the same PTY (e.g. agent hooks keyed by `tty`). Resolves `null` when
   * the backend cannot determine it.
   */
  getTty: () => Promise<string | null>;
  /**
   * Open a directory-browser tab for `path` — the same view the `axn-browse`
   * hidden command opens. Relative paths resolve against the session cwd.
   */
  openBrowser: (path: string) => void;
  /**
   * Returns true when another enabled plugin has declared that it is responsible
   * for reporting progress for the current session process. Generic output-based
   * progress guessing should bail out in this case.
   */
  isProgressHandled: () => boolean;
  /**
   * The session terminal's live screen lines — the bottom `rows` buffer lines,
   * trimmed right — regardless of scroll position. Lets plugins inspect what is
   * actually on screen; `onOutput` chunks cannot express that because cursor
   * movement has already been stripped. Empty when the terminal is unavailable.
   */
  getScreenLines: () => string[];
  /**
   * Raise or clear a "needs attention" flag for this session. Flags are keyed
   * by plugin id, so several plugins can flag the same session independently;
   * pass `null` to clear this plugin's flag. Surfaced as a halo around the
   * session's icon tile and counted in the session panel's "N waiting"
   * indicator.
   */
  setAttention: (attention: SessionAttention | null) => void;
  /**
   * Show or clear a banner strip on top of the session view. Banners are
   * keyed by plugin id (reserved pluginState key `banner`), so several
   * plugins can raise one independently; pass `null` to clear this plugin's
   * banner.
   */
  setBanner: (banner: SessionBanner | null) => void;
  /**
   * Raise or clear this plugin's "restoring" overlay over the session's
   * terminal — pass a display label to raise it, `null` to clear. Plugins
   * that declare `pendingRestore` must clear their overlay once the restore
   * resolves (success, failure, or abandon); the user can always dismiss it
   * manually via the overlay's × button.
   */
  setRestoring: (label: string | null) => void;
  /**
   * Open a session sub-view tab. `editor`/`browser`/`preview` resolve
   * relative `path` against the session cwd like their axn-* counterparts;
   * `git` opens the repo inspect view for the repo root at `path`.
   */
  openTab: (tab: {
    path: string;
    kind: 'editor' | 'browser' | 'preview' | 'git';
    /**
     * For `kind: 'git'`: compare ref — the inspect view adds a "Changes vs
     * `<base>`" section (merge-base vs HEAD, three-dot semantics).
     */
    base?: string;
  }) => void;
  /**
   * Open a sub-shell tab on this session — the same view `axn-sh` opens.
   * With `command` the tab runs `sh -c <command>` as a one-shot; without it
   * an interactive shell opens in `cwd` (default: the session's live cwd).
   * `label` overrides the tab's displayed name (command/dir by default).
   * `agent` marks the tab as hosting an agent conversation so later re-spawns
   * resume the agent session instead of re-running `command`.
   * Returns the new tab's id — also the PTY id `onSubShellExit` reports —
   * or `undefined` when the session is gone.
   */
  openSubShell: (
    command?: string,
    cwd?: string,
    label?: string,
    agent?: AgentCli,
  ) => string | undefined;
  /**
   * Open a new session rooted at `cwd` (default: the app's shell default).
   * `name` overrides the session's display name; `workspaceId` targets a
   * workspace other than this session's own; `background` spawns it without
   * selecting it or dismissing a covering plugin view (the
   * `axn-session --background` behaviour — the user's focus stays put).
   * The PTY spawns when the session's terminal mounts, so `writeToSession`
   * into it only works once `onSessionOpen` has fired for the new session.
   */
  openSession: (cwd?: string, name?: string, workspaceId?: string, background?: boolean) => void;
  /**
   * The workspace this session belongs to — carries `defaultFolder`, the
   * workspace's anchor directory set from its context menu.
   */
  getWorkspace: () => Workspace | undefined;
  /**
   * All workspaces in the current window, in panel order — lets a plugin
   * pick a target workspace for `openSession`'s `workspaceId` (e.g. the one
   * already hosting a checkout of a given repo). Absent where workspaces
   * are unavailable.
   */
  getWorkspaces?: () => Workspace[];
  /**
   * Dispatch a line through the session's hidden/plugin command pipeline —
   * the same path a typed `axn-*` line takes (`axn-git`, plugin commands,
   * `onCommand` hooks). Returns the resolution like the dispatch does:
   * `false` = swallowed, a string = replacement line to run in the shell,
   * `undefined` = pass the original line through. Unlike `writeToSession`
   * the line never reaches the PTY verbatim first, so workflows can invoke
   * `axn-*` commands from `run-in: shell` actions. Absent where dispatch
   * is unavailable.
   */
  runCommand?: (
    line: string,
  ) => Promise<string | false | undefined>;
  /**
   * Bring a session tab to the front: `'shell'` for the main terminal, else
   * a sub-view tab matched by id, kind (`git`, `editor`, `shell`,
   * `preview`, `browser`), 1-based index, or label text. Also selects the
   * session and dismisses a covering plugin view — the programmatic
   * counterpart of clicking the tab. Dispatches the `axn-focus` hidden
   * command, so workflow `command:` actions get the same behavior for free.
   * Resolves `true` when a matching tab was activated.
   */
  activateTab?: (tabId: string) => Promise<boolean>;
  /**
   * Read a text file in the session's filesystem. Relative `path` resolves
   * against `cwd` (default: the session's stored cwd). Rejects when the
   * backend cannot read files.
   */
  readFile: (path: string, cwd?: string) => Promise<string>;
  /**
   * Write a text file in the session's filesystem — same resolution rules
   * as `readFile`. Rejects when the backend cannot write files.
   */
  writeFile: (path: string, contents: string, cwd?: string) => Promise<void>;
  /**
   * Resolve and stat a path in the session's filesystem. Relative `path`
   * resolves against `cwd` (default: the session's stored cwd). Resolves
   * `null` when the path does not exist or stat is unsupported.
   */
  statPath: (path: string, cwd?: string) => Promise<PathStat | null>;
  /**
   * Create a directory (recursively) in the session's filesystem. Relative
   * `path` resolves against `cwd` (default: the session's stored cwd).
   * Resolves `false` when the backend cannot create directories.
   */
  mkdir: (path: string, cwd?: string) => Promise<boolean>;
  /**
   * List a directory in the session's filesystem. Relative `path` resolves
   * against `cwd` (default: the session's stored cwd). Resolves `null` when
   * the backend cannot list directories or the path cannot be read.
   */
  listDir: (path: string, cwd?: string) => Promise<DirEntry[] | null>;
  /**
   * Repo context-menu rows contributed by all enabled plugins via their
   * `repoMenuItems` hook — rendered by the git-status repo menu.
   */
  repoMenuItems: (repo: RepoInfo) => RepoMenuItem[];
  /**
   * App-level persisted data for this plugin — the counterpart of
   * per-session `pluginState`. Stored in window state under
   * `pluginData.<settingsKey>` and shared across sessions. This is a
   * snapshot from when the ctx was built, like `pluginState`.
   */
  appState: unknown;
  /**
   * Shallow-merge a patch into this plugin's app-level persisted data
   * (`pluginData.<settingsKey>` in window state).
   */
  updateAppState: (patch: Record<string, unknown>) => void;
}

/**
 * The host (ShellApp) registers its session command dispatch here so
 * `PluginApi.runCommand` works for apis built anywhere — the SessionPanel
 * call sites don't have the dispatch in scope. Module state is per window
 * (each webview runs its own React tree), matching the remote-command path.
 */
const sessionCommandDispatch: {
  fn?: (
    sessionId: string,
    line: string,
    ptyId?: string,
  ) => string | false | undefined | Promise<string | false | undefined>;
} = {};

export function registerSessionCommandDispatch(
  fn: (typeof sessionCommandDispatch)['fn'],
): () => void {
  sessionCommandDispatch.fn = fn;
  return () => {
    if (sessionCommandDispatch.fn === fn) sessionCommandDispatch.fn = undefined;
  };
}

export function dispatchSessionCommand(
  sessionId: string,
  line: string,
  ptyId?: string,
): Promise<string | false | undefined> {
  if (!sessionCommandDispatch.fn) {
    axnLog('warn', 'plugin', `dispatchSessionCommand('${line}') — no handler registered`);
  }
  return Promise.resolve(sessionCommandDispatch.fn?.(sessionId, line, ptyId));
}

export function createWaitForSessionOutput(
  backend: SessionBackend,
  sessionId: string,
): (timeoutMs?: number) => Promise<boolean> {
  return (timeoutMs = 8000) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const unlisten = backend.onOutput(sessionId, () => finish(true));
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlisten();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
}

/**
 * A hidden `axn-*` command owned by a plugin, declared via
 * `SessionViewPlugin.commands`. The name joins the built-in `axn-*` names
 * for Tab-completion; when `run` is set, a submitted line whose first word
 * matches `name` is dispatched to it directly (before generic `onCommand`
 * hooks see the line).
 */
export interface PluginCommand {
  /** Command name as typed in the shell, e.g. `axn-devin-resume`. */
  name: string;
  /**
   * True when the command takes an argument — Tab-completion then appends a
   * trailing space after the name instead of treating it as complete.
   */
  takesArg?: boolean;
  /**
   * Declarative argument completion for the token after the command name:
   * `workspace` completes workspace names; `dir`/`file` complete filesystem
   * paths against the session's cwd (dirs only for `dir`, files included
   * for `file`).
   */
  argCompletion?: 'workspace' | 'dir' | 'file';
  /**
   * Dynamic argument completion — takes precedence over `argCompletion`.
   * Called with the (possibly empty) argument prefix being completed;
   * returns candidate *arguments* — each is wrapped into a full replacement
   * line (`<word> <candidate>`) by the completer. Use for plugin-owned
   * values like workflow or state names.
   */
  completeArg?: (
    ctx: SessionViewContext & PluginApi,
    argPrefix: string,
  ) => string[] | Promise<string[]>;
  /**
   * Handle a submitted line whose first word is `name`. `arg` is the
   * remainder of the trimmed line (`undefined` when empty). Return a string
   * to run a replacement command instead, `false` to swallow the line, or
   * `undefined`/void to pass it through to the shell unchanged. May return
   * a Promise — note the typed line is cleared once a command claims it, so
   * a Promise resolving to `undefined` swallows rather than passes through.
   */
  run?: (
    ctx: SessionViewContext & PluginApi,
    arg: string | undefined,
    line: string,
  ) => string | false | void | Promise<string | false | void>;
}

/** Normalize a plugin's `commands` list to `PluginCommand` objects. */
export function pluginCommands(plugin: SessionViewPlugin): PluginCommand[] {
  return (plugin.commands ?? []).map((c) => (typeof c === 'string' ? { name: c } : c));
}

/**
 * A plugin this plugin requires to be registered and enabled. `version` is
 * an optional semver-ish constraint matched against the dependency's
 * `version` field: `1.2.3` (exact), `>=`/`>`/`<=`/`<`, or `^` (same major,
 * at least the given version).
 */
export interface PluginDependency {
  /** The dependency's `id` (or `settingsKey`). */
  id: string;
  version?: string;
}

/** A row contributed to the repo context menu (see `repoMenuItems`). */
export interface RepoMenuItem {
  label: string;
  onClick: () => void;
}

/**
 * Subset of `SessionViewContext & PluginApi` handed to `repoMenuItems`
 * contributions: generic session-bound calls only — contributed rows cannot
 * rely on their own pluginState/pluginSettings (the ctx belongs to the
 * session, not to the contributing plugin).
 */
export type RepoMenuContext = Pick<
  SessionViewContext & PluginApi,
  | 'session'
  | 'updateSession'
  | 'writeToSession'
  | 'exec'
  | 'getCwd'
  | 'openBrowser'
  | 'openTab'
  | 'openSubShell'
>;

function parseVersion(v: string): number[] {
  return v.split('.').map((p) => parseInt(p, 10) || 0);
}

/** Numeric compare of `x.y.z` versions; missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` satisfies `req` — `1.2.3` (exact), `>=`/`>`/`<=`/`<`
 * comparators, or `^` (same major, at least the given version).
 */
export function satisfiesVersion(version: string, req: string): boolean {
  const m = /^(>=|<=|>|<|\^)?\s*(\S+)\s*$/.exec(req.trim());
  if (!m) return false;
  const op = m[1] ?? '=';
  const cmp = compareVersions(version, m[2]);
  switch (op) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '^': return cmp >= 0 && parseVersion(version)[0] === parseVersion(m[2])[0];
    default: return cmp === 0;
  }
}

/**
 * Per-dependency status for a plugin — used by Settings to show which
 * requirements are unmet.
 */
export function pluginDependencies(
  plugin: SessionViewPlugin,
  settings: PluginSettings,
  plugins: readonly SessionViewPlugin[],
): { dep: PluginDependency; met: boolean }[] {
  return (plugin.dependsOn ?? []).map((dep) => {
    const target = plugins.find((p) => p.id === dep.id || (p.settingsKey ?? p.id) === dep.id);
    const met =
      !!target &&
      isPluginEnabled(target, settings, plugins, new Set([plugin.id])) &&
      (!dep.version || satisfiesVersion(target.version ?? '0.0.0', dep.version));
    return { dep, met };
  });
}

/**
 * A declarative plugin settings field, rendered generically in Settings →
 * Plugins. Values live in the plugin's plugins.yaml section under
 * `settingsKey` (kebab-case in the file, camelCase here). Pure data — so
 * external `.mjs` plugins can declare fields too.
 */
export interface PluginSettingField {
  key: string;
  label: string;
  description?: string;
  type: 'boolean' | 'number' | 'string';
  /** When set for `type: 'string'`, renders a select instead of a text input. */
  options?: { value: string; label: string }[];
  /** For `type: 'string'`: a password input (tokens) — the value is masked. */
  secret?: boolean;
  /** Effective value while the key is unset in plugins.yaml. */
  default?: boolean | number | string;
}

/** ctx handed to a plugin's `renderSettings` custom settings view. */
export interface PluginSettingsViewContext {
  /** The plugin's normalized plugins.yaml section. */
  settings: Record<string, unknown>;
  /** Shallow-merge a patch into the section and persist plugins.yaml. */
  update: (patch: Record<string, unknown>) => void;
}

/**
 * One piece of session information a plugin offers the session panel (see
 * `SessionViewPlugin.sessionFields`). The plugin only provides it — where
 * it shows (title row, always-visible rows, the selected card) is the
 * panel's layout (`app/sessionCardLayout.ts`, the `sessionCard` setting).
 */
export interface SessionField {
  /** Local id; the layout addresses it as `<pluginId>.<id>`. */
  id: string;
  /** Name in the layout editor/settings. */
  label: string;
  /**
   * `inline`: compact (a badge/chip, ~9-10px, single line) — fits the title
   * row and `·`-joined rows. `block`: full width, possibly multi-line — never
   * placed in the title row.
   */
  kind: 'inline' | 'block';
  /** Where the default layout puts it. */
  zone: SessionZone;
  /** The content for this session — null/false when there is nothing. */
  value: (ctx: SessionViewContext & PluginApi) => ReactNode;
  /**
   * Tooltip line(s) for the card explaining the value — one
   * `<marker>: <meaning>` line each (plain text). Only collected while the
   * field is shown; return null when `value` is empty.
   */
  tip?: (ctx: SessionViewContext & PluginApi) => string | string[] | null;
  /**
   * Plain-text term(s) the panel filter matches for this field — declaring
   * it makes the field searchable. Only placed fields are searched (a field
   * the layout hides is never matched — the user cannot see why a session
   * would match), so mirror `value`'s gate: return null when nothing shows.
   */
  search?: (ctx: SessionViewContext & PluginApi) => string | string[] | null;
}

/**
 * Hooks of the pre-field card API, still honoured on external `.mjs`
 * plugins through `pluginSessionFields` (`renderRow` → a title field,
 * `render` → a selected-card block).
 */
interface LegacyCardHooks {
  render?: (ctx: SessionViewContext & PluginApi) => ReactNode;
  renderRow?: (ctx: SessionViewContext & PluginApi) => ReactNode;
  rowTip?: (ctx: SessionViewContext & PluginApi) => string | string[] | null;
}

/** One of the plugin's session fields by local id (tests, layout editor). */
export function findSessionField(plugin: SessionViewPlugin, id: string): SessionField | undefined {
  return pluginSessionFields(plugin).find((f) => f.id === id);
}

/** The plugin's session fields — declared ones, else adapted legacy hooks. */
export function pluginSessionFields(plugin: SessionViewPlugin): SessionField[] {
  if (plugin.sessionFields) return plugin.sessionFields;
  const legacy = plugin as SessionViewPlugin & LegacyCardHooks;
  const out: SessionField[] = [];
  if (legacy.renderRow) {
    out.push({
      id: 'row',
      label: `${plugin.title} (badge)`,
      kind: 'inline',
      zone: 'title',
      value: legacy.renderRow,
      tip: legacy.rowTip,
    });
  }
  if (legacy.render) {
    out.push({ id: 'panel', label: plugin.title, kind: 'block', zone: 'selected', value: legacy.render });
  }
  return out;
}

export interface SessionViewPlugin {
  id: string;
  title: string;
  /**
   * The plugin's icon — a Lucide icon name or an inline `<svg>` tag, the
   * same value format as `sessionIcons`. Declaring it is the has-an-icon
   * capability: only then does the Logo override field appear in Settings →
   * Plugins (users override via `customIcons`/`pluginIcons` keyed by plugin
   * id) and does the plugin's own chrome render `<PluginIcon>` with that
   * override (undeclared → generic Puzzle, bag not consulted).
   *
   * When `processPattern` is set, the logo also supplies the session-row
   * icon for matching foreground processes (`resolveProcessIcon`) — so for
   * agent plugins whose id equals the process name (`devin`, `claude`), the
   * plugin logo and the process icon are literally the same bag key and
   * editing either side updates both.
   */
  logo?: string;
  /** Plugin version (`x.y.z`); shown in Settings and matched by `dependsOn`. */
  version?: string;
  /**
   * Other plugins this plugin needs — each must be registered, enabled, and
   * match the optional version constraint, or this plugin is treated as
   * disabled (unmet requirements are shown in Settings).
   */
  dependsOn?: PluginDependency[];
  stateKey?: string;
  settingsKey?: string;
  /**
   * Whether the plugin is active when the user has not set `<id>.enabled` in
   * plugins.yaml. Defaults to `true` for built-in plugins; external plugins
   * loaded from ~/.axn-term/plugins/ are always opt-in (`false`).
   */
  defaultEnabled?: boolean;
  /**
   * Bind the plugin to a foreground process. The pattern is matched against
   * `session.process`; when it stops matching (the process exits and the shell
   * takes over again), `onProcessEnd` fires once.
   */
  processPattern?: RegExp;
  /**
   * The `processPattern` program is an agent that edits its own input line.
   * While it is foreground, hidden-command interception observes only
   * `/exit` (for `onCommand`) instead of switching off, and the session
   * carries `agentInput: <plugin id>`. `title` also marks the session from
   * the OSC terminal title, before the 1 s process poll has seen the agent.
   */
  agentInput?: { title?: RegExp };
  /**
   * If true, this plugin reports progress for the matching process and the
   * generic output-scanner progress plugin should stay out of the way.
   */
  handlesProgress?: boolean;
  /**
   * Declares an agent-hook bridge spec (`@axn-term/plugin-sdk` `hooks.ts`).
   * The host drives the whole bridge for declarers — while `processPattern`
   * matches the session process it reconciles the agent's hook config with
   * the plugin's `installHooks` setting and polls the tty-keyed event file
   * for exact status/attention; on process end and session boundaries it
   * releases/drops the runtime and clears the flag. Any plugin can declare
   * one — including external `.mjs` plugins, which get full hook bridging
   * with no lifecycle code of their own.
   */
  hookSpec?: AgentHookSpec;
  /**
   * Pure screen parser: the agent's task list from the visible terminal
   * lines, or undefined when none is on screen. Sub-shell tabs running a
   * process matching `processPattern` use it to track their own tasks
   * (`app/subShellTasks.ts`) — plugin hooks only ever see the main PTY.
   */
  screenTasks?: (lines: string[]) => Task[] | undefined;
  /**
   * Declares that the plugin consumes system memory statistics. When any
   * enabled plugin sets this, the app polls `get_memory_stats` periodically
   * and makes the result available to components via `useMemoryStats()`.
   */
  needsMemoryStats?: boolean;
  onProcessEnd?: (ctx: SessionViewContext & PluginApi) => void;
  /**
   * Called when a button declared via `setBanner({actions})` is clicked.
   * Receives the action's `id`.
   */
  onBannerAction?: (ctx: SessionViewContext & PluginApi, actionId: string) => void;
  /**
   * Called when a button declared via `setAttention({actions})` is clicked
   * — the action id is the part after `<plugin>:` (`worktrees:mr-worktree`
   * routes here with `mr-worktree`). `attention` is the flag's payload.
   * `ctx` is bound to the session the flag was raised on.
   */
  onAttentionAction?: (
    ctx: SessionViewContext & PluginApi,
    actionId: string,
    attention: SessionAttention,
  ) => void;
  /** Pinned rail items render first, above the reorderable ones, and are
   * not draggable. */
  pinned?: boolean;
  /**
   * Headless, always-mounted source for the session panel's "System"
   * section (the status slot at the bottom of the panel): return a
   * component that publishes this plugin's meters with `publishPanelStatus`
   * (`app/panelStatus.ts`) and renders nothing itself. It stays mounted
   * while the plugin is enabled — also with the panel hidden — so it is
   * the place for a status plugin's app attention flag as well
   * (`setAppAttention`, pass `null` to clear).
   *
   * Use this for meters that only show numbers and open no view. A plugin
   * that owns a rail item anyway can publish from there instead.
   */
  panelStatus?: (ctx: {
    backend: SessionBackend;
    pluginSettings: unknown;
    setAppAttention: (attention: SessionAttention | null) => void;
    sessions: ShellSession[];
  }) => ReactNode;
  /**
   * Render an item in the slim left rail (the always-visible column of
   * tools, Settings at its bottom). Not bound to a session — meant for
   * something to click: an item that opens the plugin's view. Plain meters
   * belong in the panel's status stack (`panelStatus`). External plugins
   * may return a plain string. `setAppAttention` raises an app-level "needs
   * attention" flag shown in the rail; pass `null` to clear it.
   *
   * When the plugin also implements `renderView`, `toggleView` activates (or
   * deactivates) the plugin's full-area view — while active no session is
   * selected in the panel and the main area renders `renderView` instead of
   * the session terminals. `viewActive` reflects that state.
   */
  renderRail?: (ctx: {
    /** The session backend — remote-only capabilities (e.g.
     * `setViewportPaused`) are absent elsewhere; check presence. */
    backend: SessionBackend;
    pluginSettings: unknown;
    setAppAttention: (attention: SessionAttention | null) => void;
    viewActive: boolean;
    toggleView: () => void;
    /**
     * App-level persisted data for this plugin — the view counterpart of
     * `pluginState`. Stored in window state under `pluginData.<settingsKey>`.
     */
    appState: unknown;
    /** Shallow-merge into `appState` — same write path as renderView's. */
    updateAppState: (patch: Record<string, unknown>) => void;
    /** Live sessions — e.g. to keep app-level session mirrors consistent. */
    sessions: ShellSession[];
    /**
     * This plugin's session-bound api for another session — lets a session-
     * less rail component drive per-session state (attention, pluginState).
     * Undefined when the session no longer exists.
     */
    sessionApi: (
      sessionId: string,
    ) => (SessionViewContext & PluginApi) | undefined;
  }) => ReactNode;
  /**
   * Render the plugin's full-area view in place of the session terminals.
   * Activated from the rail via `toggleView` (only offered when this hook is
   * declared). `close` deactivates the view and returns to the selected
   * session. `appState`/`updateAppState` read and shallow-merge the plugin's
   * persisted app-level data. `openTab` opens a hosted tab (only provided
   * when the plugin declares `hostsTabs`).
   */
  renderView?: (ctx: {
    pluginSettings: unknown;
    close: () => void;
    appState: unknown;
    updateAppState: (patch: Record<string, unknown>) => void;
    openTab?: (tab: {
      path: string;
      kind: 'editor' | 'browser' | 'preview';
    }) => void;
    /**
     * Live sessions — for views aggregating across sessions (e.g. a kanban
     * board over per-session plugin state).
     */
    sessions: ShellSession[];
    /**
     * The session selected in the panel — stays set while a plugin view
     * covers it, so views can offer "in the current session" actions.
     */
    selectedSessionId?: string;
    /** The window's workspaces in panel order — for workspace-targeted actions. */
    workspaces: Workspace[];
    /**
     * Select a session in the panel and leave the plugin view (same as
     * clicking the session's row).
     */
    selectSession: (sessionId: string) => void;
    /**
     * This plugin's session-bound api for another session — lets a
     * session-less view drive per-session state (pluginState, banners,
     * PTY writes). Undefined when the session no longer exists.
     */
    sessionApi: (
      sessionId: string,
    ) => (SessionViewContext & PluginApi) | undefined;
  }) => ReactNode;
  /**
   * Declares that the plugin's `renderView` can host detached sub-view tabs
   * (browser/editor/preview — sub-shell tabs stay bound to their session's
   * PTY and are never hosted). The app keeps a persisted tab set per plugin
   * (window state `pluginTabs.<id>`), renders a tab strip on top of the view,
   * and offers "Move to" on session tabs to send them here — and on hosted
   * tabs to send them back to a session.
   */
  hostsTabs?: boolean;
  /**
   * Local repos this plugin knows about (e.g. axn-dev's configured repos).
   * Results from every enabled provider are added to the forge plugins'
   * `repo-roots` search and deduplicated by checkout path — see
   * `repoDirectory.ts`. Entries without `worktrees` are expanded by the host.
   */
  repoDirs?: (ctx: RepoDirsContext) => Promise<RepoDir[]>;
  /**
   * Session information this plugin offers the session panel card — the
   * panel lays it out (title row / always-visible rows / selected card) from
   * the `sessionCard` setting or each field's default `zone`. This replaced
   * `renderRow`/`rowTip`/`render`, which external `.mjs` plugins may still
   * declare (`pluginSessionFields` adapts them).
   */
  sessionFields?: SessionField[];
  onClose?: (ctx: SessionViewContext & PluginApi) => void | Promise<void>;
  /**
   * A sub-shell tab PTY owned by this session exited — `tabId` is the tab/PTY
   * id `openSubShell` returned, `exitCode` the process exit status when the
   * backend reports it (`null` when unknown, e.g. the web session host).
   * Only fires on backends implementing `onSubshellExit`.
   */
  onSubShellExit?: (
    ctx: SessionViewContext & PluginApi,
    tabId: string,
    exitCode: number | null,
  ) => void;
  /**
   * Very early restore declaration — evaluated when a session's PTY has
   * just spawned, right before `onSessionOpen` runs (and before any command
   * it injects). Return a display label (e.g. `devin session 'grey-party'`)
   * when this plugin is going to drive a restore for the session; the
   * terminal is then covered by a blocking "restoring" overlay so user
   * input cannot race the injected restore command. The overlay stays until
   * `ctx.setRestoring(null)` is called or the user dismisses it. Return
   * `undefined` when nothing will be restored. Never fires on PTY reattach
   * (sub-shell promotion/workspace adoption) — same gate as `onSessionOpen`.
   */
  pendingRestore?: (ctx: SessionViewContext & PluginApi) => string | undefined;
  onSessionOpen?: (ctx: SessionViewContext & PluginApi) => void;
  onOutput?: (ctx: SessionViewContext & PluginApi, text: string) => void;
  /**
   * Intercept a submitted input line before it reaches the shell. Return a
   * string to run a replacement command instead, `false` to swallow the line
   * entirely, or `undefined` to pass it through unchanged. Lines matching a
   * declared `commands[]` entry with a `run` handler are dispatched there
   * instead — use `onCommand` to observe or intercept arbitrary lines (the
   * devin plugin's `/exit` and `devin -r` tracking works this way).
   */
  onCommand?: (
    ctx: SessionViewContext & PluginApi,
    command: string,
  ) => string | false | void | Promise<string | false | void>;
  /**
   * Contribute rows to the repo context menu (the git-status header menu).
   * `ctx` exposes only generic session-bound calls — see `RepoMenuContext`.
   */
  repoMenuItems?: (ctx: RepoMenuContext, repo: RepoInfo) => RepoMenuItem[];
  /**
   * Contribute rows to the session context menu (right-click a session in
   * the panel). Unlike `repoMenuItems` the ctx is the plugin's own full
   * session-bound api, so items can read `pluginState`/`pluginSettings` and
   * write to the session PTY. Called each time the menu opens.
   */
  sessionMenuItems?: (ctx: SessionViewContext & PluginApi) => RepoMenuItem[];
  /**
   * Contribute rows to the workspace context menu (right-click a workspace
   * header). `ctx` is the plugin's own full api bound to a representative
   * session of that workspace (the selected session when it belongs to the
   * workspace, otherwise the workspace's first session); `workspace` is the
   * workspace the menu was opened on. Not called for workspaces without
   * sessions — PTY-bound calls like `exec` need a session to attach to.
   */
  workspaceMenuItems?: (
    ctx: SessionViewContext & PluginApi,
    workspace: Workspace,
  ) => RepoMenuItem[];
  /**
   * Hidden commands this plugin owns. A plain string advertises the name for
   * Tab-completion only (handle it via `onCommand`); a `PluginCommand`
   * object additionally dispatches matching submitted lines to its `run`
   * handler and can declare argument completion.
   */
  commands?: (string | PluginCommand)[];
  /**
   * Declarative settings shown in Settings → Plugins (the `enabled` toggle is
   * always offered automatically). Kept as plain data so external `.mjs`
   * plugins can declare fields too.
   */
  settings?: PluginSettingField[];
  /**
   * Custom settings view rendered in Settings → Plugins, shown below the
   * declared `settings` fields (or instead of them). Built-in plugins only —
   * external `.mjs` plugins should use `settings`. `update` merges a patch
   * into the plugin's plugins.yaml section and persists it.
   */
  renderSettings?: (ctx: PluginSettingsViewContext) => ReactNode;
}

/**
 * A plugin is active when `<settingsKey>.enabled` is set in plugins.yaml, or
 * when unset falls back to `plugin.defaultEnabled` (default: true) — and all
 * of its `dependsOn` requirements are met: every dependency must be present
 * in `plugins`, be enabled itself, and satisfy the version constraint.
 * Dependency cycles resolve to disabled.
 */
export function isPluginEnabled(
  plugin: SessionViewPlugin,
  settings: PluginSettings,
  plugins: readonly SessionViewPlugin[] = [],
  _visiting?: Set<string>,
): boolean {
  const key = plugin.settingsKey ?? plugin.id;
  const value = settings[key]?.enabled;
  const enabled = typeof value === 'boolean' ? value : (plugin.defaultEnabled ?? true);
  if (!enabled || !plugin.dependsOn?.length) return enabled;
  const visiting = _visiting ?? new Set<string>();
  if (visiting.has(plugin.id)) return false;
  visiting.add(plugin.id);
  return plugin.dependsOn.every((dep) => {
    const target = plugins.find(
      (p) => p.id === dep.id || (p.settingsKey ?? p.id) === dep.id,
    );
    return (
      !!target &&
      isPluginEnabled(target, settings, plugins, visiting) &&
      (!dep.version || satisfiesVersion(target.version ?? '0.0.0', dep.version))
    );
  });
}

/** What `createPluginApi` binds a ctx to — the host's state and actions. */
export interface PluginApiDeps {
  backend: SessionBackend;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  mergePluginState: (sessionId: string, stateKey: string, patch: Record<string, unknown>) => void;
  pluginSettings: PluginSettings;
  /** Every registered plugin — enabled ones are picked via `isPluginEnabled`. */
  plugins: readonly SessionViewPlugin[];
  openBrowser: (sessionId: string, path: string) => void;
  openTab: (
    sessionId: string,
    tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git'; base?: string },
  ) => void;
  openSubShell: (
    sessionId: string,
    command?: string,
    cwd?: string,
    label?: string,
    agent?: AgentCli,
  ) => string | undefined;
  openSession: (workspaceId: string, cwd?: string, name?: string, background?: boolean) => void;
  getWorkspaces?: () => Workspace[];
  pluginData: Record<string, unknown>;
  mergePluginData: (key: string, patch: Record<string, unknown>) => void;
  /**
   * Live session lookup. Lifecycle hooks (onOutput, timers, …) outlive the
   * snapshot the ctx was built from; without it `getSession` returns that
   * snapshot (fine for synchronous `render`).
   */
  getLiveSession?: (sessionId: string) => ShellSession | undefined;
  getSessionCount?: () => number;
  /** Called after a raised flag is stored — the host OS-notifies from here. */
  onAttention?: (session: ShellSession, stateKey: string, attention: SessionAttention | null) => void;
}

/**
 * Build the `PluginApi` ctx for one session and plugin — the one builder
 * behind every hook: ShellApp's lifecycle dispatch (with live lookups and
 * notifications) and the panel/view `render` call sites alike.
 */
export function createPluginApi(
  session: ShellSession,
  plugin: SessionViewPlugin,
  deps: PluginApiDeps,
): SessionViewContext & PluginApi {
  const stateKey = plugin.stateKey ?? plugin.id;
  const settingsKey = plugin.settingsKey ?? plugin.id;
  // PTY-bound ops target the session's current main PTY, which differs from
  // session.id after a sub-shell was promoted.
  const ptyId = ptyIdOf(session);
  const live = () => deps.getLiveSession?.(session.id) ?? session;
  const enabledPlugins = () =>
    deps.plugins.filter((p) => isPluginEnabled(p, deps.pluginSettings, deps.plugins));
  const writeToSession = async (data: string) => {
    await deps.backend.write(ptyId, data);
  };
  const exec = (command: string, cwd?: string) => {
    if (!deps.backend.exec) return Promise.reject(new Error('exec is not available on this backend'));
    return deps.backend.exec(ptyId, command, cwd ?? session.cwd);
  };
  const getCwd = () => deps.backend.getCwd?.(ptyId).catch(() => null) ?? Promise.resolve(null);
  const openBrowser = (path: string) => deps.openBrowser(session.id, path);
  const openTab: PluginApi['openTab'] = (tab) => deps.openTab(session.id, tab);
  const openSubShell: PluginApi['openSubShell'] = (command, cwd, label, agent) =>
    deps.openSubShell(session.id, command, cwd, label, agent);
  const menuCtx: RepoMenuContext = {
    session,
    updateSession: deps.updateSession,
    writeToSession,
    exec,
    getCwd,
    openBrowser,
    openTab,
    openSubShell,
  };
  return {
    session,
    updateSession: deps.updateSession,
    writeToSession,
    // Merged against the latest session state inside the host's updater — a
    // stale snapshot must never resurrect old fields.
    updatePluginState: (patch: unknown) => {
      deps.mergePluginState(session.id, stateKey, patch as Record<string, unknown>);
    },
    getSession: live,
    getSessionCount: () => deps.getSessionCount?.() ?? 1,
    pluginState: (session.pluginState ?? {})[stateKey],
    pluginSettings: deps.pluginSettings[settingsKey],
    exec,
    setRestoring: (label: string | null) =>
      setSessionRestoring(session.id, plugin.id, label),
    waitForSessionOutput: createWaitForSessionOutput(deps.backend, ptyId),
    waitForProcess: (pattern, timeoutMs = 30_000) =>
      new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (pattern.test(live().process ?? '')) return resolve(true);
          if (Date.now() - start >= timeoutMs) return resolve(false);
          setTimeout(tick, 300);
        };
        tick();
      }),
    getCwd,
    getTty: () => deps.backend.getTty?.(ptyId).catch(() => null) ?? Promise.resolve(null),
    openBrowser,
    openTab,
    openSubShell,
    openSession: (cwd, name, workspaceId, background) =>
      deps.openSession(workspaceId ?? session.workspaceId, cwd, name, background),
    getWorkspace: () =>
      deps.getWorkspaces?.().find((w) => w.id === session.workspaceId),
    getWorkspaces: () => deps.getWorkspaces?.() ?? [],
    runCommand: (line: string) => dispatchSessionCommand(session.id, line, ptyId),
    activateTab: (tabId: string) =>
      dispatchSessionCommand(session.id, `axn-focus ${tabId}`, ptyId).then(
        (r) => r === false,
      ),
    readFile: (path, cwd) =>
      backendFileService(deps.backend, ptyId).readFile(path, cwd ?? session.cwd),
    writeFile: (path, contents, cwd) =>
      backendFileService(deps.backend, ptyId).writeFile(path, cwd ?? session.cwd, contents),
    statPath: (path, cwd) =>
      deps.backend.statPath?.(ptyId, cwd ?? session.cwd ?? '/', path).catch(() => null) ??
      Promise.resolve(null),
    mkdir: (path, cwd) =>
      deps.backend.mkdir?.(ptyId, resolvePath(cwd ?? session.cwd, path)).then(() => true, () => false) ??
      Promise.resolve(false),
    listDir: (path, cwd) =>
      deps.backend.listDir?.(ptyId, resolvePath(cwd ?? session.cwd, path)).catch(() => null) ??
      Promise.resolve(null),
    repoMenuItems: (repo) =>
      enabledPlugins()
        .filter((p) => p.repoMenuItems)
        .flatMap((p) => p.repoMenuItems!(menuCtx, repo)),
    // Reads the live process — hooks may fire on a timer long after the ctx
    // snapshot was built (e.g. progress debounce scans).
    isProgressHandled: () =>
      enabledPlugins().some(
        (p) =>
          p.id !== plugin.id &&
          p.handlesProgress &&
          p.processPattern?.test(live().process ?? '') === true,
      ),
    getScreenLines: () => getScreenLines(session.id),
    setAttention: (attention) => {
      deps.mergePluginState(session.id, stateKey, { attention: attention ?? null });
      deps.onAttention?.(session, stateKey, attention ?? null);
    },
    setBanner: (banner) => {
      deps.mergePluginState(session.id, stateKey, { banner: banner ?? null });
    },
    appState: deps.pluginData[settingsKey],
    updateAppState: (patch) => deps.mergePluginData(settingsKey, patch),
  };
}
