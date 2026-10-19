import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { devinPlugin } from './devinTasks';
import { noteSessionSelected } from '../attention';

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
  const ctx: Ctx = {
    session,
    updateSession: (sessionId, patch) => {
      updateSessionCalls.push({ sessionId, patch });
    },
    writeToSession: async (data) => {
      writes.push(data);
    },
    updatePluginState: (patch) => {
      const current = (pluginStateStore.devin ?? {}) as Record<string, unknown>;
      pluginStateStore.devin = { ...current, ...(patch as Record<string, unknown>) };
    },
    getSession: () => session,
    getSessionCount: () => sessionCount,
    get pluginState() {
      return pluginStateStore.devin;
    },
    pluginSettings: settings,
    exec: async () => '',
    waitForSessionOutput: async () => true,
    getCwd: async () => session.realCwd,
    openBrowser: () => {},
    openTab: () => {},
    openSubShell: () => undefined,
    readFile: async () => '',
    writeFile: async () => {},
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    isProgressHandled: () => false,
    getScreenLines: () => [],
    setAttention: (attention) => {
      const current = (pluginStateStore.devin ?? {}) as Record<string, unknown>;
      pluginStateStore.devin = { ...current, attention };
    },
    setBanner: (banner) => {
      const current = (pluginStateStore.devin ?? {}) as Record<string, unknown>;
      pluginStateStore.devin = { ...current, banner };
    },
    setRestoring: (label) => {
      restoringCalls.push(label);
    },
    appState: undefined,
    updateAppState: () => {},
  };
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

const RESUME = (name: string) =>
  `Session ended.\nResume this session with \`devin -r ${name}\`\n`;

// Devin CLI 3000.11+ prints the resume hint on two lines.
const RESUME_V2 = (name: string) =>
  ` devin -r ${name}\n resumes this session · devin -r lists recent sessions\n`;

async function flushRestoreWrites() {
  // onSessionOpen: waitForSessionOutput (microtask) + 400ms settle timer.
  await vi.advanceTimersByTimeAsync(600);
}

