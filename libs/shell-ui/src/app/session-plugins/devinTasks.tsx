import { useMemo } from 'react';
import { axnLog } from '../log';
import { sessionLastSelectedAt } from '../attention';
import type { SessionAttention, SessionBanner, SessionStatus, ShellSession, Task } from '../../types';
import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { registerAgentLauncher } from './agentRegistry';
import {
  agentResumeMenuItem,
  forgetLastAgentSession,
  rememberLastAgentSession,
} from './agentResume';
import { agentCommand } from './devWorkflow';
import { shellQuote } from '../../shellQuote';

type DevinTaskStatus = 'pending' | 'running' | 'completed' | 'blocked';

interface DevinTask {
  id: string;
  title: string;
  status: DevinTaskStatus;
}

const statusIcons: Record<DevinTaskStatus, string> = {
  pending: '[ ]',
  running: '[~]',
  completed: '[x]',
  blocked: '[!]',
};

const statusClasses: Record<DevinTaskStatus, string> = {
  pending: 'text-[var(--text-secondary)]',
  running: 'text-[var(--accent)]',
  completed: 'text-[var(--green)]',
  blocked: 'text-[var(--red)]',
};

function parseStatusSymbol(symbol: string): DevinTaskStatus {
  switch (symbol) {
    case '✓':
    case '✔':
    case '●':
    case '☑':
      return 'completed';
    case '✗':
    case '✘':
    case '✕':
    case '✖':
      return 'blocked';
    case '○':
      return 'pending';
    case '◔':
    case '◐':
    case '◕':
    case '◎':
    case '⏺':
    default:
      return 'running';
  }
}

const taskLinePattern = /^\s*[\u2502\u251C\u2514\u2516\u2574]\s*([\u2713\u2714\u2715\u2716\u2717\u2718\u25CB\u25D4\u25D0\u25D5\u25CF\u25CE\u23FA])\s+(\d+)[\.)]\s+(.+)$/u;

interface TaskBlock {
  tasks: DevinTask[];
  /** Index of the block's first matching line (after the header). */
  startLine: number;
}

function collectTaskBlock(lines: string[]): TaskBlock {
  const tasks: DevinTask[] = [];
  const seen = new Set<string>();
  let startLine = -1;

  // Scan from the bottom and collect only the last contiguous block of
  // task lines. Older task lists further up are ignored so that the most
  // recently rendered list becomes the truth.
  let i = lines.length - 1;
  while (i >= 0) {
    const rawLine = lines[i];
    const line = rawLine.replace(/\r$/, '');
    const match = taskLinePattern.exec(line);
    if (!match) {
      if (tasks.length > 0) break;
      i--;
      continue;
    }

    const status = parseStatusSymbol(match[1]);
    const number = match[2];
    const title = match[3].trim();
    const id = `devin-${number}`;
    if (title && !seen.has(id)) {
      seen.add(id);
      tasks.unshift({ id, title, status });
      startLine = i;
    }
    i--;
  }

  return { tasks, startLine };
}

export function parseDevinTasks(output: string): DevinTask[] {
  return collectTaskBlock(output.split('\n')).tasks;
}

function computeTaskState(tasks: DevinTask[]) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const hasBlocked = tasks.some((t) => t.status === 'blocked');
  const hasRunning = tasks.some((t) => t.status === 'running');

  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  let status: SessionStatus | undefined;
  if (hasBlocked) {
    status = 'blocked';
  } else if (hasRunning) {
    status = 'running';
  } else if (total > 0 && completed === total) {
    status = 'completed';
  } else if (total > 0) {
    status = 'running';
  }

  return { tasks, progress, status, completed };
}

function toTasks(tasks: DevinTask[]): Task[] {
  return tasks.map((t) => ({ id: t.id, title: t.title, done: t.status === 'completed' }));
}

function tasksKey(list: Task[]): string {
  return list.map((t) => `${t.id}:${t.title}:${t.done}`).join('|');
}

function devinTasksKey(list: DevinTask[]): string {
  return list.map((t) => `${t.id}:${t.title}:${t.status}`).join('|');
}

// Only refresh the stored task list while devin is actively printing one
// (e.g. after '⏺ Updated todo list (4 items)'). A printed list can be split
// across several PTY output chunks, so keep parsing for a few chunks after
// the marker is seen.
const TASK_UPDATE_MARKER = /updated\s+(?:todo|task)s?\s*list/i;
const TASK_PARSE_CHUNKS = 4;
const taskParsePending = new Map<string, number>();

// --- Live screen scanning ------------------------------------------------
// Devin ≥3000.11 renders the todo list inside the TUI's live region — the
// diffed cell updates never form parseable lines in the retained output
// stream, so the marker-gated scrollback parser sees nothing. The xterm
// screen buffer holds the resolved lines, though: while devin is the
// foreground process, scan the visible screen for the task block
// ('│ ◔ 1. …' rows) and derive tasks + progress from it — the same
// `taskLinePattern` used for scrollback, just applied to screen lines.
// Because detection follows what this terminal shows, there is no session
// identity guesswork at all.
const SCREEN_SCAN_MS = 1_000;
const lastScreenScan = new Map<string, number>();
// Consecutive taskless scans without the work hint — guards the
// running → idle fallback against a flickering interrupt hint.
const quietScans = new Map<string, number>();

