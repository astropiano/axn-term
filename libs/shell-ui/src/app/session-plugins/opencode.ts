import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { registerAgentLauncher } from './agentRegistry';
import {
  agentResumeMenuItem,
  lastAgentSession,
  noteAgentTitle,
  rememberLastAgentSession,
} from './agentResume';
import { agentResumePanel } from './agentResumePanel';
import { agentCommand } from './devWorkflow';
import { shellQuote, shellWord } from '../../shellQuote';

interface OpencodePluginState {
  /** Set once an opencode process has been observed in this session. */
  opencodeSeen?: boolean;
  /** Conversation id captured from the exit hint (`opencode -s ses_…`). */
  opencodeSessionId?: string;
  /**
   * When the currently observed opencode process went foreground —
   * `session list` is project-global, so a captured id is only trusted when
   * its `updated` timestamp falls inside this run's window.
   */
  opencodeStartedAt?: number;
  /**
   * OpenCode was foreground when the session last went away — like devin's
   * devinActive: required for auto-restore, so a shell that once ran
   * opencode but sat at its prompt on close reopens as a plain shell.
   */
  opencodeActive?: boolean;
}

interface OpencodePluginSettings {
  restoreSession?: boolean;
}

function isOpencodeProcess(process: string | undefined): boolean {
  return /(^|\/)opencode$/i.test((process ?? '').trim()) || /opencode/i.test(process ?? '');
}

/** Live-state read — `ctx.pluginState` can be a stale snapshot mid-async work. */
function getState(ctx: SessionViewContext & PluginApi): OpencodePluginState {
  const live = (ctx.getSession().pluginState as Record<string, unknown> | undefined)?.[
    opencodePlugin.stateKey ?? opencodePlugin.id
  ];
  return (live as OpencodePluginState | undefined) ?? (ctx.pluginState as OpencodePluginState | undefined) ?? {};
}

function getSettings(ctx: SessionViewContext & PluginApi): OpencodePluginSettings {
  return (ctx.pluginSettings as OpencodePluginSettings | undefined) ?? {};
}

/** `opencode -c` continues the most recent opencode session in the TUI. */
const OPENCODE_RESUME_COMMAND = 'opencode -c';

/** Strip ANSI escapes before pattern matching terminal output. */
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]/g;

// onProcessEnd/onClose scan this much of the retained output tail for the
// resume hint the TUI prints on exit (`… opencode -s ses_…`).
const EXIT_TAIL_CHARS = 16_384;

/**
 * The opencode TUI prints its resume hint on exit, e.g.
 * `Continue the session with: opencode -s ses_abc123`. Match any
 * `opencode -s`/`--session <ses_id>` spelled out in output.
 */
const RESUME_HINT_RE =
  /opencode\s+(?:-s|--session)[=\s]+(ses_[A-Za-z0-9_-]+)/gi;

/** Last ses_ id hinted in the output tail, if any. */
export function findOpencodeSessionId(output: string): string | undefined {
  let last: string | undefined;
  for (const m of output.replace(ANSI_RE, '').matchAll(RESUME_HINT_RE)) {
    last = m[1];
  }
  return last;
}

/**
 * Resolve the just-ended conversation id. `opencode session list --format
 * json -n 1` (run in the session's project dir; the list is newest-first) is
 * the reliable source — current TUI builds print no exit hint; the tail
 * scan still catches builds that do.
 */
/**
 * Resolve the just-ended conversation id. `opencode session list --format
 * json -n 1` (run in the session's project dir; newest first) is queried —
 * but the list is project-global, so the top `ses_` id is only adopted when
 * its `updated` timestamp falls inside this run's window (clock skew
 * margin). Otherwise — or on exec failure — the output-tail hint applies.
 */
async function resolveOpencodeSessionId(
  ctx: SessionViewContext & PluginApi,
  tail: string,
): Promise<string | undefined> {
  const since = getState(ctx).opencodeStartedAt ?? 0;
  try {
    const out = await ctx.exec('opencode session list --format json -n 1');
    const top = (JSON.parse(out) as Array<{ id?: string; updated?: number }>)[0];
    // Only adopt it when the conversation was touched during this run —
    // otherwise the newest session belongs to another opencode instance.
    if (top?.id && (top.updated ?? 0) >= since - 5_000) return top.id;
  } catch {
    // Backend without exec (web) or the query failed — tail scan wins.
  }
  return findOpencodeSessionId(tail);
}

