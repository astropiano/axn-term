/**
 * Declared progress (`axn-progress`): the explicit, last-write-wins progress
 * channel. Agents and users declare a percentage or an ETA; while a
 * declaration is active it outranks task-derived and screen-scraped
 * progress for `session.progress` — task lists still render, they just
 * yield the bar.
 *
 * Runtime-only, like `panelStatus`'s store: a declaration is ephemeral
 * agent/user intent, so nothing persists across reloads. Its lifetime is
 * bound to the process that was foreground when it was made — an agent's
 * declaration dies with the agent, while a user's `--eta` reminder (typed
 * with the shell foreground) survives short commands and ends with the
 * shell or session close.
 */

export interface DeclaredProgress {
  /** Value at `startedAt` — the explicit pct, or the glide's `--from`. */
  startPct: number;
  /** Epoch ms the declaration was made. */
  startedAt: number;
  /** Epoch ms the glide should reach `targetPct`; parks at 100 once passed. */
  etaAt?: number;
  /** Glide target (default 100). */
  targetPct?: number;
  /** Optional short label ("3/7 files") — echoed in state queries and the ETA flag. */
  label?: string;
  /** `done`: show 100 briefly, then the declaration releases itself. */
  done?: boolean;
  /** Foreground process at declare time — the declaration's owner. */
  declaringProcess?: string;
}

const declared = new Map<string, DeclaredProgress>();

/** Declare/replace (`d`) or withdraw (`null`) a session's progress. */
export function declareProgress(sessionId: string, d: DeclaredProgress | null): void {
  if (d) declared.set(sessionId, d);
  else declared.delete(sessionId);
}

export function declaredProgress(sessionId: string): DeclaredProgress | undefined {
  return declared.get(sessionId);
}

/** True while a declaration owns the session's progress bar. */
export function declaredActive(sessionId: string): boolean {
  return declared.has(sessionId);
}

/** Test hook: drop every declaration. */
export function resetDeclaredProgress(): void {
  declared.clear();
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * The displayed percentage at `now`: a fixed `startPct` without an ETA, a
 * linear glide from `startPct` to `targetPct` (default 100) while inside the
 * window, parked at 100 once `etaAt` has passed.
 */
export function declaredValue(d: DeclaredProgress, now: number): number {
  if (d.done) return 100;
  if (d.etaAt === undefined) return clamp(d.startPct);
  if (d.etaAt <= d.startedAt) return 100;
  const target = clamp(d.targetPct ?? 100);
  const t = Math.min(1, Math.max(0, (now - d.startedAt) / (d.etaAt - d.startedAt)));
  const v = d.startPct + (target - d.startPct) * t;
  return now >= d.etaAt ? 100 : clamp(v);
}

/** `10m`, `90s`, `1h30m`, `45` (bare = seconds) → milliseconds. */
export function parseDurationMs(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t) * 1000;
  let total = 0;
  let rest = t;
  const re = /(\d+(?:\.\d+)?)([smh])/g;
  let m: RegExpExecArray | null;
  let matched = '';
  while ((m = re.exec(rest))) {
    matched += m[0];
    const n = parseFloat(m[1]);
    total += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : n * 1000;
  }
  return matched === rest ? total : undefined;
}

export type ProgressArgs =
  | { kind: 'query'; json: boolean }
  | { kind: 'clear' }
  | {
      kind: 'set';
      spec: Omit<DeclaredProgress, 'startedAt' | 'declaringProcess' | 'startPct'> & {
        /** Absent for a bare `--eta` — the runner anchors at the live progress. */
        startPct?: number;
        etaMs?: number;
      };
    }
  | { kind: 'error'; message: string };

const USAGE =
  'usage: axn-progress [<pct>] [--eta <dur> [--from <pct>] [--to <pct>]] [--label <text>] | done | clear | --json';

/** Words that look like options but take no value here. */
const NO_ARG_FLAGS = new Set(['--json']);

