import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import type { SessionStatus, ShellSession, Task } from '../../types';
import { axnLog } from '../log';
import { hookStatusOwned } from './agentHookBridge';
import { claudeHookSpec } from './claudeHooks';
import { registerAgentLauncher } from './agentRegistry';
import { agentCommand, promptArg, shellWord } from './devWorkflow';

interface ClaudePluginState {
  /** Set once a claude process has been observed in this session. */
  claudeSeen?: boolean;
  /**
   * Claude was running when the session last went away: set while claude is
   * foreground, cleared when it exits on its own — but kept when the app's
   * close (onClose) or a crash stops it. Restore requires it, so a shell
   * that once ran claude but sat at its prompt on close reopens as a shell.
   */
  claudeActive?: boolean;
  /** Directory the claude session ran in — claude scopes conversations per directory. */
  claudeCwd?: string;
  /** Conversation id from claude's exit hint (`claude --resume <id>`). */
  claudeResumeId?: string;
  /** Worktree from a `claude --worktree "<name>" --resume <id>` exit hint. */
  claudeWorktree?: string;
  /** "Needs attention" flag / banner owned by this plugin (reserved keys). */
  attention?: unknown;
  banner?: unknown;
  /** Whether this plugin currently owns session.tasks/progress. */
  wroteTasks?: boolean;
}

type ClaudeTaskStatus = 'pending' | 'running' | 'completed';

interface ClaudeTask {
  id: string;
  title: string;
  status: ClaudeTaskStatus;
}

/**
 * Claude Code renders the todo tool call as a block of `⎿ ☒/☐/▶ title` lines
 * under an `Update Todos` header. Symbols: ☒/✔/✓ completed, ☐/○ pending,
 * ▶/◐/● in progress.
 */
const CLAUDE_TASK_RE =
  /^\s*[⎿│├└─]*\s*(☒|✔|✓|☐|○|◐|▶|●)\s+(.+?)\s*$/u;
const CLAUDE_TODO_MARKER_RE = /\bupdate\s+todos?\b|\btodo(?:write|s)?\b/i;

function claudeTaskStatus(symbol: string): ClaudeTaskStatus {
  if (symbol === '☒' || symbol === '✔' || symbol === '✓') return 'completed';
  if (symbol === '☐' || symbol === '○') return 'pending';
  return 'running';
}

/**
 * Parse the bottom-most contiguous todo block on screen. To weed out stray
 * symbol-prefixed text, a block must follow an `Update Todos`/`todo` marker
 * within a few lines, or contain at least two task lines.
 */
export function parseClaudeTodos(lines: string[]): ClaudeTask[] | undefined {
  const matchAt = lines.map((line) => CLAUDE_TASK_RE.exec(line));

  // Find the end of the last contiguous block of task lines.
  let end = lines.length - 1;
  while (end >= 0 && !matchAt[end]) end--;
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && matchAt[start - 1]) start--;

  const blockLen = end - start + 1;
  const markerAbove = lines
    .slice(Math.max(0, start - 5), start)
    .some((line) => CLAUDE_TODO_MARKER_RE.test(line));
  if (!markerAbove && blockLen < 2) return undefined;

  const tasks: ClaudeTask[] = [];
  for (let i = start; i <= end; i++) {
    const m = matchAt[i]!;
    tasks.push({
      id: `claude-${i - start}`,
      title: m[2].trim(),
      status: claudeTaskStatus(m[1]),
    });
  }
  return tasks.length > 0 ? tasks : undefined;
}

function toTasks(tasks: ClaudeTask[]): Task[] {
  return tasks.map((t) => ({ id: t.id, title: t.title, done: t.status === 'completed' }));
}

function tasksKey(list: Task[]): string {
  return list.map((t) => `${t.id}:${t.title}:${t.done}`).join('|');
}

