import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentHookSpec } from '@axn-term/plugin-sdk';
import {
  dropHookRuntime,
  ensureHookPolling,
  EVENT_POLL_MS,
  releaseHookRuntime,
} from './agentHookBridge';

const spec = { agent: 'leaktest', events: [], configPath: 'x', mapEvent: () => null } as AgentHookSpec;

// A ctx whose home/state-dir lookups stay pending until `resolveExec`.
function makeCtx() {
  const pending: Array<(v: string) => void> = [];
  const readFile = vi.fn(async () => '');
  const ctx = {
    session: { id: 's1', mainPtyId: 'p1' },
    getSession: () => ({ id: 's1', pluginState: {} }),
    exec: vi.fn(() => new Promise<string>((r) => pending.push(r))),
    getTty: async () => '/dev/pts/9',
    readFile,
    setAttention: vi.fn(),
    updatePluginState: vi.fn(),
    updateSession: vi.fn(),
  };
  const resolveExec = (v: string) => pending.splice(0).forEach((r) => r(v));
  return { ctx: ctx as unknown as Parameters<typeof ensureHookPolling>[0], readFile, resolveExec };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  dropHookRuntime(spec, 's1');
  vi.useRealTimers();
});

it('does not start polling when the agent exited while the tty lookup was pending', async () => {
  const { ctx, readFile, resolveExec } = makeCtx();
  ensureHookPolling(ctx, spec);
  releaseHookRuntime(spec, 's1');
  resolveExec('/home/u');
  await vi.advanceTimersByTimeAsync(0);
  readFile.mockClear();
  await vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 10);
  expect(readFile).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('polls when the agent restarted before the lookup finished', async () => {
  const { ctx, readFile, resolveExec } = makeCtx();
  ensureHookPolling(ctx, spec);
  releaseHookRuntime(spec, 's1');
  ensureHookPolling(ctx, spec);
  resolveExec('/home/u');
  await vi.advanceTimersByTimeAsync(0);
  readFile.mockClear();
  await vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 2);
  expect(readFile).toHaveBeenCalled();
  // and a later release stops it
  releaseHookRuntime(spec, 's1');
  readFile.mockClear();
  await vi.advanceTimersByTimeAsync(EVENT_POLL_MS * 4);
  expect(readFile).not.toHaveBeenCalled();
});
