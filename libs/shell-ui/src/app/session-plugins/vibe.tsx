import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { axnLog } from '../log';
import { sessionLastSelectedAt } from '../attention';
import type { SessionAttention, SessionBanner, SessionStatus, ShellSession, Task } from '../../types';
import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import {
  agentResumeMenuItem,
  forgetLastAgentSession,
  rememberLastAgentSession,
} from './agentResume';
import { agentResumePanel } from './agentResumePanel';
import { shellQuote } from '../../shellQuote';

// Anchored: session.process is the argv-derived basename, so 'vibe' and
// 'vibe-agent' match while 'python -m vibe' (module launch) does not.
export const VIBE_PROCESS_RE = /^vibe/i;

/** Patterns that indicate the session name requires user attention */
const ATTENTION_NAME_PATTERNS = [
  /\?\s*vibe/i,
  /action\s+required/i,
  /input\s+required/i,
  /awaiting\s+input/i,
  /needs\s+attention/i,
];

/** Check if a session name matches any attention-requiring pattern */
function sessionNameRequiresAttention(name: string | undefined): boolean {
  if (!name) return false;
  return ATTENTION_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

type VibeTaskStatus = 'pending' | 'running' | 'completed' | 'blocked';

interface VibeTask {
  id: string;
  title: string;
  status: VibeTaskStatus;
}

const statusIcons: Record<VibeTaskStatus, string> = {
  pending: '[ ]',
  running: '[~]',
  completed: '[x]',
  blocked: '[!]',
};

const statusClasses: Record<VibeTaskStatus, string> = {
  pending: 'text-[var(--text-secondary)]',
  running: 'text-[var(--accent)]',
  completed: 'text-[var(--green)]',
  blocked: 'text-[var(--red)]',
};

function parseVibeStatusSymbol(symbol: string): VibeTaskStatus {
  switch (symbol) {
    case '✓':
    case '✔':
    case '☑':
    case '✅':
    case 'x':
    case 'X':
      return 'completed';
    case '✗':
    case '✘':
    case '✕':
    case '✖':
    case '❌':
    case '!':
      return 'blocked';
    case '○':
    case '⏳':
    case ' ':
      return 'pending';
    default:
      return 'running';
  }
}

// Task lines are either checkbox-style (`[ ] task`, `[~] task`, `[x] task`,
// `[!] task`) or a single status symbol followed by a title
// (`○ task`, `● task`, `✓ task`, `✗ task`).
const taskLinePattern = /^\s*(?:\[([xX~! ])\]|([✓✔✗✘✕✖✅❌○◔◐◕◎⏺→●]))\s+(.+)$/u;

export function parseVibeTasks(output: string): VibeTask[] {
  const lines = output.split('\n');
  const tasks: VibeTask[] = [];
  const seen = new Set<string>();

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

    const title = match[3].trim();
    const status = parseVibeStatusSymbol(match[1] ?? match[2]);
    const id = `vibe-${i}-${title.slice(0, 20)}`;
    if (title && !seen.has(id)) {
      seen.add(id);
      tasks.unshift({ id, title, status });
    }
    i--;
  }

  return tasks;
}

export function parseVibeStructuredTasks(output: string): VibeTask[] {
  const lines = output.split('\n');
  const tasks: VibeTask[] = [];
  const taskPattern = /^(?:Task\s+(\d+)\/(\d+)|\s*\[(\d+)\/(\d+)\]\s*)[:\s]+(.+)$/i;

  for (const line of lines) {
    const match = taskPattern.exec(line);
    if (match) {
      const current = parseInt(match[1] ?? match[3], 10);
      const total = parseInt(match[2] ?? match[4], 10);
      const title = match[5].trim();

      let status: VibeTaskStatus = 'pending';
      if (current < total) {
        status = 'running';
      } else if (current === total) {
        status = 'completed';
      }

      tasks.push({ id: `vibe-${current}`, title, status });
    }
  }

  return tasks;
}

