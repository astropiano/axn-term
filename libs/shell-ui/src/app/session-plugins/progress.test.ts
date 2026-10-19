import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import {
  progressPlugin,
  parseProgressLine,
  screenProgress,
  isProcessExcluded,
  DEBOUNCE_MS,
  SCAN_DELAY_MS,
} from './progress';

type Ctx = SessionViewContext & PluginApi;

interface Harness {
  ctx: Ctx;
  session: ShellSession;
  pluginStateStore: Record<string, unknown>;
  screen: string[];
}

let counter = 0;

function makeCtx(overrides: {
  process?: string;
  settings?: Record<string, unknown>;
  progressHandled?: boolean;
}): Harness {
  const screen: string[] = [];
  const pluginStateStore: Record<string, unknown> = {};
  const session: ShellSession = {
    id: `progress-${++counter}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    process: overrides.process ?? 'pacman',
  };
  const ctx: Ctx = {
    session,
    updateSession: (_sessionId, patch) => {
      Object.assign(session, patch);
    },
    writeToSession: async () => {},
    updatePluginState: (patch) => {
      pluginStateStore.progress = {
        ...(pluginStateStore.progress as Record<string, unknown> | undefined),
        ...(patch as Record<string, unknown>),
      };
    },
    getSession: () => session,
    getSessionCount: () => 1,
    pluginState: pluginStateStore.progress,
    pluginSettings: overrides.settings ?? {},
    exec: async () => '',
    waitForSessionOutput: async () => true,
    getCwd: async () => null,
    openBrowser: () => {},
    openTab: () => {},
    repoMenuItems: () => [],
    isProgressHandled: () => overrides.progressHandled ?? false,
    getScreenLines: () => screen,
    setAttention: () => {},
    setBanner: () => {},
    setRestoring: () => {},
    appState: undefined,
    updateAppState: () => {},
  };
  return { ctx, session, pluginStateStore, screen };
}

async function output(h: Harness) {
  progressPlugin.onOutput?.(h.ctx, 'chunk');
  await vi.advanceTimersByTimeAsync(SCAN_DELAY_MS);
}

describe('parseProgressLine', () => {
  it('parses percentages, fractions and bar drawings', () => {
    expect(parseProgressLine('downloading 45%')).toBe(45);
    expect(parseProgressLine('3/10 packages')).toBe(30);
    expect(parseProgressLine('12 of 50')).toBe(24);
    expect(parseProgressLine('[=====     ]')).toBe(50);
    expect(parseProgressLine('(####......)')).toBe(40);
  });

  it('returns the last match on the line', () => {
    expect(parseProgressLine('10% then 80%')).toBe(80);
  });

  it('ignores non-progress text', () => {
    expect(parseProgressLine('plain output')).toBeUndefined();
    expect(parseProgressLine('150% is impossible but skipped? 200%')).toBeUndefined();
    expect(parseProgressLine('version 1/2 beta')).toBe(50);
    expect(parseProgressLine('[]')).toBeUndefined();
  });
});

describe('screenProgress', () => {
  it('reports the bottom-most bar when several are on screen', () => {
    const found = screenProgress([
      'package-a [#####-----] 50%',
      'package-b [##--------] 20%',
      'Total (3/10)',
    ]);
    expect(found).toEqual({ bars: 3, value: 30 });
  });

  it('returns undefined without any indicator', () => {
    expect(screenProgress(['hello', 'world'])).toBeUndefined();
  });
});

describe('isProcessExcluded', () => {
  it('matches user entries as case-insensitive substrings', () => {
    expect(isProcessExcluded('docker', ['DOCKER'])).toBe(true);
    expect(isProcessExcluded('docker-compose', ['docker'])).toBe(true);
    expect(isProcessExcluded('pacman', ['docker', 'wget'])).toBe(false);
    expect(isProcessExcluded(undefined, ['docker'])).toBe(false);
    expect(isProcessExcluded('docker', 'docker')).toBe(false);
    expect(isProcessExcluded('docker', ['  '])).toBe(false);
  });

  it('excludes the built-in monitor/pager list exactly', () => {
    expect(isProcessExcluded('top', [])).toBe(true);
    expect(isProcessExcluded('htop', undefined)).toBe(true);
    expect(isProcessExcluded('vim', undefined)).toBe(true);
    // comm variants carry the real binary name.
    expect(isProcessExcluded('vim.basic', undefined)).toBe(true);
    // Exact match: real progress producers that merely contain a builtin
    // name must still be tracked.
    expect(isProcessExcluded('topgrade', undefined)).toBe(false);
    expect(isProcessExcluded('stop', undefined)).toBe(false);
  });
});

describe('progress plugin screen tracking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports the bottom-most bar only after the debounce', async () => {
    const h = makeCtx({ process: 'pacman' });
    h.screen.push('pkg-a [#####-----] 50%', 'Total (3/10)');

    await output(h);
    expect(h.session.progress).toBe(0); // still debouncing

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.session.progress).toBe(30);
    expect(h.pluginStateStore.progress).toMatchObject({ progress: 30, wrote: true });
  });

  it('never reports a bar that flashes by faster than the debounce', async () => {
    const h = makeCtx({ process: 'docker' });
    h.screen.push('layer [##########] 100%');
    await output(h);
    h.screen.length = 0;
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.session.progress).toBe(0);
  });

  it('withdraws the value once no bar remains on screen', async () => {
    const h = makeCtx({ process: 'wget' });
    h.screen.push('file.iso [####------] 40%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.session.progress).toBe(40);

    h.screen.length = 0;
    h.screen.push('saved [1234/1234]'); // still a fraction -> still progress
    await output(h);
    expect(h.session.progress).toBe(100);

    h.screen.length = 0;
    h.screen.push('$ ');
    await output(h);
    // First empty scan is only a miss; the second consecutive one resets.
    await output(h);
    expect(h.session.progress).toBe(0);
    expect(h.pluginStateStore.progress).toMatchObject({ wrote: false });
  });

  it('tracks nothing while no foreground process runs', async () => {
    const h = makeCtx({ process: undefined });
    h.session.process = undefined;
    h.screen.push('stale [##########] 100%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.session.progress).toBe(0);
  });

  it('tracks nothing for excluded processes', async () => {
    const h = makeCtx({
      process: 'docker',
      settings: { excludeProcesses: ['Docker'] },
    });
    h.screen.push('layer [##########] 100%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.session.progress).toBe(0);
  });

  it('stays out of the way while a task provider owns the progress', async () => {
    const h = makeCtx({ process: 'devin', progressHandled: true });
    h.screen.push('[#####-----] 50%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.session.progress).toBe(0);
  });

  it('clears a reported value when the process ends', async () => {
    const h = makeCtx({ process: 'wget' });
    h.screen.push('[#####-----] 50%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.session.progress).toBe(50);

    h.session.process = undefined;
    progressPlugin.onProcessEnd?.(h.ctx);
    expect(h.session.progress).toBe(0);
    // The leftover frame stays on screen but must not be re-reported.
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.session.progress).toBe(0);
  });

  it('restarts the debounce after a new command', async () => {
    const h = makeCtx({ process: 'wget' });
    h.screen.push('[#####-----] 50%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.session.progress).toBe(50);

    progressPlugin.onCommand?.(h.ctx, 'wget other-file');
    expect(h.session.progress).toBe(0);

    h.screen.length = 0;
    h.screen.push('[##--------] 20%');
    await output(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.session.progress).toBe(20);
  });
});
