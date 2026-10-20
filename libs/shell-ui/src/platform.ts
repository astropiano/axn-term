import type { Unsubscribe } from '@axn-term/session-backend';

export const isMac =
  /mac/i.test(navigator.platform ?? '') ||
  /macintosh|mac os x/i.test(navigator.userAgent);

export const isWindows = /win/i.test(navigator.platform ?? '');

/** Label for the action that reveals a file/dir in the OS file manager. */
export const revealLabel = isMac
  ? 'Reveal in Finder'
  : isWindows
    ? 'Reveal in Explorer'
    : 'Reveal in file manager';

/** Label for the action that opens a folder in the OS file manager. */
export const openFolderLabel = isMac ? 'Reveal in Finder' : 'Open folder';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Persisted app/window state. `load` returns the raw saved value (a
 * WindowState or a migration-friendly subset); `undefined`/`null` means
 * "no state yet".
 */
export interface ShellStateStore {
  load(windowId: string): Promise<unknown>;
  save(windowId: string, state: unknown): Promise<void>;
  /** Drop the stored window state (used by "close & remove" flows). */
  delete?(windowId: string): Promise<void>;
  /**
   * Optional push channel for stores whose truth lives elsewhere —
   * mirrored remote state fires `cb` when the upstream model changes so
   * the UI re-loads without a restart. Absent on all local stores.
   */
  watch?(windowId: string, cb: () => void): Unsubscribe;
}

/** YAML persistence for plugin settings (plugins.yaml content). */
export interface PluginSettingsStore {
  /** Raw YAML, or null when no config file/storage exists yet. */
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
  /**
   * Optional change subscription — fires with the raw file content whenever
   * plugins.yaml changes on disk (external edits), `null` when the file was
   * deleted. Used to live-reload plugin settings; absent on web.
   */
  watch?(cb: (yaml: string | null) => void): Unsubscribe;
}

/**
 * Generic text-file transfer — desktop uses native dialogs; web uses
 * download + file-input. `save` receives the document text and a suggested
 * filename; `load` resolves null when the user cancels.
 */
export interface FileTransfer {
  save(content: string, defaultName: string): Promise<void>;
  load(): Promise<string | null>;
}

/** Back-compat alias — workspace sets were the first FileTransfer user. */
export type WorkspaceSetStorage = FileTransfer;

/**
 * Persistent app-config store — desktop reads/writes
 * `~/.axn-term/config.yaml`; absent on web, where the settings provider
 * falls back to localStorage.
 */
export interface AppConfigStore {
  /** YAML text of the stored config, or null when no file exists. */
  load(): Promise<string | null>;
  save(yaml: string): Promise<void>;
  /**
   * Optional change subscription — fires with the raw file content whenever
   * the config changes on disk (external edits), `null` when the file was
   * deleted. Used to live-reload config.yaml; absent on web.
   */
  watch?(cb: (yaml: string | null) => void): Unsubscribe;
}

/**
 * Window/OS integration — desktop supplies real Tauri window ops; web
 * implementations omit what a browser tab cannot do.
 */
export interface ShellWindow {
  /** Stable window id used as the persistence key. */
  id: string;
  /**
   * Fired when the window is asked to close; the handler may
   * preventDefault-style defer closing (desktop: confirm modal, state flush).
   * When unset, closing a session never blocks (web: closing the tab is free).
   */
  onCloseRequested?(cb: () => void | Promise<void>): Unsubscribe;
  /** Actually tear the window down after close was confirmed/handled. */
  destroy(): Promise<void>;
  /** Close without destroying state — web: no-op (tabs can't self-close). */
  close?(): void;
  /** Spawn another app window (desktop only; web: new browser tab by user). */
  createWindow?(): void;
  /** Delete this window's persisted state, then destroy. Used by "close & remove". */
  deleteState?(): Promise<void>;
  /** Fired when the OS shuts the process down — skip confirmation. */
  onOsShutdown?(cb: () => void): Unsubscribe;
  /** Fired when another window asked this one to close (desktop multi-window). */
  onCloseWindow?(cb: (windowId: string) => void): Unsubscribe;
  /** Fired to force an immediate close without confirmation. */
  onCloseNow?(cb: () => void): Unsubscribe;
}

/**
 * Everything the shared shell needs from the environment it runs in —
 * beyond what `SessionBackend` (PTY/fs/exec) and `ShellServices`
 * (clipboard/open/reveal) already carry.
 *
 * Web implementations live in `apps/web/src/app/platform.ts`, desktop in
 * `apps/desktop/src/app/platform.ts`.
 */
export interface ShellPlatform {
  /** User home directory — session host's `/home/<user>` on web. */
  homeDir(): Promise<string>;
  /** Absolute path of the running binary; absent disables `axn-install`. */
  exePath?(): Promise<string>;
  /** Forward a log line to the host logger; absent → console. */
  emitLog?(level: LogLevel, target: string, message: string): void;
  stateStore: ShellStateStore;
  pluginSettingsStore: PluginSettingsStore;
  workspaceSetStorage: WorkspaceSetStorage;
  /** Import/export of the app config — settings modal "Import"/"Export". */
  configFileStorage: FileTransfer;
  /**
   * On-disk app settings store — desktop persists
   * `~/.axn-term/config.yaml`. Absent → settings stay in localStorage
   * (web). Migration from the legacy localStorage blob happens in the
   * settings provider.
   */
  configStore?: AppConfigStore;
  window?: ShellWindow;
  /**
   * Close the window when the last session is closed. True on desktop;
   * false/absent on web (a browser tab should never self-close).
   */
  autoCloseWhenEmpty?: boolean;
  /**
   * Remote-control command lines — a whole input line submitted out-of-band
   * (desktop: `POST /sessions/<id>/command` on the remote-control server).
   * The app feeds it through the same hidden/plugin command dispatch a typed
   * line sees. Absent on web (no remote control).
   */
  onRemoteCommand?(cb: (cmd: { sessionId: string; line: string }) => void): Unsubscribe;
  /**
   * Load external `.mjs` plugins from disk — desktop-only. Resolves the
   * number of plugins registered. Absent = no external plugin support.
   */
  loadExternalPlugins?(): Promise<number>;
  /**
   * Message channel between this app's windows (desktop: Tauri app-wide
   * events, delivered to every window including the sender — filter by the
   * payload's own window id). Powers the cross-window workspace directory and
   * moving a session into another window. Absent on web (one tab = one app).
   */
  peers?: PeerChannel;
}

export interface PeerChannel {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, cb: (payload: unknown) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Process-wide platform handle — non-React helpers (axnLog, gitClient) can't
// reach a context, so ShellApp registers its platform once at mount.
// ---------------------------------------------------------------------------

let currentPlatform: ShellPlatform | null = null;

/** Called once by ShellApp at mount. */
export function registerShellPlatform(platform: ShellPlatform): void {
  currentPlatform = platform;
}

/** The active platform, or null before ShellApp mounts. */
export function shellPlatform(): ShellPlatform | null {
  return currentPlatform;
}