function computeTaskState(tasks: VibeTask[]): { tasks: VibeTask[]; progress: number; status: SessionStatus | undefined; completed: number } {
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

function toTasks(tasks: VibeTask[]): Task[] {
  return tasks.map((t) => ({ id: t.id, title: t.title, done: t.status === 'completed' }));
}

function tasksKey(list: Task[]): string {
  return list.map((t) => `${t.id}:${t.title}:${t.done}`).join('|');
}

function vibeTasksKey(list: VibeTask[]): string {
  return list.map((t) => `${t.id}:${t.title}:${t.status}`).join('|');
}

const TASK_UPDATE_MARKER = /(?:updated|refresh)\s+(?:todo|task)s?\s*list/i;
const TASK_PARSE_CHUNKS = 4;
const taskParsePending = new Map<string, number>();

interface VibePluginState {
  vibeSessionName?: string;
  vibeSessionCwd?: string;
  vibeOutputStart?: number;
  vibeWasActive?: boolean;
  attention?: SessionAttention | null;
  banner?: SessionBanner | null;
  tasks?: VibeTask[];
  /** Track the previous session name to detect changes */
  previousSessionName?: string;
}

interface ExitCapture {
  output: string;
  done: Promise<void>;
  finish: (name?: string) => void;
}

const exitCaptures = new Map<string, ExitCapture>();

function beginExitCapture(ctx: SessionViewContext & PluginApi): ExitCapture {
  const id = ctx.session.id;
  const pending = exitCaptures.get(id);
  if (pending) return pending;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const capture: ExitCapture = {
    output: '',
    done,
    finish: (name) => {
      if (exitCaptures.get(id) !== capture) return;
      clearTimeout(timer);
      exitCaptures.delete(id);
      if (name) {
        ctx.updatePluginState({ vibeSessionName: name });
        rememberVibeLast(ctx, { name });
      }
      axnLog(name ? 'debug' : 'warn', 'vibe-close',
        `session ${id}: ${name ? `captured post-exit session ${name}` : 'no complete post-exit resume line; name cleared'}`);
      resolveDone();
    },
  };
  const timer = setTimeout(() => capture.finish(), 8000);
  exitCaptures.set(id, capture);
  ctx.updatePluginState({ vibeSessionName: undefined, vibeOutputStart: undefined });
  axnLog('debug', 'vibe-close', `session ${id}: starting fresh /exit capture`);
  void recordSessionCwd(ctx).catch(() => {});
  return capture;
}

interface PendingRestore {
  name: string;
  recent: string;
  timer: ReturnType<typeof setTimeout>;
}

const RESTORE_FAILED_RE = /no session found matching/i;
const RESTORE_CONFIRM_TIMEOUT_MS = 20_000;
const pendingRestores = new Map<string, PendingRestore>();

function finishRestore(ctx: SessionViewContext & PluginApi, outcome: 'ok' | 'gone' | 'timeout') {
  const id = ctx.session.id;
  ctx.setRestoring(null);
  const pending = pendingRestores.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRestores.delete(id);
  if (outcome === 'ok') {
    ctx.setBanner(null);
    axnLog('info', 'vibe-restore', `session ${id}: restored '${pending.name}'`);
    return;
  }
  if (outcome === 'gone') {
    forgetLastAgentSession(ctx, 'vibe', pending.name);
    ctx.updatePluginState({ vibeSessionName: undefined });
    ctx.setBanner({
      level: 'error',
      message: `Vibe session '${pending.name}' no longer exists - could not restore it.`,
    });
    ctx.setAttention({ level: 'warning', message: 'vibe restore failed' });
    axnLog('warn', 'vibe-restore', `session ${id}: '${pending.name}' not found by vibe CLI`);
    return;
  }
  ctx.setBanner({
    level: 'error',
    message: `Could not restore vibe session '${pending.name}' - it did not start.`,
  });
  ctx.setAttention({ level: 'warning', message: 'vibe restore failed' });
  axnLog('warn', 'vibe-restore', `session ${id}: restore of '${pending.name}' could not be confirmed`);
}

function cancelPendingRestore(sessionId: string) {
  const pending = pendingRestores.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRestores.delete(sessionId);
  }
}

