import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';
import { vibePlugin, parseVibeTasks, parseVibeStructuredTasks, parseVibeSessionName, VIBE_PROCESS_RE } from './vibe';

interface MockSession extends ShellSession {
  /** The shell's real cwd as reported by the backend (get_session_cwd). */
  realCwd: string | null;
}

type Ctx = SessionViewContext & PluginApi;

interface Harness {
  ctx: Ctx;
  writes: string[];
  pluginStateStore: Record<string, unknown>;
  updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }>;
  /** Every label passed to setRestoring (null = overlay cleared). */
  restoringCalls: Array<string | null>;
}

/**
 * Mirrors App.tsx's buildPluginApi: pluginState is read from a per-session
 * store (like session.pluginState[stateKey]) and updatePluginState merges into
 * that session's store only.
 */
function makeCtx(
  session: MockSession,
  pluginStateStore: Record<string, unknown>,
  settings: Record<string, unknown> = { restoreSession: true },
  sessionCount = 1,
): Harness {
  const writes: string[] = [];
  const restoringCalls: Array<string | null> = [];
  const updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }> = [];
  // Only the API surface the vibe plugin touches.
  const ctx = {
    session,
    updateSession: (sessionId, patch) => {
      updateSessionCalls.push({ sessionId, patch });
    },
    writeToSession: async (data) => {
      writes.push(data);
    },
    updatePluginState: (patch) => {
      const current = (pluginStateStore.vibe ?? {}) as Record<string, unknown>;
      pluginStateStore.vibe = { ...current, ...(patch as Record<string, unknown>) };
    },
    getSession: () => session,
    getSessionCount: () => sessionCount,
    get pluginState() {
      return pluginStateStore.vibe;
    },
    pluginSettings: settings,
    exec: async () => '',
    waitForSessionOutput: async () => true,
    getCwd: async () => session.realCwd,
    getTty: async () => null,
    openBrowser: () => {},
    openTab: () => {},
    openSubShell: () => undefined,
    openSession: () => {},
    readFile: async () => { throw new Error('ENOENT'); },
    writeFile: async () => {},
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    isProgressHandled: () => false,
    getScreenLines: () => [],
    setAttention: (attention) => {
      const current = (pluginStateStore.vibe ?? {}) as Record<string, unknown>;
      pluginStateStore.vibe = { ...current, attention };
    },
    setBanner: (banner) => {
      const current = (pluginStateStore.vibe ?? {}) as Record<string, unknown>;
      pluginStateStore.vibe = { ...current, banner };
    },
    setRestoring: (label) => {
      restoringCalls.push(label);
    },
    appState: undefined,
    updateAppState: () => {},
  } satisfies Partial<Ctx> as unknown as Ctx;
  return { ctx, writes, pluginStateStore, updateSessionCalls, restoringCalls };
}

function makeSession(overrides: Partial<MockSession>): MockSession {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    realCwd: null,
    ...overrides,
  };
}

async function flushRestoreWrites() {
  // onSessionOpen: waitForSessionOutput (microtask) + 400ms settle timer.
  await vi.advanceTimersByTimeAsync(600);
}