describe('devin plugin session restore — 3 workspaces × 2 sessions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * Replicates the reported bug: only the first (visible) session restored
   * correctly; sessions in other workspaces ran `devin -r <name>` in a stale
   * persisted cwd, so devin's directory-scoped lookup picked a session from
   * another folder. session.cwd of hidden sessions is stale/undefined because
   * cwd polling only ran for the visible session.
   */
  it('injects cd <devinSessionCwd> && devin -r <own name> into each devin session', async () => {
    const workspaces = ['w1', 'w2', 'w3'];
    // Simulate hidden/background sessions: session.cwd is stale (the shell's
    // last persisted cwd, e.g. home), while devinSessionCwd records where the
    // devin session actually ran.
    const devinSessions = workspaces.map((ws, i) =>
      makeSession({
        id: `devin-${ws}`,
        workspaceId: ws,
        cwd: '/home/user', // stale persisted cwd
        pluginState: {
          devin: {
            devinSessionName: `sess-${ws}`,
            devinSessionCwd: `/home/user/proj-${i + 1}`,
            devinActive: true,
          },
        },
      }),
    );
    const plainSessions = workspaces.map((ws) =>
      makeSession({ id: `shell-${ws}`, workspaceId: ws, cwd: '/home/user' }),
    );

    const storeById = new Map<string, Record<string, unknown>>();
    const writesById = new Map<string, string[]>();

    for (const s of [...devinSessions, ...plainSessions]) {
      const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
      storeById.set(s.id, store);
      const h = makeCtx(s, store);
      writesById.set(s.id, h.writes);
      devinPlugin.onSessionOpen?.(h.ctx);
    }

    await flushRestoreWrites();

    for (const s of plainSessions) {
      expect(writesById.get(s.id), `plain session ${s.id} must not get a restore`).toEqual([]);
    }
    devinSessions.forEach((s, i) => {
      expect(writesById.get(s.id)).toEqual([
        `cd '/home/user/proj-${i + 1}' && devin -r sess-${s.workspaceId}\r`,
      ]);
    });
  });

  it('falls back to devin -r when no cwd was ever recorded', async () => {
    const s = makeSession({
      id: 'devin-no-cwd',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: { devin: { devinSessionName: 'orphan-name', devinActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual(['devin -r orphan-name\r']);
  });

  it('records the real PTY cwd (not stale session.cwd) when devin exits', async () => {
    vi.useRealTimers(); // recordSessionCwd resolves via microtasks
    const s = makeSession({
      id: 'devin-exit',
      workspaceId: 'w2',
      cwd: '/home/user', // stale — user was somewhere else when it persisted
      realCwd: '/home/user/proj-2', // where devin actually ran
      output: RESUME('sess-w2-new'),
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    // Resume lines are captured on process end, not from the output stream.
    devinPlugin.onProcessEnd?.(h.ctx);
    await vi.waitFor(() => {
      expect(store.devin).toMatchObject({
        devinSessionCwd: '/home/user/proj-2',
        devinSessionName: 'sess-w2-new',
      });
    });
  });

  it('prefers devinSessionCwd over stale session.cwd for axn-devin-resume', async () => {
    const s = makeSession({
      id: 'devin-cmd',
      workspaceId: 'w3',
      cwd: '/home/user/Downloads', // stale — devin ran elsewhere
      pluginState: {
        devin: { devinSessionName: 'sess-w3', devinSessionCwd: '/home/user/proj-3' },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    const declared = pluginCommands(devinPlugin).find((c) => c.name === 'axn-devin-resume');
    const cmd = await declared?.run?.(h.ctx, undefined, 'axn-devin-resume');
    expect(cmd).toBe(`cd '/home/user/proj-3' && devin -r sess-w3`);
  });

  it('never leaks one session\'s devin name into another session', async () => {
    // Two devin sessions with different remembered names and cwd; each must
    // inject its own name into its own session id.
    const a = makeSession({
      id: 'devin-a',
      workspaceId: 'w1',
      cwd: '/home/user',
      realCwd: '/work/a',
      output: RESUME('name-a'),
      pluginState: { devin: { devinSessionName: 'name-a', devinSessionCwd: '/work/a', devinActive: true } },
    });
    const b = makeSession({
      id: 'devin-b',
      workspaceId: 'w2',
      cwd: '/home/user',
      realCwd: '/work/b',
      output: RESUME('name-b'),
      pluginState: { devin: { devinSessionName: 'name-b', devinSessionCwd: '/work/b', devinActive: true } },
    });
    const writesById = new Map<string, string[]>();
    for (const s of [a, b]) {
      const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
      const h = makeCtx(s, store);
      writesById.set(s.id, h.writes);
      devinPlugin.onSessionOpen?.(h.ctx);
    }
    await flushRestoreWrites();
    expect(writesById.get('devin-a')).toEqual([`cd '/work/a' && devin -r name-a\r`]);
    expect(writesById.get('devin-b')).toEqual([`cd '/work/b' && devin -r name-b\r`]);
  });
});

describe('devin restore failure banner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function restoringSession(
    pluginState: Record<string, unknown> = {},
    beforeOpen?: (h: Harness) => void,
  ) {
    const s = makeSession({
      id: 'devin-restore',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: {
        devin: {
          devinSessionName: 'sess-gone',
          devinSessionCwd: '/work/proj',
          devinActive: true,
          ...pluginState,
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    beforeOpen?.(h);
    devinPlugin.onSessionOpen?.(h.ctx);
    return { s, store, h };
  }

  it('shows an error banner when the CLI reports the session is gone', async () => {
    const { s, store, h } = restoringSession();
    await flushRestoreWrites();
    expect(h.writes).toEqual([`cd '/work/proj' && devin -r sess-gone\r`]);

    devinPlugin.onOutput?.(h.ctx, "No session found matching 'sess-gone'\n");
    const banner = (store.devin as Record<string, unknown>).banner as {
      level: string;
      message: string;
    };
    expect(banner.level).toBe('error');
    expect(banner.message).toContain('sess-gone');
    // The dead name is dropped so it is not retried on every restart.
    expect((store.devin as Record<string, unknown>).devinSessionName).toBeUndefined();
    void s;
  });

  it('shows an error banner when devin never becomes the foreground process', async () => {
    const { store } = restoringSession();
    await flushRestoreWrites();
    await vi.advanceTimersByTimeAsync(21_000);
    const banner = (store.devin as Record<string, unknown>).banner as {
      level: string;
      message: string;
    };
    expect(banner.level).toBe('error');
    expect(banner.message).toContain('sess-gone');
  });

  it('clears a stale banner once devin is running again', async () => {
    const { s, store, h } = restoringSession({
      banner: { level: 'error', message: 'old failure' },
    });
    // Stale banner is cleared on open before the new attempt resolves.
    expect((store.devin as Record<string, unknown>).banner).toBeNull();
    await flushRestoreWrites();

    s.process = 'devin';
    devinPlugin.onOutput?.(h.ctx, 'devin tui\n');
    expect((store.devin as Record<string, unknown>).banner).toBeNull();
    // And no timeout error fires afterwards.
    await vi.advanceTimersByTimeAsync(21_000);
    expect((store.devin as Record<string, unknown>).banner).toBeNull();
  });

  it('shows an error banner when the restore command cannot be written', async () => {
    const { store } = restoringSession({}, (h) => {
      h.ctx.writeToSession = async () => {
        throw new Error('pty gone');
      };
    });
    await flushRestoreWrites();
    const banner = (store.devin as Record<string, unknown>).banner as {
      level: string;
      message: string;
    };
    expect(banner.level).toBe('error');
    expect(banner.message).toContain('sess-gone');
  });
});

describe('devin pendingRestore overlay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function rememberedSession(
    settings: Record<string, unknown> = { restoreSession: true },
    devinActive = true,
  ) {
    const s = makeSession({
      id: 'devin-overlay',
      workspaceId: 'w1',
      cwd: '/home/user',
      pluginState: {
        devin: { devinSessionName: 'sess-x', devinSessionCwd: '/work/proj', devinActive },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    return { s, h: makeCtx(s, store, settings) };
  }

  it('declares a restore overlay only when a remembered name will be restored', () => {
    const { h } = rememberedSession();
    expect(devinPlugin.pendingRestore?.(h.ctx)).toBe("devin session 'sess-x'");
    // restore-session off → nothing declared
    expect(devinPlugin.pendingRestore?.(rememberedSession({ restoreSession: false }).h.ctx))
      .toBeUndefined();
    // No remembered name → nothing declared
    const plain = makeCtx(makeSession({ id: 'plain', workspaceId: 'w1' }), {});
    expect(devinPlugin.pendingRestore?.(plain.ctx)).toBeUndefined();
    // devin was not running at close → nothing declared, nothing injected
    const idle = rememberedSession({ restoreSession: true }, false);
    expect(devinPlugin.pendingRestore?.(idle.h.ctx)).toBeUndefined();
  });

  it('does not restore when devin had exited before the session closed', async () => {
    const { h } = rememberedSession({ restoreSession: true }, false);
    devinPlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual([]);
  });

  it('clears the overlay once devin is confirmed running', async () => {
    const { s, h } = rememberedSession();
    devinPlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    expect(h.writes).toEqual([`cd '/work/proj' && devin -r sess-x\r`]);

    s.process = 'devin';
    devinPlugin.onOutput?.(h.ctx, 'devin tui\n');
    expect(h.restoringCalls).toContain(null);
  });

  it('clears the overlay on restore timeout and on write failure', async () => {
    const { h } = rememberedSession();
    devinPlugin.onSessionOpen?.(h.ctx);
    await flushRestoreWrites();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(h.restoringCalls).toContain(null);

    const { h: hw } = rememberedSession();
    hw.ctx.writeToSession = async () => {
      throw new Error('pty gone');
    };
    devinPlugin.onSessionOpen?.(hw.ctx);
    await flushRestoreWrites();
    expect(hw.restoringCalls).toContain(null);
  });
});

describe('devin process output boundaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records devinOutputStart the first time devin is active in output', () => {
    const base = 'starting devin...\n';
    const resumeChunk = RESUME('gray-party');
    const s = makeSession({
      id: 'devin-track',
      workspaceId: 'w1',
      process: 'devin',
      output: base + resumeChunk,
      realCwd: '/home/user/proj',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onOutput?.(h.ctx, resumeChunk);
    expect(store.devin).toMatchObject({
      devinOutputStart: base.length,
      devinWasActive: true,
    });
  });

  it('onProcessEnd captures the newest tail resume line, not an earlier stale one', () => {
    const stale = 'Resume this session with devin -r green-aurora\n';
    const base = stale + 'starting new devin...\n';
    const resumeChunk = RESUME('gray-party');
    const s = makeSession({
      id: 'devin-stale-process',
      workspaceId: 'w1',
      process: 'devin',
      output: base + resumeChunk,
      realCwd: '/home/user/proj',
      pluginState: { devin: { devinOutputStart: stale.length, devinWasActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(store.devin).toMatchObject({
      devinOutputStart: undefined,
      // The just-exited run's hint is the last match in the tail — the
      // stale green-aurora line above it is ignored.
      devinSessionName: 'gray-party',
    });
  });

  it('remembers the session when devin is quit with a manual Ctrl-C×2', () => {
    // Regression: a user-driven exit (no typed /exit, no plugin close) armed
    // no capture, so the printed resume line was ignored and restore found
    // nothing to restore (empty devinSessionName).
    const base = 'starting devin...\n';
    const s = makeSession({
      id: 'devin-ctrlc-exit',
      workspaceId: 'w1',
      process: 'devin',
      output: base,
      realCwd: '/home/user/proj',
      pluginState: { devin: { devinOutputStart: base.length, devinWasActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    // Devin prints the resume hint after the second interrupt; the chunks
    // land in retained output before the foreground poll sees the exit.
    s.output += 'Press Ctrl+C again to exit.\n';
    devinPlugin.onOutput?.(h.ctx, 'Press Ctrl+C again to exit.\n');
    s.output += RESUME_V2('crimson-eyeliner');
    devinPlugin.onOutput?.(h.ctx, RESUME_V2('crimson-eyeliner'));
    // …then the poll reports devin → shell.
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(store.devin).toMatchObject({ devinSessionName: 'crimson-eyeliner' });
  });

  it('picks up a resume hint that arrives in chunks after the process end', () => {
    const base = 'starting devin...\n';
    const s = makeSession({
      id: 'devin-late-hint',
      workspaceId: 'w1',
      process: 'devin',
      output: base + 'Press Ctrl+C again to exit.\n',
      realCwd: '/home/user/proj',
      pluginState: { devin: { devinOutputStart: base.length, devinWasActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    // The poll fires before the final PTY chunks are delivered.
    devinPlugin.onProcessEnd?.(h.ctx);
    expect((store.devin as Record<string, unknown>).devinSessionName).toBeUndefined();
    devinPlugin.onOutput?.(h.ctx, ' devin -r late-');
    devinPlugin.onOutput?.(h.ctx, 'arrival\n resumes this session · devin -r lists recent sessions\n');
    expect(store.devin).toMatchObject({ devinSessionName: 'late-arrival' });
  });

  it('keeps a stored name when devin exits without printing a resume hint', () => {
    const s = makeSession({
      id: 'devin-killed',
      workspaceId: 'w1',
      process: 'devin',
      output: 'starting devin...\n(killed)\n$ ',
      realCwd: '/home/user/proj',
      pluginState: {
        devin: { devinWasActive: true, devinSessionName: 'kept-name' },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onProcessEnd?.(h.ctx);
    // The passive capture is not authoritative — it never erases.
    vi.advanceTimersByTime(5_000);
    expect(store.devin).toMatchObject({ devinSessionName: 'kept-name' });
  });

  it('a pending /exit capture owns the name; the tail scan must not interfere', () => {
    const base = 'starting devin...\n';
    const s = makeSession({
      id: 'devin-exit-armed',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: base + 'Resume this session with devin -r stale-tail\n',
      pluginState: {
        devin: {
          devinOutputStart: base.length,
          devinWasActive: true,
          devinSessionName: 'old-name',
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onCommand?.(h.ctx, '/exit');
    expect(store.devin).toMatchObject({ devinSessionName: undefined });
    devinPlugin.onProcessEnd?.(h.ctx);
    // The tail's stale hint is ignored while the authoritative capture runs.
    expect((store.devin as Record<string, unknown>).devinSessionName).toBeUndefined();
    devinPlugin.onOutput?.(h.ctx, RESUME('fresh-name'));
    expect(store.devin).toMatchObject({ devinSessionName: 'fresh-name' });
  });

  it('onClose clears the name if the current devin process prints no resume line', async () => {
    const stale = 'Resume this session with devin -r green-aurora\n$ ';
    const s = makeSession({
      id: 'devin-close-stale',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: stale,
      realCwd: '/home/user/proj',
      pluginState: {
        devin: { devinOutputStart: stale.length, devinWasActive: true, devinSessionName: 'green-aurora' },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: true }, 10);
    const closePromise = devinPlugin.onClose?.(h.ctx) as Promise<void> | undefined;
    // First Ctrl-C, 300 ms pause, second Ctrl-C, then the 8 s capture timeout.
    await vi.advanceTimersByTimeAsync(8300);
    await closePromise;
    await Promise.resolve();
    expect(h.writes).toEqual(['\x03', '\x03']);
    expect(store.devin).toMatchObject({
      devinSessionName: undefined,
      devinSessionCwd: '/home/user/proj',
    });
  });

  it('does not flag a quiet devin session the user never selected', async () => {
    const s = makeSession({
      id: 'devin-idle',
      workspaceId: 'w1',
      process: 'devin',
      output: 'devin working...\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);

    devinPlugin.onOutput?.(h.ctx, 'still working\n');
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();

    // Silence in a session the user never opened must not flag.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it('flags "possibly finished" for a watched devin session that went quiet', async () => {
    const s = makeSession({
      id: 'devin-idle-finished',
      workspaceId: 'w1',
      process: 'devin',
      output: 'devin working...\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: true, idleTimeoutSeconds: 10 });

    // The user selected the session, then the screen changed → silence counts.
    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'still working\n');
    await vi.advanceTimersByTimeAsync(11_000);
    const attention = (store.devin as Record<string, unknown>).attention as {
      level: string;
      message: string;
    };
    expect(attention.message).toContain('possibly finished');
    expect(attention.level).toBe('warning');
  });

  it('does not flag silence that began before the user last selected the session', async () => {
    const s = makeSession({
      id: 'devin-idle-reselect',
      workspaceId: 'w1',
      process: 'devin',
      output: 'devin working...\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: true, idleTimeoutSeconds: 10 });

    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'output\n');
    // The user looks at the session again — the baseline resets, so quiet
    // following output from before this view must not flag.
    vi.advanceTimersByTime(1_000);
    noteSessionSelected(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it('flags "waiting for input" when the quiet screen ends in a question, clears on output', async () => {
    const s = makeSession({
      id: 'devin-idle-question',
      workspaceId: 'w1',
      process: 'devin',
      output: 'Shall I continue with the refactor?\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: true, idleTimeoutSeconds: 10 });

    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'anything\n');
    await vi.advanceTimersByTimeAsync(11_000);
    const attention = (store.devin as Record<string, unknown>).attention as {
      level: string;
      message: string;
    };
    expect(attention.message).toContain('waiting for input');
    expect(attention.level).toBe('warning');

    // New output clears the flag and re-arms the timer.
    s.output += 'resuming\n';
    devinPlugin.onOutput?.(h.ctx, 'resuming\n');
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it('onProcessEnd clears a raised attention flag and stops the timer', () => {
    const s = makeSession({
      id: 'devin-idle-end',
      workspaceId: 'w1',
      process: 'devin',
      output: 'done\n',
      pluginState: { devin: { attention: { level: 'warning', message: 'quiet' } } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onProcessEnd?.(h.ctx);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
    // The timer is gone: advancing time must not re-raise the flag.
    vi.advanceTimersByTime(60_000);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it('flags once after watched work goes quiet; repaints cannot re-flag it', async () => {
    // Regression: TUI repaints (focus-in, SIGWINCH reflow, attach replay)
    // resent identical bytes and each re-armed the idle timer, so a session
    // re-flagged every <timeout> seconds after every click.
    const s = makeSession({
      id: 'devin-repaint-loop',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: 'working\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { idleTimeoutSeconds: 10 });
    let screen = ['⢰ Thinking · 1m (esc twice to interrupt)', '❭ Guide Devin while it works'];
    h.ctx.getScreenLines = () => screen;

    // Watched work: the interrupt hint marks the turn as running, then the
    // turn ends — the quiet that follows real work may flag once.
    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'tick');
    screen = ['● done', '❭ Guide Devin while it works'];
    devinPlugin.onOutput?.(h.ctx, 'turn ends');
    await vi.advanceTimersByTimeAsync(11_000);
    let attention = (store.devin as Record<string, unknown>).attention as
      | { message: string }
      | undefined;
    expect(attention?.message).toContain('possibly finished');

    // The user looks — ShellApp clears the flag on selection. A repaint of
    // the identical screen resends bytes but is not fresh activity: it must
    // neither re-arm the timer nor be treated as new output.
    (store.devin as Record<string, unknown>).attention = undefined;
    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'repaint');
    await vi.advanceTimersByTimeAsync(11_000);
    attention = (store.devin as Record<string, unknown>).attention as
      | { message: string }
      | undefined;
    expect(attention).toBeUndefined();

    // A chunk that really changes the screen still counts — a new question
    // after the look flags again.
    screen = ['● done', 'Do you want me to continue? (y/n)'];
    devinPlugin.onOutput?.(h.ctx, 'new question');
    await vi.advanceTimersByTimeAsync(11_000);
    attention = (store.devin as Record<string, unknown>).attention as
      | { message: string }
      | undefined;
    expect(attention?.message).toContain('waiting for input');
  });

  it('does not flag a session quiet at its prompt since the user last looked', async () => {
    // Regression: a restored session sat at its devin prompt — repaints and
    // reflows re-armed the timer and flagged "possibly finished" every
    // timeout even though nothing happened. Quiet only counts when devin
    // was seen working since the last look (or asks a question).
    const s = makeSession({
      id: 'devin-restored-quiet',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: 'restored\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { idleTimeoutSeconds: 10 });
    let screen = [
      '❭ Guide Devin while it works',
      'SWE-2 High          Context: 40k / 262k tokens',
    ];
    h.ctx.getScreenLines = () => screen;

    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'attach replay');
    // A reflow repaint produces different text but the same state: a quiet
    // prompt with no work since the last look has nothing to finish.
    screen = [
      '  ❭ Guide Devin while it works',
      'SWE-2 High          Context: 40k / 262k tokens',
    ];
    devinPlugin.onOutput?.(h.ctx, 'reflow repaint');
    await vi.advanceTimersByTimeAsync(11_000);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it('does not flag while the interrupt hint is still on screen', async () => {
    // A stalled spinner is still busy — the hint means "working", so quiet
    // with it on screen is neither finished nor waiting for input.
    const s = makeSession({
      id: 'devin-stalled-spinner',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: 'thinking\n',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { idleTimeoutSeconds: 10 });
    const screen = ['⢰ Thinking · 1m 59s (esc twice to interrupt) · (5339c)'];
    h.ctx.getScreenLines = () => screen;

    noteSessionSelected(s.id);
    devinPlugin.onOutput?.(h.ctx, 'tick');
    await vi.advanceTimersByTimeAsync(11_000);
    expect((store.devin as Record<string, unknown>).attention).toBeUndefined();
  });

  it.each([
    ['single-line', RESUME],
    ['two-line (devin 3000.11+)', RESUME_V2],
  ])(
    'onClose captures the %s resume hint printed after two Ctrl-C interrupts',
    async (_label, resume) => {
      const base = 'starting devin...\n';
      const s = makeSession({
        id: 'devin-close-capture',
        workspaceId: 'w1',
        process: 'devin',
        devinActive: true,
        output: base,
        realCwd: '/home/user/proj',
        pluginState: {
          devin: { devinOutputStart: base.length, devinWasActive: true },
        },
      });
      const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
      const h = makeCtx(s, store, { restoreSession: true }, 10);
      const closePromise = devinPlugin.onClose?.(h.ctx) as Promise<void> | undefined;
      // Simulate devin printing the resume hint after the second Ctrl-C — the
      // close-time capture only consumes chunks delivered via onOutput.
      await vi.advanceTimersByTimeAsync(300);
      devinPlugin.onOutput?.(h.ctx, resume('gray-party'));
      await closePromise;
      await Promise.resolve();
      expect(h.writes).toEqual(['\x03', '\x03']);
      expect(store.devin).toMatchObject({
        devinSessionName: 'gray-party',
        devinSessionCwd: '/home/user/proj',
      });
    },
  );

  it('captures a two-line resume hint split across output chunks', async () => {
    const base = 'starting devin...\n';
    const s = makeSession({
      id: 'devin-close-split',
      workspaceId: 'w1',
      process: 'devin',
      devinActive: true,
      output: base,
      realCwd: '/home/user/proj',
      pluginState: {
        devin: { devinOutputStart: base.length, devinWasActive: true },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: true }, 10);
    const closePromise = devinPlugin.onClose?.(h.ctx) as Promise<void> | undefined;
    await vi.advanceTimersByTimeAsync(300);
    // The name line must not complete the capture until the context line
    // arrives — a name split across chunks never matches prematurely.
    devinPlugin.onOutput?.(h.ctx, ' devin -r gray-par');
    devinPlugin.onOutput?.(
      h.ctx,
      'ty\n resumes this session · devin -r lists recent sessions\n',
    );
    await closePromise;
    await Promise.resolve();
    expect(store.devin).toMatchObject({ devinSessionName: 'gray-party' });
  });
});

describe('devin screen task scanning', () => {
  // Devin >=3000.11 draws the todo block in the TUI's live region — the
  // screen buffer is scanned for '│ glyph N.' rows while devin is
  // foreground (throttled to one scan per second).
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const SCREEN_WITH_TASKS = [
    'Thinking · 2m (esc twice to interrupt)',
    ' ● Updated todo list (3 items)',
    ' │ ✓ 1. explore codebase',
    ' │ ◔ 2. implement feature',
    ' └ ○ 3. write tests',
    '──────────────────────────────────────────────',
    '❭ Guide Devin while it works',
    'SWE-2 High          Context: 40k / 262k tokens',
  ];
  const SCREEN_DONE = [
    ' ● Updated todo list (3 items)',
    ' │ ✓ 1. explore codebase',
    ' │ ✓ 2. implement feature',
    ' └ ✓ 3. write tests',
    '❭ Guide Devin while it works',
  ];
  const SCREEN_NO_TASKS = [
    ' ● Ran command',
    ' │ $ ls',
    ' └ Exited with code 0',
    '❭ Guide Devin while it works',
  ];

  function screenHarness(lines: string[]) {
    const session = makeSession({
      id: `scr-${Math.random().toString(36).slice(2, 8)}`,
      process: 'devin',
      devinActive: true,
      cwd: '/repo',
      realCwd: '/repo',
    });
    const store = { ...(session.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(session, store);
    let screen = lines;
    h.ctx.getScreenLines = () => screen;
    return { h, session, store, setScreen: (l: string[]) => { screen = l; }, updateSessionCalls: h.updateSessionCalls };
  }

  it('derives tasks + progress from a todo block on the live screen', () => {
    const { h, session, store, updateSessionCalls } = screenHarness(SCREEN_WITH_TASKS);
    devinPlugin.onOutput?.(h.ctx, 'chunk');
    expect(updateSessionCalls).toContainEqual({
      sessionId: session.id,
      patch: {
        tasks: [
          { id: 'devin-1', title: 'explore codebase', done: true },
          { id: 'devin-2', title: 'implement feature', done: false },
          { id: 'devin-3', title: 'write tests', done: false },
        ],
        progress: 33,
        status: 'running',
      },
    });
    const devin = store.devin as { tasks?: Array<{ id: string; status: string }> };
    expect(devin.tasks).toHaveLength(3);
    expect(devin.tasks?.[1].status).toBe('running');
  });

  it('keeps the last list when the block leaves the viewport', () => {
    const { h, setScreen, updateSessionCalls } = screenHarness(SCREEN_WITH_TASKS);
    devinPlugin.onOutput?.(h.ctx, 'chunk1');
    expect(updateSessionCalls).toHaveLength(1);
    setScreen(SCREEN_NO_TASKS);
    vi.advanceTimersByTime(1_500);
    devinPlugin.onOutput?.(h.ctx, 'chunk2');
    // No tasks were parsed on the new screen — nothing is cleared or written.
    expect(updateSessionCalls).toHaveLength(1);
  });

  it('picks up status changes on subsequent scans', () => {
    const { h, setScreen, updateSessionCalls } = screenHarness(SCREEN_WITH_TASKS);
    devinPlugin.onOutput?.(h.ctx, 'chunk1');
    setScreen(SCREEN_DONE);
    vi.advanceTimersByTime(1_500);
    devinPlugin.onOutput?.(h.ctx, 'chunk2');
    expect(updateSessionCalls.some((c) => c.patch.progress === 100)).toBe(true);
  });

  it('rejects task-shaped rows without the todo-list header', () => {
    // Echoed dumps of another session's scrollback can draw task rows on
    // screen — without the 'Updated todo list' header above them they are
    // not a live widget and must not be adopted.
    const { h, updateSessionCalls } = screenHarness([
      ' $ python3 -c \"print(...)\"',
      ' │ ✓ 1. explore codebase',
      ' │ ◔ 2. implement feature',
      ' └ ○ 3. write tests',
      '❭ Guide Devin while it works',
    ]);
    devinPlugin.onOutput?.(h.ctx, 'chunk');
    expect(updateSessionCalls).toHaveLength(0);
  });

  it('does not scan while devin is not the foreground process', () => {
    const { h, session, updateSessionCalls } = screenHarness(SCREEN_WITH_TASKS);
    session.devinActive = false;
    session.process = 'zsh';
    devinPlugin.onOutput?.(h.ctx, 'plain output\n');
    expect(updateSessionCalls).toHaveLength(0);
  });

  it('writes a completed status once every task is done', () => {
    const { h, setScreen, updateSessionCalls } = screenHarness(SCREEN_WITH_TASKS);
    devinPlugin.onOutput?.(h.ctx, 'chunk1');
    setScreen(SCREEN_DONE);
    vi.advanceTimersByTime(1_500);
    devinPlugin.onOutput?.(h.ctx, 'chunk2');
    expect(updateSessionCalls.some((c) => c.patch.status === 'completed')).toBe(true);
  });

  it('reports running while the interrupt hint shows, even with every task done', () => {
    // Regression: a completed todo list forced status 'completed' while
    // '⢰ Thinking · (esc twice to interrupt)' proved devin still worked.
    const { h, session, updateSessionCalls } = screenHarness([
      '⢰ Thinking · 1m 59s (esc twice to interrupt) · (5339c)',
      ' ● Updated todo list (3 items)',
      ' │ ✓ 1. explore codebase',
      ' │ ✓ 2. implement feature',
      ' └ ✓ 3. write tests',
      '❭ Guide Devin while it works',
    ]);
    devinPlugin.onOutput?.(h.ctx, 'chunk');
    expect(updateSessionCalls.some((c) => c.patch.status === 'completed')).toBe(false);
    expect(updateSessionCalls).toContainEqual({
      sessionId: session.id,
      patch: {
        tasks: [
          { id: 'devin-1', title: 'explore codebase', done: true },
          { id: 'devin-2', title: 'implement feature', done: true },
          { id: 'devin-3', title: 'write tests', done: true },
        ],
        progress: 100,
        status: 'running',
      },
    });
  });

  it('reports running for a working screen without a todo block, then steps back to idle', () => {
    const { h, session, setScreen, updateSessionCalls } = screenHarness([
      '● Verifying the fix',
      '⢰ Thinking · 1m 59s (esc twice to interrupt) · (5339c)',
      '❭ Guide Devin while it works',
    ]);
    devinPlugin.onOutput?.(h.ctx, 'a');
    expect(updateSessionCalls).toContainEqual({
      sessionId: session.id,
      patch: { status: 'running' },
    });

    // The hint is gone — the turn ended without ever rendering a todo
    // block. The first hint-free scan keeps running (flicker guard); the
    // second steps back to idle.
    session.status = 'running';
    setScreen(['● Done', '❭ Guide Devin while it works']);
    vi.advanceTimersByTime(1_500);
    devinPlugin.onOutput?.(h.ctx, 'b');
    expect(updateSessionCalls.every((c) => c.patch.status !== 'idle')).toBe(true);
    vi.advanceTimersByTime(1_500);
    devinPlugin.onOutput?.(h.ctx, 'c');
    expect(updateSessionCalls).toContainEqual({
      sessionId: session.id,
      patch: { status: 'idle' },
    });
  });
});

describe('devin session status badge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function taskSession(taskStatuses: string[], status: string = 'running') {
    const s = makeSession({
      id: 'devin-badge',
      workspaceId: 'w1',
      process: 'devin',
      status: status as ShellSession['status'],
      tasks: taskStatuses.map((t, i) => ({ id: `devin-${i}`, title: `task ${i}`, done: t === 'completed' })),
      progress: 50,
      pluginState: {
        devin: {
          tasks: taskStatuses.map((t, i) => ({ id: `devin-${i}`, title: `task ${i}`, status: t })),
        },
      },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    return { s, h: makeCtx(s, store) };
  }

  it('keeps a completed badge when devin exits with all tasks done', () => {
    const { s, h } = taskSession(['completed', 'completed'], 'completed');
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: { tasks: [], progress: 0, status: 'completed' },
    });
  });

  it('keeps a blocked badge when devin exits with a blocked task', () => {
    const { s, h } = taskSession(['completed', 'blocked', 'pending'], 'blocked');
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: { tasks: [], progress: 0, status: 'blocked' },
    });
  });

  it('falls back to idle when devin exits mid-run', () => {
    const { s, h } = taskSession(['completed', 'running'], 'running');
    devinPlugin.onProcessEnd?.(h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: { tasks: [], progress: 0, status: 'idle' },
    });
  });

  it('clears a terminal badge when a new command is submitted', () => {
    const { h } = taskSession(['completed'], 'completed');
    devinPlugin.onCommand?.(h.ctx, 'ls -la');
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: 'devin-badge',
      patch: { status: 'idle' },
    });
  });

  it('leaves a running badge alone when a command is submitted', () => {
    const { h } = taskSession(['running'], 'running');
    devinPlugin.onCommand?.(h.ctx, 'ls -la');
    expect(h.updateSessionCalls.some((c) => 'status' in c.patch)).toBe(false);
  });

  it('resets a stale status on session open', () => {
    const s = makeSession({
      id: 'devin-stale-badge',
      workspaceId: 'w1',
      status: 'completed',
      pluginState: { devin: {} },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store, { restoreSession: false });
    devinPlugin.onSessionOpen?.(h.ctx);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: s.id,
      patch: { tasks: [], progress: 0, status: 'idle' },
    });
  });
});

describe('devin restore only when devin ran at close', () => {
  it('clears devinActive when devin exits on its own', () => {
    const s = makeSession({
      id: 'devin-exit',
      process: 'zsh',
      pluginState: { devin: { devinSessionName: 'kept', devinActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    devinPlugin.onProcessEnd?.(h.ctx);
    // The name stays for axn-devin-resume; only the auto-restore is off.
    expect(store.devin).toMatchObject({ devinSessionName: 'kept', devinActive: false });
  });

  it('clears devinActive when the session closes at a plain shell prompt', async () => {
    const s = makeSession({
      id: 'devin-idle-close',
      process: 'zsh',
      pluginState: { devin: { devinSessionName: 'kept', devinActive: true } },
    });
    const store = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
    const h = makeCtx(s, store);
    await devinPlugin.onClose?.(h.ctx);
    expect(store.devin).toMatchObject({ devinActive: false });
  });
});