interface VibePluginSettings {
  restoreSession?: boolean;
  idleTimeoutSeconds?: number;
}

const DEFAULT_IDLE_TIMEOUT_S = 45;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watchedOutput = new Map<string, number>();

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
  const seconds = getVibeSettings(ctx).idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S;
  if (!(seconds > 0)) return;
  const selectedAt = sessionLastSelectedAt(id);
  if (selectedAt > 0) watchedOutput.set(id, selectedAt);
  if (selectedAt === 0 || watchedOutput.get(id) !== selectedAt) return;
  idleTimers.set(
    id,
    setTimeout(() => {
      idleTimers.delete(id);
      if (!isVibeSession(ctx.getSession())) return;
      const lastSel = sessionLastSelectedAt(id);
      if (lastSel === 0 || watchedOutput.get(id) !== lastSel) return;
      const screen = ctx.getScreenLines().join('\n');
      const tail = screen || (ctx.getSession().output ?? '');
      ctx.setAttention({
        level: 'warning',
        message: isWaitingForInput(tail)
          ? `quiet for ${seconds}s - likely waiting for input`
          : `quiet for ${seconds}s - possibly finished`,
      });
    }, seconds * 1000),
  );
}

function isVibeSession(session: ShellSession): boolean {
  return VIBE_PROCESS_RE.test(session.process ?? '');
}

function getVibeSettings(ctx: SessionViewContext & PluginApi): VibePluginSettings {
  return (ctx.pluginSettings as VibePluginSettings | undefined) ?? {};
}

function getVibeState(ctx: SessionViewContext & PluginApi): VibePluginState {
  return (ctx.pluginState as VibePluginState | undefined) ?? {};
}

/**
 * The live counterpart of getVibeState: `ctx.pluginState` is a snapshot
 * from when the ctx was built, so a capture finishing in the same tick as
 * another update reads the session's live pluginState instead.
 */
function getVibeStateLive(ctx: SessionViewContext & PluginApi): VibePluginState {
  const live = (ctx.getSession().pluginState as Record<string, unknown> | undefined)?.[
    vibePlugin.stateKey ?? vibePlugin.id
  ];
  return (live as VibePluginState | undefined) ?? getVibeState(ctx);
}

interface VibeSessionNameMatch {
  name: string;
  end: number;
}

function findVibeSessionName(output: string): VibeSessionNameMatch | undefined {
  // Patterns in priority order — most specific first. Within a group the
  // LAST match wins (most recent hint in the output). Groups are checked in
  // order so a specific hint beats a looser later mention: the two-line
  // resume hint ("vibe -r <name>\n resumes this session · vibe -r lists
  // recent sessions") must resolve to <name>, not 'lists' from the help
  // text on the same line.
  const patterns = [
    /vibe\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)[^\n]*\r?\n[^\n]*?resumes?\s+this\s+session/gi,
    /resume[^\n]*?vibe\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)/gi,
    /(?:session|session id)\s*[:=]\s*([A-Za-z0-9_-]+)/gi,
    /^\s*vibe\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)\s*$/gim,
  ];

  for (const re of patterns) {
    let last: VibeSessionNameMatch | undefined;
    for (const m of output.matchAll(re)) {
      const end = m.index + m[0].length;
      if (!last || end > last.end) last = { name: m[1], end };
    }
    if (last) return last;
  }
  return undefined;
}

export function parseVibeSessionName(output: string, requireComplete = false): string | undefined {
  const match = findVibeSessionName(output);
  if (!match) return undefined;
  if (requireComplete && match.end >= output.length) {
    return undefined;
  }
  return match.name;
}


function isPlausibleVibeName(name: string | undefined): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 3 &&
    /^[A-Za-z0-9_-]+$/.test(name)
  );
}

