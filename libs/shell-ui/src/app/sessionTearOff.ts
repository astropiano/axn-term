import type { PeerChannel } from '../platform';
import type { WorkspaceRef } from './windowPeers';

/**
 * Chrome-style session tear-off between windows, on top of the peer channel
 * and the adopt hand-over in `windowPeers.ts`:
 *
 * - Dragging a session row out of its window (dropped where no window takes
 *   it) opens a new window booted *empty* with a tear-off intent; the new
 *   window announces itself on TOPIC_WINDOW_READY and the source hands the
 *   session over with the regular adopt request — PTYs stay alive throughout.
 * - While a session is dragged, its window announces the drag
 *   (TOPIC_SESSION_DRAG / _END) so every other window accepts the drop; the
 *   window it lands on asks the source for it (TOPIC_SESSION_DROP), and the
 *   source runs the same adopt hand-over into that window.
 */

/** A window opened for a tear-off is up and waiting for its session. */
export const TOPIC_WINDOW_READY = 'axn:window-ready';
/** A window started dragging one of its sessions. */
export const TOPIC_SESSION_DRAG = 'axn:session-drag';
/** That drag ended (dropped anywhere, or cancelled). */
export const TOPIC_SESSION_DRAG_END = 'axn:session-drag-end';
/** A window took a dragged session — the source should hand it over. */
export const TOPIC_SESSION_DROP = 'axn:session-drop';

/** How long the source waits for a freshly opened window to come up. */
export const WINDOW_READY_TIMEOUT_MS = 15_000;
/** How long a tear-off window waits for its session before closing again. */
export const TEAR_OFF_ADOPT_TIMEOUT_MS = 20_000;
/** How often a tear-off window repeats its ready announcement. */
export const WINDOW_READY_REPEAT_MS = 1_000;
/**
 * After a drag ends outside the window, wait this long before tearing off: a
 * drop claim from another window (sent from its own drop handler) wins.
 */
export const TEAR_OFF_CLAIM_GRACE_MS = 400;
/**
 * A drop target keeps the foreign drag this long after the source announced
 * its end — the source's dragend can overtake the target's own drop event.
 */
export const FOREIGN_DRAG_LINGER_MS = 1_000;

/** What a window was opened for, carried in its URL fragment. */
export interface WindowBootIntent {
  kind: 'tear-off';
  /** Correlates the new window's ready announcement with the source. */
  requestId: string;
  /** The source window's id. */
  from: string;
  /** Name for the new window's workspace (the source session's workspace). */
  workspaceName?: string;
}

const BOOT_KEY = 'axn-boot';

/** URL fragment (without `#`) that hands `intent` to a new window. */
export function encodeBootIntent(intent: WindowBootIntent): string {
  return `${BOOT_KEY}=${encodeURIComponent(JSON.stringify(intent))}`;
}