describe('vibe plugin', () => {
  describe('VIBE_PROCESS_RE', () => {
    it('matches vibe process name', () => {
      expect(VIBE_PROCESS_RE.test('vibe')).toBe(true);
      expect(VIBE_PROCESS_RE.test('Vibe')).toBe(true);
      expect(VIBE_PROCESS_RE.test('vibe-agent')).toBe(true);
      expect(VIBE_PROCESS_RE.test('python -m vibe')).toBe(false);
    });
  });

  describe('parseVibeSessionName', () => {
    it('extracts session name from resume line', () => {
      const output = 'Session ended.\nResume this session with `vibe -r my-session`\n';
      expect(parseVibeSessionName(output)).toBe('my-session');
    });

    it('extracts session name from two-line resume hint', () => {
      const output = ' vibe -r my-session-123\n resumes this session · vibe -r lists recent sessions\n';
      expect(parseVibeSessionName(output)).toBe('my-session-123');
    });

    it('extracts session name from Session: prefix', () => {
      const output = 'Session: abc-123-def\nSome other text\n';
      expect(parseVibeSessionName(output)).toBe('abc-123-def');
    });

    it('extracts session name from standalone vibe -r line', () => {
      const output = 'vibe -r session-name\n';
      expect(parseVibeSessionName(output)).toBe('session-name');
    });

    it('returns undefined when no session name found', () => {
      expect(parseVibeSessionName('Just some regular output')).toBeUndefined();
    });

    it('returns undefined when requireComplete and name is at end', () => {
      const output = 'Resume with: vibe -r test';
      expect(parseVibeSessionName(output, true)).toBeUndefined();
    });

    it('handles name at end when not requireComplete', () => {
      const output = 'Resume with: vibe -r test';
      expect(parseVibeSessionName(output, false)).toBe('test');
    });
  });

  describe('parseVibeTasks', () => {
    it('parses checkbox-style tasks', () => {
      const output = `
[ ] Task 1
[~] Task 2
[x] Task 3
`;
      const tasks = parseVibeTasks(output);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].title).toBe('Task 1');
      expect(tasks[0].status).toBe('pending');
      expect(tasks[1].status).toBe('running');
      expect(tasks[2].status).toBe('completed');
    });

    it('parses emoji-style tasks', () => {
      const output = `
○ Task pending
● Task running
✓ Task done
✗ Task failed
`;
      const tasks = parseVibeTasks(output);
      expect(tasks).toHaveLength(4);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[1].status).toBe('running');
      expect(tasks[2].status).toBe('completed');
      expect(tasks[3].status).toBe('blocked');
    });

    it('returns empty array when no tasks found', () => {
      expect(parseVibeTasks('No tasks here')).toEqual([]);
    });

    it('scans from bottom and stops at first non-task line', () => {
      const output = `
Old tasks:
[ ] Old task 1
[x] Old task 2

New tasks:
[~] Current task 1
[ ] Current task 2
`;
      const tasks = parseVibeTasks(output);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe('Current task 1');
      expect(tasks[1].title).toBe('Current task 2');
    });
  });

  describe('parseVibeStructuredTasks', () => {
    it('parses Task X/Y format', () => {
      const output = `
Task 1/3: Doing something
Task 2/3: Waiting
Task 3/3: Completed
`;
      const tasks = parseVibeStructuredTasks(output);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('running');
      expect(tasks[1].status).toBe('running');
      expect(tasks[2].status).toBe('completed');
    });

    it('parses [X/Y] format', () => {
      const output = `
[1/3] First task
[2/3] Second task
[3/3] Third task
`;
      const tasks = parseVibeStructuredTasks(output);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('running');
      expect(tasks[2].status).toBe('completed');
    });

    it('returns empty array when no structured tasks found', () => {
      expect(parseVibeStructuredTasks('Random text')).toEqual([]);
    });
  });
});

