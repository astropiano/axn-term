import type { SessionBackend } from '@axn-term/session-backend';

interface Lifetime {
  owners: Set<symbol>;
  spawn: () => Promise<boolean>;
  ready?: Promise<boolean>;
  started: boolean;
  notified: boolean;
  keepAlive: boolean;
}

const lifetimes = new WeakMap<SessionBackend, Map<string, Lifetime>>();

/** PTYs owned by session state outlive their views (plugin-style mounts):
 * a view unmount never closes a live session's process. The session layer
 * swaps this set on every session-state change; a PTY absent from it (its
 * session is gone) is still closed on last release so nothing orphans. */
const retainedPtys = new Set<string>();

export function syncRetainedPtys(ids: Iterable<string>): void {
  retainedPtys.clear();
  for (const id of ids) retainedPtys.add(id);
}

/** Share one PTY across effect replays. A genuine unmount closes it only
 * when its session is gone — session-owned (retained) PTYs survive. */
export function acquirePty(
  backend: SessionBackend,
  id: string,
  spawn: () => Promise<boolean>,
) {
  let sessions = lifetimes.get(backend);
  if (!sessions) lifetimes.set(backend, sessions = new Map());
  let lifetime = sessions.get(id);
  const owner = Symbol(id);
  const start = (resource: Lifetime) => Promise.resolve().then(() => {
    if (resource.owners.size === 0) return false;
    resource.started = true;
    return resource.spawn();
  });
  if (!lifetime) {
    lifetime = {
      owners: new Set(), spawn,
      started: false, notified: false, keepAlive: false,
    };
    sessions.set(id, lifetime);
  }
  const resource = lifetime;
  resource.owners.add(owner);
  // A replay's first view has already disposed its xterm. Use the live
  // view's spawn options when the deferred start actually runs — but only
  // the first owner's options may win: the session layer holds a permanent
  // owner per live session, and its spawn options must not override a
  // mounted view's (fitted dims).
  if (resource.owners.size === 1) resource.spawn = spawn;
  resource.keepAlive = false;

  const claimSpawn = (ready: Promise<boolean>) => ready.then((spawned) => {
    if (!resource.owners.has(owner) || !spawned || resource.notified) return false;
    resource.notified = true;
    return true;
  });

  return {
    start() {
      if (!resource.owners.has(owner)) return Promise.resolve(false);
      resource.ready ??= start(resource);
      return claimSpawn(resource.ready);
    },
    /** Explicit rerun after a sub-shell exits (Enter in its terminal). */
    restart() {
      if (!resource.owners.has(owner)) return Promise.resolve(false);
      resource.notified = false;
      resource.ready = start(resource);
      return claimSpawn(resource.ready);
    },
    release(keepAlive = false) {
      if (!resource.owners.delete(owner)) return;
      // Sticky: any owner's keep-alive release marks the resource — with a
      // permanent session owner in play, the last release isn't the one
      // carrying the flag.
      resource.keepAlive ||= keepAlive;
      if (resource.owners.size > 0) return;
      // StrictMode setup -> cleanup -> setup happens in one turn. Defer
      // disposal so the replacement view can reclaim the same PTY.
      queueMicrotask(() => {
        const pending = resource.ready;
        const finish = () => {
          if (resource.owners.size > 0 || sessions.get(id) !== resource || resource.ready !== pending) return;
          sessions.delete(id);
          if (resource.started && !resource.keepAlive && !retainedPtys.has(id)) backend.close(id);
        };
        // A real unmount during an asynchronous spawn must close *after*
        // the spawn finishes, otherwise it can leave an orphan process.
        void (pending ?? Promise.resolve(false)).then(finish, finish);
      });
    },
  };
}

/** How long the PTY sits one row short. Node only emits `resize` when the
 * size it reads on SIGWINCH differs from the last one, so shrink and restore
 * must not land inside the same event-loop turn of the program. */
export const REDRAW_NUDGE_MS = 80;
const redrawNudges = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Make the program in front of the PTY repaint its whole screen. A resize to
 * the unchanged size sends no SIGWINCH, so the PTY is shrunk by one row and
 * restored. Back-to-back nudges coalesce into one.
 */
export function nudgePtyRedraw(
  backend: SessionBackend,
  id: string,
  size: () => { cols: number; rows: number } | null | undefined,
): void {
  const now = size();
  if (!now || now.rows < 2) return;
  const pending = redrawNudges.get(id);
  if (pending) clearTimeout(pending);
  else backend.resize(id, now.cols, now.rows - 1);
  redrawNudges.set(
    id,
    setTimeout(() => {
      redrawNudges.delete(id);
      const latest = size() ?? now;
      backend.resize(id, latest.cols, latest.rows);
    }, REDRAW_NUDGE_MS),
  );
}
