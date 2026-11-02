import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import {
  agentResumeMenuItem,
  clearAgentLasts,
  forgetLastAgentSession,
  lastAgentSession,
  rememberLastAgentSession,
} from './agentResume';
import { devinPlugin } from './devinTasks';
import { claudePlugin } from './claude';
import { codexPlugin } from './codex';

import { antigravityPlugin } from './antigravity';

import { opencodePlugin } from './opencode';
import { vibePlugin } from './vibe';

type Ctx = SessionViewContext & PluginApi;

interface Harness {
  ctx: Ctx;
  session: ShellSession;
  pluginStateStore: Record<string, unknown>;
  appData: Record<string, unknown>;
  appStateCalls: Array<Record<string, unknown>>;
  writes: string[];
  runCommandCalls: string[];
}

/**
 * Minimal ctx for the last-session feature: per-plugin pluginState store,
 * app-level appData behind appState/updateAppState, recorded PTY writes and
 * an optional runCommand dispatch stub.
 */
function makeCtx(
  stateKey: string,
  overrides: Partial<ShellSession> = {},
  opts: {
    pluginState?: Record<string, unknown>;
    appData?: Record<string, unknown>;
    runCommand?: (line: string) => string | false | undefined | Promise<string | false | undefined>;
  } = {},
): Harness {
  const session: ShellSession = {
    id: `${stateKey}-s1`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    cwd: '/repo',
    ...overrides,
  };
  const pluginStateStore: Record<string, unknown> = { [stateKey]: opts.pluginState ?? {} };
  const appData: Record<string, unknown> = { ...(opts.appData ?? {}) };
  const appStateCalls: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const runCommandCalls: string[] = [];
  const ctx = {
    session,
    updateSession: () => {},
    writeToSession: async (data: string) => {
      writes.push(data);
    },
    updatePluginState: (patch: unknown) => {
      pluginStateStore[stateKey] = {
        ...(pluginStateStore[stateKey] as Record<string, unknown>),
        ...(patch as Record<string, unknown>),
      };
    },
    get pluginState() {
      return pluginStateStore[stateKey];
    },
    pluginSettings: {},
    getSession: () => session,
    getSessionCount: () => 1,
    exec: async () => '',
    waitForSessionOutput: async () => true,
    getCwd: async () => session.cwd ?? null,
    getTty: async () => null,
    openBrowser: () => {},
    isProgressHandled: () => false,
    getScreenLines: () => [],
    setAttention: () => {},
    setBanner: () => {},
    setRestoring: () => {},
    openTab: () => {},
    openSubShell: () => undefined,
    openSession: () => {},
    getWorkspace: () => undefined,
    getWorkspaces: () => [],
    ...(opts.runCommand
      ? {
          runCommand: async (line: string) => {
            runCommandCalls.push(line);
            return opts.runCommand!(line);
          },
        }
      : {}),
    readFile: async () => '',
    writeFile: async () => {},
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    get appState() {
      return appData;
    },
    updateAppState: (patch: Record<string, unknown>) => {
      appStateCalls.push(patch);
      Object.assign(appData, patch);
    },
  } as unknown as Ctx;
  // Live pluginState view — the plugins' *StateLive helpers read it.
  Object.defineProperty(session, 'pluginState', { get: () => pluginStateStore });
  return { ctx, session, pluginStateStore, appData, appStateCalls, writes, runCommandCalls };
}

const lastOf = (h: Harness) => h.appData.last;

beforeEach(() => clearAgentLasts());

describe('lastAgentSession', () => {
  it('returns undefined without a record', () => {
    const h = makeCtx('devin');
    expect(lastAgentSession(h.ctx)).toBeUndefined();
  });

  it('rejects malformed records', () => {
    for (const last of ['x', 5, [], { name: 'n' }, { command: '' }]) {
      const h = makeCtx('devin', {}, { appData: { last } });
      expect(lastAgentSession(h.ctx)).toBeUndefined();
    }
  });

  it('normalizes a valid record', () => {
    const h = makeCtx('devin', {}, {
      appData: { last: { name: 'grey-party', cwd: '/repo', command: 'devin -r grey-party', at: 7 } },
    });
    expect(lastAgentSession(h.ctx)).toEqual({
      name: 'grey-party',
      cwd: '/repo',
      command: 'devin -r grey-party',
      at: 7,
    });
  });
});