/** The boot intent in a window's `location.hash`, or null. */
export function parseBootIntent(hash: string | null | undefined): WindowBootIntent | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get(BOOT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WindowBootIntent>;
    if (value?.kind !== 'tear-off') return null;
    if (typeof value.requestId !== 'string' || typeof value.from !== 'string') return null;
    if (!value.requestId || !value.from) return null;
    return {
      kind: 'tear-off',
      requestId: value.requestId,
      from: value.from,
      ...(typeof value.workspaceName === 'string' && value.workspaceName.trim()
        ? { workspaceName: value.workspaceName.trim().slice(0, 200) }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface WindowReady {
  windowId: string;
  requestId: string;
  workspace: WorkspaceRef;
}

export interface SessionDrag {
  from: string;
  sessionId: string;
  name: string;
}

export interface SessionDragEnd {
  from: string;
  sessionId: string;
}

export interface SessionDrop {
  /** The source window, which owns the session. */
  to: string;
  sessionId: string;
  /** The window the session was dropped on. */
  windowId: string;
  workspace: WorkspaceRef;
  /** Insert before this session in the target workspace; null appends. */
  beforeSessionId: string | null;
}

/**
 * Wait for the window opened with `requestId` to announce itself. Subscribe
 * BEFORE creating the window so the announcement cannot be missed; `cancel`
 * stops listening (resolving null) when the window could not be created.
 */
export function waitForWindowReady(
  peers: PeerChannel,
  requestId: string,
  timeoutMs = WINDOW_READY_TIMEOUT_MS,
): { promise: Promise<WindowReady | null>; cancel: () => void } {
  let finish: (value: WindowReady | null) => void = () => {};
  const promise = new Promise<WindowReady | null>((resolve) => {
    let settled = false;
    finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(value);
    };
    const unsub = peers.subscribe(TOPIC_WINDOW_READY, (payload) => {
      const ready = payload as Partial<WindowReady> | null;
      if (
        ready?.requestId !== requestId ||
        typeof ready.windowId !== 'string' ||
        typeof ready.workspace?.id !== 'string'
      ) {
        return;
      }
      finish(ready as WindowReady);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
  return { promise, cancel: () => finish(null) };
}

/**
 * Open a window for a tear-off and wait until it is up: subscribes to its
 * ready announcement first, then creates the window booted with the intent.
 * Resolves the window and its workspace, or an error message.
 */
export async function openTearOffWindow(
  peers: PeerChannel,
  createWindow: (options: { boot: WindowBootIntent } & TearOffPlacement) => Promise<string>,
  request: { from: string; workspaceName?: string; placement?: TearOffPlacement },
  timeoutMs = WINDOW_READY_TIMEOUT_MS,
): Promise<{ ok: true; ready: WindowReady } | { ok: false; error: string }> {
  const requestId = `${request.from}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  // Listen before the window exists so its announcement cannot be missed.
  const ready = waitForWindowReady(peers, requestId, timeoutMs);
  let windowId: string;
  try {
    windowId = await createWindow({
      boot: {
        kind: 'tear-off',
        requestId,
        from: request.from,
        ...(request.workspaceName ? { workspaceName: request.workspaceName } : {}),
      },
      ...request.placement,
    });
  } catch (e) {
    ready.cancel();
    return { ok: false, error: `the window could not be opened (${String(e)})` };
  }
  const announced = await ready.promise;
  if (!announced) return { ok: false, error: 'the new window did not start' };
  if (announced.windowId !== windowId) {
    return { ok: false, error: 'a different window answered' };
  }
  return { ok: true, ready: announced };
}

/** Where to open a torn-off window: the drop point and the source's size. */
export interface TearOffPlacement {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Placement for a window torn off at a dragend: the source window's size, and
 * — when the drop point is known to be outside the source window — that
 * screen point, offset so the cursor lands near the new window's top-left.
 * Wayland reports no global coordinates, so there the compositor places it.
 */
export function tearOffPlacement(
  drop: { screenX: number; screenY: number; clientX: number; clientY: number },
  viewport: { width: number; height: number },
): TearOffPlacement {
  const size = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
  const outside =
    drop.clientX < 0 ||
    drop.clientY < 0 ||
    drop.clientX > viewport.width ||
    drop.clientY > viewport.height;
  const known = Number.isFinite(drop.screenX) && Number.isFinite(drop.screenY) && (drop.screenX !== 0 || drop.screenY !== 0);
  if (!outside || !known) return size;
  return { ...size, x: Math.round(drop.screenX - 60), y: Math.round(drop.screenY - 20) };
}

/**
 * Tracks whether an HTML5 drag that started in this document has left it —
 * without coordinates, which Wayland does not report outside the window.
 * Crossing from one element to another fires `dragenter` on the new element
 * and `dragleave` on the old one in the same task; leaving the window fires a
 * lone `dragleave`. So a `dragleave` with no `dragenter` earlier in the same
 * task means the pointer left, and any later `dragenter`/`dragover` means it
 * is back.
 */
export function createDragExitTracker(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
) {
  let inside = true;
  let enteredThisTask = false;
  let active = false;
  const onEnter = () => {
    inside = true;
    if (!enteredThisTask) {
      enteredThisTask = true;
      // A macrotask: it runs after every listener of the current native
      // event batch, so a dragleave in the same batch still sees the flag.
      defer(() => {
        enteredThisTask = false;
      });
    }
  };
  const onOver = () => {
    inside = true;
  };
  const onLeave = () => {
    if (!enteredThisTask) inside = false;
  };
  return {
    start() {
      if (active) return;
      active = true;
      inside = true;
      enteredThisTask = false;
      target.addEventListener('dragenter', onEnter, true);
      target.addEventListener('dragover', onOver, true);
      target.addEventListener('dragleave', onLeave, true);
    },
    /** Whether the pointer was outside the document when the drag ended. */
    stop(): boolean {
      if (!active) return false;
      active = false;
      target.removeEventListener('dragenter', onEnter, true);
      target.removeEventListener('dragover', onOver, true);
      target.removeEventListener('dragleave', onLeave, true);
      return !inside;
    },
  };
}

/** Whether a dragend landed outside the window, by coordinates or tracking. */
export function dragEndedOutside(
  e: { clientX: number; clientY: number },
  viewport: { width: number; height: number },
  trackerSaysLeft: boolean,
): boolean {
  if (trackerSaysLeft) return true;
  return e.clientX < 0 || e.clientY < 0 || e.clientX > viewport.width || e.clientY > viewport.height;
}
