/**
 * Public API surface for sandboxed axn-term plugins.
 *
 * A sandboxed plugin is a directory in `~/.axn-term/plugins/<name>/`:
 *
 *   plugin.json   — manifest (see `PluginManifest`)
 *   plugin.mjs    — logic entry; runs in a hidden sandboxed frame and gets a
 *                   global `window.axn` client (see `AxnClient`)
 *   index.html    — optional view UI (any stack); rendered in the plugin's
 *                   full-area view with the same `window.axn` client
 *
 * Enable it in `~/.axn-term/plugins.yaml` via `<id>.enabled: true`.
 *
 * Nothing here imports the app's internals — the file is self-contained so it
 * can be published (or vendored) on its own.
 */

/** A declarative plugin settings field, rendered in Settings → Plugins. */
export interface PluginSettingField {
  key: string;
  label: string;
  description?: string;
  type: 'boolean' | 'number' | 'string';
  /** When set for `type: 'string'`, renders a select instead of a text input. */
  options?: { value: string; label: string }[];
  /** Effective value while the key is unset in plugins.yaml. */
  default?: boolean | number | string;
}

/** A hidden `axn-*` command owned by the plugin, declared in the manifest. */
export interface PluginCommandDecl {
  /** Command name as typed in the shell, e.g. `axn-my-thing`. */
  name: string;
  /** Appends a trailing space on Tab-completion when the command takes an arg. */
  takesArg?: boolean;
  /** Built-in argument completion: workspace names or filesystem paths. */
  argCompletion?: 'workspace' | 'dir' | 'file';
  /**
   * Dynamic argument completion — when true, Tab on the argument position
   * dispatches a `completeArg` event to the logic frame expecting `string[]`.
   */
  completeArg?: boolean;
}

/** `~/.axn-term/plugins/<name>/plugin.json`. */
export interface PluginManifest {
  /** Unique plugin id — also the plugins.yaml section key (`settingsKey`). */
  id: string;
  title: string;
  /** `x.y.z` — shown in Settings. */
  version?: string;
  description?: string;
  /**
   * The plugin's icon — a Lucide icon name or inline `<svg>` tag (the
   * `sessionIcons` value format). Declaring it is the has-an-icon
   * capability: the Logo override field appears in Settings → Plugins, and
   * with `processPattern` it doubles as the session icon for matching
   * foreground processes.
   */
  logo?: string;
  /**
   * Bind the plugin to a foreground process: a regex matched against the
   * session's `process`. When it stops matching, `processEnd` fires.
   */
  processPattern?: string;
  /** Declares the plugin reports progress for the matching process. */
  handlesProgress?: boolean;
  /** Entry file for the logic frame. Defaults to `plugin.mjs`. */
  logic?: string;
  /**
   * View file (default `index.html`) — declaring it gives the plugin a
   * full-area view, activated from the app rail.
   */
  view?: string;
  /** The view may host detached session tabs (editor/browser/preview). */
  hostsTabs?: boolean;
  /** Declarative settings rendered in Settings → Plugins. */
  settings?: PluginSettingField[];
  /** Owned `axn-*` commands. */
  commands?: PluginCommandDecl[];
  /**
   * Capabilities the plugin needs (see `PluginPermission`) — shown in
   * Settings; anything undeclared is refused by the host. Default: none.
   */
  permissions?: import('./permissions').PluginPermission[];
}

// ---------------------------------------------------------------------------
// Data shapes crossing the boundary
// ---------------------------------------------------------------------------

export type AttentionLevel = 'warning' | 'critical';

/** A "needs attention" flag — pulsing disc on the session's process icon. */
export interface SessionAttention {
  message?: string;
  level?: AttentionLevel;
}

export type BannerLevel = 'info' | 'warning' | 'error';

export interface SessionBannerAction {
  id: string;
  icon?: 'chevron-left' | 'chevron-right' | 'play' | 'trash';
  label?: string;
  title?: string;
  disabled?: boolean;
}

/** A banner strip on top of a session view. */
export interface SessionBanner {
  message: string;
  level?: BannerLevel;
  dismissible?: boolean;
  actions?: SessionBannerAction[];
  trailingActions?: SessionBannerAction[];
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'blocked' | 'completed';

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

/**
 * The session projection visible to sandboxed plugins — a trimmed, stable
 * subset of the app's internal session shape. `state` holds *this plugin's
 * own* `pluginState` slice.
 */
export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  customName?: string;
  autoName?: string;
  topic: string;
  summary: string;
  status?: SessionStatus;
  tasks: Task[];
  progress: number;
  cwd?: string;
  process?: string;
  /** Id of the plugin whose input-owning agent runs in the session (e.g. `devin`). */
  agentInput?: string;
  /** @deprecated Use `agentInput === 'devin'`. */
  devinActive?: boolean;
  repo?: RepoInfo;
  /** This plugin's own persisted per-session state. */
  state?: unknown;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  collapsed?: boolean;
  /** The workspace's anchor directory, set from its context menu. */
  defaultFolder?: string;
}

export interface PathStat {
  path: string;
  isDir: boolean;
  isFile: boolean;
  size: number;
  mtime?: number;
}

// ---------------------------------------------------------------------------
// The `window.axn` client
// ---------------------------------------------------------------------------

/** Event names accepted by `axn.on` in the logic frame. */
export type AxnLogicEvent =
  | 'init'
  | 'sessionOpen'
  | 'output'
  | 'close'
  | 'line'
  | 'command'
  | 'completeArg'
  | 'processEnd'
  | 'subShellExit'
  | 'bannerAction'
  | 'surfaceAction'
  | 'peer'
  | 'theme';