function rememberedVibeSession(
  ctx: SessionViewContext & PluginApi,
): { name: string; cwd?: string } | undefined {
  const state = getVibeState(ctx);
  if (isPlausibleVibeName(state.vibeSessionName)) {
    return { name: state.vibeSessionName, cwd: state.vibeSessionCwd };
  }
  return undefined;
}

function recordSessionCwd(ctx: SessionViewContext & PluginApi): Promise<void> {
  const fallback = ctx.getSession().cwd;
  if (fallback) {
    ctx.updatePluginState({ vibeSessionCwd: fallback });
  }
  return ctx.getCwd().then((cwd) => {
    if (cwd) ctx.updatePluginState({ vibeSessionCwd: cwd });
  });
}

function vibeResumeCommand(remembered: { name: string; cwd?: string }): string {
  const resume = `vibe -r ${remembered.name}`;
  if (remembered.cwd) {
    return `cd ${shellQuote(remembered.cwd)} && ${resume}`;
  }
  return resume;
}

/**
 * Publish the just-exited vibe conversation as this agent's last session
 * (app-level pluginData — see agentResume.ts). Named records only: vibe has
 * no "continue latest" line (bare `vibe -r` lists recent sessions), so a
 * vibe exit without a captured name leaves no resumable last session.
 */
function rememberVibeLast(
  ctx: SessionViewContext & PluginApi,
  remembered: { name: string; cwd?: string } | undefined,
): void {
  if (!remembered) return;
  const cwd = remembered.cwd ?? getVibeStateLive(ctx).vibeSessionCwd ?? ctx.getSession().cwd;
  rememberLastAgentSession(ctx, 'vibe', {
    name: remembered.name,
    cwd,
    command: vibeResumeCommand({ name: remembered.name, cwd }),
  });
}

