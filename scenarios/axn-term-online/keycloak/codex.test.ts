import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentEventFile } from './agentHookBridge';
import { codexPlugin } from './codex';
import { CODEX_HOOK_EVENTS, mapCodexHookEvent } from './codexHooks';
import {
  dispatchClose,
  dispatchOutput,
  dispatchProcessEnd,
  makeHarness,
  TEST_HOME,
  TEST_TTY,
} from './agentTestkit';

const EVENT_FILE = agentEventFile(TEST_HOME, 'codex', TEST_TTY);

describe('mapCodexHookEvent', () => {
  it('maps activity events to running + clear', () => {
    for (const name of [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
    ]) {
      expect(mapCodexHookEvent({ hook_event_name: name })).toEqual({
        status: 'running',
        attention: null,
      });
    }
  });

  it('maps PermissionRequest to blocked + critical attention with the tool name', () => {
    expect(
      mapCodexHookEvent({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
    ).toEqual({
      status: 'blocked',
      attention: { level: 'critical', message: 'codex needs permission: Bash' },
    });
  });

  it('maps Stop to completed and Interrupt to idle', () => {
    expect(mapCodexHookEvent({ hook_event_name: 'Stop' })).toEqual({
      status: 'completed',
      attention: null,
    });
    expect(mapCodexHookEvent({ hook_event_name: 'Interrupt' })).toEqual({
      status: 'idle',
      attention: null,
    });
  });

  it('SessionStart is idle + clear; SessionEnd clears attention only', () => {
    expect(mapCodexHookEvent({ hook_event_name: 'SessionStart' })).toEqual({
      status: 'idle',
      attention: null,
    });
    expect(mapCodexHookEvent({ hook_event_name: 'SessionEnd' })).toEqual({
      attention: null,
    });
  });

  it('ignores unknown events', () => {
    expect(mapCodexHookEvent({ hook_event_name: 'PreCompact' })).toBeNull();
    expect(mapCodexHookEvent({})).toBeNull();
  });
});

describe('codex hook bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconciles Stop on exit when the CLI finishes between polling ticks', async () => {
    const h = makeHarness('codex');
    dispatchOutput(codexPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
    h.files.set(EVENT_FILE, JSON.stringify({ hook_event_name: 'Stop' }));
    h.session.process = undefined;
    dispatchProcessEnd(codexPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updateSessionCalls).toContainEqual({ sessionId: h.session.id, patch: { status: 'completed' } });
    dispatchClose(codexPlugin, h.ctx);
  });

  /** Trigger detection, then let tty/home resolution + the first poll land. */
  async function startCodex(h: ReturnType<typeof makeHarness>) {
    dispatchOutput(codexPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
  }

  function writeEvent(h: ReturnType<typeof makeHarness>, ev: Record<string, unknown>) {
    h.files.set(EVENT_FILE, JSON.stringify(ev));
  }

  it('maps PermissionRequest to blocked + critical attention', async () => {
    const h = makeHarness('codex');
    writeEvent(h, { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
    await startCodex(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'blocked' },
    });
    expect(h.attentionCalls).toContainEqual(
      expect.objectContaining({ level: 'critical', message: 'codex needs permission: Write' }),
    );
    dispatchClose(codexPlugin, h.ctx);
  });

  it('maps Stop to completed and keeps the badge on process end', async () => {
    const h = makeHarness('codex');
    writeEvent(h, { hook_event_name: 'Stop' });
    await startCodex(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'completed' },
    });
    // Simulate the session now showing 'completed' and the process exiting.
    h.session.status = 'completed';
    dispatchProcessEnd(codexPlugin, h.ctx);
    expect(h.updateSessionCalls.filter((c) => c.patch.status === 'idle')).toEqual([]);
    dispatchClose(codexPlugin, h.ctx);
  });

  it('clears attention on renewed activity', async () => {
    const h = makeHarness('codex');
    writeEvent(h, { hook_event_name: 'PermissionRequest' });
    await startCodex(h);
    await vi.advanceTimersByTimeAsync(1600);
    writeEvent(h, { hook_event_name: 'PreToolUse' });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'running' },
    });
    expect(h.attentionCalls.at(-1)).toBeNull();
    dispatchClose(codexPlugin, h.ctx);
  });

  it('installs hook entries into ~/.codex/hooks.json when enabled', async () => {
    const h = makeHarness('codex', {}, {}, { installHooks: true });
    await startCodex(h);
    await vi.waitFor(() => {
      expect(h.files.has(`${TEST_HOME}/.codex/hooks.json`)).toBe(true);
    });
    const config = JSON.parse(h.files.get(`${TEST_HOME}/.codex/hooks.json`)!);
    const command = `'${TEST_HOME}/.axn-term/agent-hook.sh' codex`;
    for (const event of CODEX_HOOK_EVENTS) {
      expect(config.hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: `${command} '${event}'`, timeout: 10 }] },
      ]);
    }
    dispatchClose(codexPlugin, h.ctx);
  });

  it('removes hook entries when disabled', async () => {
    const h = makeHarness('codex');
    h.files.set(
      `${TEST_HOME}/.codex/hooks.json`,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'other.sh' }] },
            {
              hooks: [
                { type: 'command', command: `'${TEST_HOME}/.axn-term/agent-hook.sh' codex` },
              ],
            },
          ],
        },
      }),
    );
    await startCodex(h);
    await vi.waitFor(() => {
      const config = JSON.parse(h.files.get(`${TEST_HOME}/.codex/hooks.json`)!);
      expect(config.hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: 'other.sh' }] },
      ]);
    });
    dispatchClose(codexPlugin, h.ctx);
  });

  it('clears a terminal badge when a new command is submitted', () => {
    const h = makeHarness('codex', { status: 'completed' });
    codexPlugin.onCommand?.(h.ctx, 'ls');
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'idle' },
    });
  });
});
