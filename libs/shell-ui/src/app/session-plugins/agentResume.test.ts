import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { MenuScope, SessionViewContext, PluginApi } from './plugin';

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
  stripAgentTitlePrefix,
} from './agentResume';
import { agentResumePanel } from './agentResumePanel';
import type { ReactElement } from 'react';
import { devinPlugin } from './devinTasks';
import { claudePlugin } from './claude';
import { codexPlugin } from './codex';

import { antigravityPlugin } from './antigravity';

import { opencodePlugin } from './opencode';
import { vibePlugin } from './vibe';

type Ctx = SessionViewContext & PluginApi;

/** The single-session scope SessionPanel hands `sessionMenuItems`. */
const scopeOf = (ctx: Ctx): MenuScope => ({
  targets: [ctx],
  sessions: [ctx.session],
  workspaces: [],
});

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
    pluginSettings?: Record<string, unknown>;
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
    pluginSettings: opts.pluginSettings ?? {},
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

const lastOf = (h: Harness) =>
  ((h.ctx.pluginState as { last?: unknown } | undefined)?.last ?? h.appData.last) as unknown;

beforeEach(() => clearAgentLasts());

describe('lastAgentSession', () => {
  it('returns undefined without a record', () => {
    const h = makeCtx('devin');
    expect(lastAgentSession(h.ctx)).toBeUndefined();
  });

  it('rejects malformed records', () => {
    for (const last of ['x', 5, [], { name: 'n' }, { command: '' }]) {
      const h = makeCtx('devin', {}, { pluginState: { last } });
      expect(lastAgentSession(h.ctx)).toBeUndefined();
    }
  });

  it('normalizes a valid record', () => {
    const h = makeCtx('devin', {}, {
      pluginState: { last: { name: 'grey-party', cwd: '/repo', command: 'devin -r grey-party', at: 7 } },
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
      pluginState: { last: { name: 'n-1', command: 'devin -r n-1', at: 42 } },
    });
    rememberLastAgentSession(h.ctx, 'devin', { name: 'n-1', command: 'devin -r n-1' });
    expect(h.appStateCalls).toHaveLength(0);
    expect((lastOf(h) as { at: number }).at).toBe(42);
  });

  it('writes a changed record stamped in the same millisecond as the previous one', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const h = makeCtx('devin');
      rememberLastAgentSession(h.ctx, 'devin', { name: 'n-1', command: 'devin -r n-1' });
      rememberLastAgentSession(h.ctx, 'devin', { name: 'n-2', command: 'devin -r n-2' });
      expect(lastOf(h)).toMatchObject({ name: 'n-2', command: 'devin -r n-2', at: 1_000 });
    } finally {
      now.mockRestore();
    }
  });

  it('never reads a legacy app-level record and retires it on capture', () => {
    const h = makeCtx('devin', {}, {
      appData: { last: { name: 'n-1', cwd: '/repo', command: 'devin -r n-1', at: 42 } },
    });
    // The legacy record is invisible — no resume row, not the current record.
    expect(lastAgentSession(h.ctx)).toBeUndefined();
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
    rememberLastAgentSession(h.ctx, 'devin', { name: 'n-2', command: 'devin -r n-2' });
    expect(lastOf(h)).toEqual({ name: 'n-2', command: 'devin -r n-2', at: expect.any(Number) });
    expect(h.appData.last).toBeUndefined();
  });

  it('clears only a matching name', () => {
    const h = makeCtx('devin', {}, {
      pluginState: { last: { name: 'n-1', command: 'devin -r n-1', at: 1 } },
    });
    forgetLastAgentSession(h.ctx, 'devin', 'other');
    expect(lastOf(h)).toBeTruthy();
    forgetLastAgentSession(h.ctx, 'devin', 'n-1');
    expect(lastOf(h)).toBeUndefined();
  });
});

