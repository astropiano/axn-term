import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';

/**
 * Generic progress provider.
 *
 * Scans the session's live terminal screen for common progress indicators and
 * reports the bottom-most one via `session.progress`, which the session panel
 * renders as the inline progress bar in place of the RUNNING label.
 *
 * Recognized forms (one value per screen line):
 *   - percentages:   `45%`
 *   - bar drawings:  `[====>     ]`, `(####......)`
 *   - fractions:     `3/10`, `12 of 50`
 *
 * Behavior:
 *   - Programs can draw several bars at once (pacman: one per download plus an
 *     overall bar). The bottom-most line wins — overall/total bars are
 *     conventionally drawn last.
 *   - An indicator must stay on screen for DEBOUNCE_MS before it is reported,
 *     so commands whose bars flash by (a quick `docker pull`) never surface.
 *   - When no indicator remains on screen, the reported value is withdrawn
 *     instead of freezing on the last percentage.
 *   - Processes listed in plugins.yaml under `progress.exclude-processes`
 *     (case-insensitive substrings) are never tracked.
 *
 * Precedence: task-based providers (e.g. the devin plugin) own
 * `session.progress` whenever the session has a task list — this plugin stays
 * out of the way in that case.
 */

const PERCENT_RE = /(\d{1,3})\s*%/g;
const FRACTION_RE = /(\d+)\s*(?:\/|of)\s*(\d+)/g;
const BAR_RE = /[\[(]([=#>:\-*. ]{2,})[\])]/g;

const BAR_SOLID_CHARS = new Set(['=', '#', '>', ':', '*']);
const BAR_TRACK_CHARS = new Set(['-', '.', ' ']);

/** An indicator must stay on screen this long before it is reported. */
export const DEBOUNCE_MS = 500;
/** Output bursts are coalesced into one trailing screen scan after this delay. */
export const SCAN_DELAY_MS = 80;
/** Consecutive bar-less scans required before an episode ends — a single empty
 *  scan can just be a redraw caught mid-frame. */
export const MAX_MISSES = 2;

interface ProgressPluginState {
  progress?: number;
  wrote?: boolean;
}

interface ProgressPluginSettings {
  excludeProcesses?: unknown;
}

/**
 * Programs whose screens permanently carry percent/bar-like noise that is not
 * task progress — full-screen monitors show live stats, pagers and editors
 * report scroll position as a percentage. Matched exactly against the
 * foreground process name (`session.process` is the comm basename, so
 * substring matching would needlessly catch e.g. `topgrade`). The
 * `progress.exclude-processes` user setting adds substring entries on top.
 */
export const BUILTIN_EXCLUDED_PROCESSES = new Set([
  // Full-screen monitors
  'top', 'htop', 'btop', 'atop', 'iotop', 'iftop', 'nvtop', 'powertop',
  'ctop', 'gtop', 'vtop', 'gotop', 'bpytop', 'bashtop',
  'glances', 'nmon', 'btm', 'zenith', 's-tui', 'bandwhich',
  // TUIs that repaint bar widgets
  'alsamixer', 'k9s', 'lazygit', 'lazydocker', 'mc', 'ranger', 'nnn',
  // Pagers and editors whose status line is a scroll percentage
  'more', 'most', 'less', 'man', 'vi', 'vim', 'nvim', 'emacs',
]);

export interface ScreenProgress {
  /** Number of screen lines carrying a progress indicator. */
  bars: number;
  /** Value of the bottom-most indicator. */
  value: number;
}

/** Per-session ephemeral state — timers and sightings must not persist. */
interface ProgressRuntime {
  /** When the current run of on-screen bars was first seen. */
  episodeStart?: number;
  /** Bar-less scans in a row; brief redraw gaps must not end an episode. */
  misses: number;
  /** Value currently published on session.progress. */
  reported?: number;
  scanTimer?: ReturnType<typeof setTimeout>;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

const runtimes = new Map<string, ProgressRuntime>();

function runtimeFor(sessionId: string): ProgressRuntime {
  let rt = runtimes.get(sessionId);
  if (!rt) {
    rt = { misses: 0 };
    runtimes.set(sessionId, rt);
  }
  return rt;
}

function parseBarProgress(fill: string): number | undefined {
  if (fill.length < 2) return undefined;
  const chars = [...fill];
  if (!chars.every((c) => BAR_SOLID_CHARS.has(c) || BAR_TRACK_CHARS.has(c))) {
    return undefined;
  }
  const trimmed = fill.trimEnd();
  if (trimmed.length === 0) return undefined;
  // `[====>   ]` / `[---->   ]` styles: everything up to the `>` head is
  // filled. Otherwise (`[#####...]`, `[###    ]`) count the leading run of
  // solid characters — `-`, `.` and space are the empty track.
  const head = trimmed.lastIndexOf('>');
  let filled = 0;
  if (head !== -1) {
    filled = head + 1;
  } else {
    while (filled < trimmed.length && BAR_SOLID_CHARS.has(trimmed[filled])) filled++;
  }
  if (filled === 0) return undefined;
  return Math.min(100, Math.round((filled / fill.length) * 100));
}

/**
 * Returns the progress value of the last match in the line, so that later
 * (more recent) indicators win within a line.
 */
export function parseProgressLine(line: string): number | undefined {
  let best: number | undefined;
  let bestIdx = -1;

  for (const m of line.matchAll(PERCENT_RE)) {
    const v = parseInt(m[1], 10);
    if (v >= 0 && v <= 100 && (m.index ?? 0) > bestIdx) {
      bestIdx = m.index ?? 0;
      best = v;
    }
  }

  for (const m of line.matchAll(FRACTION_RE)) {
    const done = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (total >= 2 && done <= total && (m.index ?? 0) > bestIdx) {
      bestIdx = m.index ?? 0;
      best = Math.round((done / total) * 100);
    }
  }

  for (const m of line.matchAll(BAR_RE)) {
    const v = parseBarProgress(m[1]);
    if (v !== undefined && (m.index ?? 0) > bestIdx) {
      bestIdx = m.index ?? 0;
      best = v;
    }
  }

  return best;
}

/**
 * Collect every screen line carrying a progress indicator. Several bars can be
 * on screen at once (e.g. pacman's per-download bars plus the overall bar);
 * the bottom-most line wins.
 */
export function screenProgress(lines: string[]): ScreenProgress | undefined {
  let bars = 0;
  let value = 0;
  for (const line of lines) {
    const v = parseProgressLine(line);
    if (v !== undefined) {
      bars++;
      value = v;
    }
  }
  return bars > 0 ? { bars, value } : undefined;
}

/**
 * The built-in list is matched exactly (plus the name up to a `.` suffix, for
 * comm variants like `vim.basic`); user entries are case-insensitive
 * substrings.
 */
export function isProcessExcluded(
  process: string | undefined,
  excludeProcesses: unknown,
): boolean {
  if (!process) return false;
  const proc = process.toLowerCase();
  if (
    BUILTIN_EXCLUDED_PROCESSES.has(proc) ||
    BUILTIN_EXCLUDED_PROCESSES.has(proc.split('.')[0])
  ) {
    return true;
  }
  if (!Array.isArray(excludeProcesses)) return false;
  return excludeProcesses.some(
    (entry) =>
      typeof entry === 'string' && entry.trim() !== '' && proc.includes(entry.trim().toLowerCase()),
  );
}

function scheduleScan(ctx: SessionViewContext & PluginApi, rt: ProgressRuntime, delay: number): void {
  if (rt.scanTimer !== undefined) return;
  rt.scanTimer = setTimeout(() => {
    rt.scanTimer = undefined;
    scan(ctx);
  }, delay);
}

/** Forget the episode and withdraw a reported value, if we published one. */
function reset(ctx: SessionViewContext & PluginApi, rt: ProgressRuntime): void {
  rt.episodeStart = undefined;
  rt.misses = 0;
  if (rt.debounceTimer !== undefined) {
    clearTimeout(rt.debounceTimer);
    rt.debounceTimer = undefined;
  }
  if (rt.reported === undefined) return;
  rt.reported = undefined;
  ctx.updatePluginState({ progress: undefined, wrote: false });
  // Never clobber a value a task provider wrote over ours.
  if (ctx.isProgressHandled()) return;
  if ((ctx.getSession().progress ?? 0) !== 0) {
    ctx.updateSession(ctx.session.id, { progress: 0 });
  }
}

function scan(ctx: SessionViewContext & PluginApi): void {
  const session = ctx.getSession();
  const rt = runtimeFor(session.id);
  const settings = ctx.pluginSettings as ProgressPluginSettings | undefined;

  // Hard stops: no foreground process (a leftover final frame must not
  // re-report), an excluded program, or a task provider owning the progress.
  if (
    !session.process ||
    isProcessExcluded(session.process, settings?.excludeProcesses) ||
    ctx.isProgressHandled()
  ) {
    reset(ctx, rt);
    return;
  }

  const found = screenProgress(ctx.getScreenLines());
  if (!found) {
    rt.misses++;
    if (rt.misses >= MAX_MISSES) {
      reset(ctx, rt);
    } else {
      scheduleScan(ctx, rt, SCAN_DELAY_MS);
    }
    return;
  }
  rt.misses = 0;

  const now = Date.now();
  rt.episodeStart ??= now;
  const remaining = DEBOUNCE_MS - (now - rt.episodeStart);
  if (remaining > 0) {
    if (rt.debounceTimer === undefined) {
      rt.debounceTimer = setTimeout(() => {
        rt.debounceTimer = undefined;
        scan(ctx);
      }, remaining);
    }
    return;
  }

  if (rt.reported !== found.value) {
    rt.reported = found.value;
    ctx.updatePluginState({ progress: found.value, wrote: true });
    if (found.value !== (session.progress ?? 0)) {
      ctx.updateSession(session.id, { progress: found.value });
    }
  }
}

/** Cancel pending scans and forget everything about the session's episode. */
function teardown(ctx: SessionViewContext & PluginApi): void {
  const rt = runtimeFor(ctx.session.id);
  if (rt.scanTimer !== undefined) {
    clearTimeout(rt.scanTimer);
    rt.scanTimer = undefined;
  }
  reset(ctx, rt);
}

export const progressPlugin: SessionViewPlugin = {
  id: 'progress',
  title: 'progress',
  version: '0.1.0',
  stateKey: 'progress',
  // Bound to any foreground process: when the command that produced progress
  // output exits, the guessed progress bar must disappear.
  processPattern: /.+/,

  // A freshly spawned session has no running process — clear any persisted
  // progress so a stale 100% bar does not reappear after an app restart.
  onSessionOpen: (ctx) => {
    const state = (ctx.pluginState as ProgressPluginState | undefined) ?? {};
    teardown(ctx);
    if (state.wrote || (ctx.session.progress ?? 0) !== 0) {
      ctx.updatePluginState({ progress: undefined, wrote: false });
      ctx.updateSession(ctx.session.id, { progress: 0 });
    }
  },

  onProcessEnd: teardown,

  onOutput: (ctx) => {
    // The terminal buffer lags the chunk slightly (term.write is queued), so
    // coalesce output bursts into one trailing screen scan.
    scheduleScan(ctx, runtimeFor(ctx.session.id), SCAN_DELAY_MS);
  },

  onCommand: (ctx) => {
    // A newly submitted command starts a fresh progress sequence; clear any
    // value this plugin previously contributed so a stale bar does not linger.
    teardown(ctx);
  },

  onClose: (ctx) => {
    teardown(ctx);
    runtimes.delete(ctx.session.id);
  },
};
