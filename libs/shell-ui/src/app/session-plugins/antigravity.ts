import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { antigravityHookSpec } from './antigravityHooks';
import { registerAgentLauncher } from './agentRegistry';
import { agentResumeMenuItem, rememberLastAgentSession } from './agentResume';
import { promptArg, shellQuote, shellWord } from '../../shellQuote';

interface AntigravityPluginState {
  /** Set once an agy process has been observed in this session. */
  agySeen?: boolean;
  /** Conversation id from agy's exit hint (`agy --conversation <id>`). */
  agyConversationId?: string;
  /** Directory the agy conversation ran in — agy scopes conversations per workspace. */
  agyCwd?: string;
}

interface AntigravityPluginSettings {
  restoreSession?: boolean;
  /** Register axn-term hook entries in ~/.gemini/config/hooks.json. */
  installHooks?: boolean;
}

function isAgyProcess(process: string | undefined): boolean {
  const p = (process ?? '').trim();
  return /(^|\/)(agy|antigravity)(\.exe)?$/i.test(p) || /^(agy|antigravity)\b/i.test(p);
}

function getState(ctx: SessionViewContext & PluginApi): AntigravityPluginState {
  return (ctx.pluginState as AntigravityPluginState | undefined) ?? {};
}

function getSettings(ctx: SessionViewContext & PluginApi): AntigravityPluginSettings {
  return (ctx.pluginSettings as AntigravityPluginSettings | undefined) ?? {};
}

/** `agy -c` continues the most recent conversation in the current workspace. */
const AGY_RESUME_COMMAND = 'agy -c';

// agy prints its exact resume command on exit (`agy --conversation <id>`).
// Output arrives in chunks that can split the line, so the regex runs over
// a rolling tail per session rather than the single chunk.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CONVERSATION_HINT_RE = /\bagy --conversation[ =]([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const OUTPUT_TAIL_CHARS = 16_384;
const outputTails = new Map<string, string>();

export function parseAgyConversationId(output: string): string | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of output.replace(ANSI_RE, '').matchAll(CONVERSATION_HINT_RE)) last = m;
  return last?.[1];
}

function dropOutputTail(sessionId: string): void {
  outputTails.delete(sessionId);
}

/**
 * Resume this session's own conversation when the exit hint was captured;
 * otherwise `agy -c` — the most recent conversation in the directory,
 * which may belong to another session.
 */
function agyResumeCommand(state: AntigravityPluginState, sessionCwd: string | undefined): string {
  const resume = state.agyConversationId
    ? `agy --conversation ${state.agyConversationId}`
    : AGY_RESUME_COMMAND;
  const cwd = state.agyCwd;
  if (cwd && cwd !== sessionCwd) return `cd ${shellQuote(cwd)} && ${resume}`;
  return resume;
}

/**
 * Publish the just-exited agy conversation as this agent's last session
 * (app-level pluginData — see agentResume.ts): the captured id's exact
 * `agy --conversation <id>` line, else `agy -c`. The `cd` prefix is always
 * folded in — the menu resume can run from any session's shell.
 */
function rememberAgyLast(ctx: SessionViewContext & PluginApi): void {
  const state = getState(ctx);
  const cwd = state.agyCwd ?? ctx.getSession().cwd;
  const resume = state.agyConversationId
    ? `agy --conversation ${state.agyConversationId}`
    : AGY_RESUME_COMMAND;
  rememberLastAgentSession(ctx, 'antigravity', {
    name: state.agyConversationId,
    cwd,
    command: cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume,
  });
}