function applyDevinTasks(
  ctx: SessionViewContext & PluginApi,
  tasks: DevinTask[],
  working: boolean,
) {
  const state = getDevinState(ctx);
  if (devinTasksKey(tasks) !== devinTasksKey(state.tasks ?? [])) {
    ctx.updatePluginState({ tasks });
  }
  const simple = toTasks(tasks);
  const { progress, status } = computeTaskState(tasks);
  // The interrupt hint outranks the task list: a run whose todo rows all
  // show done is still working while the hint is on screen — 'completed'
  // would be a lie. A blocked task keeps its signal either way.
  const nextStatus =
    status === 'blocked' ? 'blocked' : working ? 'running' : (status ?? 'idle');
  const live = ctx.getSession();
  if (
    tasksKey(simple) !== tasksKey(live.tasks ?? []) ||
    progress !== (live.progress ?? 0) ||
    nextStatus !== (live.status ?? 'idle')
  ) {
    ctx.updateSession(live.id, { tasks: simple, progress, status: nextStatus });
  }
}

/** Header the TUI draws above the todo block on screen. */
const SCREEN_TASK_HEADER = /(updated|current)\s+(?:todo|task)s?\s*list/i;
/** Lines allowed between the header and the first task row on screen. */
const HEADER_GAP = 3;

/** The on-screen todo block, accepted only under its visible header. */
function screenTaskBlock(lines: string[]): DevinTask[] | undefined {
  const { tasks, startLine } = collectTaskBlock(lines);
  if (tasks.length === 0) return undefined;
  const headed = lines
    .slice(Math.max(0, startLine - HEADER_GAP), startLine)
    .some((l) => SCREEN_TASK_HEADER.test(l));
  return headed ? tasks : undefined;
}

function scanScreenTasks(ctx: SessionViewContext & PluginApi) {
  const lines = ctx.getScreenLines();
  if (lines.length === 0) return;
  const working = lines.some((l) => DEVIN_WORKING_RE.test(l));
  const { tasks, startLine } = collectTaskBlock(lines);
  // Anything devin displays — including echoed dumps of other sessions'
  // scrollback — can carry task-shaped rows, so a block is only accepted
  // when the todo-list header is still visible just above it.
  if (tasks.length > 0) {
    const headerIdx = lines
      .slice(Math.max(0, startLine - HEADER_GAP), startLine)
      .findIndex((l) => SCREEN_TASK_HEADER.test(l));
    if (headerIdx < 0) return;
  }
  if (tasks.length === 0) {
    // No todo block on screen — a vanished block keeps the last known list
    // (onProcessEnd owns the real clear). The interrupt hint still marks a
    // running turn, so taskless runs get an honest badge too; stepping back
    // takes two consecutive hint-free scans so a flicker cannot flap it.
    const live = ctx.getSession();
    if (working) {
      quietScans.delete(live.id);
      if ((live.status ?? 'idle') !== 'running') {
        ctx.updateSession(live.id, { status: 'running' });
      }
    } else {
      quietScans.set(live.id, (quietScans.get(live.id) ?? 0) + 1);
      if (live.status === 'running' && (quietScans.get(live.id) ?? 0) >= 2) {
        // Same rule as onProcessEnd: a terminal badge (completed/blocked)
        // persists, anything else steps back to idle.
        const t = computeTaskState(getDevinState(ctx).tasks ?? []).status;
        const back = t === 'completed' || t === 'blocked' ? t : 'idle';
        ctx.updateSession(live.id, { status: back });
      }
    }
    return;
  }
  quietScans.delete(ctx.session.id);
  if (devinTasksKey(tasks) !== devinTasksKey(getDevinState(ctx).tasks ?? [])) {
    axnLog('debug', 'devin', `screen task list changed: ${JSON.stringify(tasks)}`);
  }
  applyDevinTasks(ctx, tasks, working);
}

interface DevinPluginState {
  devinSessionName?: string;
  /** Directory the devin session was started in — devin scopes sessions per directory. */
  devinSessionCwd?: string;
  /** Character offset in session.output where the current devin process started. */
  devinOutputStart?: number;
  /** Whether devin was active the last time output changed. */
  devinWasActive?: boolean;
  /**
   * Devin was running when the session last went away: set while devin is
   * foreground, cleared when it exits on its own — but kept when the app's
   * close (onClose) or a crash stops it. Restore requires it, so a shell
   * that once ran devin but sat at its prompt on close reopens as a shell.
   */
  devinActive?: boolean;
  /** "Needs attention" flag raised by ctx.setAttention — cleared on output. */
  attention?: SessionAttention | null;
  /** Banner strip raised by ctx.setBanner — e.g. a failed session restore. */
  banner?: SessionBanner | null;
  tasks?: DevinTask[];
}

interface ExitCapture {
  output: string;
  /** Authoritative captures (typed /exit, onClose) own the name and clear it
   * up front; passive ones only adopt a name they see, never erase one. */
  authoritative: boolean;
  done: Promise<void>;
  finish: (name?: string) => void;
}

const exitCaptures = new Map<string, ExitCapture>();

// onProcessEnd scans this much of the retained output tail for a resume line
// (same size as the capture chunk buffer) and keeps a passive capture alive
// this long for exit output still in flight when the foreground poll fires.
const EXIT_TAIL_CHARS = 16_384;
const PASSIVE_CAPTURE_MS = 3_000;

