import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { codexHookSpec } from './codexHooks';
import { registerAgentLauncher } from './agentRegistry';
import { agentResumeMenuItem, noteAgentTitle, rememberLastAgentSession } from './agentResume';
import { agentResumePanel } from './agentResumePanel';
import { agentCommand } from './devWorkflow';
import { shellQuote, shellWord } from '../../shellQuote';

interface CodexPluginState {
  /** Set once a codex process has been observed in this session. */
  codexSeen?: boolean;
}

interface CodexPluginSettings {
  restoreSession?: boolean;
  /** Register axn-term hook entries in ~/.codex/hooks.json. */
  installHooks?: boolean;
}

function isCodexProcess(process: string | undefined): boolean {
  return /(^|\/)codex$/i.test((process ?? '').trim()) || /codex/i.test(process ?? '');
}

function getState(ctx: SessionViewContext & PluginApi): CodexPluginState {
  return (ctx.pluginState as CodexPluginState | undefined) ?? {};
}

function getSettings(ctx: SessionViewContext & PluginApi): CodexPluginSettings {
  return (ctx.pluginSettings as CodexPluginSettings | undefined) ?? {};
}

/** `codex resume --last` continues the most recent codex conversation. */
const CODEX_RESUME_COMMAND = 'codex resume --last';

/**
 * Publish the just-exited codex conversation as this agent's last session
 * (app-level pluginData — see agentResume.ts). Codex prints no session id
 * on exit, so the record carries the generic `codex resume --last` —
 * which targets exactly the conversation that just ended.
 */
function rememberCodexLast(ctx: SessionViewContext & PluginApi): void {
  const cwd = ctx.getSession().cwd;
  rememberLastAgentSession(ctx, 'codex', {
    cwd,
    command: cwd ? `cd ${shellQuote(cwd)} && ${CODEX_RESUME_COMMAND}` : CODEX_RESUME_COMMAND,
  });
}

export const codexPlugin: SessionViewPlugin = {
  id: 'codex',
  title: 'codex',
  logo: 'Bot',
  version: '0.1.0',
  stateKey: 'codex',
  settingsKey: 'codex',
  // Opt-in: users must set `codex.enabled: true` in plugins.yaml.
  defaultEnabled: false,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume Codex sessions',
      description:
        "Run 'codex resume --last' when a session that previously ran codex is reopened.",
      type: 'boolean',
      default: false,
    },
    {
      key: 'installHooks',
      label: 'Install Codex hooks',
      description:
        'Merge axn-term hook entries into ~/.codex/hooks.json for exact ' +
        'working/waiting status and needs-you notifications (existing hooks ' +
        'are preserved; entries are removed again when disabled). Afterwards ' +
        'approve the new hooks once inside codex via /hooks (trust review).',
      type: 'boolean',
      default: false,
    },
    {
      key: 'resumeButton',
      label: 'Show resume button',
      description:
        "Show a 'Resume codex session' button in the session panel while the " +
        'last codex session can be resumed (the session context menu offers it regardless).',
      type: 'boolean',
      default: true,
    },
  ],
  // Bound to the codex process.
  processPattern: /^codex/i,
  // Declarative agent-hook bridge — the host installs hook entries per
  // installHooks, polls the tty-keyed event file, and releases it when the
  // process ends.
  hookSpec: codexHookSpec,

  onProcessEnd: (ctx) => {
    // The host already released the hook bridge + cleared the flag.
    // Terminal badge as the done signal — 'completed' persists, mid-run
    // exits fall back to idle.
    const session = ctx.getSession();
    if ((session.status ?? 'idle') !== 'completed' && (session.status ?? 'idle') !== 'idle') {
      ctx.updateSession(session.id, { status: 'idle' });
    }
    rememberCodexLast(ctx);
  },

  onOutput: (ctx, text) => {
    if (!isCodexProcess(ctx.session.process)) return;
    noteAgentTitle(ctx, 'codex', text);
    const state = getState(ctx);
    if (!state.codexSeen) {
      ctx.updatePluginState({ codexSeen: true });
      axnLog('debug', 'codex', 'remembered codex session');
    }
  },

  commands: [
    {
      // `axn-codex-resume` continues the last codex conversation.
      name: 'axn-codex-resume',
      run: () => {
        axnLog('info', 'codex-resume', `resuming codex: ${CODEX_RESUME_COMMAND}`);
        return CODEX_RESUME_COMMAND;
      },
    },
  ],

  // "Resume codex session" — the shared last-session capability; offered on
  // idle sessions once a codex conversation was captured.
  sessionMenuItems: (ctx) => agentResumeMenuItem(ctx, 'codex'),
  sessionFields: [
    {
      id: 'resume',
      label: 'Resume Codex',
      kind: 'block',
      zone: 'selected',
      value: (ctx) => agentResumePanel(ctx, 'codex'),
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

  // Codex exits with the session (no graceful-close capture): keep the last
  // record so a different shell can still pick the conversation up.
  onClose: (ctx) => {
    if (getState(ctx).codexSeen) rememberCodexLast(ctx);
  },

  onSessionOpen: (ctx) => {
    // Fresh PTY — the host already dropped the hook-bridge runtime and the
    // flag.
    const live = ctx.getSession();
    if ((live.status ?? 'idle') !== 'idle') {
      ctx.updateSession(live.id, { status: 'idle' });
    }
    const { restoreSession } = getSettings(ctx);
    if (!restoreSession || !getState(ctx).codexSeen) return;

    axnLog('info', 'codex-restore', `will resume codex for session ${ctx.session.id}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog('warn', 'codex-restore', `timed out waiting for shell output on session ${ctx.session.id}; resuming anyway`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${CODEX_RESUME_COMMAND}\r`);
      } catch (e) {
        axnLog('error', 'codex-restore', `failed to write resume command: ${String(e)}`);
      }
    })();
  },
};

// Codex owns its launch semantics: `instructions`/`instructionsFile` go
// through its config-override channel — `-c developer_instructions="…"`
// (a TOML string; the `key=value` word is shell-quoted as one arg). A file
// is resolved by us since codex has no instructions-file flag; it reads
// AGENTS.md natively for repo context either way.
registerAgentLauncher('codex', async (spec, prompt, tools, cwd) => {
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  return agentCommand(
    'codex',
    spec,
    prompt,
    inst ? ` -c ${shellWord(`developer_instructions=${JSON.stringify(inst)}`)}` : '',
  );
});
