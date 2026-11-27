import { perfMark } from '../perf';
import { bufferQueueStats } from '../terminalRegistry';

/**
 * Perf-trace counters for the output path — what a restore storm costs the
 * main thread. Everything is a no-op unless the perf trace is on
 * (`window.__AXN_PERF__`, set while `AXN_TERM_PERF_TRACE` is), so the hot path
 * pays one property read. A `output_stats` mark with cumulative numbers is
 * written every 500 ms while anything changes; flows read the last one.
 *
 * - `headless_ms` / `visible_ms`: synchronous time in the per-chunk handlers
 *   of the headless session buffer and of the mounted terminal (xterm parses
 *   later, in its own write queue — that cost shows up as event-loop lag);
 * - `flush_ms`: the batched plugin/state flush;
 * - `lag_*`: how late a 20 ms timer fires — the freeze a user feels.
 */

type Kind = 'headless' | 'visible' | 'flush';

interface Stats {
  chunks: number;
  bytes: number;
  headlessMs: number;
  visibleMs: number;
  flushMs: number;
  flushes: number;
  lagMaxMs: number;
  lagSumMs: number;
  lagOver50: number;
  /** timer ticks skipped because the page was hidden (throttled) */
  hiddenTicks: number;
}

const stats: Stats = {
  chunks: 0,
  bytes: 0,
  headlessMs: 0,
  visibleMs: 0,
  flushMs: 0,
  flushes: 0,
  lagMaxMs: 0,
  lagSumMs: 0,
  lagOver50: 0,
  hiddenTicks: 0,
};

const enabled = () => !!(globalThis as { __AXN_PERF__?: unknown }).__AXN_PERF__;

let started = false;
let lastEmitted = '';

function start(): void {
  if (started) return;
  started = true;
  let last = performance.now();
  setInterval(() => {
    const t = performance.now();
    const late = t - last - 20;
    last = t;
    // A hidden/occluded page gets its timers throttled to 1 Hz by the engine —
    // that is not a stall, and would drown the real ones.
    if (document.visibilityState === 'hidden') {
      stats.hiddenTicks += 1;
      return;
    }
    if (late > 0) {
      stats.lagSumMs += late;
      if (late > stats.lagMaxMs) stats.lagMaxMs = late;
      if (late > 50) {
        stats.lagOver50 += 1;
        // each long stall as its own trace mark, to line up with what the app was doing
        perfMark('stall', String(Math.round(late)));
      }
    }
  }, 20);
  setInterval(() => {
    const json = JSON.stringify({
      ...stats,
      queuePeakKb: Math.round(bufferQueueStats().peakQueuedBytes / 1024),
      headlessMs: Math.round(stats.headlessMs),
      visibleMs: Math.round(stats.visibleMs),
      flushMs: Math.round(stats.flushMs),
      lagMaxMs: Math.round(stats.lagMaxMs),
      lagSumMs: Math.round(stats.lagSumMs),
    });
    if (json !== lastEmitted) {
      lastEmitted = json;
      perfMark('output_stats', json);
    }
  }, 500);
}

/** Run `fn` (one chunk's synchronous work) and account its time and size. */
export function timeOutput<T>(kind: Kind, bytes: number, fn: () => T): T {
  if (!enabled()) return fn();
  start();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    if (kind === 'headless') {
      stats.headlessMs += ms;
      stats.chunks += 1;
      stats.bytes += bytes;
    } else if (kind === 'visible') {
      stats.visibleMs += ms;
    } else {
      stats.flushMs += ms;
      stats.flushes += 1;
    }
  }
}
