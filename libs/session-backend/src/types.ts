/**
 * Backend-neutral port between the shared shell UI and the environment that
 * actually owns the PTY. The desktop app implements this over Tauri
 * invoke()/listen(); the web app implements it over the gateway/session-host
 * WebSocket protocol.
 *
 * Optional members are capabilities that only exist in some environments —
 * UI features depending on them must degrade when absent.
 */

export type Unsubscribe = () => void;

export interface PtySpawnOptions {
  /** Shell binary override; undefined means the environment default. */
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface PathStat {
  /** Resolved absolute path. */
  path: string;
  isFile: boolean;
  isDir: boolean;
}

/** A directory listing entry, as returned by `listDir`. */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Per-session RSS, for plugins declaring `needsMemoryStats`. */
export interface SessionMemory {
  sessionId: string;
  rssKb: number;
}

/** System memory statistics (KiB), for plugins declaring `needsMemoryStats`. */
export interface MemoryStats {
  totalKb: number;
  availableKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  appRssKb: number;
  sessions: SessionMemory[];
}

export interface SubshellSpawnOptions {
  /** Owning session's current main PTY id. */
  parentId: string;
  /** One-shot `sh -c` command; undefined spawns an interactive shell. */
  command?: string;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface FsResult {
  ok: boolean;
  contents?: string;
  error?: string;
  /** Absolute path the backend resolved the request against. */
  resolved?: string;
}

/** The answer to an `axn-term session …` line: ok + message, or an error. */
export interface ControlReply {
  ok: boolean;
  message?: string;
  error?: string;
}

/**
 * Runs an `axn-term session …` line for the PTY it came from; resolves null
 * when this window does not show that PTY.
 */
export type ControlCommandHandler = (cmd: { ptyId: string; line: string }) => Promise<ControlReply | null>;

/** The first handler that owns the PTY answers; nobody → an error. */
export async function answerControl(
  handlers: Iterable<ControlCommandHandler>,
  cmd: { ptyId: string; line: string },
): Promise<ControlReply> {
  for (const handler of handlers) {
    const reply = await handler(cmd).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (reply) return reply;
  }
  return { ok: false, error: 'this window does not show that terminal' };
}

export interface SessionBackend {
  /**
   * Spawn or attach to the PTY bound to `sessionId`. Resolves `true` when a
   * new process was spawned, `false` when an existing PTY was reattached
   * (e.g. a promoted sub-shell, or a reconnected remote session).
   */
  createSession(sessionId: string, opts: PtySpawnOptions): Promise<boolean>;
  /** Raw input bytes for the PTY. Fire-and-forget. */
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  /**
   * Viewer stopped looking at this PTY — remote backends close the pull
   * stream so the authority can relax shared geometry back to the owner's
   * size. Absent on local backends (nothing shared to relax).
   */
  releasePty?(sessionId: string): void;
  /**
   * Write once the slave tty is in raw mode (ECHO/ICANON cleared) — for
   * emulator query replies (OSC 10/11/12 color reports) that a cooked+echo
   * tty would echo back as visible text and canonical-buffer into the
   * asker's input at the next mode flip. Resolves after the write landed
   * (true) or the reply was dropped still-cooked at `timeoutMs` (default
   * 4 s), so callers can hold later input behind it. Desktop only; absent
   * → caller falls back to a delay.
   */
  writeWhenRaw?(sessionId: string, data: string, timeoutMs?: number): Promise<boolean>;
  close(sessionId: string): void;
  /** Raw PTY output. Must be subscribed before createSession to avoid losing early output. */
  onOutput(sessionId: string, cb: (data: Uint8Array) => void): Unsubscribe;
  /**
   * Pause/resume this device's viewport claim on shared remote PTY geometry.
   * Absent on backends without shared-session geometry (local PTY, WsBackend).
   */
  setViewportPaused?(paused: boolean): void;