/** Event names accepted by `axn.on` in the view frame. */
export type AxnViewEvent = 'init' | 'sessions' | 'appState' | 'peer' | 'theme';

/** Session-scoped operations, also reachable via `axn.session(id)`. */
export interface AxnSessionHandle {
  /** Write input to the session's main PTY. */
  write(data: string): Promise<void>;
  /** Run `sh -c <command>`; resolves trimmed stdout. Rejects when unsupported. */
  exec(command: string, cwd?: string): Promise<string>;
  /** The live PTY cwd (falls back to the session's stored cwd). */
  getCwd(): Promise<string | null>;
  /** Resolves once the PTY emits output, false on timeout. */
  waitForOutput(timeoutMs?: number): Promise<boolean>;
  /** Bottom terminal screen lines (right-trimmed), regardless of scrollback. */
  getScreenLines(): Promise<string[]>;
  readFile(path: string, cwd?: string): Promise<string>;
  writeFile(path: string, contents: string, cwd?: string): Promise<void>;
  statPath(path: string, cwd?: string): Promise<PathStat | null>;
  mkdir(path: string, cwd?: string): Promise<boolean>;
  /** Open a directory-browser tab. */
  openBrowser(path: string): Promise<void>;
  /** Open a session sub-view tab. */
  openTab(tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git' }): Promise<void>;
  /**
   * Open a sub-shell tab — one-shot `sh -c` with `command`, interactive
   * shell without. Resolves the tab/PTY id (`subShellExit` reports it).
   */
  openSubShell(
    command?: string,
    cwd?: string,
    label?: string,
    agent?: 'devin' | 'claude' | 'agy' | 'codex',
  ): Promise<string | undefined>;
  /**
   * Open a new session rooted at `cwd` (default: the app's shell default).
   * `name` overrides its display name; `workspaceId` targets a workspace
   * other than this session's own. The PTY spawns when its terminal mounts
   * — writes into it must wait for the new session's `sessionOpen` event.
   */
  openSession(cwd?: string, name?: string, workspaceId?: string): Promise<void>;
  /** The workspace this session belongs to (carries `defaultFolder`). */
  getWorkspace(): Promise<WorkspaceInfo | null>;
  /** All workspaces in the window, in panel order. */
  getWorkspaces(): Promise<WorkspaceInfo[]>;
  /**
   * Dispatch a line through the session's hidden/plugin command pipeline —
   * the same path a typed `axn-*` line takes. Resolves `false` when the
   * command swallowed the line (handled), a replacement command string, or
   * `undefined` when it should pass through to the shell unchanged.
   */
  runCommand(line: string): Promise<string | false | undefined>;
  /**
   * Bring a session tab to the front: `'shell'` for the main terminal, else
   * a tab matched by id, kind, 1-based index, or label. Selects the session
   * and dismisses a covering plugin view. Resolves `true` when a matching
   * tab was activated.
   */
  activateTab(tabId: string): Promise<boolean>;
  /** Shallow-merge into this plugin's per-session persisted state. */
  updateState(patch: Record<string, unknown>): Promise<void>;
  /** Raise/clear a "needs attention" flag (pass `null` to clear). */
  setAttention(attention: SessionAttention | null): Promise<void>;
  /** Show/clear the session banner (pass `null` to clear). */
  setBanner(banner: SessionBanner | null): Promise<void>;
  /** Raise/clear the blocking "restoring" overlay (pass `null` to clear). */
  setRestoring(label: string | null): Promise<void>;
  /** Current session projection. */
  info(): Promise<SessionInfo | null>;
}

/**
 * The sandboxed plugin client — injected as `window.axn` into both frames
 * before the plugin code runs.
 */
export interface AxnClient {
  /** `AXN_PLUGIN_API_VERSION` of the connected host. */
  readonly apiVersion: number;
  /** Which frame this is: `logic` or `view`. */
  readonly role: 'logic' | 'view';
  /** Current theme CSS vars (`--bg`, `--text-primary`, …). */
  readonly theme: Record<string, string>;
  /** The plugin's normalized plugins.yaml section. */
  readonly settings: unknown;
  /** The plugin's app-level persisted data (views only; pushed live). */
  readonly appState: unknown;
  /** Latest session list (views only; pushed live). */
  readonly sessions: SessionInfo[];

  /** Subscribe to an event; returns an unsubscribe function. */
  on(event: AxnLogicEvent | AxnViewEvent, fn: (data: unknown) => unknown): () => void;
  /** Raw RPC escape hatch for methods without a typed helper. */
  call(method: string, args?: unknown[], sessionId?: string): Promise<unknown>;
  /** Session-scoped operations bound to one session id. */
  session(sessionId: string): AxnSessionHandle;

  /** All live sessions. */
  getSessions(): Promise<SessionInfo[]>;
  /** App-level persisted data — shallow-merge patch. */
  updateAppState(patch: Record<string, unknown>): Promise<void>;
  /** Select a session in the panel and leave the plugin view. */
  selectSession(sessionId: string): Promise<void>;
  /** Deactivate the plugin view (view frames only). */
  closeView(): Promise<void>;

  /**
   * Push a sanitized-HTML surface for a session — `render` shows under the
   * terminal, `row` a compact line inside the session panel row. Elements
   * carrying `data-axn-action="<id>"` emit `surfaceAction` events on click.
   */
  setSurface(surface: 'render' | 'row', sessionId: string, html: string | null): void;

  /** Send a payload to the plugin's other frame (`peer` event there). */
  sendToPeer(payload: unknown): void;
}
