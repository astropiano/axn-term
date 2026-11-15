import type { ControlReply, KnownServer, RemoteConsole, Unsubscribe } from '@axn-term/session-backend';
import type { RemoteStatus } from '@axn-term/session-backend/remote';
import type { AppSettings } from './themes';
import type { WindowBootIntent } from './app/sessionTearOff';

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
  /**
   * Attach-only mirror (remote mode): the UI must NEVER synthesize or spawn
   * sessions — an empty/failed load means "wait for the authority", not
   * "create a fresh session". Cloud/hosted stores leave this unset.
   */
  attachOnly?: boolean;
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

/** Options for a window opened by tearing a session out of another one. */
export interface NewWindowOptions {
  boot?: WindowBootIntent;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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
  /** Bring this window to the front (after a session moved into it). */
  focus?(): void;
  /**
   * Spawn another app window (desktop only; web: new browser tab by user).
   * Resolves the new window's id. `options` open it for a session tear-off:
   * `boot` is handed to the new window as its `bootIntent`, placement is a
   * logical screen position/size (ignored where the compositor places windows).
   */
  createWindow?(options?: NewWindowOptions): Promise<string>;
  /**
   * Why this window was opened, when another window opened it for a session
   * tear-off (desktop: parsed from the window URL's fragment). Absent for
   * windows the user opened or restored.
   */
  bootIntent?: WindowBootIntent | null;
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
  /** Open the app log folder in the OS file manager — desktop only. */
  openLogDir?(): void;
  stateStore: ShellStateStore;
  pluginSettingsStore: PluginSettingsStore;
  workspaceSetStorage: WorkspaceSetStorage;
  /**
   * Native directory picker — resolves the picked absolute path, null on
   * cancel. Desktop only (Tauri dialog); absent elsewhere, where callers
   * fall back to the embedded FilePickerModal over the backend's fs ops.
   */
  pickDirectory?(): Promise<string | null>;
  /** Installed font family names for settings suggestions; absent → no hints. */
  listFonts?(): Promise<string[]>;
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
   * Tint the native window titlebar to the given #rrggbb — desktop/macOS
   * only; called from applyTheme with the resolved --bg-secondary.
   */
  setTitlebarColor?(color: string): void;
  /**
   * Live remote-authority (publish) status — desktop only, present once
   * Remote control is configured. `state` is 'idle' while not publishing.
   */
  remoteAuthorityStatus?: {
    get(): { state: 'idle' | 'connecting' | 'connected' | 'failed'; error?: string };
    subscribe(cb: () => void): () => void;
  };
  /**
   * The remote console's shared viewport/viewer state — desktop: the
   * RemoteAuthority's claims+ptys (role 'authority'); web viewer: the
   * mirrored replica (role 'viewer'). Absent when no remote is in play.
   */
  remoteConsole?: RemoteConsole;
  /**
   * Publish a shared app-level state entry to every connected device —
   * desktop authority: a `setPluginState`-equivalent local write + replica
   * patch; web viewer: a `/vm/setPluginState` invoke upstream. Absent when
   * no remote session is in play. Keys are `app:`-prefixed (`app:icons`).
   */
  publishSharedState?(key: string, data: string): void;
  /**
   * Sign the user out of the account session — web: keycloak logout
   * (redirects the page). The remote viewer panel exposes it; the desktop
   * signs out of publishing via `remoteAuth.signOut` instead.
   */
  signOut?(): void;
  /**
   * OIDC sign-in for remote publishing — desktop only. 'pending' carries
   * the device-flow user code + verification URI to show/open.
   */
  remoteAuth?: {
    get(): {
      state: 'signedOut' | 'pending' | 'signedIn' | 'error';
      user?: string;
      error?: string;
      userCode?: string;
      verificationUri?: string;
    };
    subscribe(cb: () => void): () => void;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
    /** Fresh access token for the authority hello; undefined when signed out. */
    getAccessToken?(): Promise<string | undefined>;
  };
  /**
   * Connect-by-address for remote publishing — desktop only. `connect`
   * resolves a typed server address through its discovery document and
   * returns the settings to apply (server, hub, issuer, client id);
   * `pairingLink` is what the "Connect a phone" QR code carries.
   */
  remoteServer?: {
    connect(input: string): Promise<Partial<AppSettings>>;
    pairingLink(server: KnownServer): string | null;
    /** The server's view of this account: mirrored sessions + recent
     *  hello attempts with denial reasons (GET <hub>/status). */
    status?(hubUrl: string): Promise<RemoteStatus>;
  };
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
   * `axn-term session …` requests from a program inside one of our
   * terminals (desktop: the control socket, already authenticated as
   * `ptyId`). Every window hears each request; the one owning the PTY
   * resolves an answer, the others resolve null. Absent on web.
   */
  onControlCommand?(
    cb: (cmd: { ptyId: string; line: string }) => Promise<ControlReply | null>,
  ): Unsubscribe;
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