describe('rememberLastAgentSession / forgetLastAgentSession', () => {
  it('writes the stamped record into appData', () => {
    const h = makeCtx('devin');
    rememberLastAgentSession(h.ctx, 'devin', { name: 'n-1', command: 'devin -r n-1' });
    expect(lastOf(h)).toEqual({ name: 'n-1', command: 'devin -r n-1', at: expect.any(Number) });
  });

  it('skips an unchanged record and keeps its stamp', () => {
    const h = makeCtx('devin', {}, {
      appData: { last: { name: 'n-1', command: 'devin -r n-1', at: 42 } },
    });
    rememberLastAgentSession(h.ctx, 'devin', { name: 'n-1', command: 'devin -r n-1' });
    expect(h.appStateCalls).toHaveLength(0);
    expect((lastOf(h) as { at: number }).at).toBe(42);
  });

  it('clears only a matching name', () => {
    const h = makeCtx('devin', {}, {
      appData: { last: { name: 'n-1', command: 'devin -r n-1', at: 1 } },
    });
    forgetLastAgentSession(h.ctx, 'devin', 'other');
    expect(lastOf(h)).toBeTruthy();
    forgetLastAgentSession(h.ctx, 'devin', 'n-1');
    expect(lastOf(h)).toBeUndefined();
  });
});