/** Output bursts are coalesced into one trailing screen scan after this delay. */
const SCAN_DELAY_MS = 120;
const scanTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Re-read the screen and publish the todo block, if any. */
function scanTodos(ctx: SessionViewContext & PluginApi): void {
  const session = ctx.getSession();
  const tasks = parseClaudeTodos(ctx.getScreenLines());
  const state = getState(ctx);
  if (!tasks) return; // keep the last list — the block may be folded or scrolled

  const simple = toTasks(tasks);
  const progress = Math.round(
    (tasks.filter((t) => t.status === 'completed').length / tasks.length) * 100,
  );
  const status: SessionStatus = tasks.every((t) => t.status === 'completed')
    ? 'completed'
    : 'running';
  // Hook events are the exact lifecycle source once seen — the screen scan
  // then only contributes task content, not status guesses.
  const hooksOwn = hookStatusOwned(claudeHookSpec, session.id);
  const statusChanged = !hooksOwn && status !== (session.status ?? 'idle');
  if (
    tasksKey(simple) !== tasksKey(session.tasks ?? []) ||
    progress !== (session.progress ?? 0) ||
    statusChanged
  ) {
    const patch: Partial<ShellSession> = { tasks: simple, progress };
    if (!hooksOwn) patch.status = status;
    ctx.updateSession(session.id, patch);
  }
  if (!state.wroteTasks) ctx.updatePluginState({ wroteTasks: true });
}

function clearTasks(ctx: SessionViewContext & PluginApi): void {
  const state = getState(ctx);
  if (!state.wroteTasks) return;
  ctx.updatePluginState({ wroteTasks: false });
  const session = ctx.getSession();
  const tasks = session.tasks ?? [];
  // A fully done run keeps its 'completed' badge — the "done" signal.
  const allDone = tasks.length > 0 && tasks.every((t) => t.done);
  if (
    tasks.length > 0 ||
    (session.progress ?? 0) !== 0 ||
    (session.status ?? 'idle') !== 'idle'
  ) {
    ctx.updateSession(session.id, {
      tasks: [],
      progress: 0,
      status: allDone || session.status === 'completed' ? 'completed' : 'idle',
    });
  }
}

interface ClaudePluginSettings {
  restoreSession?: boolean;
  /** Register axn-term hook entries in ~/.claude/settings.json. */
  installHooks?: boolean;
}

function isClaudeProcess(process: string | undefined): boolean {
  return /(^|\/)claude$/i.test((process ?? '').trim()) || /claude/i.test(process ?? '');
}

function getState(ctx: SessionViewContext & PluginApi): ClaudePluginState {
  return (ctx.pluginState as ClaudePluginState | undefined) ?? {};
}

function getSettings(ctx: SessionViewContext & PluginApi): ClaudePluginSettings {
  return (ctx.pluginSettings as ClaudePluginSettings | undefined) ?? {};
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resume this session's own conversation when claude's exit hint was
 * captured; otherwise fall back to `claude -c` — the most recent
 * conversation in the directory, which may belong to another session.
 */
function claudeResumeCommand(state: ClaudePluginState, sessionCwd: string | undefined): string {
  const worktree = state.claudeWorktree ? ` --worktree ${shellQuote(state.claudeWorktree)}` : '';
  const resume = state.claudeResumeId ? `claude${worktree} --resume ${state.claudeResumeId}` : 'claude -c';
  const cwd = state.claudeCwd;
  if (cwd && cwd !== sessionCwd) return `cd ${shellQuote(cwd)} && ${resume}`;
  return resume;
}

// Claude Code prints its resume hint on exit (double Ctrl-C, /exit, /quit):
//   Resume this session with:
//   claude --resume <id>
// or, inside a worktree, `claude --worktree "<name>" --resume <id>` / the
// short `claude -w "<name>" -r <id>`. The trailing newline marks the line
// complete, so an id split across output chunks is never taken half-way.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RESUME_HINT_RE =
  /Resume this session with:[ \t]*\r?\n[ \t]*claude(?: (?:--worktree|-w) "([^"\r\n]+)")? (?:--resume|-r) ([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*\r?\n/g;

export function parseClaudeResumeHint(output: string): { id: string; worktree?: string } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of output.replace(ANSI_RE, '').matchAll(RESUME_HINT_RE)) last = m;
  if (!last) return undefined;
  return last[1] ? { id: last[2], worktree: last[1] } : { id: last[2] };
}

// Exit capture: once claude is closing (onClose's Ctrl-C, or any exit seen
// at process end), collect the following output chunks until the resume
// hint arrives or the capture times out. A capture only adopts a hint it
// sees — a kill prints nothing, and the stored id stays valid.
interface ExitCapture {
  output: string;
  done: Promise<void>;
  finish: () => void;
}

const exitCaptures = new Map<string, ExitCapture>();
const EXIT_TAIL_CHARS = 16_384;
const CLOSE_CAPTURE_MS = 6_000;
const PASSIVE_CAPTURE_MS = 3_000;

