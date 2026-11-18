import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionAttention, SessionViewContext, PluginApi } from './plugin';
import { progressPlugin, DEBOUNCE_MS, SCAN_DELAY_MS } from './progress';
import {
  declareProgress,
  declaredActive,
  declaredProgress,
  declaredValue,
  describeDeclaration,
  formatDuration,
  parseDurationMs,
  parseProgressArgs,
  resetDeclaredProgress,
} from './declaredProgress';

type Ctx = SessionViewContext & PluginApi;

let counter = 0;

function makeCtx(overrides: { process?: string } = {}) {
  const screen: string[] = [];
  const session: ShellSession = {
    id: `declared-${++counter}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    process: overrides.process,
  };
  const attention: (SessionAttention | null)[] = [];
  const ctx: Ctx = {
    session,
    updateSession: (_id, patch) => {
      Object.assign(session, patch);
    },
    writeToSession: async () => {},
    updatePluginState: () => {},
    getSession: () => session,
    getSessionCount: () => 1,
    pluginState: {},
    pluginSettings: {},
    exec: async () => '',
    waitForSessionOutput: async () => true,
    getCwd: async () => null,
    openBrowser: () => {},
    openTab: () => {},
    repoMenuItems: () => [],
    isProgressHandled: () => false,
    getScreenLines: () => screen,
    setAttention: (a) => {
      attention.push(a);
    },
    setBanner: () => {},
    setRestoring: () => {},
    appState: undefined,
    updateAppState: () => {},
  };
  return { ctx, session, screen, attention };
}

function run(ctx: Ctx, arg?: string) {
  return progressPlugin.commands![0].run!(ctx, arg, `axn-progress ${arg ?? ''}`);
}

async function output(ctx: Ctx) {
  progressPlugin.onOutput?.(ctx, 'chunk');
  await vi.advanceTimersByTimeAsync(SCAN_DELAY_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDeclaredProgress();
});
afterEach(() => vi.useRealTimers());

describe('parseDurationMs', () => {
  it('parses s/m/h units, composites and bare seconds', () => {
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('10m')).toBe(600_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1h30m')).toBe(5_400_000);
    expect(parseDurationMs('45')).toBe(45_000);
    expect(parseDurationMs('1.5m')).toBe(90_000);
  });

  it('rejects garbage and partial composites', () => {
    expect(parseDurationMs('soon')).toBeUndefined();
    expect(parseDurationMs('10x')).toBeUndefined();
    expect(parseDurationMs('10m30')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
  });
});

describe('declaredValue', () => {
  it('returns a static percentage without an ETA', () => {
    expect(declaredValue({ startPct: 42, startedAt: 1000 }, 5000)).toBe(42);
    expect(declaredValue({ startPct: 150, startedAt: 1000 }, 5000)).toBe(100);
  });

  it('interpolates the glide and parks at 100 past the ETA', () => {
    const d = { startPct: 20, startedAt: 0, etaAt: 10_000, targetPct: 80 };
    expect(declaredValue(d, 0)).toBe(20);
    expect(declaredValue(d, 5_000)).toBe(50);
    expect(declaredValue(d, 9_000)).toBe(74);
    expect(declaredValue(d, 10_000)).toBe(100);
    expect(declaredValue(d, 60_000)).toBe(100);
  });

  it('defaults the glide target to 100', () => {
    const d = { startPct: 0, startedAt: 0, etaAt: 10_000 };
    expect(declaredValue(d, 5_000)).toBe(50);
  });

  it('reports 100 for a done declaration', () => {
    expect(declaredValue({ startPct: 100, startedAt: 0, done: true }, 1)).toBe(100);
  });
});

describe('parseProgressArgs', () => {
  it('queries on bare and --json', () => {
    expect(parseProgressArgs(undefined)).toEqual({ kind: 'query', json: false });
    expect(parseProgressArgs('')).toEqual({ kind: 'query', json: false });
    expect(parseProgressArgs('--json')).toEqual({ kind: 'query', json: true });
  });

  it('parses clear/off/done', () => {
    expect(parseProgressArgs('clear')).toEqual({ kind: 'clear' });
    expect(parseProgressArgs('off')).toEqual({ kind: 'clear' });
    expect(parseProgressArgs('done')).toEqual({
      kind: 'set',
      spec: { startPct: 100, done: true, etaMs: undefined, targetPct: undefined, label: undefined },
    });
  });

  it('parses a bare percentage and an ETA glide', () => {
    expect(parseProgressArgs('42')).toMatchObject({ kind: 'set', spec: { startPct: 42 } });
    expect(parseProgressArgs('--eta 10m')).toMatchObject({
      kind: 'set',
      spec: { etaMs: 600_000 },
    });
    expect(parseProgressArgs('--eta 10m --from 20 --to 90')).toMatchObject({
      kind: 'set',
      spec: { startPct: 20, etaMs: 600_000, targetPct: 90 },
    });
    expect(parseProgressArgs('30 --eta 10m')).toMatchObject({
      kind: 'set',
      spec: { startPct: 30, etaMs: 600_000 },
    });
  });

  it('takes the rest of the line as the label', () => {
    const p = parseProgressArgs('--eta 5m --label three of seven files');
    expect(p).toMatchObject({ kind: 'set', spec: { label: 'three of seven files' } });
    const quoted = parseProgressArgs('--eta 5m --label "quoted label"');
    expect(quoted).toMatchObject({ kind: 'set', spec: { label: 'quoted label' } });
  });

  it('rejects bad input with a usage error', () => {
    for (const arg of [
      '--eta soon',
      '--eta',
      '--from',
      '--to 50',
      '140',
      '--bogus',
      '--json 42',
      '--label',
    ]) {
      expect(parseProgressArgs(arg)).toMatchObject({ kind: 'error' });
    }
  });
});

describe('declaration registry', () => {
  it('last write wins', () => {
    declareProgress('s1', { startPct: 40, startedAt: 1 });
    declareProgress('s1', { startPct: 80, startedAt: 2 });
    expect(declaredProgress('s1')).toMatchObject({ startPct: 80 });
    expect(declaredActive('s1')).toBe(true);
    declareProgress('s1', null);
    expect(declaredActive('s1')).toBe(false);
  });
});

describe('formatDuration / describeDeclaration', () => {
  it('formats compact durations', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(3_720_000)).toBe('1h2m');
  });

  it('describes declarations for the echo reply', () => {
    expect(
      describeDeclaration({ startPct: 42, startedAt: 0 }, 0),
    ).toBe('42%');
    expect(
      describeDeclaration({ startPct: 0, startedAt: 0, etaAt: 60_000 }, 0),
    ).toBe('0% — eta in 1m');
    expect(
      describeDeclaration({ startPct: 0, startedAt: 0, etaAt: 60_000 }, 90_000),
    ).toBe('100% — eta reached');
  });
});

describe('axn-progress command', () => {
  it('sets an explicit percentage and answers the confirmation', () => {
    const { ctx, session } = makeCtx();
    const reply = run(ctx, '42');
    expect(session.progress).toBe(42);
    expect(reply).toContain('42%');
    expect(declaredActive(session.id)).toBe(true);
  });

  it('anchors a bare --eta at the current progress', async () => {
    const { ctx, session } = makeCtx();
    session.progress = 30;
    run(ctx, '--eta 10m');
    const d = declaredProgress(session.id)!;
    expect(d.startPct).toBe(30);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.progress).toBeGreaterThan(30);
    expect(session.progress).toBeLessThan(100);
  });

  it('glides toward the ETA and parks at 100 with a one-shot warning', async () => {
    const { ctx, session, attention } = makeCtx();
    run(ctx, '--eta 5s --from 0 --to 100');
    await vi.advanceTimersByTimeAsync(2_000);
    const midway = session.progress;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(100);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(session.progress).toBe(100);
    const warnings = attention.filter((a) => a?.message === 'ETA reached');
    expect(warnings).toHaveLength(1);

    // Parked: no further writes, no repeated attention.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attention.filter((a) => a?.message === 'ETA reached')).toHaveLength(1);
  });

  it('labels the ETA-reached warning', async () => {
    const { ctx, attention } = makeCtx();
    run(ctx, '--eta 1s --label tests');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attention.at(-1)?.message).toBe('ETA reached — tests');
  });

  it('clear withdraws the bar, the declaration and the flag', async () => {
    const { ctx, session, attention } = makeCtx();
    run(ctx, '50');
    expect(session.progress).toBe(50);
    const reply = run(ctx, 'clear');
    expect(reply).toContain('progress cleared');
    expect(session.progress).toBe(0);
    expect(declaredActive(session.id)).toBe(false);
    expect(attention.at(-1)).toBeNull();
  });

  it('done flashes 100 then releases the bar', async () => {
    const { ctx, session } = makeCtx();
    run(ctx, 'done');
    expect(session.progress).toBe(100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.progress).toBe(0);
    expect(declaredActive(session.id)).toBe(false);
  });

  it('a later declaration replaces the earlier one', async () => {
    const { ctx, session } = makeCtx();
    run(ctx, '40');
    run(ctx, '--eta 1h --from 80');
    expect(declaredProgress(session.id)).toMatchObject({ startPct: 80 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.progress).toBeGreaterThanOrEqual(80);
  });

  it('answers state as text and JSON', () => {
    const { ctx, session } = makeCtx();
    session.progress = 12;
    expect(run(ctx, undefined)).toContain('12%');
    run(ctx, '66 --label build');
    const json = run(ctx, '--json')!;
    const payload = JSON.parse(JSON.parse(json.slice(5)));
    expect(payload).toMatchObject({ progress: 66, source: 'declared' });
    expect(payload.declared).toMatchObject({ pct: 66, label: 'build' });
  });

  it('yields the screen scraper while declared', async () => {
    const { ctx, session, screen } = makeCtx({ process: 'pacman' });
    run(ctx, '55');
    screen.push('pkg [#####-----] 90%');
    await output(ctx);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(session.progress).toBe(55);
  });

  it('releases the declaration when the declaring process ends', async () => {
    const { ctx, session } = makeCtx({ process: 'claude' });
    run(ctx, '70');
    expect(session.progress).toBe(70);
    // claude exits — the shell takes over (foreground process gone).
    session.process = undefined;
    progressPlugin.onProcessEnd?.(ctx);
    expect(declaredActive(session.id)).toBe(false);
    expect(session.progress).toBe(0);
  });

  it('keeps a shell-declared reminder across short commands', async () => {
    // Declared with the shell at the prompt (no foreground process).
    const { ctx, session } = makeCtx();
    session.process = undefined;
    run(ctx, '--eta 10m');
    // `ls` runs and exits — foreground goes undefined → ls → undefined.
    session.process = 'ls';
    session.process = undefined;
    progressPlugin.onProcessEnd?.(ctx);
    expect(declaredActive(session.id)).toBe(true);
  });

  it('tears down on session close and fresh session open', () => {
    const { ctx, session } = makeCtx();
    run(ctx, '33');
    progressPlugin.onClose?.(ctx);
    expect(declaredActive(session.id)).toBe(false);

    const h2 = makeCtx();
    run(h2.ctx, '44');
    progressPlugin.onSessionOpen?.(h2.ctx);
    expect(declaredActive(h2.session.id)).toBe(false);
    expect(h2.session.progress).toBe(0);
  });
});