function parseVibeCommand(command: string): { name: string; cwd?: string } | undefined {
  const trimmed = command.trim();
  const nameMatch = trimmed.match(/(?:^|[;&|]\s*|&&\s*)vibe\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)/);
  if (!nameMatch) return undefined;
  const name = nameMatch[1];
  const quoted = /cd\s+(['"])(.*?)\1(?:\s*&&|\s*;|\s*$)/.exec(trimmed);
  const unquoted = /cd\s+([^\s&;|]+)(?:\s*&&|\s*;|\s*$)/.exec(trimmed);
  const cwd = quoted ? quoted[2] : unquoted ? unquoted[1] : undefined;
  return { name, cwd };
}

function VibeTasks({ ctx }: { ctx: SessionViewContext & PluginApi }): ReactNode {
  const tasks = getVibeState(ctx).tasks ?? [];
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

/** Render a compact indicator in the session row when name requires attention */
function VibeRow({ ctx }: { ctx: SessionViewContext & PluginApi }): ReactNode {
  const session = ctx.getSession();
  if (!sessionNameRequiresAttention(session.name)) return null;
  return (
    <span className="text-[10px] text-[var(--red)]" data-tip="Session name indicates action required">
      !
    </span>
  );
}

export const vibePlugin: SessionViewPlugin = {
  id: 'vibe',
  title: 'vibe',
  logo: 'Bot',
  version: '0.1.0',
  stateKey: 'vibe',
  settingsKey: 'vibe',
  // Opt-in like the other agent plugins — users set `vibe.enabled: true`.
  defaultEnabled: false,
  processPattern: VIBE_PROCESS_RE,
  handlesProgress: true,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume vibe sessions',
      description:
        "Run 'vibe -r <session>' when a session that previously ran vibe is reopened.",
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
    {
      key: 'resumeButton',
      label: 'Show resume button',
      description:
        "Show a 'Resume vibe session' button in the session panel while the " +
        'last vibe session can be resumed (the session context menu offers it regardless).',
      type: 'boolean',
      default: true,
    },
  ],
  commands: [
    {
      name: 'axn-vibe-resume',
      run: (ctx) => {
        const remembered = rememberedVibeSession(ctx);
        if (!remembered) {
          axnLog('warn', 'vibe-resume', 'no remembered vibe session');
          return `echo "axn-vibe-resume: no remembered vibe session"`;
        }
        ctx.updatePluginState({
          vibeSessionName: remembered.name,
          vibeSessionCwd: remembered.cwd,
        });
        const cmd = vibeResumeCommand(remembered);
        axnLog('info', 'vibe-resume', `resuming session: ${cmd}`);
        return cmd;
      },
    },
  ],
  // "Resume vibe session '<name>'" — the shared last-session capability;
  // offered on idle sessions once a vibe conversation was captured.
  sessionMenuItems: (ctx) => agentResumeMenuItem(ctx, 'vibe'),
  sessionFields: [
    {
      id: 'attention',
      label: 'Vibe attention marker',
      kind: 'inline',
      zone: 'title',
      value: (ctx) => <VibeRow ctx={ctx} />,
      tip: (ctx) =>
        sessionNameRequiresAttention(ctx.getSession().name)
          ? `!: session name indicates action required`
          : null,
    },
    {
      id: 'panel',
      label: 'Vibe',
      kind: 'block',
      zone: 'selected',
      value: (ctx) => (
        <>
          {agentResumePanel(ctx, 'vibe')}
          <VibeTasks ctx={ctx} />
        </>
      ),
    },
  ],
  pendingRestore: (ctx) => {
    if (!getVibeSettings(ctx).restoreSession) return undefined;
    const remembered = rememberedVibeSession(ctx);
    return remembered ? `vibe -r '${remembered.name}'` : undefined;
  },

  onProcessEnd: (ctx) => {
    const state = getVibeState(ctx);
    clearIdleTimer(ctx.session.id);
    watchedOutput.delete(ctx.session.id);
    ctx.updatePluginState({ vibeOutputStart: undefined, attention: undefined });
    void recordSessionCwd(ctx);
    // A vibe exit the plugin did not drive (/quit, a manual Ctrl-C) prints
    // its resume hint before the foreground poll catches up — take it from
    // a bounded tail so the last-session record sees it too.
    const tail = (ctx.getSession().output ?? '').slice(-16_384);
    const tailName = parseVibeSessionName(tail, true);
    if (tailName && tailName !== state.vibeSessionName) {
      ctx.updatePluginState({ vibeSessionName: tailName });
    }
    // Publish the just-exited conversation as this agent's last session —
    // named records only (rememberVibeLast drops nameless exits); the tail
    // scan's fresh name wins over an older remembered one.
    rememberVibeLast(ctx, (tailName ? { name: tailName } : undefined) ?? rememberedVibeSession(ctx));
    const hasTasks = (state.tasks ?? []).length > 0;
    const hasSessionProgress =
      (ctx.session.tasks ?? []).length > 0 || (ctx.session.progress ?? 0) > 0;
    if (hasTasks || hasSessionProgress) {
      axnLog('debug', 'vibe', 'vibe process ended; clearing task list and progress');
      if (hasTasks) ctx.updatePluginState({ tasks: [] });
      if (hasSessionProgress) {
        ctx.updateSession(ctx.session.id, { tasks: [], progress: 0 });
      }
    }
    // Terminal badge as the done signal — 'completed' persists, mid-run
    // exits fall back to idle (same convention as codex/antigravity).
    const live = ctx.getSession();
    const status = live.status ?? 'idle';
    if (status !== 'completed' && status !== 'idle') {
      ctx.updateSession(live.id, { status: 'idle' });
    }
  },

  onOutput: (ctx, text) => {
    const output = ctx.getSession().output ?? '';
    const state = getVibeState(ctx);
    const patch: Partial<VibePluginState> = {};
    const live = ctx.getSession();
    const isActive = isVibeSession(live);

    if (isActive && !state.vibeWasActive) {
      patch.vibeOutputStart = Math.max(0, output.length - text.length);
      patch.vibeWasActive = true;
    } else if (!isActive && state.vibeWasActive) {
      patch.vibeWasActive = false;
    }

    if (isActive) {
      armIdleTimer(ctx);
      if (state.attention) patch.attention = undefined;
    }

    // Check if session name requires attention
    const currentName = live.name;
    const nameRequiresAttention = sessionNameRequiresAttention(currentName);
    const prevName = state.previousSessionName;
    const nameChanged = currentName !== prevName;

    if (nameChanged) {
      patch.previousSessionName = currentName;
      if (nameRequiresAttention) {
        // Set attention when session name indicates action is needed
        ctx.setAttention({ level: 'warning', message: `session name: ${currentName}` });
        ctx.setBanner({
          level: 'warning',
          message: `Session needs attention: ${currentName}`,
        });
        axnLog('info', 'vibe', `session ${live.id}: name changed to "${currentName}" - setting attention`);
      } else if (state.attention && prevName && sessionNameRequiresAttention(prevName)) {
        // Clear attention if name no longer requires it
        patch.attention = undefined;
        ctx.setBanner(null);
      }
    }

    const capture = exitCaptures.get(ctx.session.id);
    if (capture) {
      capture.output = (capture.output + text).slice(-16_384);
      const name = parseVibeSessionName(capture.output, true);
      if (name) capture.finish(name);
    }

    const pendingRestore = pendingRestores.get(ctx.session.id);
    if (pendingRestore) {
      pendingRestore.recent = (pendingRestore.recent + text).slice(-8_192);
      if (RESTORE_FAILED_RE.test(pendingRestore.recent)) {
        finishRestore(ctx, 'gone');
      } else if (isActive) {
        finishRestore(ctx, 'ok');
      }
    }

    const markerFound = TASK_UPDATE_MARKER.test(text);
    if (markerFound) {
      taskParsePending.set(ctx.session.id, TASK_PARSE_CHUNKS);
    }
    const pending = taskParsePending.get(ctx.session.id) ?? 0;
    if (pending > 0) {
      taskParsePending.set(ctx.session.id, pending - 1);
      const tasks = parseVibeTasks(output);
      const structuredTasks = parseVibeStructuredTasks(output);
      const finalTasks = structuredTasks.length > 0 ? structuredTasks : tasks;

      axnLog('debug', 'vibe', `parsed ${finalTasks.length} tasks from output`);
      if (vibeTasksKey(finalTasks) !== vibeTasksKey(state.tasks ?? [])) {
        axnLog('debug', 'vibe', `task list changed: ${JSON.stringify(finalTasks)}`);
        patch.tasks = finalTasks;
      }
      const simple = toTasks(finalTasks);
      const { progress, status } = computeTaskState(finalTasks);
      // A parsed task list owns the lifecycle badge while vibe runs —
      // blocked/running/completed; an empty list means idle.
      const nextStatus = status ?? 'idle';
      if (
        tasksKey(simple) !== tasksKey(ctx.session.tasks ?? []) ||
        progress !== (ctx.session.progress ?? 0) ||
        nextStatus !== (ctx.session.status ?? 'idle')
      ) {
        axnLog('debug', 'vibe', `updating session progress: ${progress}% status=${nextStatus}`);
        ctx.updateSession(ctx.session.id, { tasks: simple, progress, status: nextStatus });
      }
    }

    if (Object.keys(patch).length > 0) {
      ctx.updatePluginState(patch);
    }
  },

  onCommand: (ctx, command) => {
    // A submitted command starts new shell work — a terminal badge left by a
    // finished agent run no longer applies.
    const status = ctx.getSession().status;
    if (status === 'completed' || status === 'blocked') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    if (command.trim() === '/exit' && isVibeSession(ctx.getSession())) {
      beginExitCapture(ctx);
      return;
    }
    const fromCommand = parseVibeCommand(command);
    if (fromCommand) {
      exitCaptures.get(ctx.session.id)?.finish();
      const patch: Partial<VibePluginState> = { vibeSessionName: undefined };
      if (fromCommand.cwd) {
        patch.vibeSessionCwd = fromCommand.cwd;
      } else {
        void recordSessionCwd(ctx);
      }
      ctx.updatePluginState(patch);
      axnLog('debug', 'vibe', `session ${ctx.session.id}: launch command invalidated previous capture`);
    }
  },

  onClose: async (ctx) => {
    clearIdleTimer(ctx.session.id);
    watchedOutput.delete(ctx.session.id);
    cancelPendingRestore(ctx.session.id);
    const pending = exitCaptures.get(ctx.session.id);
    if (pending) {
      await pending.done;
      await recordSessionCwd(ctx);
      rememberVibeLast(ctx, rememberedVibeSession(ctx));
      return;
    }
    const live = ctx.getSession();
    if (!isVibeSession(live)) {
      const state = getVibeState(ctx).vibeSessionName;
      if (state) {
        axnLog('warn', 'vibe-close', `session ${ctx.session.id} has remembered '${state}' but no vibe process detected; not interrupting`);
      }
      return;
    }

    const capture = beginExitCapture(ctx);
    await ctx.writeToSession('\x03');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (isVibeSession(ctx.getSession())) {
      await ctx.writeToSession('\x03');
    }
    await capture.done;
    await recordSessionCwd(ctx);
    // A capture that ended nameless leaves nothing resumable for vibe —
    // rememberVibeLast drops nameless exits.
    rememberVibeLast(ctx, rememberedVibeSession(ctx));
  },

  onSessionOpen: (ctx) => {
    exitCaptures.get(ctx.session.id)?.finish();
    clearIdleTimer(ctx.session.id);
    cancelPendingRestore(ctx.session.id);
    const state = getVibeState(ctx);
    if ((state.tasks ?? []).length > 0) {
      ctx.updatePluginState({ tasks: [] });
    }
    if (state.attention) {
      ctx.updatePluginState({ attention: undefined });
    }
    if ((ctx.session.tasks ?? []).length > 0 || (ctx.session.progress ?? 0) > 0) {
      ctx.updateSession(ctx.session.id, { tasks: [], progress: 0 });
    }
    if ((ctx.getSession().status ?? 'idle') !== 'idle') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    if (state.vibeOutputStart !== undefined) {
      ctx.updatePluginState({ vibeOutputStart: undefined });
    }
    if (state.banner) {
      ctx.setBanner(null);
    }
    // Reset session name tracking on open
    if (state.previousSessionName) {
      ctx.updatePluginState({ previousSessionName: undefined });
    }

    const settings = getVibeSettings(ctx);
    const { restoreSession } = settings;
    const remembered = rememberedVibeSession(ctx);
    axnLog(
      'debug',
      'vibe-restore',
      `pluginSettings=${JSON.stringify(settings)} session=${ctx.session.id} remembered=${remembered ? `${remembered.name}@${remembered.cwd ?? '?'}` : 'none'}`,
    );
    if (!restoreSession) {
      if (remembered) {
        axnLog('debug', 'vibe-restore', `restore-session is disabled; not restoring '${remembered.name}' for session ${ctx.session.id}`);
      }
      ctx.setRestoring(null);
      return;
    }
    if (!remembered) {
      ctx.setRestoring(null);
      return;
    }

    const cmd = vibeResumeCommand(remembered);
    axnLog('info', 'vibe-restore', `will restore '${remembered.name}' for session ${ctx.session.id} via: ${cmd}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog(
          'warn',
          'vibe-restore',
          `timed out waiting for shell output on session ${ctx.session.id}; attempting restore anyway`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${cmd}\r`);
        axnLog(
          'info',
          'vibe-restore',
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
          'vibe-restore',
          `failed to write restore command '${cmd}': ${String(e)}`,
        );
        ctx.setRestoring(null);
        ctx.setBanner({
          level: 'error',
          message: `Failed to restore vibe session '${remembered.name}' - could not write to the session.`,
        });
        ctx.setAttention({ level: 'warning', message: 'vibe restore failed' });
      }
    })();
  },
};