  /** Name of the foreground process in the session PTY (null = shell). */
  getForegroundProcess?(sessionId: string): Promise<string | null>;
  /**
   * `axn-term session …` lines from programs inside a remote terminal,
   * forwarded by the session host (web: a `control-command` frame on the
   * PTY's /ws connection, or the Ramphastos `control` stream). `ptyId` is
   * this backend's id for the PTY. Desktop uses `platform.onControlCommand`.
   */
  onControlCommand?(cb: ControlCommandHandler): Unsubscribe;
  /**
   * Controlling terminal of the session PTY (e.g. `/dev/ttys003`,
   * `/dev/pts/0`) — lets a plugin correlate out-of-band events emitted by a
   * process running in that PTY (e.g. agent hooks writing files). Absent on
   * backends that cannot answer it.
   */
  getTty?(sessionId: string): Promise<string | null>;
  /** Live cwd of the session PTY. */
  getCwd?(sessionId: string): Promise<string | null>;
  getDefaultShell?(): Promise<string>;
  /**
   * Resolve a path-like token against a cwd. `cwd` is advisory — remote
   * backends may ignore it and always resolve against the live PTY cwd.
   */
  statPath?(sessionId: string, cwd: string, path: string): Promise<PathStat | null>;
  readFile?(sessionId: string, path: string): Promise<FsResult>;
  writeFile?(sessionId: string, path: string, contents: string): Promise<FsResult>;

  /**
   * Run a shell command (`sh -c`) in the session's environment and resolve
   * with trimmed stdout. Absent when the environment cannot exec (UI that
   * depends on it should hide).
   */
  exec?(sessionId: string, command: string, cwd?: string): Promise<string>;
  /** Run `git` with an explicit argv (no shell quoting) in `cwd`. */
  execGit?(sessionId: string, cwd: string, args: string[]): Promise<string>;
  /** List a directory in the session's filesystem. */
  listDir?(sessionId: string, path: string): Promise<DirEntry[]>;
  mkdir?(sessionId: string, path: string): Promise<void>;
  /** Binary read for previews (images etc.); absent disables binary previews. */
  readBytes?(sessionId: string, path: string): Promise<Uint8Array>;
  /**
   * True when sessions run on this machine, so a dropped file's own path
   * (from a `file://` URI) is valid inside them.
   */
  readonly localFiles?: boolean;
  /**
   * Store the contents of a file dropped onto the session's terminal where
   * the session can read it (a fresh private temp dir) and resolve with its
   * path — for drops that carry no path. Absent → such drops are ignored.
   */
  saveDroppedFile?(sessionId: string, name: string, bytes: Uint8Array): Promise<string>;
  /**
   * Watch a directory for changes; absent means directory views refresh only
   * on explicit actions.
   */
  watchDir?(sessionId: string, path: string, cb: () => void): Unsubscribe | Promise<Unsubscribe>;

  /**
   * Spawn a sibling PTY for a sub-shell tab. `command` runs as `sh -c`;
   * absent command spawns an interactive shell.
   */
  createSubshell?(ptyId: string, opts: SubshellSpawnOptions): Promise<boolean>;
  /**
   * Re-parent (or detach, `parentId = null`) a sub-shell PTY — used by
   * sub-shell promotion and turn-into-workspace. Absent on backends without
   * PTY parent tracking; callers must tolerate no-ops.
   */
  setSubshellParent?(subshellId: string, parentId: string | null): void;
  /**
   * Output flow control: stop reading the PTY while the terminal is behind,
   * resume once it caught up. Absent → output is never throttled.
   */
  pause?(sessionId: string): void;
  resume?(sessionId: string): void;
  /** A session's main PTY exited (payload: the PTY id). */
  onSessionExit?(cb: (ptyId: string) => void): Unsubscribe;
  /** A sub-shell PTY exited (payload: tab/PTY id + exit code when known). */
  onSubshellExit?(cb: (ptyId: string, exitCode: number | null) => void): Unsubscribe;
  /**
   * Any session PTY produced output — used by views that refresh on terminal
   * activity (e.g. the git workbench). `sessionId` is the PTY id.
   */
  onAnyOutput?(cb: (sessionId: string, data: Uint8Array) => void): Unsubscribe;

  /** System memory stats; absent disables memory-bound UI (e.g. ram plugin). */
  getMemoryStats?(): Promise<MemoryStats>;

