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
  /** Directory the claude session ran in — claude scopes conversations per directory. */
  claudeCwd?: string;
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

/** `claude -c` continues the most recent conversation in the given directory. */
function claudeResumeCommand(cwd: string | undefined, sessionCwd: string | undefined): string {
  const resume = 'claude -c';
  if (cwd && cwd !== sessionCwd) return `cd ${shellQuote(cwd)} && ${resume}`;
  return resume;
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
        "Run 'claude -c' when a session that previously ran claude is reopened.",
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
  },

  onOutput: (ctx) => {
    const state = getState(ctx);
    // Remember that this session ran claude, and in which directory, so the
    // conversation can be continued after the terminal session is reopened.
    if (isClaudeProcess(ctx.session.process) && (!state.claudeSeen || state.claudeCwd !== ctx.session.cwd)) {
      ctx.updatePluginState({ claudeSeen: true, claudeCwd: ctx.session.cwd });
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
        const state = getState(ctx);
        const cmd = claudeResumeCommand(state.claudeCwd, ctx.session.cwd);
        axnLog('info', 'claude-resume', `resuming claude: ${cmd}`);
        return cmd;
      },
    },
  ],

  // A submitted command starts new shell work — a terminal badge left by a
  // finished agent run no longer applies, and a stale needs-you flag is gone.
  onCommand: (ctx) => {
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
    const { restoreSession } = getSettings(ctx);
    const state = getState(ctx);
    axnLog(
      'debug',
      'claude-restore',
      `pluginSettings=${JSON.stringify(getSettings(ctx))} session=${ctx.session.id} claudeSeen=${state.claudeSeen === true}`,
    );
    if (!restoreSession || !state.claudeSeen) return;

    const cmd = claudeResumeCommand(state.claudeCwd, ctx.session.cwd);
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
      } catch (e) {
        axnLog('error', 'claude-restore', `failed to write '${cmd}': ${String(e)}`);
      }
    })();
  },

  onClose: (ctx) => {
    const timer = scanTimers.get(ctx.session.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      scanTimers.delete(ctx.session.id);
    }
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