describe('agentResumeMenuItem', () => {
  const last = { name: 'grey-party', cwd: '/repo', command: `cd '/repo' && devin -r grey-party`, at: 1 };

  it('is hidden while a process runs in the session', () => {
    const h = makeCtx('devin', { process: 'devin' }, { pluginState: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('is hidden while an agent is marked via terminal title', () => {
    const h = makeCtx('devin', { agentInput: 'devin' }, { pluginState: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('is hidden without a recorded last session', () => {
    const h = makeCtx('devin');
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('offers "Resume <agent> session \'<name>\'" on an idle session', () => {
    const h = makeCtx('devin', {}, { pluginState: { last } });
    const items = agentResumeMenuItem(h.ctx, 'devin');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Resume devin session 'grey-party'");
  });

  it('drops the name for nameless records', () => {
    const h = makeCtx('codex', {}, {
      pluginState: { last: { cwd: '/repo', command: 'codex resume --last', at: 1 } },
    });
    expect(agentResumeMenuItem(h.ctx, 'codex')[0].label).toBe('Resume codex session');
  });

  it('is scoped per session — another session\'s newest record does not leak', () => {
    // Two sessions: devin's record in s1, claude's in s2 — each shows its own.
    const devin = makeCtx('devin', { id: 's1' }, { pluginState: { last: { ...last, at: 10 } } });
    const claude = makeCtx('claude', { id: 's2' }, {
      pluginState: { last: { name: 'abc', cwd: '/repo', command: 'claude --resume abc', at: 20 } },
    });
    agentResumeMenuItem(claude.ctx, 'claude');
    expect(agentResumeMenuItem(devin.ctx, 'devin')).toHaveLength(1);
    expect(agentResumeMenuItem(claude.ctx, 'claude')).toHaveLength(1);
  });

  it('shows only the session\'s newest record — one resume row per menu', () => {
    // Same session ran devin then claude — only the newest (claude) shows.
    const devin = makeCtx('devin', { id: 's1' }, { pluginState: { last: { ...last, at: 10 } } });
    const claude = makeCtx('claude', { id: 's1' }, {
      pluginState: { last: { name: 'abc', cwd: '/repo', command: 'claude --resume abc', at: 20 } },
    });
    agentResumeMenuItem(claude.ctx, 'claude');
    expect(agentResumeMenuItem(devin.ctx, 'devin')).toEqual([]);
    expect(agentResumeMenuItem(claude.ctx, 'claude')).toHaveLength(1);
  });

  it('is hidden when the session sits in a different folder', () => {
    const h = makeCtx('devin', { cwd: '/elsewhere' }, { pluginState: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('is hidden when the record has no cwd to verify', () => {
    const h = makeCtx('devin', {}, {
      pluginState: { last: { name: 'grey-party', command: 'devin -r grey-party', at: 1 } },
    });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toEqual([]);
  });

  it('matches the folder ignoring a trailing slash', () => {
    const h = makeCtx('devin', { cwd: '/repo/' }, { pluginState: { last } });
    expect(agentResumeMenuItem(h.ctx, 'devin')).toHaveLength(1);
  });

  it('writes the stored command into the PTY', async () => {
    const h = makeCtx('devin', {}, { pluginState: { last } });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual([`${last.command}\r`]));
  });

  it('dispatches the line through runCommand like a typed command', async () => {
    const runCommand = vi.fn(() => undefined as string | false | undefined);
    const h = makeCtx('devin', {}, { pluginState: { last }, runCommand });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual([`${last.command}\r`]));
    expect(runCommand).toHaveBeenCalledWith(last.command);
  });

  it('writes a replacement line when dispatch resolves one', async () => {
    const h = makeCtx('devin', {}, {
      pluginState: { last },
      runCommand: () => 'devin -r resolved',
    });
    agentResumeMenuItem(h.ctx, 'devin')[0].onClick();
    await vi.waitFor(() => expect(h.writes).toEqual(['devin -r resolved\r']));
  });

  it('writes nothing when dispatch swallows the line', async () => {
    const h = makeCtx('devin', {}, { pluginState: { last }, runCommand: () => false });
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
      pluginState: { last: { name: 'grey-party', cwd: '/repo', command: 'devin -r grey-party', at: 1 } },
    });
    const items = devinPlugin.sessionMenuItems?.(h.ctx, scopeOf(h.ctx)) ?? [];
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

describe('stripAgentTitlePrefix', () => {
  it('strips the agent id and its aliases before a separator', () => {
    expect(stripAgentTitlePrefix('devin: grey-party', 'devin')).toBe('grey-party');
    expect(stripAgentTitlePrefix('Claude — research the codebase', 'claude')).toBe(
      'research the codebase',
    );
    expect(stripAgentTitlePrefix('agy - fix bug', 'antigravity')).toBe('fix bug');
  });

  it('leaves unrelated titles alone', () => {
    expect(stripAgentTitlePrefix('My feature', 'claude')).toBe('My feature');
    expect(stripAgentTitlePrefix('notadev: x', 'devin')).toBe('notadev: x');
  });
});

describe('session title capture', () => {
  it('records the process-reported title with the agent prefix stripped', () => {
    const h = makeCtx('devin', { autoName: 'devin: grey-party' });
    rememberLastAgentSession(h.ctx, 'devin', {
      name: 'grey-party',
      command: 'devin -r grey-party',
    });
    expect(lastOf(h)).toMatchObject({ title: 'grey-party' });
  });

  it('falls back to the custom session name', () => {
    const h = makeCtx('claude', { name: 'My feature', customName: 'My feature' });
    rememberLastAgentSession(h.ctx, 'claude', {
      name: 'abc-1',
      command: 'claude --resume abc-1',
    });
    expect(lastOf(h)).toMatchObject({ title: 'My feature' });
  });

  it('keeps an explicit caller-provided title', () => {
    const h = makeCtx('devin', { autoName: 'devin: other' });
    rememberLastAgentSession(h.ctx, 'devin', { command: 'devin -c', title: 'kept' });
    expect(lastOf(h)).toMatchObject({ title: 'kept' });
  });

  it('does not persist the generic default session name', () => {
    const h = makeCtx('devin', { name: 'session' });
    rememberLastAgentSession(h.ctx, 'devin', { command: 'devin -c' });
    expect((lastOf(h) as { title?: string }).title).toBeUndefined();
  });

  it('a changed title re-stamps the record', () => {
    const h = makeCtx('claude', { autoName: 'first title' }, {
      pluginState: { last: { name: 'abc', command: 'claude --resume abc', at: 5 } },
    });
    rememberLastAgentSession(h.ctx, 'claude', { name: 'abc', command: 'claude --resume abc' });
    expect(lastOf(h)).toMatchObject({ title: 'first title', at: expect.any(Number) });
    expect((lastOf(h) as { at: number }).at).toBeGreaterThan(5);
  });
});

describe('agentResumeMenuItem labels', () => {
  it('prefers the display title over the raw session id', () => {
    const h = makeCtx('claude', {}, {
      pluginState: {
        last: {
          name: 'abc-123',
          title: 'Research the codebase',
          cwd: '/repo',
          command: 'claude --resume abc-123',
          at: 1,
        },
      },
    });
    expect(agentResumeMenuItem(h.ctx, 'claude')[0].label).toBe(
      "Resume claude session 'Research the codebase'",
    );
  });
});

describe('agentResumePanel', () => {
  const last = {
    name: 'grey-party',
    title: 'Grey Party',
    cwd: '/repo',
    command: `cd '/repo' && devin -r grey-party`,
    at: 1,
  };

  it('renders a resume button on an idle session', () => {
    const h = makeCtx('devin', {}, { pluginState: { last } });
    const el = agentResumePanel(h.ctx, 'devin') as ReactElement | null;
    expect(el).not.toBeNull();
  });

  it('is hidden while a process runs in the session', () => {
    const h = makeCtx('devin', { process: 'zsh' }, { pluginState: { last } });
    expect(agentResumePanel(h.ctx, 'devin')).toBeNull();
  });

  it('is hidden when the resume-button setting is off', () => {
    const h = makeCtx('devin', {}, {
      pluginState: { last },
      pluginSettings: { resumeButton: false },
    });
    expect(agentResumePanel(h.ctx, 'devin')).toBeNull();
    // The context-menu row is offered regardless.
    expect(agentResumeMenuItem(h.ctx, 'devin')).toHaveLength(1);
  });

  it('is hidden when another agent owns the session\'s newest record', () => {
    const h = makeCtx('devin', { id: 's1' }, { pluginState: { last } });
    const claude = makeCtx('claude', { id: 's1' });
    rememberLastAgentSession(claude.ctx, 'claude', { command: 'claude -c' });
    expect(agentResumePanel(h.ctx, 'devin')).toBeNull();
  });

  it('still renders when another session has a newer record', () => {
    const h = makeCtx('devin', { id: 's1' }, { pluginState: { last } });
    const claude = makeCtx('claude', { id: 's2' });
    rememberLastAgentSession(claude.ctx, 'claude', { command: 'claude -c' });
    expect(agentResumePanel(h.ctx, 'devin')).not.toBeNull();
  });

  it('clicking the button writes the stored command into the PTY', async () => {
    const h = makeCtx('devin', {}, { pluginState: { last } });
    const el = agentResumePanel(h.ctx, 'devin') as ReactElement<{ children: ReactElement }>;
    const button = el.props.children as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    await vi.waitFor(() => expect(h.writes).toEqual([`${last.command}\r`]));
  });
});
