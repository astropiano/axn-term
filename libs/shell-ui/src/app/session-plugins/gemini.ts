import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { geminiHookSpec } from './geminiHooks';
import { registerAgentLauncher } from './agentRegistry';
import { agentCommand } from './devWorkflow';

interface GeminiPluginState {
  /** Set once a gemini process has been observed in this session. */
  geminiSeen?: boolean;
}

interface GeminiPluginSettings {
  restoreSession?: boolean;
  /** Register axn-term hook entries in ~/.gemini/settings.json. */
  installHooks?: boolean;
  /**
   * Deliver persona `instructions` to gemini by writing a new `GEMINI.md`
   * into the launch cwd (gemini has no instructions flag — without this
   * they are folded into the first prompt instead). Never overwrites: an
   * existing `GEMINI.md` makes the launch fail with an error.
   */
  writeGeminiMd?: boolean;
}

function isGeminiProcess(process: string | undefined): boolean {
  return /(^|\/)gemini$/i.test((process ?? '').trim()) || /gemini/i.test(process ?? '');
}

function getState(ctx: SessionViewContext & PluginApi): GeminiPluginState {
  return (ctx.pluginState as GeminiPluginState | undefined) ?? {};
}

function getSettings(ctx: SessionViewContext & PluginApi): GeminiPluginSettings {
  return (ctx.pluginSettings as GeminiPluginSettings | undefined) ?? {};
}

// The launcher has no ctx — the plugin's own settings are cached on every
// ctx touch (same pattern as the agents plugin's persona registry).
let writeGeminiMd = false;

function syncSettings(ctx: SessionViewContext & PluginApi): void {
  writeGeminiMd = getSettings(ctx).writeGeminiMd === true;
}

/** `gemini --resume` continues a previous chat (interactive picker). */
const GEMINI_RESUME_COMMAND = 'gemini --resume';

export const geminiPlugin: SessionViewPlugin = {
  id: 'gemini',
  title: 'gemini',
  version: '0.1.0',
  stateKey: 'gemini',
  settingsKey: 'gemini',
  // Opt-in: users must set `gemini.enabled: true` in plugins.yaml.
  defaultEnabled: false,
  settings: [
    {
      key: 'restoreSession',
      label: 'Auto-resume Gemini CLI sessions',
      description:
        "Run 'gemini --resume' when a session that previously ran gemini is reopened.",
      type: 'boolean',
      default: false,
    },
    {
      key: 'installHooks',
      label: 'Install Gemini CLI hooks',
      description:
        'Merge axn-term hook entries into ~/.gemini/settings.json for exact ' +
        'working/waiting status and needs-you notifications (existing hooks ' +
        'are preserved; entries are removed again when disabled).',
      type: 'boolean',
      default: false,
    },
    {
      key: 'writeGeminiMd',
      label: 'Write persona instructions to GEMINI.md',
      description:
        'Deliver agent-persona instructions to gemini by creating a new ' +
        'GEMINI.md in the launch folder (never overwrites — the launch ' +
        'fails when the file already exists). Without it, instructions are ' +
        'folded into the first prompt.',
      type: 'boolean',
      default: false,
    },
  ],
  // Bound to the gemini process.
  processPattern: /^gemini/i,
  // Declarative agent-hook bridge — the host installs hook entries per
  // installHooks, polls the tty-keyed event file, and releases it when the
  // process ends.
  hookSpec: geminiHookSpec,

  onProcessEnd: (ctx) => {
    syncSettings(ctx);
    // The host already released the hook bridge + cleared the flag.
    // Terminal badge as the done signal — 'completed' persists, mid-run
    // exits fall back to idle.
    const session = ctx.getSession();
    if ((session.status ?? 'idle') !== 'completed' && (session.status ?? 'idle') !== 'idle') {
      ctx.updateSession(session.id, { status: 'idle' });
    }
  },

  onOutput: (ctx) => {
    syncSettings(ctx);
    if (!isGeminiProcess(ctx.session.process)) return;
    const state = getState(ctx);
    if (!state.geminiSeen) {
      ctx.updatePluginState({ geminiSeen: true });
      axnLog('debug', 'gemini', 'remembered gemini session');
    }
  },

  commands: [
    {
      // `axn-gemini-resume` continues a previous gemini chat.
      name: 'axn-gemini-resume',
      run: (ctx) => {
        syncSettings(ctx);
        axnLog('info', 'gemini-resume', `resuming gemini: ${GEMINI_RESUME_COMMAND}`);
        return GEMINI_RESUME_COMMAND;
      },
    },
  ],

  // A submitted command starts new shell work — a terminal badge left by a
  // finished agent run no longer applies, and a stale needs-you flag is gone.
  onCommand: (ctx) => {
    syncSettings(ctx);
    const status = ctx.getSession().status;
    if (status === 'completed' || status === 'blocked') {
      ctx.updateSession(ctx.session.id, { status: 'idle' });
    }
    const st = ctx.pluginState as { attention?: unknown } | undefined;
    if (st?.attention) ctx.setAttention(null);
  },

  onSessionOpen: (ctx) => {
    syncSettings(ctx);
    // Fresh PTY — the host already dropped the hook-bridge runtime and the
    // flag.
    const live = ctx.getSession();
    if ((live.status ?? 'idle') !== 'idle') {
      ctx.updateSession(live.id, { status: 'idle' });
    }
    const { restoreSession } = getSettings(ctx);
    if (!restoreSession || !getState(ctx).geminiSeen) return;

    axnLog('info', 'gemini-restore', `will resume gemini for session ${ctx.session.id}`);
    void (async () => {
      const gotOutput = await ctx.waitForSessionOutput(10_000);
      if (!gotOutput) {
        axnLog('warn', 'gemini-restore', `timed out waiting for shell output on session ${ctx.session.id}; resuming anyway`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await ctx.writeToSession(`${GEMINI_RESUME_COMMAND}\r`);
      } catch (e) {
        axnLog('error', 'gemini-restore', `failed to write resume command: ${String(e)}`);
      }
    })();
  },
};

// Gemini owns its launch semantics. It has no instructions flag, so a
// persona's `instructions`/`instructionsFile` either fold into the seed
// prompt, or — with the plugin's own `writeGeminiMd` setting — are written
// to a NEW `GEMINI.md` in the launch cwd (gemini reads it natively). The
// write is create-only: an existing file is user/repo content and aborts
// the launch rather than being merged or replaced.
registerAgentLauncher('gemini', async (spec, prompt, tools, cwd) => {
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  if (!inst) return agentCommand('gemini', spec, prompt);
  if (!writeGeminiMd) {
    return agentCommand('gemini', spec, inst + (prompt ? `\n\n${prompt}` : ''));
  }
  const dir = (cwd || '/').replace(/\/+$/, '') || '/';
  const path = `${dir === '/' ? '' : dir}/GEMINI.md`;
  const exists = tools.statPath
    ? (await tools.statPath(path).catch(() => null)) !== null
    : await tools.readFile(path).then(() => true).catch(() => false);
  if (exists) {
    throw new Error(
      `GEMINI.md already exists in ${dir} — refusing to overwrite (gemini.write-gemini-md)`,
    );
  }
  if (!tools.writeFile) {
    throw new Error('this backend cannot write files — disable gemini.write-gemini-md');
  }
  await tools.writeFile(path, `${inst.trim()}\n`);
  axnLog('info', 'gemini', `wrote persona instructions to ${path}`);
  return agentCommand('gemini', spec, prompt);
});