function beginExitCapture(
  ctx: SessionViewContext & PluginApi,
  opts: { authoritative?: boolean; timeoutMs?: number; seed?: string } = {},
): ExitCapture {
  const authoritative = opts.authoritative ?? true;
  const id = ctx.session.id;
  const pending = exitCaptures.get(id);
  if (pending) {
    if (pending.authoritative || !authoritative) return pending;
    // Upgrade a passive capture into an authoritative /exit or close capture.
    pending.finish();
  }
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const capture: ExitCapture = {
    output: opts.seed ?? '',
    authoritative,
    done,
    finish: (name) => {
      if (exitCaptures.get(id) !== capture) return;
      clearTimeout(timer);
      exitCaptures.delete(id);
      if (name) {
        ctx.updatePluginState({ devinSessionName: name });
        rememberDevinLast(ctx, { name });
      }
      axnLog(
        name ? 'debug' : authoritative ? 'warn' : 'debug',
        'devin-close',
        `session ${id}: ${
          name
            ? `captured post-exit session ${name}`
            : authoritative
              ? 'no complete post-exit resume line; name cleared'
              : 'no post-exit resume line; stored name kept'
        }`,
      );
      resolveDone();
    },
  };
  const timer = setTimeout(
    () => capture.finish(),
    opts.timeoutMs ?? (authoritative ? 8000 : PASSIVE_CAPTURE_MS),
  );
  exitCaptures.set(id, capture);
  if (authoritative) {
    ctx.updatePluginState({ devinSessionName: undefined, devinOutputStart: undefined });
    axnLog('debug', 'devin-close', `session ${id}: starting fresh /exit capture`);
    void recordSessionCwd(ctx).catch(() => {});
  }
  return capture;
}

// After the restore command is injected into a freshly spawned shell, the
// attempt is tracked until devin is observed as the foreground process
// ('ok'), the CLI reports the session is gone ('gone'), or neither happens
// within RESTORE_CONFIRM_TIMEOUT_MS ('timeout') — e.g. when the remembered
// cwd no longer exists and the `cd` in the restore command fails.
interface PendingRestore {
  name: string;
  /** Rolling tail of post-injection output; the failure line can split across chunks. */
  recent: string;
  timer: ReturnType<typeof setTimeout>;
}

const RESTORE_FAILED_RE = /no session found matching/i;
const RESTORE_CONFIRM_TIMEOUT_MS = 20_000;
const pendingRestores = new Map<string, PendingRestore>();

// Sessions whose devin is being stopped by onClose — that exit must not
// clear devinActive, it is exactly the state restore should resume.
const closingSessions = new Set<string>();

function finishRestore(ctx: SessionViewContext & PluginApi, outcome: 'ok' | 'gone' | 'timeout') {
  const id = ctx.session.id;
  ctx.setRestoring(null);
  const pending = pendingRestores.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRestores.delete(id);
  if (outcome === 'ok') {
    ctx.setBanner(null);
    axnLog('info', 'devin-restore', `session ${id}: restored '${pending.name}'`);
    return;
  }
  if (outcome === 'gone') {
    // The CLI confirmed the session does not exist — stop retrying it on
    // every restart.
    ctx.updatePluginState({ devinSessionName: undefined });
    forgetLastAgentSession(ctx, 'devin', pending.name);
    ctx.setBanner({
      level: 'error',
      message: `Devin session '${pending.name}' no longer exists — could not restore it.`,
    });
    ctx.setAttention({ level: 'warning', message: 'devin restore failed' });
    axnLog('warn', 'devin-restore', `session ${id}: '${pending.name}' not found by devin CLI`);
    return;
  }
  ctx.setBanner({
    level: 'error',
    message: `Could not restore devin session '${pending.name}' — it did not start.`,
  });
  ctx.setAttention({ level: 'warning', message: 'devin restore failed' });
  axnLog('warn', 'devin-restore', `session ${id}: restore of '${pending.name}' could not be confirmed`);
}

function cancelPendingRestore(sessionId: string) {
  const pending = pendingRestores.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRestores.delete(sessionId);
  }
}

interface DevinPluginSettings {
  restoreSession?: boolean;
  /** Seconds of silence before the session is flagged "needs attention". 0 disables. */
  idleTimeoutSeconds?: number;
}

// While devin works, its TUI redraws continuously, so a quiet screen usually
// means devin stopped — on a prompt, or finished. Arm a per-session idle
// timer on every output chunk; when it fires, flag the session via
// ctx.setAttention. Silence only counts once the user selected the session
// and the screen changed thereafter — a session that was never watched, or
// that went quiet before the user last looked, must not flag.
const DEFAULT_IDLE_TIMEOUT_S = 45;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
// sessionId -> the latest selection timestamp that an output chunk followed.
// Compared against sessionLastSelectedAt to know whether the screen changed
// *after* the user's most recent view.
const watchedOutput = new Map<string, number>();
// sessionId -> fingerprint of the last screen counted as real activity.
// TUI repaints (focus-in, SIGWINCH reflow, scrollback replay on reattach)
// resend bytes without changing the visible text; they must not re-arm the
// idle timer or clear a raised flag, or a quiet session re-flags forever.
const screenSeen = new Map<string, string>();
// sessionId -> selection timestamp already reconciled with workSeen.
const selSeen = new Map<string, number>();
// sessionId -> devin was visibly working (interrupt hint on screen) in a
// screen change since the user's last look. "Possibly finished" only
// applies to quiet that follows actual work — a session sitting at its
// prompt since before the user looked has nothing to finish.
const workSeen = new Map<string, boolean>();

// Devin's TUI draws the interrupt hint only while a turn is running, so a
// screen line carrying it marks real work regardless of the task list —
// even when every todo row already shows done.
const DEVIN_WORKING_RE = /\besc\b[^\n]*interrupt/i;

function clearIdleTimer(sessionId: string) {
  const timer = idleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }
}

function isWaitingForInput(output: string): boolean {
  const tail = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-6)
    .join('\n');
  return /[?]\s*$|\(y(?:es)?\/n(?:o)?\)|\[(?:y|yes)\/(?:n|no)\]|press (?:enter|return)|choose|select an? (?:option|answer)/i.test(
    tail,
  );
}