/** Strict percentage token — `parseFloat('4abc')` must not sneak in as 4. */
const NUM_RE = /^\d+(?:\.\d+)?$/;
const parseNum = (v: string | undefined): number | undefined =>
  v !== undefined && NUM_RE.test(v) ? parseFloat(v) : undefined;

/**
 * Parse the `axn-progress` argument string. `arg` is the text after the
 * command name (`undefined` for a bare command). Bare `axn-progress` and
 * `--json` query the state — see `progressReport` in progress.ts.
 */
export function parseProgressArgs(arg: string | undefined): ProgressArgs {
  const tokens = (arg ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'query', json: false };
  if (tokens.length === 1 && tokens[0] === '--json') return { kind: 'query', json: true };
  if (tokens.length === 1 && (tokens[0] === 'clear' || tokens[0] === 'off')) {
    return { kind: 'clear' };
  }
  if (tokens.length === 1 && tokens[0] === 'done') {
    return { kind: 'set', spec: { startPct: 100, done: true } };
  }

  let startPct: number | undefined;
  let etaMs: number | undefined;
  let targetPct: number | undefined;
  let label: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = () => tokens[++i];
    if (tok === '--eta') {
      const v = next();
      if (v === undefined || (etaMs = parseDurationMs(v)) === undefined) {
        return { kind: 'error', message: `--eta takes a duration like 90s, 10m, 1h30m — ${USAGE}` };
      }
    } else if (tok === '--from') {
      if ((startPct = parseNum(next())) === undefined) {
        return { kind: 'error', message: `--from takes a percentage — ${USAGE}` };
      }
    } else if (tok === '--to') {
      if ((targetPct = parseNum(next())) === undefined) {
        return { kind: 'error', message: `--to takes a percentage — ${USAGE}` };
      }
    } else if (tok === '--label') {
      // The label is the rest of the line — quotes optional.
      label = tokens.slice(i + 1).join(' ').replace(/^"(.*)"$/, '$1').trim() || undefined;
      if (label === undefined) return { kind: 'error', message: `--label takes text — ${USAGE}` };
      break;
    } else if (NO_ARG_FLAGS.has(tok)) {
      return { kind: 'error', message: `--json cannot be combined — ${USAGE}` };
    } else if (tok.startsWith('--')) {
      return { kind: 'error', message: `unknown option ${tok} — ${USAGE}` };
    } else if (startPct === undefined && (startPct = parseNum(tok)) !== undefined) {
      // bare percentage
    } else {
      return { kind: 'error', message: `unexpected '${tok}' — ${USAGE}` };
    }
  }
  if (etaMs === undefined && targetPct !== undefined) {
    return { kind: 'error', message: `--to only makes sense with --eta — ${USAGE}` };
  }
  if (startPct !== undefined && (startPct < 0 || startPct > 100)) {
    return { kind: 'error', message: `percentage must be 0-100 — ${USAGE}` };
  }
  if (targetPct !== undefined && (targetPct < 0 || targetPct > 100)) {
    return { kind: 'error', message: `--to must be 0-100 — ${USAGE}` };
  }
  if (etaMs === undefined && startPct === undefined) {
    return { kind: 'error', message: `nothing to set — ${USAGE}` };
  }
  return {
    kind: 'set',
    spec: { startPct, etaMs, targetPct, label },
  };
}

/** Compact human summary for the `echo` reply, e.g. `42% (eta in 3m)`. */
export function describeDeclaration(d: DeclaredProgress, now: number): string {
  const pct = declaredValue(d, now);
  if (d.done) return '100% (done)';
  const parts = [`${pct}%`];
  if (d.etaAt !== undefined) {
    const left = d.etaAt - now;
    parts.push(left >= 0 ? `eta in ${formatDuration(left)}` : 'eta reached');
  }
  if (d.label) parts.push(`“${d.label}”`);
  return parts.join(' — ');
}

/** `3720000` → `1h2m`; `45000` → `45s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec > 0 && m < 10 ? `${sec}s` : ''}`;
  return `${sec}s`;
}