function beginExitCapture(
  ctx: SessionViewContext & PluginApi,
  timeoutMs: number,
  seed = '',
): ExitCapture {
  const id = ctx.session.id;
  const pending = exitCaptures.get(id);
  if (pending) return pending;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const capture: ExitCapture = {
    output: seed,
    done,
    finish: () => {
      if (exitCaptures.get(id) !== capture) return;
      clearTimeout(timer);
      exitCaptures.delete(id);
      resolveDone();
    },
  };
  const timer = setTimeout(() => capture.finish(), timeoutMs);
  exitCaptures.set(id, capture);
  return capture;
}

/** Feed captured output; adopts the hint and ends the capture once complete. */
function adoptResumeHint(ctx: SessionViewContext & PluginApi, output: string): boolean {
  const hint = parseClaudeResumeHint(output);
  if (!hint) return false;
  const state = getState(ctx);
  if (hint.id !== state.claudeResumeId || hint.worktree !== state.claudeWorktree) {
    ctx.updatePluginState({ claudeResumeId: hint.id, claudeWorktree: hint.worktree });
    axnLog('debug', 'claude-close', `session ${ctx.session.id}: captured resume id ${hint.id}`);
  }
  return true;
}

// After the restore command is injected, the attempt is tracked until
// claude is the foreground process ('ok'), claude reports the conversation
// is gone ('gone'), or neither happens in time ('timeout').
interface PendingRestore {
  label: string;
  recent: string;
  timer: ReturnType<typeof setTimeout>;
}

const RESTORE_FAILED_RE = /No conversation found/i;
const RESTORE_CONFIRM_TIMEOUT_MS = 20_000;
const pendingRestores = new Map<string, PendingRestore>();

// Sessions whose claude is being stopped by onClose — that exit must not
// clear claudeActive, it is exactly the state restore should resume.
const closingSessions = new Set<string>();

function restoreLabel(state: ClaudePluginState): string {
  return state.claudeResumeId ? `claude session '${state.claudeResumeId}'` : 'last claude conversation';
}

function finishRestore(ctx: SessionViewContext & PluginApi, outcome: 'ok' | 'gone' | 'timeout') {
  const id = ctx.session.id;
  ctx.setRestoring(null);
  const pending = pendingRestores.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRestores.delete(id);
  if (outcome === 'ok') {
    ctx.setBanner(null);
    axnLog('info', 'claude-restore', `session ${id}: restored ${pending.label}`);
    return;
  }
  if (outcome === 'gone') {
    // Claude confirmed the conversation is gone — stop retrying it.
    ctx.updatePluginState({ claudeResumeId: undefined, claudeWorktree: undefined });
  }
  ctx.setBanner({
    level: 'error',
    message:
      outcome === 'gone'
        ? `Claude ${pending.label} no longer exists — could not restore it.`
        : `Could not restore ${pending.label} — claude did not start.`,
  });
  ctx.setAttention({ level: 'warning', message: 'claude restore failed' });
  axnLog('warn', 'claude-restore', `session ${id}: restore of ${pending.label} ${outcome}`);
}

function cancelPendingRestore(sessionId: string) {
  const pending = pendingRestores.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRestores.delete(sessionId);
  }
}

/** A typed `claude …` launch starts a new conversation (unless it resumes one). */
function startsNewClaudeConversation(command: string): boolean {
  const words = command.trim().split(/\s+/);
  return words[0] === 'claude' && !words.some((w) => ['-c', '--continue', '-r', '--resume'].includes(w));
}