function armIdleTimer(ctx: SessionViewContext & PluginApi) {
  const id = ctx.session.id;
  clearIdleTimer(id);
  const seconds = getDevinSettings(ctx).idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S;
  if (!(seconds > 0)) return;
  // This output arrived after the latest selection → silence may count.
  const selectedAt = sessionLastSelectedAt(id);
  if (selectedAt > 0) watchedOutput.set(id, selectedAt);
  if (selectedAt === 0 || watchedOutput.get(id) !== selectedAt) return;
  idleTimers.set(
    id,
    setTimeout(() => {
      idleTimers.delete(id);
      if (!isDevinSession(ctx.getSession())) return;
      // Re-selecting the session after this timer armed resets the baseline:
      // only quiet following output the user watched it produce may flag.
      const lastSel = sessionLastSelectedAt(id);
      if (lastSel === 0 || watchedOutput.get(id) !== lastSel) return;
      // Prefer the live screen buffer: a devin question prompt is on screen,
      // while the scrollback tail can be polluted by older output.
      const lines = ctx.getScreenLines();
      const tail =
        lines.length > 0 ? lines.join('\n') : (ctx.getSession().output ?? '');
      // The interrupt hint still on screen means devin is working — a
      // stalled spinner is busy, not finished or idle.
      if (lines.some((l) => DEVIN_WORKING_RE.test(l))) return;
      const waiting = isWaitingForInput(tail);
      // "Possibly finished" only applies to quiet that follows work seen
      // since the user's last look. A session restored to a quiet prompt
      // has nothing to finish; with no screen buffer, keep the old guess.
      const worked = workSeen.get(id) === true;
      workSeen.delete(id);
      if (!waiting && lines.length > 0 && !worked) return;
      ctx.setAttention({
        level: 'warning',
        message: waiting
          ? `quiet for ${seconds}s — likely waiting for input`
          : `quiet for ${seconds}s — possibly finished`,
      });
    }, seconds * 1000),
  );
}

/** The devin CLI as `session.process` reports it (argv-derived basename). */
export const DEVIN_PROCESS_RE = /^devin/i;

function isDevinSession(session: ShellSession): boolean {
  return session.agentInput === devinPlugin.id || DEVIN_PROCESS_RE.test(session.process ?? '');
}

function getDevinSettings(ctx: SessionViewContext & PluginApi): DevinPluginSettings {
  return (ctx.pluginSettings as DevinPluginSettings | undefined) ?? {};
}

function getDevinState(ctx: SessionViewContext & PluginApi): DevinPluginState {
  return (ctx.pluginState as DevinPluginState | undefined) ?? {};
}

/**
 * The live counterpart of getDevinState: `ctx.pluginState` is a snapshot
 * from when the ctx was built, so a capture finishing in the same tick as
 * another update reads the session's live pluginState instead.
 */
function getDevinStateLive(ctx: SessionViewContext & PluginApi): DevinPluginState {
  const live = (ctx.getSession().pluginState as Record<string, unknown> | undefined)?.[
    devinPlugin.stateKey ?? devinPlugin.id
  ];
  return (live as DevinPluginState | undefined) ?? getDevinState(ctx);
}

interface DevinSessionNameMatch {
  name: string;
  end: number;
}

function findDevinSessionName(output: string): DevinSessionNameMatch | undefined {
  // Match variations like:
  // Resume this session with `devin -r seen-ancient`
  // Resume this session with devin -r seen-ancient.
  // Resume this session by running `devin resume seen-ancient`
  // and the two-line hint newer CLIs print on exit (3000.11+):
  //  devin -r crimson-eyeliner
  //  resumes this session · devin -r lists recent sessions
  const patterns = [
    /resume this session[^\n]*?devin\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)/gi,
    /devin\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)[^\n]*\r?\n[^\n]*?resumes\s+this\s+session/gi,
  ];
  let last: DevinSessionNameMatch | undefined;
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      const end = m.index + m[0].length;
      if (!last || end > last.end) last = { name: m[1], end };
    }
  }
  return last;
}

export function parseDevinSessionName(output: string, requireComplete = false): string | undefined {
  const match = findDevinSessionName(output);
  if (!match) return undefined;
  if (requireComplete && match.end >= output.length) {
    // The resume line reaches the end of the currently available output,
    // so the name may be split across PTY chunks. Wait for more output.
    return undefined;
  }
  return match.name;
}


/**
 * Validate the devin session name remembered for this terminal session.
 * Only explicitly captured post-exit names are eligible for future restore.
 * Retained output is never consulted because it can contain historical names
 * from earlier runs or session switches. A missing name means restore is
 * skipped while the session's working directory is preserved.
 */
function isPlausibleDevinName(name: string | undefined): name is string {
  return (
    typeof name === 'string' &&
    name.includes('-') &&
    name.split('-').every((part) => part.length > 0) &&
    name.length >= 4
  );
}

function rememberedDevinSession(
  ctx: SessionViewContext & PluginApi,
): { name: string; cwd?: string } | undefined {
  const state = getDevinState(ctx);
  // Only use a stored name that was explicitly captured on a previous devin
  // exit. The retained output is not a reliable source here because it can
  // still hold very old resume lines (e.g. an `echo` test or an earlier
  // session). If no valid stored name exists, do not restore — the cwd is
  // kept so the next manual `devin -r` or `axn-devin-resume` can at least
  // start from the right directory.
  if (isPlausibleDevinName(state.devinSessionName)) {
    return { name: state.devinSessionName, cwd: state.devinSessionCwd };
  }
  return undefined;
}

