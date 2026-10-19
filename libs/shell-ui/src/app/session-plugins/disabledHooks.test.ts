import { claudePlugin } from './claude';
import { geminiPlugin } from './gemini';
import type { SessionViewPlugin } from './plugin';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dropHookSpec, ensureHookPolling, hookStatusOwned, agentEventFile, syncHookSpecPlugins } from './agentHookBridge';
import { codexPlugin } from './codex';
import { makeHarness, TEST_HOME, TEST_TTY } from './agentTestkit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('ignores a hook read completing after disposal, even after a new runtime is created', async () => {
  const h = makeHarness('codex');
  const spec = codexPlugin.hookSpec!;
  let finish!: (raw: string) => void;
  const path = agentEventFile(TEST_HOME, 'codex', TEST_TTY);
  h.ctx.readFile = async (p) => {
    if (p === path) return new Promise<string>((r) => { finish = r; });
    throw new Error('ENOENT');
  };
  ensureHookPolling(h.ctx, spec);
  await vi.advanceTimersByTimeAsync(10);
  expect(finish).toBeTypeOf('function');
  dropHookSpec(codexPlugin, h.ctx);
  h.ctx.readFile = async () => '';
  ensureHookPolling(h.ctx, spec);
  await vi.advanceTimersByTimeAsync(10);
  finish(JSON.stringify({ hook_event_name: 'Stop' }));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.updateSessionCalls).toEqual([]);
  expect(hookStatusOwned(spec, h.session.id)).toBe(false);
  dropHookSpec(codexPlugin, h.ctx);
});


const externalPlugin: SessionViewPlugin = {
  id: 'external-agent', title: 'External agent', processPattern: /external-agent/,
  hookSpec: { ...codexPlugin.hookSpec!, agent: 'external-agent', configPath: '.external/hooks.json' },
};

it.each([codexPlugin, claudePlugin, geminiPlugin, externalPlugin])('$id stops polling on disable and resumes without new output', async (plugin) => {
  const h = makeHarness(plugin.id);
  const spec = plugin.hookSpec!;
  const eventPath = agentEventFile(TEST_HOME, spec.agent, TEST_TTY);
  h.files.set(eventPath, JSON.stringify({ hook_event_name: plugin.id === 'gemini' ? 'Notification' : 'PermissionRequest' }));
  const readFile = vi.fn(h.ctx.readFile);
  h.ctx.readFile = readFile;
  syncHookSpecPlugins([], [plugin], () => [h.ctx]);
  await vi.advanceTimersByTimeAsync(10);
  expect(hookStatusOwned(spec, h.session.id)).toBe(true);
  syncHookSpecPlugins([plugin], [], () => [h.ctx]);
  expect(hookStatusOwned(spec, h.session.id)).toBe(false);
  expect(h.attentionCalls[h.attentionCalls.length - 1]).toBeNull();
  h.updateSessionCalls.length = 0;
  readFile.mockClear();
  h.files.set(eventPath, JSON.stringify({ hook_event_name: plugin.id === 'gemini' ? 'AfterAgent' : 'Stop' }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(readFile).not.toHaveBeenCalled();
  expect(h.updateSessionCalls).toEqual([]);
  syncHookSpecPlugins([], [plugin], () => [h.ctx]);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.updateSessionCalls).toContainEqual({ sessionId: h.session.id, patch: { status: 'completed' } });
  syncHookSpecPlugins([plugin], [], () => [h.ctx]);
});

it('does not stop a still-enabled plugin when unrelated settings change', async () => {
  const h = makeHarness('codex');
  syncHookSpecPlugins([], [codexPlugin], () => [h.ctx]);
  await vi.advanceTimersByTimeAsync(10);
  syncHookSpecPlugins([codexPlugin], [codexPlugin], () => [h.ctx]);
  h.files.set(agentEventFile(TEST_HOME, 'codex', TEST_TTY), JSON.stringify({ hook_event_name: 'Stop' }));
  await vi.advanceTimersByTimeAsync(1600);
  expect(h.updateSessionCalls).toContainEqual({ sessionId: h.session.id, patch: { status: 'completed' } });
  syncHookSpecPlugins([codexPlugin], [], () => [h.ctx]);
});

it('cannot restart a disposed poller after delayed path resolution', async () => {
  const h = makeHarness('codex');
  let finish!: (tty: string) => void;
  h.ctx.getTty = () => new Promise<string>((r) => { finish = r; });
  const readFile = vi.fn(h.ctx.readFile);
  h.ctx.readFile = readFile;
  ensureHookPolling(h.ctx, codexPlugin.hookSpec!);
  dropHookSpec(codexPlugin, h.ctx);
  finish(TEST_TTY);
  await vi.advanceTimersByTimeAsync(5000);
  expect(readFile).not.toHaveBeenCalled();
  expect(hookStatusOwned(codexPlugin.hookSpec!, h.session.id)).toBe(false);
});
