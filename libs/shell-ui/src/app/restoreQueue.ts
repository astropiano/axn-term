/**
 * Restores the sessions' shells a few at a time instead of all at once.
 *
 * Starting a window's sessions means starting a login shell (and often an
 * agent restore command) for each of them. All together they saturate every
 * core for seconds — including the shell the user is looking at, whose prompt
 * then arrives late. The queue lets `concurrency` sessions start at once; the
 * next one is released when a started session has printed its first output (its
 * rc has run, it is at the prompt) or, failing that, after `readyTimeoutMs`.
 *
 * A session that is not queued yet can be started by anyone else at any time —
 * the selected session's view spawns its PTY the moment it mounts — and its
 * job then settles at once (`run` reports it did not have to wait). So
 * "switch to a session that is still waiting" needs no special case: it starts
 * on the spot, and `prioritize` only reorders the ones nobody asked for.
 */

export interface RestoreQueueOptions {
  /** Sessions starting at once — a function so a setting change applies to the sessions still waiting. */
  concurrency?: number | (() => number);
  readyTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface RestoreQueue {
  /**
   * Queue `id` (ignored when already queued, running or done). `run` starts the
   * session and resolves to `{ ready }` — the promise to wait on until it is up
   * (an object, not the bare promise: an `async` function would flatten it) —
   * or to nothing when there is nothing to wait for (already running, failed).
   */
  enqueue(id: string, run: () => Promise<{ ready: Promise<void> } | void>): void;
  /** Run `id` before the other queued sessions. */
  prioritize(id: string): void;
  /** Forget a queued session (it went away); a running one is left alone. */
  cancel(id: string): void;
  stats(): { queued: number; running: number; done: number };
}

export function createRestoreQueue(options: RestoreQueueOptions = {}): RestoreQueue {
  const limit = () => {
    const c = typeof options.concurrency === 'function' ? options.concurrency() : options.concurrency;
    return Math.max(1, c ?? 3);
  };
  const readyTimeoutMs = options.readyTimeoutMs ?? 4000;
  const setT = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const waiting: Array<{ id: string; run: () => Promise<{ ready: Promise<void> } | void> }> = [];
  const known = new Set<string>();
  let running = 0;
  let done = 0;

  function pump(): void {
    while (running < limit() && waiting.length > 0) {
      const job = waiting.shift()!;
      running += 1;
      let settled = false;
      let timer: unknown;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearT(timer);
        running -= 1;
        done += 1;
        pump();
      };
      void job
        .run()
        .then((result) => {
          if (!result) return settle();
          timer = setT(settle, readyTimeoutMs);
          if (settled) clearT(timer);
          return result.ready.then(settle, settle);
        })
        .catch(settle);
    }
  }

  return {
    enqueue(id, run) {
      if (known.has(id)) return;
      known.add(id);
      waiting.push({ id, run });
      pump();
    },
    prioritize(id) {
      const i = waiting.findIndex((j) => j.id === id);
      if (i > 0) waiting.unshift(...waiting.splice(i, 1));
    },
    cancel(id) {
      const i = waiting.findIndex((j) => j.id === id);
      if (i >= 0) waiting.splice(i, 1);
      known.delete(id);
    },
    stats() {
      return { queued: waiting.length, running, done };
    },
  };
}

export interface SettleSignalOptions {
  /** Output must have been quiet this long. */
  quietMs: number;
  /** A plugin restore (or similar) is still running — keep waiting. */
  isBusy: () => boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * "This restored session has settled": resolves once output has come and then
 * gone quiet for `quietMs` with nothing still running on it. `touch()` is
 * called for every chunk of output; the first one starts the clock, each later
 * one restarts it. Nothing resolves before the first output.
 */
export function createSettleSignal(options: SettleSignalOptions): { settled: Promise<void>; touch(): void } {
  const setT = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let resolveFn!: () => void;
  const settled = new Promise<void>((resolve) => (resolveFn = resolve));
  const arm = () => {
    timer = setT(() => {
      if (options.isBusy()) arm();
      else resolveFn();
    }, options.quietMs);
  };
  return {
    settled,
    touch() {
      if (timer !== undefined) clearT(timer);
      arm();
    },
  };
}