  /** True when the path exists in the session's filesystem. */
  fsExists?(sessionId: string, path: string): Promise<boolean>;
}

/**
 * OS-level services the shared UI needs. Browser builds wire these to
 * navigator.clipboard/window.open; desktop builds to Tauri plugins.
 * Optional members hide their corresponding UI affordance when absent.
 */
/** Decoded image pixels for `ShellServices.copyImage` (RGBA8888, row-major). */
export interface ClipboardImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ShellServices {
  copyText(text: string): Promise<void> | void;
  /**
   * Copy decoded image pixels to the clipboard (Copy on image previews).
   * Absent where the platform cannot write images.
   */
  copyImage?(image: ClipboardImage): Promise<void> | void;
  /** Read clipboard text; browsers without permission may omit it. */
  pasteText?(): Promise<string | undefined>;
  /** Open an external URL in the system browser / a new tab. */
  openExternal(url: string): void;
  /** Open a directory in the OS file manager or an app browser view. */
  openDirectory?(path: string): void;
  /** Reveal a path in the OS file manager. */
  revealPath?(path: string): void;
  /** Label for revealPath (e.g. "Reveal in Finder"); unused when revealPath is absent. */
  revealLabel?: string;
  /**
   * Small persisted key-value store for UI-side caches (e.g. agent review
   * explanations). Desktop stores it under `~/.axn-term/kv.json`, web builds
   * use localStorage. `set(key, null)` deletes the key.
   */
  storage?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
  };
  /** Whether a read-only preview tab is available for this path (Preview button). */
  hasFilePreview?(path: string): boolean;
  /**
   * Post an OS-level notification (desktop: system notification, web: Web
   * Notification). Permission is requested lazily by the implementation.
   * Absent where notifications are unavailable.
   */
  notify?(title: string, body?: string): void;
  /**
   * Files dropped onto this window, with their own paths, where the webview
   * takes file drops natively (desktop on Linux: WebKitGTK hides a dropped
   * file's path from the page's drop event). Absent elsewhere — the page's
   * drop events carry those drops.
   */
  onFileDrop?(cb: (paths: string[]) => void): Unsubscribe;
}

/** File access used by hover-card content previews and the editor. */
export interface FileReader {
  readText(path: string): Promise<string>;
  /** Binary reads for image thumbnails; absent disables image previews. */
  readBytes?(path: string): Promise<Uint8Array>;
  /** Writes text; absent means read-only (editor saves disabled). */
  writeText?(path: string, contents: string): Promise<void>;
}

/**
 * Read-only view of the remote hub's shared viewport state — the
 * `/viewportClaims` collection plus the published PTY list. An authority
 * (desktop host) reports `role: 'authority'`; a remote viewer reports
 * `role: 'viewer'` with the host's device/hostname filled in. Used by the
 * remote console rail view — absent on backends/platforms with no remote.
 */
export interface RemoteConsoleSnapshot {
  role: 'authority' | 'viewer';
  /** Authority: 'idle'|'connecting'|'connected'|'failed'. Viewer: session state. */
  state: string;
  error?: string;
  hostName?: string;
  hostDevice?: string;
  /** This device's claim key — lets the UI mark "this is me". */
  selfViewerId?: string;
  /** Published terminals (id + display fields) claims are keyed on. */
  ptys: { id: string; name?: string; sessionId?: string; cols?: number; rows?: number }[];
  /** ptyId -> viewerId -> reported geometry. Smallest claim wins the PTY. */
  claims: Record<string, Record<string, { cols: number; rows: number }>>;
  /** Connected client roster (the /viewers plane): viewerId -> identity. */
  viewers?: Record<string, { name?: string; platform?: string }>;
  /** This device is not contributing a claim right now (viewer only). */
  paused?: boolean;
  /** Classified by an HTTP probe after a failed reconnect (viewer only):
   *  'unreachable' = hub down, 'ws-broken' = server up, WS path broken. */
  errorKind?: 'unreachable' | 'ws-broken';
  /** A backoff reconnect is scheduled (viewer only). */
  retrying?: boolean;
  /** Mirrored sessions this account owns (viewer discovery, >1 = pick). */
  sessions?: string[];
  /** The session id this client is attached/pinned to. */
  sessionId?: string;
  /** The hub URL this viewer/authority is bound to (viewer only). */
  authorityUrl?: string;
}

export interface RemoteConsole {
  /** Stable snapshot — rebuild on change only (useSyncExternalStore). */
  get(): RemoteConsoleSnapshot;
  subscribe(cb: () => void): () => void;
  /** Pause/resume this device's claims (viewer only; absent on authority). */
  setViewportPaused?(paused: boolean): void;
  /** Skip the backoff wait and reconnect now (viewer only). */
  retryNow?(): void;
  /** Attach to a different mirrored session by id (viewer only). */
  chooseSession?(id: string): void;
}