export const antigravityPlugin: SessionViewPlugin = {
  id: 'antigravity',
  title: 'antigravity',
  version: '0.1.0',
  stateKey: 'antigravity',
  settingsKey: 'antigravity',
  // Opt-in: users must set `antigravity.enabled: true` in plugins.yaml.
  defaultEnabled: false,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume Antigravity CLI sessions',
      description:
        "Run 'agy -c' (or the captured 'agy --conversation <id>') when a " +
        'session that previously ran agy is reopened.',
      type: 'boolean',
      default: false,
    },
    {
      key: 'installHooks',
      label: 'Install Antigravity CLI hooks',
      description:
        'Merge an axn-term hook group into ~/.gemini/config/hooks.json for ' +
        'working/done status (existing hooks are preserved; the group is ' +
        'removed again when disabled). agy exposes no permission-request ' +
        'hook event, so needs-you flags are unavailable for this agent.',
      type: 'boolean',
      default: false,
    },
  ],
  // Bound to the agy process.
  processPattern: /^(agy|antigravity)/i,
  // Declarative agent-hook bridge — the host installs the named hook group
  // per installHooks, polls the tty-keyed event file, and releases it when
  // the process ends.
  hookSpec: antigravityHookSpec,

  onProcessEnd: (ctx) => {
    dropOutputTail(ctx.session.id);
    // The host already released the hook bridge + cleared the flag.
    // Terminal badge as the done signal — 'completed' persists, mid-run
    // exits fall back to idle.
    const session = ctx.getSession();
    if ((session.status ?? 'idle') !== 'completed' && (session.status ?? 'idle') !== 'idle') {
      ctx.updateSession(session.id, { status: 'idle' });
    }
    rememberAgyLast(ctx);
  },

  onOutput: (ctx, text) => {
    if (!isAgyProcess(ctx.session.process)) return;
    const state = getState(ctx);
    if (!state.agySeen) {
      ctx.updatePluginState({ agySeen: true, agyCwd: ctx.getSession().cwd });
      axnLog('debug', 'antigravity', 'remembered agy session');
    }
    const tail = (outputTails.get(ctx.session.id) ?? '') + (text ?? '');
    outputTails.set(ctx.session.id, tail.slice(-OUTPUT_TAIL_CHARS));
    const id = parseAgyConversationId(tail.slice(-OUTPUT_TAIL_CHARS));
    if (id && id !== state.agyConversationId) {
      ctx.updatePluginState({ agyConversationId: id });
      axnLog('debug', 'antigravity', `session ${ctx.session.id}: captured conversation id ${id}`);
    }
  },

  commands: [
    {
      // `axn-agy-resume` continues this session's agy conversation.
      name: 'axn-agy-resume',
      run: (ctx) => {
        const line = agyResumeCommand(getState(ctx), ctx.getSession().cwd);
        axnLog('info', 'agy-resume', `resuming agy: ${line}`);
        return line;
      },
    },
  ],

  // "Resume antigravity session" — the shared last-session capability;
  // offered on idle sessions once an agy conversation was captured.
  sessionMenuItems: (ctx) => agentResumeMenuItem(ctx, 'antigravity'),

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

  // agy exits with the session (no graceful-close capture): keep the last
  // record so a different shell can still pick the conversation up.
  onClose: (ctx) => {
    dropOutputTail(ctx.session.id);
    if (getState(ctx).agySeen) rememberAgyLast(ctx);
  },

  onSessionOpen: (ctx) => {
    dropOutputTail(ctx.session.id);
    // Fresh PTY — the host already dropped the hook-bridge runtime and the
    // flag.
    const live = ctx.getSession();
    if ((live.status ?? 'idle') !== 'idle') {
      ctx.updateSession(live.id, { status: 'idle' });
    }
    const { restoreSession } = getSettings(ctx);
    const state = getState(ctx);
    if (!restoreSession || !state.agySeen) return;

    const line = agyResumeCommand(state, live.cwd);
    axnLog('info', 'agy-restore', `will resume agy for session ${ctx.session.id}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog('warn', 'agy-restore', `timed out waiting for shell output on session ${ctx.session.id}; resuming anyway`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${line}\r`);
      } catch (e) {
        axnLog('error', 'agy-restore', `failed to write resume command: ${String(e)}`);
      }
    })();
  },
};

// agy owns its launch semantics: prompts are only read from -p/--print,
// -i/--prompt-interactive or stdin — a positional prompt would be ignored.
// Persona `instructions`/`instructionsFile` fold into the seed prompt.
// Registered under both the binary name and the product name.
const agyLauncher = async (
  spec: { model?: string; args?: string; instructions?: string; instructionsFile?: string },
  prompt: string | undefined,
  tools: { readFile: (path: string, cwd?: string) => Promise<string> },
  cwd: string,
): Promise<string> => {
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  const seed = inst ? inst + (prompt ? `\n\n${prompt}` : '') : prompt;
  const model = spec.model ? ` --model ${shellWord(spec.model)}` : '';
  const args = spec.args ? ` ${spec.args}` : '';
  return `agy${model}${args}${seed ? ` -i ${promptArg(seed)}` : ''}`;
};
registerAgentLauncher('agy', agyLauncher);
registerAgentLauncher('antigravity', agyLauncher);
