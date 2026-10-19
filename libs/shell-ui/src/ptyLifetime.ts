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

/** Share one PTY across effect replays. Only a genuine unmount closes it. */
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
  // view's spawn options when the deferred start actually runs.
  resource.spawn = spawn;
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
      if (!resource.owners.delete(owner) || resource.owners.size > 0) return;
      resource.keepAlive = keepAlive;
      // StrictMode setup -> cleanup -> setup happens in one turn. Defer
      // disposal so the replacement view can reclaim the same PTY.
      queueMicrotask(() => {
        const pending = resource.ready;
        const finish = () => {
          if (resource.owners.size > 0 || sessions.get(id) !== resource || resource.ready !== pending) return;
          sessions.delete(id);
          if (resource.started && !resource.keepAlive) backend.close(id);
        };
        // A real unmount during an asynchronous spawn must close *after*
        // the spawn finishes, otherwise it can leave an orphan process.
        void (pending ?? Promise.resolve(false)).then(finish, finish);
      });
    },
  };
}