/**
 * Persist the session's cwd as devinSessionCwd. pollCwd now refreshes
 * session.cwd for every session (not just the visible one), so it is the most
 * reliable value we can set synchronously. We still refine with getCwd() when
 * available so a just-changed directory is captured exactly.
 */
function recordSessionCwd(ctx: SessionViewContext & PluginApi): Promise<void> {
  const fallback = ctx.getSession().cwd;
  if (fallback) {
    ctx.updatePluginState({ devinSessionCwd: fallback });
  }
  return ctx.getCwd().then((cwd) => {
    if (cwd) ctx.updatePluginState({ devinSessionCwd: cwd });
  });
}

/** Command line that resumes the remembered devin session from its original directory. */
function devinResumeCommand(remembered: { name: string; cwd?: string }): string {
  const resume = `devin -r ${remembered.name}`;
  // Always cd into the directory the devin session was started in — devin
  // scopes sessions per directory, and the shell's cwd at restore time is not
  // reliable (a restored/hidden session may carry a stale persisted cwd).
  if (remembered.cwd) {
    return `cd ${shellQuote(remembered.cwd)} && ${resume}`;
  }
  return resume;
}

/**
 * Publish the just-exited devin conversation as this agent's last session
 * (app-level pluginData — see agentResume.ts): the captured name's exact
 * `devin -r` line when one is known, else `devin -c` — continue the latest
 * session in the directory devin ran in.
 */
function rememberDevinLast(
  ctx: SessionViewContext & PluginApi,
  remembered?: { name: string; cwd?: string },
): void {
  const cwd = remembered?.cwd ?? getDevinStateLive(ctx).devinSessionCwd ?? ctx.getSession().cwd;
  const command = remembered
    ? devinResumeCommand({ ...remembered, cwd: remembered.cwd ?? cwd })
    : cwd
      ? `cd ${shellQuote(cwd)} && devin -c`
      : 'devin -c';
  rememberLastAgentSession(ctx, 'devin', { name: remembered?.name, cwd, command });
}

function parseDevinCommand(command: string): { name: string; cwd?: string } | undefined {
  // Match commands like:
  //   devin -r grey-party
  //   devin resume grey-party
  //   cd '/some/dir' && devin -r grey-party
  const trimmed = command.trim();
  const nameMatch = trimmed.match(/(?:^|[;&|]\s*|&&\s*)devin\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)/);
  if (!nameMatch) return undefined;
  const name = nameMatch[1];
  const quoted = /cd\s+(['"])(.*?)\1(?:\s*&&|\s*;|\s*$)/.exec(trimmed);
  const unquoted = /cd\s+([^\s&;|]+)(?:\s*&&|\s*;|\s*$)/.exec(trimmed);
  const cwd = quoted ? quoted[2] : unquoted ? unquoted[1] : undefined;
  return { name, cwd };
}

function DevinTasks({ ctx }: { ctx: SessionViewContext & PluginApi }) {
  // Render the last task list devin actually reported. It stays visible even
  // after the printed list scrolls out of the retained output buffer.
  const tasks = getDevinState(ctx).tasks ?? [];
  const { completed } = useMemo(() => computeTaskState(tasks), [tasks]);

  if (tasks.length === 0) return null;

  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        tasks
      </div>
      <ul className="max-h-24 space-y-0.5 overflow-y-auto">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-start gap-1.5 text-[10px]">
            <span className={`shrink-0 select-none whitespace-nowrap ${statusClasses[task.status]}`}>
              {statusIcons[task.status]}
            </span>
            <span
              className={`min-w-0 break-words ${
                task.status === 'completed'
                  ? 'line-through text-[var(--text-secondary)]'
                  : 'text-[var(--text-primary)]'
              }`}
            >
              {task.title}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1 text-[10px] text-[var(--text-secondary)]">
        {completed}/{tasks.length} done
      </div>
    </div>
  );
}