export const claudePlugin: SessionViewPlugin = {
  id: 'claude',
  title: 'claude',
  version: '0.1.0',
  stateKey: 'claude',
  settingsKey: 'claude',
  // Opt-in: users must set `claude.enabled: true` in plugins.yaml.
  defaultEnabled: false,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume Claude Code sessions',
      description:
        'Resume the session\'s own claude conversation (captured from claude\'s ' +
        "exit hint, else 'claude -c') when a session that ran claude is reopened.",
      type: 'boolean',
      default: false,
    },
    {
      key: 'installHooks',
      label: 'Install Claude Code hooks',
      description:
        'Merge axn-term hook entries into ~/.claude/settings.json for exact ' +
        'working/waiting status and needs-you notifications (existing hooks ' +
        'are preserved; entries are removed again when disabled).',
      type: 'boolean',
      default: false,
    },
  ],
  // Bound to the claude process: its rendered todo list drives
  // session.tasks/progress, so generic screen-guessed bars stay out of the way.
  processPattern: /claude/i,
  handlesProgress: true,
  // Declarative agent-hook bridge — the host installs hook entries per
  // installHooks, polls the tty-keyed event file, and owns session.status
  // once an event lands.
  hookSpec: claudeHookSpec,

  onProcessEnd: (ctx) => {
    const timer = scanTimers.get(ctx.session.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      scanTimers.delete(ctx.session.id);
    }
    // The host already released the hook bridge + cleared the flag.
    clearTasks(ctx);
    // Claude ended while the session lives on — the user is back at the
    // shell, so a later reopen must not resume claude.
    if (!closingSessions.has(ctx.session.id) && getState(ctx).claudeActive) {
      ctx.updatePluginState({ claudeActive: false });
    }
    // The foreground poll lags real output: an exit the plugin did not drive
    // (/exit, /quit, a manual double Ctrl-C) has usually printed its resume
    // hint already. Take it from a bounded tail, and keep a short passive
    // capture alive for exit chunks still in flight.
    if (!exitCaptures.has(ctx.session.id)) {
      const tail = (ctx.getSession().output ?? '').slice(-EXIT_TAIL_CHARS);
      if (!adoptResumeHint(ctx, tail)) beginExitCapture(ctx, PASSIVE_CAPTURE_MS);
    }
  },

  // Declared before onSessionOpen injects the resume command: the app covers
  // the terminal so input cannot race the injected line. Cleared by
  // finishRestore and on every onSessionOpen path that does not restore.
  pendingRestore: (ctx) => {
    const state = getState(ctx);
    if (!getSettings(ctx).restoreSession || !state.claudeActive) return undefined;
    return restoreLabel(state);
  },

  onOutput: (ctx, text) => {
    const state = getState(ctx);
    const capture = exitCaptures.get(ctx.session.id);
    if (capture) {
      capture.output = (capture.output + text).slice(-EXIT_TAIL_CHARS);
      if (adoptResumeHint(ctx, capture.output)) capture.finish();
    }
    const pendingRestore = pendingRestores.get(ctx.session.id);
    if (pendingRestore) {
      pendingRestore.recent = (pendingRestore.recent + text).slice(-8_192);
      if (RESTORE_FAILED_RE.test(pendingRestore.recent)) finishRestore(ctx, 'gone');
      else if (isClaudeProcess(ctx.getSession().process)) finishRestore(ctx, 'ok');
    }

    // Remember that this session ran claude, and in which directory, so the
    // conversation can be continued after the terminal session is reopened.
    if (
      isClaudeProcess(ctx.session.process) &&
      (!state.claudeSeen || !state.claudeActive || state.claudeCwd !== ctx.session.cwd)
    ) {
      ctx.updatePluginState({ claudeSeen: true, claudeActive: true, claudeCwd: ctx.session.cwd });
      axnLog('debug', 'claude', `remembered claude session (cwd=${ctx.session.cwd ?? 'unknown'})`);
    }

    // The todo list is a TUI element — read the live screen rather than the
    // output stream. The buffer lags the chunk slightly (term.write is
    // queued), so coalesce bursts into one trailing scan.
    if (isClaudeProcess(ctx.getSession().process) && !scanTimers.has(ctx.session.id)) {
      scanTimers.set(
        ctx.session.id,
        setTimeout(() => {
          scanTimers.delete(ctx.session.id);
          scanTodos(ctx);
        }, SCAN_DELAY_MS),
      );
    }
  },

  commands: [
    {
      // `axn-claude-resume` continues the last claude conversation for this
      // session's directory.
      name: 'axn-claude-resume',
      run: (ctx) => {
        const cmd = claudeResumeCommand(getState(ctx), ctx.session.cwd);
        axnLog('info', 'claude-resume', `resuming claude: ${cmd}`);
        return cmd;
      },
    },
  ],

  // A submitted command starts new shell work — a terminal badge left by a
  // finished agent run no longer applies, and a stale needs-you flag is gone.
  onCommand: (ctx, command) => {
    // A fresh `claude` launch replaces the conversation this session
    // resumes; until its exit hint is captured, restore falls back to -c.
    if (startsNewClaudeConversation(command) && getState(ctx).claudeResumeId) {
      ctx.updatePluginState({ claudeResumeId: undefined, claudeWorktree: undefined });
    }
    const status = ctx.getSession().status;
    if (status === 'completed' || status === 'blocked') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    const st = ctx.pluginState as { attention?: unknown } | undefined;
    if (st?.attention) ctx.setAttention(null);
  },

  onSessionOpen: (ctx) => {
    // Fresh PTY — the host already dropped the hook-bridge runtime and the
    // flag; task state persisted by a previous process must not linger.
    const state0 = getState(ctx);
    if (state0.wroteTasks) ctx.updatePluginState({ wroteTasks: false });
    const live = ctx.getSession();
    if (
      (live.tasks ?? []).length > 0 ||
      (live.progress ?? 0) !== 0 ||
      (live.status ?? 'idle') !== 'idle'
    ) {
      ctx.updateSession(live.id, { tasks: [], progress: 0, status: 'idle' });
    }
    exitCaptures.get(ctx.session.id)?.finish();
    cancelPendingRestore(ctx.session.id);
    closingSessions.delete(ctx.session.id);
    if (state0.banner) ctx.setBanner(null);
    const { restoreSession } = getSettings(ctx);
    const state = getState(ctx);
    axnLog(
      'debug',
      'claude-restore',
      `pluginSettings=${JSON.stringify(getSettings(ctx))} session=${ctx.session.id} claudeActive=${state.claudeActive === true} resumeId=${state.claudeResumeId ?? 'none'}`,
    );
    if (!restoreSession || !state.claudeActive) {
      ctx.setRestoring(null);
      return;
    }

    const cmd = claudeResumeCommand(state, ctx.session.cwd);
    const label = restoreLabel(state);
    axnLog('info', 'claude-restore', `will resume claude for session ${ctx.session.id} via: ${cmd}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog('warn', 'claude-restore', `timed out waiting for shell output on session ${ctx.session.id}; resuming anyway`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${cmd}\r`);
        axnLog('info', 'claude-restore', `injected '${cmd}' into session ${ctx.session.id}`);
        pendingRestores.set(ctx.session.id, {
          label,
          recent: '',
          timer: setTimeout(() => finishRestore(ctx, 'timeout'), RESTORE_CONFIRM_TIMEOUT_MS),
        });
      } catch (e) {
        axnLog('error', 'claude-restore', `failed to write '${cmd}': ${String(e)}`);
        ctx.setRestoring(null);
        ctx.setBanner({
          level: 'error',
          message: `Failed to restore ${label} — could not write to the session.`,
        });
        ctx.setAttention({ level: 'warning', message: 'claude restore failed' });
      }
    })();
  },

  // Close claude gracefully so it prints its resume hint, and capture the
  // conversation id before the PTY goes away.
  onClose: async (ctx) => {
    const timer = scanTimers.get(ctx.session.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      scanTimers.delete(ctx.session.id);
    }
    cancelPendingRestore(ctx.session.id);
    const pending = exitCaptures.get(ctx.session.id);
    if (pending) {
      await pending.done;
      return;
    }
    if (!isClaudeProcess(ctx.getSession().process)) {
      // Not running at close — nothing to resume next time.
      if (getState(ctx).claudeActive) ctx.updatePluginState({ claudeActive: false });
      return;
    }
    closingSessions.add(ctx.session.id);
    // Arm the capture before the first Ctrl-C. Claude exits on a second
    // Ctrl-C ("Press Ctrl-C again to exit"); a first one only clears a
    // half-typed prompt, so a second pair follows if claude is still up.
    const capture = beginExitCapture(ctx, CLOSE_CAPTURE_MS);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let round = 0; round < 2 && exitCaptures.get(ctx.session.id) === capture; round++) {
      await ctx.writeToSession('\x03');
      await pause(250);
      await ctx.writeToSession('\x03');
      await Promise.race([capture.done, pause(1_500)]);
    }
    await capture.done;
  },
};

// Claude owns its launch semantics: `instructions`/`instructionsFile` go
// through the native system-prompt channel — `--append-system-prompt-file`
// when a file is given (claude reads it itself, keeping the launch line
// small and the file's exact bytes), inline `--append-system-prompt`
// otherwise — and the seed prompt stays the positional first message.
registerAgentLauncher('claude', (spec, prompt) =>
  agentCommand(
    'claude',
    spec,
    prompt,
    spec.instructionsFile
      ? ` --append-system-prompt-file ${shellWord(spec.instructionsFile)}`
      : spec.instructions
        ? ` --append-system-prompt ${promptArg(spec.instructions)}`
        : '',
  ),
);
