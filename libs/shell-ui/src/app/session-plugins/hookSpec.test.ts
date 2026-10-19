import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentHookSpec } from '@axn-term/plugin-sdk';
import { agentEventFile } from '@axn-term/plugin-sdk';
import { syncHookConfig } from './agentHookBridge';
import type { SessionViewPlugin } from './plugin';
import {
  dispatchClose,
  dispatchOutput,
  dispatchProcessEnd,
  dispatchSessionOpen,
  makeHarness,
  TEST_HOME,
  TEST_TTY,
} from './agentTestkit';

/**
 * Host-driven `hookSpec` wiring — simulates an external .mjs plugin whose
 * entire surface is metadata + a hook spec (no lifecycle handlers at all).
 */

const toySpec: AgentHookSpec = {
  agent: 'toy',
  events: ['Go', 'NeedYou', 'Done'],
  configPath: '.toy/config.json',
  mapEvent: (ev) => {
    switch (ev.hook_event_name) {
      case 'Go':
        return { status: 'running', attention: null };
      case 'NeedYou':
        return {
          status: 'blocked',
          attention: {
            level: 'critical',
            message: `toy needs you${ev.what ? `: ${ev.what}` : ''}`,
          },
        };
      case 'Done':
        return { status: 'completed', attention: null };
      default:
        return null;
    }
  },
};

/** The whole plugin — no onOutput/onProcessEnd/onSessionOpen/onClose. */
const toyPlugin: SessionViewPlugin = {
  id: 'toy',
  title: 'toy',
  version: '0.0.1',
  stateKey: 'toy',
  settingsKey: 'toy',
  processPattern: /toyagent/i,
  hookSpec: toySpec,
};

const EVENT_FILE = agentEventFile(TEST_HOME, 'toy', TEST_TTY);

function harness(overrides: Parameters<typeof makeHarness>[1] = {}) {
  return makeHarness('toy', { process: 'toyagent', ...overrides });
}

function writeEvent(h: ReturnType<typeof harness>, ev: Record<string, unknown>) {
  h.files.set(EVENT_FILE, JSON.stringify(ev));
}

describe('hookSpec host wiring (spec-only plugin)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves malformed user hook configuration untouched', async () => {
    const h = makeHarness('broken', { process: 'broken' }, {}, { installHooks: true });
    const path = `${TEST_HOME}/.broken/config.json`;
    h.files.set(path, '{ invalid user JSON');
    syncHookConfig(h.ctx, { ...toySpec, agent: 'broken', configPath: '.broken/config.json' }, true);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.files.get(path)).toBe('{ invalid user JSON');
  });

  it('does not replace unreadable hook configuration', async () => {
    const h = makeHarness('unreadable', { process: 'unreadable' }, {}, { installHooks: true });
    const path = `${TEST_HOME}/.unreadable/config.json`;
    h.files.set(path, '{"userSetting":true}');
    const readFile = h.ctx.readFile;
    h.ctx.readFile = async (file, cwd) => {
      if (file === path) throw new Error('Permission denied');
      return readFile(file, cwd);
    };
    syncHookConfig(h.ctx, { ...toySpec, agent: 'unreadable', configPath: '.unreadable/config.json' }, true);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.files.get(path)).toBe('{"userSetting":true}');
  });

  async function start(h: ReturnType<typeof harness>) {
    dispatchOutput(toyPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
  }

  it('polls the event file and applies mapped status + attention', async () => {
    const h = harness();
    writeEvent(h, { hook_event_name: 'NeedYou', what: 'approve' });
    await start(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'blocked' },
    });
    expect(h.attentionCalls).toContainEqual(
      expect.objectContaining({ level: 'critical', message: 'toy needs you: approve' }),
    );
    dispatchClose(toyPlugin, h.ctx);
  });

  it('does nothing while the process pattern does not match', async () => {
    const h = makeHarness('toy', { process: 'zsh' });
    writeEvent(h, { hook_event_name: 'Go' });
    dispatchOutput(toyPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(3200);
    expect(h.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);
    expect(h.files.has(`${TEST_HOME}/.toy/config.json`)).toBe(false);
    dispatchClose(toyPlugin, h.ctx);
  });

  it('installs hook entries when installHooks is enabled', async () => {
    const h = makeHarness('toy', { process: 'toyagent' }, {}, { installHooks: true });
    dispatchOutput(toyPlugin, h.ctx);
    await vi.waitFor(() => {
      expect(h.files.has(`${TEST_HOME}/.toy/config.json`)).toBe(true);
    });
    const config = JSON.parse(h.files.get(`${TEST_HOME}/.toy/config.json`)!);
    const command = `'${TEST_HOME}/.axn-term/agent-hook.sh' toy`;
    for (const event of ['Go', 'NeedYou', 'Done']) {
      expect(config.hooks[event]).toEqual([{ hooks: [{ type: 'command', command: `${command} '${event}'` }] }]);
    }
    expect(h.files.get(`${TEST_HOME}/.axn-term/agent-hook.sh`)).toContain('#!/bin/sh');
    dispatchClose(toyPlugin, h.ctx);
  });

  it('stops polling and clears the flag on process end', async () => {
    const h = harness();
    writeEvent(h, { hook_event_name: 'NeedYou' });
    await start(h);
    await vi.advanceTimersByTimeAsync(1600);
    h.session.status = 'blocked';
    dispatchProcessEnd(toyPlugin, h.ctx);
    expect(h.attentionCalls.at(-1)).toBeNull();
    // Poll released — later events never land.
    writeEvent(h, { hook_event_name: 'Done' });
    await vi.advanceTimersByTimeAsync(3200);
    expect(h.updateSessionCalls.filter((c) => c.patch.status === 'completed')).toEqual([]);
    dispatchClose(toyPlugin, h.ctx);
  });

  it('keeps a completed badge on process end, resets running to idle', async () => {
    const done = harness({ status: 'completed' });
    dispatchProcessEnd(toyPlugin, done.ctx);
    expect(done.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);
    const mid = harness({ status: 'running' });
    dispatchProcessEnd(toyPlugin, mid.ctx);
    expect(mid.updateSessionCalls).toContainEqual({
      sessionId: mid.session.id,
      patch: { status: 'idle' },
    });
  });

  it('drops the runtime on session open — a fresh PTY re-resolves', async () => {
    const h = harness();
    await start(h);
    await vi.advanceTimersByTimeAsync(1600);
    dispatchSessionOpen(toyPlugin, h.ctx);
    // Runtime forgotten: restart resolves tty/home anew and polls again.
    writeEvent(h, { hook_event_name: 'Done' });
    dispatchOutput(toyPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'completed' },
    });
    dispatchClose(toyPlugin, h.ctx);
  });
});
