import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionAttention, ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { claudePlugin, parseClaudeTodos } from './claude';
import { claudeEventFile } from './claudeHooks';
import {
  dispatchClose,
  dispatchOutput,
  dispatchProcessEnd,
  dispatchSessionOpen,
} from './agentTestkit';

type Ctx = SessionViewContext & PluginApi;

const HOME = '/home/tester';
const TTY = '/dev/ttys099';

interface Harness {
  ctx: Ctx;
  session: ShellSession;
  store: Record<string, unknown>;
  updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }>;
  attentionCalls: Array<SessionAttention | null>;
  files: Map<string, string>;
  setScreen: (lines: string[]) => void;
}

function makeHarness(
  overrides: Partial<ShellSession> = {},
  pluginState: Record<string, unknown> = {},
  pluginSettings: Record<string, unknown> = {},
): Harness {
  const session: ShellSession = {
    id: `claude-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    process: 'claude',
    ...overrides,
  };
  const store: Record<string, unknown> = { claude: pluginState };
  const files = new Map<string, string>();
  const updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }> = [];
  const attentionCalls: Array<SessionAttention | null> = [];
  let screen: string[] = [];
  const ctx = {
    session,
    updateSession: (sessionId: string, patch: Partial<ShellSession>) => {
      updateSessionCalls.push({ sessionId, patch });
    },
    writeToSession: async () => {},
    updatePluginState: (patch: unknown) => {
      store.claude = { ...(store.claude as Record<string, unknown>), ...(patch as Record<string, unknown>) };
    },
    get pluginState() {
      return store.claude;
    },
    pluginSettings,
    getSession: () => session,
    getSessionCount: () => 1,
    exec: async (command: string) => (command.includes('$HOME') ? HOME : ''),
    waitForSessionOutput: async () => true,
    getCwd: async () => null,
    getTty: async () => TTY,
    openBrowser: () => {},
    isProgressHandled: () => false,
    getScreenLines: () => screen,
    setAttention: (a: SessionAttention | null) => {
      attentionCalls.push(a);
      store.claude = { ...(store.claude as Record<string, unknown>), attention: a };
    },
    setBanner: () => {},
    setRestoring: () => {},
    openTab: () => {},
    openSubShell: () => {},
    readFile: async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    writeFile: async (path: string, contents: string) => {
      files.set(path, contents);
    },
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    appState: undefined,
    updateAppState: () => {},
  } as unknown as Ctx;
  // Live pluginState view on the session — the plugin reads flags off
  // getSession().pluginState inside its poll loop.
  Object.defineProperty(session, 'pluginState', { get: () => store });
  return {
    ctx,
    session,
    store,
    updateSessionCalls,
    attentionCalls,
    files,
    setScreen: (l) => { screen = l; },
  };
}

const TODOS_RUNNING = [
  '⏺ Update Todos',
  '  ⎿  ☒ explore',
  '     ▶ implement',
  '     ☐ write tests',
];
const TODOS_DONE = [
  '⏺ Update Todos',
  '  ⎿  ☒ explore',
  '     ☒ implement',
  '     ☒ write tests',
];

function scanNow(h: Harness) {
  dispatchOutput(claudePlugin, h.ctx, 'chunk');
  vi.advanceTimersByTime(200);
}

describe('parseClaudeTodos', () => {
  it('parses an Update Todos block from the screen', () => {
    const screen = [
      '$ claude',
      '⏺ Update Todos',
      '  ⎿  ☒ Research the codebase',
      '     ☐ Implement the feature',
      '     ▶ Write tests',
      '',
    ];
    expect(parseClaudeTodos(screen)).toEqual([
      { id: 'claude-0', title: 'Research the codebase', status: 'completed' },
      { id: 'claude-1', title: 'Implement the feature', status: 'pending' },
      { id: 'claude-2', title: 'Write tests', status: 'running' },
    ]);
  });

  it('uses the bottom-most block when the screen shows several', () => {
    const screen = [
      '⎿ Update Todos',
      '  ☒ old task one',
      '  ☒ old task two',
      'some other output',
      'Update Todos',
      '  ☐ fresh task',
      '  ◐ running task',
    ];
    const tasks = parseClaudeTodos(screen);
    expect(tasks?.map((t) => t.title)).toEqual(['fresh task', 'running task']);
  });

  it('rejects a single stray symbol line without a marker', () => {
    expect(parseClaudeTodos(['nothing here', '  ☒ lonely', 'more'])).toBeUndefined();
  });

  it('accepts a lone task line that follows a marker', () => {
    const screen = ['Update Todos', '  ☐ only task'];
    expect(parseClaudeTodos(screen)).toEqual([
      { id: 'claude-0', title: 'only task', status: 'pending' },
    ]);
  });

  it('returns undefined on a screen without tasks', () => {
    expect(parseClaudeTodos(['$ ls', 'file.txt', '$ '])).toBeUndefined();
    expect(parseClaudeTodos([])).toBeUndefined();
  });
});

describe('claude session status badge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves hook-confirmed completion when the last visible task list is unfinished', () => {
    const h = makeHarness({
      status: 'completed', tasks: [{ id: 'claude-0', title: 'stale visible task', done: false }], progress: 0,
    }, { wroteTasks: true });
    dispatchProcessEnd(claudePlugin, h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id, patch: { tasks: [], progress: 0, status: 'completed' },
    });
  });

  it('writes running status while tasks are open', () => {
    const h = makeHarness();
    h.setScreen(TODOS_RUNNING);
    scanNow(h);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: expect.objectContaining({ status: 'running' }),
    });
  });

  it('writes completed status when all tasks are done', () => {
    const h = makeHarness();
    h.setScreen(TODOS_DONE);
    scanNow(h);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: expect.objectContaining({ status: 'completed' }),
    });
  });

  it('keeps a completed badge when claude exits with all tasks done', () => {
    const h = makeHarness(
      {
        tasks: [
          { id: 'claude-0', title: 'a', done: true },
          { id: 'claude-1', title: 'b', done: true },
        ],
        progress: 100,
        status: 'running',
      },
      { wroteTasks: true },
    );
    dispatchProcessEnd(claudePlugin, h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { tasks: [], progress: 0, status: 'completed' },
    });
  });

  it('falls back to idle when claude exits mid-run', () => {
    const h = makeHarness(
      {
        tasks: [
          { id: 'claude-0', title: 'a', done: true },
          { id: 'claude-1', title: 'b', done: false },
        ],
        progress: 50,
        status: 'running',
      },
      { wroteTasks: true },
    );
    dispatchProcessEnd(claudePlugin, h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { tasks: [], progress: 0, status: 'idle' },
    });
  });

  it('clears a terminal badge when a new command is submitted', () => {
    const h = makeHarness({ status: 'completed' });
    claudePlugin.onCommand?.(h.ctx, 'ls -la');
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'idle' },
    });
  });

  it('resets stale task state on session open', () => {
    const h = makeHarness(
      {
        tasks: [{ id: 'claude-0', title: 'a', done: true }],
        progress: 100,
        status: 'completed',
      },
      { wroteTasks: true },
    );
    dispatchSessionOpen(claudePlugin, h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { tasks: [], progress: 0, status: 'idle' },
    });
    expect((h.store.claude as Record<string, unknown>).wroteTasks).toBe(false);
  });
});

describe('claude hook bridge', () => {
  const EVENT_FILE = claudeEventFile(HOME, TTY);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Trigger detection, then let tty/home resolution + the first poll land. */
  async function startClaude(h: Harness) {
    dispatchOutput(claudePlugin, h.ctx, 'chunk');
    await vi.advanceTimersByTimeAsync(10);
  }

  function writeEvent(h: Harness, ev: Record<string, unknown>) {
    h.files.set(EVENT_FILE, JSON.stringify(ev));
  }

  it('maps PermissionRequest to blocked + critical attention', async () => {
    const h = makeHarness();
    writeEvent(h, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'blocked' },
    });
    expect(h.attentionCalls).toContainEqual(
      expect.objectContaining({ level: 'critical', message: 'claude needs permission: Bash' }),
    );
    dispatchClose(claudePlugin, h.ctx);
  });

  it('clears attention on UserPromptSubmit and sets running', async () => {
    const h = makeHarness();
    writeEvent(h, { hook_event_name: 'PermissionRequest' });
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(1600);
    writeEvent(h, { hook_event_name: 'UserPromptSubmit' });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'running' },
    });
    expect(h.attentionCalls.at(-1)).toBeNull();
    dispatchClose(claudePlugin, h.ctx);
  });

  it('maps Stop to completed', async () => {
    const h = makeHarness();
    writeEvent(h, { hook_event_name: 'Stop' });
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'completed' },
    });
    dispatchClose(claudePlugin, h.ctx);
  });

  it('screen-scanned status does not override hook state, but tasks still update', async () => {
    const h = makeHarness();
    writeEvent(h, { hook_event_name: 'PermissionRequest' });
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(1600);
    h.setScreen(TODOS_RUNNING);
    scanNow(h);
    // No later 'running' status patch — the hook stays authoritative.
    const statusPatches = h.updateSessionCalls
      .map((c) => c.patch.status)
      .filter((s) => s !== undefined);
    expect(statusPatches).toEqual(['blocked']);
    // …while the todo content still publishes.
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: expect.objectContaining({ tasks: expect.any(Array) }),
    });
    dispatchClose(claudePlugin, h.ctx);
  });

  it('ignores a missing event file and duplicate events', async () => {
    const h = makeHarness();
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(3200);
    expect(h.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);
    // Same event content re-polled → applied once.
    writeEvent(h, { hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(1600);
    const statusCalls = () => h.updateSessionCalls.filter((c) => c.patch.status);
    const count = statusCalls().length;
    await vi.advanceTimersByTimeAsync(3200);
    expect(statusCalls().length).toBe(count);
    dispatchClose(claudePlugin, h.ctx);
  });

  it('stops polling on process end', async () => {
    const h = makeHarness();
    await startClaude(h);
    await vi.advanceTimersByTimeAsync(1600);
    dispatchProcessEnd(claudePlugin, h.ctx);
    writeEvent(h, { hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(3200);
    expect(h.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);
    dispatchClose(claudePlugin, h.ctx);
  });

  it('installs hook script + settings entries when enabled', async () => {
    const h = makeHarness({}, {}, { installHooks: true });
    await startClaude(h);
    await vi.waitFor(() => {
      expect(h.files.has(`${HOME}/.claude/settings.json`)).toBe(true);
    });
    const settings = JSON.parse(h.files.get(`${HOME}/.claude/settings.json`)!);
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toBe(
      `'${HOME}/.axn-term/agent-hook.sh' claude 'PermissionRequest'`,
    );
    expect(settings.hooks.Stop).toBeDefined();
    expect(h.files.get(`${HOME}/.axn-term/agent-hook.sh`)).toContain('#!/bin/sh');
    dispatchClose(claudePlugin, h.ctx);
  });

  it('removes hook entries when disabled', async () => {
    const h = makeHarness();
    h.files.set(
      `${HOME}/.claude/settings.json`,
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] },
            {
              matcher: '',
              hooks: [{ type: 'command', command: `${HOME}/.axn-term/claude-hook.sh` }],
            },
          ],
        },
      }),
    );
    await startClaude(h);
    await vi.waitFor(() => {
      const raw = h.files.get(`${HOME}/.claude/settings.json`);
      expect(raw).toBeDefined();
      const settings = JSON.parse(raw!);
      expect(settings.hooks.Stop).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] },
      ]);
    });
    dispatchClose(claudePlugin, h.ctx);
  });
});