/**
 * The resume line the plugin records: `opencode -s <ses_id>` when a
 * conversation id was captured, else `opencode -c` — continue the latest
 * session in the directory.
 */
function opencodeResumeLine(state: OpencodePluginState, cwd?: string): string {
  const resume = state.opencodeSessionId
    ? `opencode -s ${state.opencodeSessionId}`
    : OPENCODE_RESUME_COMMAND;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

/**
 * Publish the just-exited opencode conversation as this agent's last session
 * (app-level pluginData — see agentResume.ts). A fresh tail-scanned id wins
 * over a stale remembered one, like devin's fresh-name precedence.
 */
function rememberOpencodeLast(
  ctx: SessionViewContext & PluginApi,
  tailId?: string,
): void {
  const cwd = ctx.getSession().cwd;
  const id = tailId ?? getState(ctx).opencodeSessionId;
  rememberLastAgentSession(ctx, 'opencode', {
    name: id,
    cwd,
    command: opencodeResumeLine({ opencodeSessionId: id }, cwd),
  });
}

/** A typed `opencode …` launch starts a new conversation (unless it resumes one). */
function isFreshOpencodeLaunch(words: string[]): boolean {
  return (
    words[0] === 'opencode' &&
    !words.some((w) => ['-c', '--continue', '-s', '--session', '-r', '--resume'].includes(w))
  );
}

export const opencodePlugin: SessionViewPlugin = {
  id: 'opencode',
  title: 'opencode',
  logo: 'Bot',
  version: '0.1.0',
  stateKey: 'opencode',
  settingsKey: 'opencode',
  // Opt-in: users must set `opencode.enabled: true` in plugins.yaml.
  defaultEnabled: false,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume OpenCode sessions',
      description:
        "Run 'opencode -s <session>' when a session that previously ran opencode is reopened.",
      type: 'boolean',
      default: false,
    },
    {
      key: 'resumeButton',
      label: 'Show resume button',
      description:
        "Show a 'Resume opencode session' button in the session panel while the " +
        'last opencode session can be resumed (the session context menu offers it regardless).',
      type: 'boolean',
      default: true,
    },
  ],
  // Bound to the opencode process.
  processPattern: /^opencode/i,

  onProcessEnd: (ctx) => {
    const session = ctx.getSession();
    if ((session.status ?? 'idle') !== 'completed' && (session.status ?? 'idle') !== 'idle') {
      ctx.updateSession(session.id, { status: 'idle' });
    }
    // Resolve the ended conversation id — session list first, then the
    // output-tail hint; the fresh id wins over a stale remembered one.
    ctx.updatePluginState({ opencodeActive: false });
    const tail = session.output?.slice(-EXIT_TAIL_CHARS) ?? '';
    void (async () => {
      const id = await resolveOpencodeSessionId(ctx, tail);
      if (id && id !== getState(ctx).opencodeSessionId) {
        ctx.updatePluginState({ opencodeSessionId: id });
      }
      rememberOpencodeLast(ctx, id);
    })();
  },

  onOutput: (ctx, text) => {
    if (!isOpencodeProcess(ctx.session.process)) return;
    noteAgentTitle(ctx, 'opencode', text);
    const state = getState(ctx);
    if (!state.opencodeSeen || !state.opencodeActive) {
      // A fresh foreground run — stamp its start so session-list captures
      // only adopt ids touched inside this window.
      ctx.updatePluginState({
        opencodeSeen: true,
        opencodeActive: true,
        opencodeStartedAt: Date.now(),
      });
      if (!state.opencodeSeen) axnLog('debug', 'opencode', 'remembered opencode session');
    }
    // A `opencode -s ses_…` launch echoes its own session id — adopt it as
    // the running conversation too (manual `opencode -s` behaves like a
    // resumed exit-hint).
    const tail = ctx.session.output?.slice(-EXIT_TAIL_CHARS) ?? '';
    const id = findOpencodeSessionId(tail);
    if (id && id !== state.opencodeSessionId) {
      ctx.updatePluginState({ opencodeSessionId: id });
    }
  },

  onCommand: (ctx, command) => {
    const status = ctx.getSession().status;
    if (status === 'completed' || status === 'blocked') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    const st = ctx.pluginState as { attention?: unknown } | undefined;
    if (st?.attention) ctx.setAttention(null);

    const words = command.trim().split(/\s+/);
    if (isFreshOpencodeLaunch(words)) {
      // A fresh `opencode` starts a new conversation — the old resume id no
      // longer applies (mirrors devin's invalidate-on-manual-resume).
      ctx.updatePluginState({
        opencodeSessionId: undefined,
        opencodeActive: true,
        opencodeStartedAt: Date.now(),
      });
    } else if (words[0] === 'opencode') {
      const sIdx = words.findIndex((w) => w === '-s' || w === '--session');
      if (sIdx >= 0 && words[sIdx + 1]) {
        // Manual `opencode -s <id>` — adopt it as the running conversation.
        ctx.updatePluginState({
          opencodeSessionId: words[sIdx + 1],
          opencodeActive: true,
          opencodeStartedAt: Date.now(),
        });
      }
    }
  },

  commands: [
    {
      // `axn-opencode-resume` continues the last opencode conversation.
      name: 'axn-opencode-resume',
      run: (ctx) => {
        const line = opencodeResumeLine(getState(ctx));
        axnLog('info', 'opencode-resume', `resuming opencode: ${line}`);
        return line;
      },
    },
  ],

  // "Resume opencode session" — the shared last-session capability; offered
  // on idle sessions once an opencode conversation was captured.
  sessionMenuItems: (ctx) => agentResumeMenuItem(ctx, 'opencode'),
  sessionFields: [
    {
      id: 'resume',
      label: 'Resume opencode',
      kind: 'block',
      zone: 'selected',
      value: (ctx) => agentResumePanel(ctx, 'opencode', opencodePlugin.logo),
    },
  ],
  // OpenCode exits with the session (no graceful-close capture): keep the
  // last record so a different shell can still pick the conversation up.
  onClose: (ctx) => {
    const state = getState(ctx);
    if (!state.opencodeSeen) return;
    const tail = ctx.getSession().output?.slice(-EXIT_TAIL_CHARS) ?? '';
    void (async () => {
      // exec usually fails during teardown — then the tail scan applies.
      rememberOpencodeLast(ctx, await resolveOpencodeSessionId(ctx, tail));
    })();
  },

  onSessionOpen: (ctx) => {
    const live = ctx.getSession();
    if ((live.status ?? 'idle') !== 'idle') {
      ctx.updateSession(live.id, { status: 'idle' });
    }
    const { restoreSession } = getSettings(ctx);
    const state = getState(ctx);
    if (!restoreSession || !state.opencodeSeen || !state.opencodeActive) return;

    // If the app persisted a newer last record, prefer its line (e.g. the
    // named `opencode -s` captured on exit).
    const last = lastAgentSession(ctx);
    const line = last?.command ?? opencodeResumeLine(state);
    axnLog('info', 'opencode-restore', `will resume opencode for session ${ctx.session.id}: ${line}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog('warn', 'opencode-restore', `timed out waiting for shell output on session ${ctx.session.id}; resuming anyway`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${line}\r`);
      } catch (e) {
        axnLog('error', 'opencode-restore', `failed to write resume command: ${String(e)}`);
      }
    })();
  },
};

// OpenCode owns its launch semantics: the TUI takes the seed prompt via
// `--prompt` (not a positional arg); `instructions`/`instructionsFile` are
// folded into it since opencode has no dedicated flag — it reads AGENTS.md
// natively for repo context either way.
registerAgentLauncher('opencode', async (spec, prompt, tools, cwd) => {
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  const seed = [inst, prompt].filter(Boolean).join('\n\n');
  return agentCommand(
    'opencode',
    spec,
    undefined,
    seed ? ` --prompt ${shellWord(seed)}` : '',
  );
});