describe('vibe plugin session restore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('injects cd <vibeSessionCwd> && vibe -r <own name> when cwd is recorded', async () => {
    const s = makeSession({
      id: 'vibe-with-cwd',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: {
        vibe: {
          vibeSessionName: 'my-vibe-session',
          vibeSessionCwd: '/home/user/proj-1',
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    vibePlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual([`cd '/home/user/proj-1' && vibe -r my-vibe-session\r`]);
  });

  it('falls back to vibe -r when no cwd was recorded', async () => {
    const s = makeSession({
      id: 'vibe-no-cwd',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: { vibe: { vibeSessionName: 'orphan-name' } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    vibePlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual(['vibe -r orphan-name\r']);
  });

  it('does not restore when restoreSession is disabled', async () => {
    const s = makeSession({
      id: 'vibe-disabled',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: {
        vibe: {
          vibeSessionName: 'test-session',
          vibeSessionCwd: '/work',
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: false });
    vibePlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual([]);
  });

  it('does not restore when no session name is remembered', async () => {
    const s = makeSession({
      id: 'vibe-no-name',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: { vibe: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    vibePlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual([]);
  });

  it('axn-vibe-resume command returns resume command', async () => {
    const s = makeSession({
      id: 'vibe-cmd',
      workspaceId: 'w1',
      cwd: '/home/user/Downloads',
      pluginState: {
        vibe: { vibeSessionName: 'sess-123', vibeSessionCwd: '/home/user/proj' },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    const declared = pluginCommands(vibePlugin).find((c) => c.name === 'axn-vibe-resume');
    const cmd = await declared?.run?.(h.ctx, undefined, 'axn-vibe-resume');
    expect(cmd).toBe(`cd '/home/user/proj' && vibe -r sess-123`);
  });

  it('axn-vibe-resume returns error message when no session remembered', async () => {
    const s = makeSession({
      id: 'vibe-cmd-no-session',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: { vibe: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    const declared = pluginCommands(vibePlugin).find((c) => c.name === 'axn-vibe-resume');
    const cmd = await declared?.run?.(h.ctx, undefined, 'axn-vibe-resume');
    expect(cmd).toBe(`echo 'axn-vibe-resume: no remembered vibe session'`);
  });
});

describe('vibe plugin process detection', () => {
  it('detects vibe process', () => {
    const s = makeSession({
      id: 'vibe-detect',
      process: 'vibe',
    });
    const store: Record<string, unknown> = {};
    const h = makeCtx(s, store);
    
    // Simulate onOutput with vibe as process
    vibePlugin.onOutput?.(h.ctx, 'some output');
    
    // Check that vibeWasActive is set
    const state = store.vibe as Record<string, unknown>;
    expect(state.vibeWasActive).toBe(true);
  });

  it('does not detect non-vibe process', () => {
    const s = makeSession({
      id: 'non-vibe',
      process: 'zsh',
    });
    const store: Record<string, unknown> = {};
    const h = makeCtx(s, store);
    
    vibePlugin.onOutput?.(h.ctx, 'some output');
    
    const state = store.vibe as Record<string, unknown>;
    expect(state.vibeWasActive).toBeUndefined();
  });
});

describe('vibe plugin task tracking', () => {
  it('clears tasks when process ends', () => {
    const s = makeSession({
      id: 'vibe-tasks',
      process: 'vibe',
      pluginState: {
        vibe: {
          tasks: [
            { id: '1', title: 'Task 1', status: 'running' },
            { id: '2', title: 'Task 2', status: 'pending' },
          ],
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    
    vibePlugin.onProcessEnd?.(h.ctx);
    
    const state = store.vibe as Record<string, unknown>;
    expect(state.tasks).toEqual([]);
  });

  it('clears progress when process ends', () => {
    const s = makeSession({
      id: 'vibe-progress',
      process: 'vibe',
      tasks: [
        { id: '1', title: 'Task 1', done: false },
      ],
      progress: 50,
      pluginState: {
        vibe: { wroteTasks: true },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);

    vibePlugin.onProcessEnd?.(h.ctx);

    expect(h.updateSessionCalls).toContainEqual({
      sessionId: 'vibe-progress',
      patch: { tasks: [], progress: 0 },
    });
  });

  it('writes running status while tasks are open', () => {
    const s = makeSession({
      id: 'vibe-status',
      process: 'vibe',
      output: '[x] Done\n[~] Working\n',
    });
    const h = makeCtx(s, {});

    vibePlugin.onOutput?.(h.ctx, 'Updated todo list');

    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: expect.objectContaining({ status: 'running' }),
    });
  });

  it('writes completed status when all tasks are done', () => {
    const s = makeSession({
      id: 'vibe-status-done',
      process: 'vibe',
      output: '[x] Done one\n[x] Done two\n',
    });
    const h = makeCtx(s, {});

    vibePlugin.onOutput?.(h.ctx, 'Updated todo list');

    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: expect.objectContaining({ status: 'completed', progress: 100 }),
    });
  });

  it('keeps a completed badge on process end, resets a mid-run exit to idle', () => {
    const done = makeSession({ id: 'vibe-done', process: 'vibe', status: 'completed' });
    const hDone = makeCtx(done, {});
    vibePlugin.onProcessEnd?.(hDone.ctx);
    expect(hDone.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);

    const mid = makeSession({ id: 'vibe-mid', process: 'vibe', status: 'running' });
    const hMid = makeCtx(mid, {});
    vibePlugin.onProcessEnd?.(hMid.ctx);
    expect(hMid.updateSessionCalls).toContainEqual({
      sessionId: 'vibe-mid',
      patch: { status: 'idle' },
    });
  });

  it('clears a terminal badge when a new command is submitted', () => {
    const s = makeSession({ id: 'vibe-cmd-badge', process: 'vibe', status: 'completed' });
    const h = makeCtx(s, {});
    vibePlugin.onCommand?.(h.ctx, 'ls');
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: 'vibe-cmd-badge',
      patch: { status: 'idle' },
    });
  });
});

describe('vibe plugin /exit capture', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms exit capture on /exit command', () => {
    const s = makeSession({
      id: 'vibe-exit',
      process: 'vibe',
      output: '',
      pluginState: { vibe: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    
    vibePlugin.onCommand?.(h.ctx, '/exit');
    
    // The capture should be armed
    const state = store.vibe as Record<string, unknown>;
    expect(state.vibeSessionName).toBeUndefined();
    expect(state.vibeOutputStart).toBeUndefined();
  });

  it('captures session name from output after /exit', () => {
    const s = makeSession({
      id: 'vibe-exit-capture',
      process: 'vibe',
      output: '',
      pluginState: { vibe: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    
    // Arm the capture
    vibePlugin.onCommand?.(h.ctx, '/exit');
    
    // Simulate output with session name
    vibePlugin.onOutput?.(h.ctx, 'Resume with: vibe -r captured-session\n');
    
    // Give the capture time to process
    vi.advanceTimersByTime(0);
    
    const state = store.vibe as Record<string, unknown>;
    expect(state.vibeSessionName).toBe('captured-session');
  });
});