export const devinPlugin: SessionViewPlugin = {
  id: 'devin',
  title: 'devin',
  logo: 'Bot',
  version: '0.1.0',
  stateKey: 'devin',
  settingsKey: 'devin',
  processPattern: DEVIN_PROCESS_RE,
  // devin edits its own input line; it also sets the terminal title while it
  // runs, which marks the session before the process poll catches up.
  agentInput: { title: /devin/i },
  handlesProgress: true,
  screenTasks: (lines) => {
    const tasks = screenTaskBlock(lines);
    return tasks?.length ? toTasks(tasks) : undefined;
  },
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume devin sessions',
      description:
        "Run 'devin -r <session>' when a session that previously ran devin is reopened.",
      type: 'boolean',
      default: false,
    },
    {
      key: 'idleTimeoutSeconds',
      label: 'Idle timeout (seconds)',
      description:
        'Flag "needs attention" after this many quiet seconds (finished or waiting for input). 0 disables.',
      type: 'number',
      default: 45,
    },
  ],
  commands: [
    {
      // `axn-devin-resume` resumes the devin session last remembered for this
      // session, regardless of the restore-session plugin setting.
      name: 'axn-devin-resume',
      run: (ctx) => {
        const remembered = rememberedDevinSession(ctx);
        if (!remembered) {
          axnLog('warn', 'devin-resume', 'no remembered devin session');
          return `echo "axn-devin-resume: no remembered devin session"`;
        }
        ctx.updatePluginState({
          devinSessionName: remembered.name,
          devinSessionCwd: remembered.cwd,
        });
        const cmd = devinResumeCommand(remembered);
        axnLog('info', 'devin-resume', `resuming session: ${cmd}`);
        return cmd;
      },
    },
  ],
  // "Resume devin session '<name>'" — the shared last-session capability;
  // offered on idle sessions once a devin conversation was captured.
  sessionMenuItems: (ctx) => agentResumeMenuItem(ctx, 'devin'),
  render: (ctx) => <DevinTasks ctx={ctx} />,

  // Declared before onSessionOpen injects the resume command: the app covers
  // the terminal with a "restoring" overlay so input cannot race the
  // injected line. Cleared in finishRestore (ok/gone/timeout) and on every
  // onSessionOpen path that ends up not restoring.
  pendingRestore: (ctx) => {
    if (!getDevinSettings(ctx).restoreSession || !getDevinState(ctx).devinActive) return undefined;
    const remembered = rememberedDevinSession(ctx);
    return remembered ? `devin session '${remembered.name}'` : undefined;
  },

  // The task list is bound to the devin process: when devin exits, the
  // remembered tasks and the session progress disappear. The devin session
  // name is kept — it is needed for restore-session/axn-devin-resume.
  onProcessEnd: (ctx) => {
    const state = getDevinState(ctx);
    // Devin's final output can arrive after the foreground process changes.
    // Leave any pending /exit or close capture alive until its line arrives
    // or it times out — it owns the session name.
    clearIdleTimer(ctx.session.id);
    watchedOutput.delete(ctx.session.id);
    lastScreenScan.delete(ctx.session.id);
    screenSeen.delete(ctx.session.id);
    selSeen.delete(ctx.session.id);
    workSeen.delete(ctx.session.id);
    quietScans.delete(ctx.session.id);
    ctx.updatePluginState({
      devinOutputStart: undefined,
      attention: undefined,
      // Devin ended while the session lives on — the user is back at the
      // shell, so a later reopen must not resume devin.
      ...(closingSessions.has(ctx.session.id) ? {} : { devinActive: false }),
    });
    // Capture the cwd one last time when devin exits — if the resume line was
    // missed or truncated, this still records where the session actually ran.
    void recordSessionCwd(ctx);
    let tailName: string | undefined;
    if (!exitCaptures.get(ctx.session.id)) {
      // A devin exit the plugin did not drive — a manual Ctrl-C×2, /quit,
      // devin's own quit key — still prints the resume hint, and the
      // foreground poll lags real output, so the line is already sitting in
      // the tail. Take the newest hint from a bounded tail window: no
      // scrollback offset (the buffer is capped) and recent text only, so
      // historical lines cannot leak in. The passive capture left behind
      // covers exit chunks still in flight and never clears a stored name —
      // an abrupt kill prints nothing, yet the name stays valid.
      const tail = (ctx.getSession().output ?? '').slice(-EXIT_TAIL_CHARS);
      const name = parseDevinSessionName(tail, true);
      if (name && name !== state.devinSessionName) {
        axnLog('debug', 'devin', `session ${ctx.session.id}: remembered post-exit session ${name}`);
        ctx.updatePluginState({ devinSessionName: name });
      }
      tailName = name;
      beginExitCapture(ctx, { authoritative: false, seed: tail });
    }
    // Publish the just-exited conversation as this agent's last session —
    // the exact `devin -r <name>` line when a name is known (the tail scan's
    // fresh name wins over an older remembered one), else the directory's
    // `devin -c` fallback. A hint landing inside the armed capture upgrades
    // the record.
    rememberDevinLast(ctx, (tailName ? { name: tailName } : undefined) ?? rememberedDevinSession(ctx));
    const hasTasks = (state.tasks ?? []).length > 0;
    const hasSessionProgress =
      (ctx.session.tasks ?? []).length > 0 || (ctx.session.progress ?? 0) > 0;
    // A finished or blocked run keeps its badge — the "done / needs-you"
    // signal. Exiting mid-run falls back to idle; quitting is no failure.
    const { status } = computeTaskState(state.tasks ?? []);
    const finalStatus: SessionStatus =
      status === 'completed' || status === 'blocked' ? status : 'idle';
    if (!hasTasks && !hasSessionProgress && (ctx.session.status ?? 'idle') === finalStatus)
      return;
    axnLog('debug', 'devin', 'devin process ended; clearing task list and progress');
    if (hasTasks) ctx.updatePluginState({ tasks: [] });
    ctx.updateSession(ctx.session.id, { tasks: [], progress: 0, status: finalStatus });
  },

  onOutput: (ctx, text) => {
    const output = ctx.getSession().output ?? '';
    const state = getDevinState(ctx);
    const patch: DevinPluginState = {};
    const live = ctx.getSession();
    const isActive = isDevinSession(live);

    // Track where the current devin process started in the retained output.
    // The marker lets onProcessEnd/onClose search only the output produced
    // during this process, so stale resume lines from an earlier run cannot
    // be picked up.
    if (isActive && !state.devinActive) patch.devinActive = true;
    if (isActive && !state.devinWasActive) {
      patch.devinOutputStart = Math.max(0, output.length - text.length);
      patch.devinWasActive = true;
    } else if (!isActive && state.devinWasActive) {
      patch.devinWasActive = false;
    }

    // Fresh output means devin is alive — but only output that changed the
    // visible screen counts as activity. Repaint chunks (focus-in, SIGWINCH
    // reflow, scrollback replay on reattach) resend identical text and must
    // neither re-arm the idle timer nor drop a raised attention flag.
    if (isActive) {
      const sel = sessionLastSelectedAt(ctx.session.id);
      if (sel > 0 && sel !== selSeen.get(ctx.session.id)) {
        // The user (re)selected since the last chunk — whatever the screen
        // showed then is acknowledged, so earlier work no longer justifies
        // a "possibly finished" flag.
        selSeen.set(ctx.session.id, sel);
        workSeen.delete(ctx.session.id);
      }
      let screenChanged = true;
      const lines = ctx.getScreenLines();
      if (lines.length > 0) {
        const fp = lines.join('\n');
        screenChanged = screenSeen.get(ctx.session.id) !== fp;
        if (screenChanged) screenSeen.set(ctx.session.id, fp);
        if (lines.some((l) => DEVIN_WORKING_RE.test(l))) {
          workSeen.set(ctx.session.id, true);
        }
      }
      if (screenChanged) {
        armIdleTimer(ctx);
        if (state.attention) patch.attention = undefined;
      }
      // Live-region redraws produce output chunks constantly, so gate the
      // screen scan by time, not by update markers.
      const now = Date.now();
      if (now - (lastScreenScan.get(ctx.session.id) ?? 0) >= SCREEN_SCAN_MS) {
        lastScreenScan.set(ctx.session.id, now);
        scanScreenTasks(ctx);
      }
    }

    // Collect only chunks delivered after /exit armed this session's capture.
    // The independent buffer remains valid even when retained scrollback fills
    // up and its length stops increasing.
    const capture = exitCaptures.get(ctx.session.id);
    if (capture) {
      capture.output = (capture.output + text).slice(-16_384);
      const name = parseDevinSessionName(capture.output, true);
      if (name) capture.finish(name);
    }

    // Resolve a pending restore attempt: devin becoming the foreground
    // process means success; the CLI reporting the session is gone is a
    // definite failure. Everything else is left to the confirm timeout.
    const pendingRestore = pendingRestores.get(ctx.session.id);
    if (pendingRestore) {
      pendingRestore.recent = (pendingRestore.recent + text).slice(-8_192);
      if (RESTORE_FAILED_RE.test(pendingRestore.recent)) {
        finishRestore(ctx, 'gone');
      } else if (isActive) {
        finishRestore(ctx, 'ok');
      }
    }

    // Resume lines outside an armed /exit capture are ignored. Neither startup
    // output nor process transitions can capture a name from historical text.
    // A name split across output chunks is accepted only after its delimiter
    // arrives, so a partial name cannot prematurely complete the capture.

    // Only refresh the remembered task list when devin reports an update
    // (e.g. '⏺ Updated todo list (4 items)'). Otherwise the list stays as it
    // is — output scrolling or process changes must not make it disappear.
    const markerFound = TASK_UPDATE_MARKER.test(text);
    if (markerFound) {
      taskParsePending.set(ctx.session.id, TASK_PARSE_CHUNKS);
    }
    const pending = taskParsePending.get(ctx.session.id) ?? 0;
    if (pending > 0) {
      taskParsePending.set(ctx.session.id, pending - 1);
      const tasks = parseDevinTasks(output);
      axnLog('debug', 'devin', `parsed ${tasks.length} tasks from output`);
      if (devinTasksKey(tasks) !== devinTasksKey(state.tasks ?? [])) {
        axnLog('debug', 'devin', `task list changed: ${JSON.stringify(tasks)}`);
        patch.tasks = tasks;
      }
      // Keep session.tasks/progress in sync for the panel's progress bar.
      const simple = toTasks(tasks);
      const { progress, status } = computeTaskState(tasks);
      const nextStatus = status ?? 'idle';
      if (
        tasksKey(simple) !== tasksKey(ctx.session.tasks ?? []) ||
        progress !== (ctx.session.progress ?? 0) ||
        nextStatus !== (ctx.session.status ?? 'idle')
      ) {
        axnLog('debug', 'devin', `updating session progress: ${progress}%`);
        ctx.updateSession(ctx.session.id, { tasks: simple, progress, status: nextStatus });
      }
    }

    if (Object.keys(patch).length > 0) {
      ctx.updatePluginState(patch);
    }
  },

  onCommand: (ctx, command) => {
    if (command.trim() === '/exit' && isDevinSession(ctx.getSession())) {
      beginExitCapture(ctx);
      return;
    }
    // A submitted command starts new shell work — a terminal badge left by a
    // finished or blocked devin run no longer applies.
    const status = ctx.getSession().status;
    if (status === 'completed' || status === 'blocked') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    // A launch command can establish cwd, but not the final session name:
    // the user can switch sessions inside Devin after starting it.
    // Only an explicitly armed /exit capture may remember a new name.
    // Clear the previous name rather than treating the launch name as captured.
    const fromCommand = parseDevinCommand(command);
    if (fromCommand) {
      exitCaptures.get(ctx.session.id)?.finish();
      const patch: DevinPluginState = { devinSessionName: undefined };
      if (fromCommand.cwd) {
        patch.devinSessionCwd = fromCommand.cwd;
      } else {
        void recordSessionCwd(ctx);
      }
      ctx.updatePluginState(patch);
      axnLog('debug', 'devin', `session ${ctx.session.id}: launch command invalidated previous capture`);
    }
  },

  onClose: async (ctx) => {
    clearIdleTimer(ctx.session.id);
    watchedOutput.delete(ctx.session.id);
    lastScreenScan.delete(ctx.session.id);
    screenSeen.delete(ctx.session.id);
    selSeen.delete(ctx.session.id);
    workSeen.delete(ctx.session.id);
    quietScans.delete(ctx.session.id);
    cancelPendingRestore(ctx.session.id);
    const pending = exitCaptures.get(ctx.session.id);
    if (pending) {
      await pending.done;
      await recordSessionCwd(ctx);
      // A capture that ended nameless still leaves the session's last
      // conversation resumable via the -c fallback.
      rememberDevinLast(ctx, rememberedDevinSession(ctx));
      return;
    }
    const live = ctx.getSession();
    if (!isDevinSession(live)) {
      // Not running at close — nothing to resume next time.
      if (getDevinState(ctx).devinActive) ctx.updatePluginState({ devinActive: false });
      const state = getDevinState(ctx).devinSessionName;
      if (state) {
        axnLog('warn', 'devin-close', `session ${ctx.session.id} has remembered '${state}' but no devin process detected; not interrupting`);
      }
      return;
    }

    closingSessions.add(ctx.session.id);
    // Arm the post-interrupt capture BEFORE the first Ctrl-C. Retained
    // scrollback is capped at 200,000 characters, so an offset into it cannot
    // be used as a cursor for output printed after the interrupts — only the
    // dedicated per-chunk buffer reliably sees them.
    const capture = beginExitCapture(ctx);
    // Do not try to submit /exit here: the user may already have partially
    // typed input, or a questionnaire / spinner may be open. Send Ctrl-C, then
    // a second one after a short pause only if devin is still running — a
    // second interrupt during a graceful shutdown could kill devin before it
    // prints its resume line.
    await ctx.writeToSession('\x03');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (isDevinSession(ctx.getSession())) {
      await ctx.writeToSession('\x03');
    }
    await capture.done;
    // Capture the devin session directory before the app saves state and the
    // PTY disappears. This is the final fallback for sessions whose resume
    // line was missed or whose cwd was not yet written to disk.
    await recordSessionCwd(ctx);
    // No name within the capture window still leaves a resumable last
    // session — `devin -c` continues the latest session in its dir.
    rememberDevinLast(ctx, rememberedDevinSession(ctx));
  },

  onSessionOpen: (ctx) => {
    exitCaptures.get(ctx.session.id)?.finish();
    clearIdleTimer(ctx.session.id);
    lastScreenScan.delete(ctx.session.id);
    cancelPendingRestore(ctx.session.id);
    closingSessions.delete(ctx.session.id);
    // A freshly spawned session cannot have devin running — any persisted task
    // list/progress belongs to a dead process and must not linger.
    const state = getDevinState(ctx);
    if ((state.tasks ?? []).length > 0) {
      ctx.updatePluginState({ tasks: [] });
    }
    if (state.attention) {
      ctx.updatePluginState({ attention: undefined });
    }
    if (
      (ctx.session.tasks ?? []).length > 0 ||
      (ctx.session.progress ?? 0) > 0 ||
      (ctx.session.status ?? 'idle') !== 'idle'
    ) {
      ctx.updateSession(ctx.session.id, { tasks: [], progress: 0, status: 'idle' });
    }
    if (state.devinOutputStart !== undefined) {
      ctx.updatePluginState({ devinOutputStart: undefined });
    }
    // Drop a banner left over from a previous run — a new restore attempt
    // below (or a successful one later) manages its own banner.
    if (state.banner) {
      ctx.setBanner(null);
    }

    const settings = getDevinSettings(ctx);
    const { restoreSession } = settings;
    // Use only the persisted name; a missing capture must not fall back to
    // historical resume lines in the retained output.
    const remembered = rememberedDevinSession(ctx);
    axnLog(
      'debug',
      'devin-restore',
      `pluginSettings=${JSON.stringify(settings)} session=${ctx.session.id} remembered=${remembered ? `${remembered.name}@${remembered.cwd ?? '?'}` : 'none'}`,
    );
    if (!restoreSession) {
      if (remembered) {
        axnLog('debug', 'devin-restore', `restore-session is disabled; not restoring '${remembered.name}' for session ${ctx.session.id}`);
      }
      ctx.setRestoring(null);
      return;
    }
    if (!remembered || !state.devinActive) {
      if (remembered) {
        axnLog('debug', 'devin-restore', `devin was not running at close; not restoring '${remembered.name}' for session ${ctx.session.id}`);
      }
      ctx.setRestoring(null);
      return;
    }

    const cmd = devinResumeCommand(remembered);
    axnLog('info', 'devin-restore', `will restore '${remembered.name}' for session ${ctx.session.id} via: ${cmd}`);
    void (async () => {
      // Wait for the freshly spawned shell to emit its first output (prompt)
      // before injecting the resume command; fall back after a timeout.
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog(
          'warn',
          'devin-restore',
          `timed out waiting for shell output on session ${ctx.session.id}; attempting restore anyway`,
        );
      }
      // Small settle delay so the prompt is fully drawn / line editor is up.
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${cmd}\r`);
        axnLog(
          'info',
          'devin-restore',
          `injected '${cmd}' into session ${ctx.session.id}`,
        );
        const pending: PendingRestore = {
          name: remembered.name,
          recent: '',
          timer: setTimeout(() => finishRestore(ctx, 'timeout'), RESTORE_CONFIRM_TIMEOUT_MS),
        };
        pendingRestores.set(ctx.session.id, pending);
      } catch (e) {
        axnLog(
          'error',
          'devin-restore',
          `failed to write restore command '${cmd}': ${String(e)}`,
        );
        ctx.setRestoring(null);
        ctx.setBanner({
          level: 'error',
          message: `Failed to restore devin session '${remembered.name}' — could not write to the session.`,
        });
        ctx.setAttention({ level: 'warning', message: 'devin restore failed' });
      }
    })();
  },
};

// Devin owns its launch semantics: it has no instructions channel, so a
// persona's `instructions`/`instructionsFile` are resolved (a file is read
// cwd-relative) and folded in ahead of the seed prompt.
registerAgentLauncher('devin', async (spec, prompt, tools, cwd) => {
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  return agentCommand('devin', spec, inst ? inst + (prompt ? `\n\n${prompt}` : '') : prompt);
});