describe('agentResumeMenuItem', () => {
  const last = { name: 'grey-party', command: `cd '/repo' && devin -r grey-party`, at: 1 };

  it('is hidden while a process runs in the session', () => {
    const h = makeCtx('devin', { process: 'devin' }, { appData: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('is hidden while an agent is marked via terminal title', () => {
    const h = makeCtx('devin', { agentInput: 'devin' }, { appData: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('is hidden without a recorded last session', () => {
    const h = makeCtx('devin');
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('offers "Resume <agent> session \'<name>\'" on an idle session', () => {
    const h = makeCtx('devin', {}, { appData: { last } });
    const items = agentResumeMenuItem(h.ctx, 'devin');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Resume devin session 'grey-party'");
  });

  it('drops the name for nameless records', () => {
    const h = makeCtx('codex', {}, {
      appData: { last: { command: 'codex resume --last', at: 1 } },
    });
    expect(agentResumeMenuItem(h.ctx, 'codex')[0].label).toBe('Resume codex session');
  });

  it('shows only the globally newest record — one resume row per menu', () => {
    // Simulate persisted records: devin exited earlier, claude last.
    const devin = makeCtx('devin', {}, { appData: { last: { ...last, at: 10 } } });
    const claude = makeCtx('claude', {}, {
      appData: { last: { name: 'abc', command: 'claude --resume abc', at: 20 } },
    });
    // devin's row is built before claude registers its newer record — still
    // hidden once claude's newer one has been seen (second pass mirrors the
    // steady state; within one menu build registration precedes comparison).
    agentResumeMenuItem(claude.ctx, 'claude');
    expect(agentResumeMenuItem(devin.ctx, 'devin')).toEqual([]);
    expect(agentResumeMenuItem(claude.ctx, 'claude')).toHaveLength(1);
  });

  it('a fresh record wins over an older one from another agent', () => {
    const devin = makeCtx('devin', {}, { appData: { last: { ...last, at: 10 } } });
    const claude = makeCtx('claude');
    rememberLastAgentSession(claude.ctx, 'claude', { command: 'claude -c' });
    agentResumeMenuItem(claude.ctx, 'claude');
    expect(agentResumeMenuItem(devin.ctx, 'devin')).toEqual([]);
  });

  it('writes the stored command into the PTY', async () => {
    const h = makeCtx('devin', {}, { appData: { last } });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual([`${last.command}\r`]));
  });

  it('dispatches the line through runCommand like a typed command', async () => {
    const runCommand = vi.fn(() => undefined as string | false | undefined);
    const h = makeCtx('devin', {}, { appData: { last }, runCommand });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual([`${last.command}\r`]));
    expect(runCommand).toHaveBeenCalledWith(last.command);
  });

  it('writes a replacement line when dispatch resolves one', async () => {
    const h = makeCtx('devin', {}, {
      appData: { last },
      runCommand: () => 'devin -r resolved',
    });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual(['devin -r resolved\r']));
  });

  it('writes nothing when dispatch swallows the line', async () => {
    const h = makeCtx('devin', {}, { appData: { last }, runCommand: () => false });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.writes).toEqual([]);
  });
});

describe('devin plugin', () => {
  it('records the exit-hint name as the last session on process end', () => {
    const output = 'Session ended.\nResume this session with `devin -r grey-party`\n$ ';
    const h = makeCtx('devin', { output }, { pluginState: { devinSessionCwd: '/repo' } });
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'grey-party',
      cwd: '/repo',
      command: `cd '/repo' && devin -r grey-party`,
      at: expect.any(Number),
    });
  });

  it('falls back to devin -c when no name was captured', () => {
    const h = makeCtx('devin', { output: 'no hint here' });
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && devin -c`,
      at: expect.any(Number),
    });
  });

  it('prefers the remembered name over the -c fallback', () => {
    const h = makeCtx('devin', { output: 'no hint' }, {
      pluginState: { devinSessionName: 'older-name', devinSessionCwd: '/repo' },
    });
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'older-name',
      cwd: '/repo',
      command: `cd '/repo' && devin -r older-name`,
      at: expect.any(Number),
    });
  });

  it('contributes the resume row to the session menu on an idle session', () => {
    const h = makeCtx('devin', {}, {
      appData: { last: { name: 'grey-party', command: 'devin -r grey-party', at: 1 } },
    });
    const items = devinPlugin.sessionMenuItems?.(h.ctx) ?? [];
    expect(items.map((i) => i.label)).toEqual(["Resume devin session 'grey-party'"]);
  });
});

describe('claude plugin', () => {
  const hint = 'Resume this session with:\nclaude --resume abc-123\n';

  it('records the exit-hint id as the last session on process end', () => {
    const h = makeCtx('claude', { output: hint }, { pluginState: { claudeCwd: '/repo' } });
    claudePlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'abc-123',
      cwd: '/repo',
      command: `cd '/repo' && claude --resume abc-123`,
      at: expect.any(Number),
    });
  });

  it('keeps the worktree in the recorded resume line', () => {
    const h = makeCtx('claude', {
      output: 'Resume this session with:\nclaude --worktree "feat-x" --resume abc-1\n',
    });
    claudePlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'abc-1',
      cwd: '/repo',
      command: `cd '/repo' && claude --worktree 'feat-x' --resume abc-1`,
      at: expect.any(Number),
    });
  });

  it('falls back to claude -c when no hint was captured', () => {
    const h = makeCtx('claude', { output: 'no hint' });
    claudePlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && claude -c`,
      at: expect.any(Number),
    });
  });
});

describe('codex / antigravity plugins', () => {
  it('codex records the generic --last resume on process end', () => {
    const h = makeCtx('codex');
    codexPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && codex resume --last`,
      at: expect.any(Number),
    });
  });

  it('antigravity records `agy -c` on process end without a captured id', () => {
    const h = makeCtx('antigravity');
    antigravityPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && agy -c`,
      at: expect.any(Number),
    });
  });

  it('opencode records the generic -c resume on process end', async () => {
    const h = makeCtx('opencode');
    opencodePlugin.onProcessEnd?.(h.ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && opencode -c`,
      at: expect.any(Number),
    });
  });

  it('opencode records the hinted ses_ id on process end', async () => {
    const output = 'done.\nContinue the session with: opencode -s ses_abc123\n$ ';
    const h = makeCtx('opencode', { output });
    opencodePlugin.onProcessEnd?.(h.ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOf(h)).toEqual({
      name: 'ses_abc123',
      cwd: '/repo',
      command: `cd '/repo' && opencode -s ses_abc123`,
      at: expect.any(Number),
    });
  });

  it('opencode session-list capture only adopts ids touched in this run', async () => {
    const h = makeCtx('opencode', {}, {
      pluginState: { opencodeSeen: true, opencodeStartedAt: Date.now() },
    });
    // stale "newest" session from another opencode instance → falls back
    (h.ctx as { exec: (c: string) => Promise<string> }).exec = async () =>
      JSON.stringify([{ id: 'ses_other99', updated: Date.now() - 3_600_000 }]);
    opencodePlugin.onProcessEnd?.(h.ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOf(h)).toEqual({
      name: undefined,
      cwd: '/repo',
      command: `cd '/repo' && opencode -c`,
      at: expect.any(Number),
    });

    // fresh one → adopted as the named record
    (h.ctx as { exec: (c: string) => Promise<string> }).exec = async () =>
      JSON.stringify([{ id: 'ses_fresh42', updated: Date.now() }]);
    opencodePlugin.onProcessEnd?.(h.ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOf(h)).toMatchObject({
      name: 'ses_fresh42',
      command: `cd '/repo' && opencode -s ses_fresh42`,
    });
  });

  it('opencode adopts a manually launched -s id and clears it on fresh launch', () => {
    const h = makeCtx('opencode');
    opencodePlugin.onCommand?.(h.ctx, 'opencode -s ses_manual9');
    expect(h.ctx.pluginState).toMatchObject({ opencodeSessionId: 'ses_manual9' });
    opencodePlugin.onCommand?.(h.ctx, 'opencode');
    expect(h.ctx.pluginState).toMatchObject({ opencodeSessionId: undefined });
  });

  it('antigravity records the captured --conversation id on process end', () => {
    const h = makeCtx('antigravity', {}, { pluginState: { agyConversationId: 'abc-123' } });
    antigravityPlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'abc-123',
      cwd: '/repo',
      command: `cd '/repo' && agy --conversation abc-123`,
      at: expect.any(Number),
    });
  });
});

describe('vibe plugin', () => {
  it('records the exit-hint name as the last session on process end', () => {
    const output = 'Session ended.\nResume this session with `vibe -r blue-otter`\n$ ';
    const h = makeCtx('vibe', { output }, { pluginState: { vibeSessionCwd: '/repo' } });
    vibePlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toEqual({
      name: 'blue-otter',
      cwd: '/repo',
      command: `cd '/repo' && vibe -r blue-otter`,
      at: expect.any(Number),
    });
  });

  it('records nothing when no vibe session name is known', () => {
    const h = makeCtx('vibe', { output: 'no hint' });
    vibePlugin.onProcessEnd?.(h.ctx);
    expect(lastOf(h)).toBeUndefined();
  });
});
