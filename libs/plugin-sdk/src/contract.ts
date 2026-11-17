/**
 * Wire contract between axn-term and sandboxed plugins.
 *
 * A sandboxed plugin lives in `<iframe sandbox="allow-scripts">` documents
 * (opaque origin — no DOM/storage/Tauri access to the app). Everything it can
 * do flows over `postMessage` envelopes tagged `{ axn: 'plugin-v1' }`.
 *
 * Two frames exist per plugin:
 *  - the *logic* frame (hidden, runs `plugin.mjs`) — receives session
 *    lifecycle events and issues RPC calls
 *  - the *view* frame (optional, `index.html`) — rendered into the plugin's
 *    full-area view; gets its own `init`/`sessions` pushes and can relay
 *    messages to the logic frame via `peer`
 */

/** Bump when an envelope shape below changes incompatibly. */
export const AXN_PLUGIN_API_VERSION = 1;

/** Envelope marker — every message carries `{ axn: AXN_MSG_TAG }`. */
export const AXN_MSG_TAG = 'plugin-v1';

/** Session-bound hooks the host forwards to the logic frame once subscribed. */
export type SandboxHook =
  /** A session's PTY spawned (and replayed for pre-existing sessions on subscribe). */
  | 'sessionOpen'
  /** A chunk of PTY output; `data` is `{ text }`. */
  | 'output'
  /** A session closed. */
  | 'close'
  /**
   * Arbitrary submitted input line (onCommand semantics); `data` is
   * `{ line }`. Response string replaces the line, `false` swallows it,
   * undefined passes through.
   */
  | 'line'
  /**
   * An owned manifest command was submitted; `data` is `{ name, arg, line }`.
   * Same response semantics as `line`.
   */
  | 'command'
  /**
   * Tab-completion asked for arguments of an owned command; `data` is
   * `{ name, argPrefix }`. Response must be a `string[]` of candidates.
   */
  | 'completeArg'
  /** The session's foreground process stopped matching `processPattern`. */
  | 'processEnd'
  /** A plugin-spawned sub-shell tab exited; `data` is `{ tabId, exitCode }`. */
  | 'subShellExit'
  /** A session banner button was clicked; `data` is `{ actionId }`. */
  | 'bannerAction'
  /** A `[data-axn-action]` element inside a pushed surface was clicked;
   * `data` is `{ surface, sessionId, action }`. */
  | 'surfaceAction';

/** The two frame roles a sandboxed plugin occupies. */
export type SandboxRole = 'logic' | 'view';

/** Host → frame. */
export type HostMessage =
  | {
      axn: typeof AXN_MSG_TAG;
      type: 'init';
      role: SandboxRole;
      apiVersion: number;
      /** CSS custom property values (`--bg`, `--text-primary`, …). */
      theme: Record<string, string>;
      settings: unknown;
      appState: unknown;
    }
  | {
      axn: typeof AXN_MSG_TAG;
      type: 'event';
      hook: SandboxHook;
      sessionId?: string;
      /** The session projection at dispatch time (`SessionInfo`). */
      session?: unknown;
      data?: unknown;
      /** Set when the hook expects a reply (`line`, `command`, `completeArg`). */
      requestId?: number;
    }
  | {
      axn: typeof AXN_MSG_TAG;
      type: 'result';
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    }
  | { axn: typeof AXN_MSG_TAG; type: 'theme'; theme: Record<string, string> }
  /** A `peer` payload relayed from the plugin's other frame. */
  | { axn: typeof AXN_MSG_TAG; type: 'peer'; payload: unknown }
  /** View frames: pushed session list (see `SessionInfo`). */
  | { axn: typeof AXN_MSG_TAG; type: 'sessions'; sessions: unknown[] }
  /** View frames: pushed app-level plugin state. */
  | { axn: typeof AXN_MSG_TAG; type: 'appState'; value: unknown }
  /** Both frames: the selected rail view changed (`ActiveView | null`). */
  | { axn: typeof AXN_MSG_TAG; type: 'viewChanged'; value: unknown };

/** Frame → host. */
export type FrameMessage =
  | { axn: typeof AXN_MSG_TAG; type: 'ready' }
  | { axn: typeof AXN_MSG_TAG; type: 'subscribe'; hooks: SandboxHook[] }
  | {
      axn: typeof AXN_MSG_TAG;
      type: 'call';
      id: number;
      method: string;
      sessionId?: string;
      args: unknown[];
    }
  | { axn: typeof AXN_MSG_TAG; type: 'respond'; requestId: number; result: unknown }
  | {
      axn: typeof AXN_MSG_TAG;
      type: 'surface';
      surface: 'render' | 'row';
      sessionId: string;
      html: string | null;
    }
  /** Relay a payload to the plugin's other frame (logic ↔ view). */
  | { axn: typeof AXN_MSG_TAG; type: 'peer'; payload: unknown };

export function isFrameMessage(data: unknown): data is FrameMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { axn?: unknown }).axn === AXN_MSG_TAG
  );
}
