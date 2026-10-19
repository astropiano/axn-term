import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentEventFile } from './agentHookBridge';
import { geminiPlugin } from './gemini';
import { agentLaunchLine } from './devWorkflow';
import { GEMINI_HOOK_EVENTS, mapGeminiHookEvent } from './geminiHooks';
import {
  dispatchClose,
  dispatchOutput,
  dispatchProcessEnd,
  makeHarness,
  TEST_HOME,
  TEST_TTY,
} from './agentTestkit';

const EVENT_FILE = agentEventFile(TEST_HOME, 'gemini', TEST_TTY);

describe('mapGeminiHookEvent', () => {
  it('maps activity events to running + clear', () => {
    for (const name of ['BeforeAgent', 'BeforeTool', 'AfterTool']) {
      expect(mapGeminiHookEvent({ hook_event_name: name })).toEqual({
        status: 'running',
        attention: null,
      });
    }
  });

  it('maps AfterAgent to completed + clear', () => {
    expect(mapGeminiHookEvent({ hook_event_name: 'AfterAgent' })).toEqual({
      status: 'completed',
      attention: null,
    });
  });

  it('maps ToolPermission notifications to critical attention', () => {
    expect(
      mapGeminiHookEvent({
        hook_event_name: 'Notification',
        notification_type: 'ToolPermission',
        message: 'run_shell_command needs approval',
      }),
    ).toEqual({
      status: 'blocked',
      attention: { level: 'critical', message: 'run_shell_command needs approval' },
    });
  });

  it('maps other notifications to warning attention', () => {
    expect(
      mapGeminiHookEvent({ hook_event_name: 'Notification', message: 'Idle for a while' }),
    ).toEqual({
      status: 'blocked',
      attention: { level: 'warning', message: 'Idle for a while' },
    });
    expect(mapGeminiHookEvent({ hook_event_name: 'Notification' })?.attention).toEqual({
      level: 'warning',
      message: 'gemini needs input',
    });
  });

  it('SessionStart is idle + clear; SessionEnd clears attention only', () => {
    expect(mapGeminiHookEvent({ hook_event_name: 'SessionStart' })).toEqual({
      status: 'idle',
      attention: null,
    });
    expect(mapGeminiHookEvent({ hook_event_name: 'SessionEnd' })).toEqual({
      attention: null,
    });
  });

  it('ignores unknown events', () => {
    expect(mapGeminiHookEvent({ hook_event_name: 'BeforeModel' })).toBeNull();
    expect(mapGeminiHookEvent({})).toBeNull();
  });
});

describe('gemini hook bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Trigger detection, then let tty/home resolution + the first poll land. */
  async function startGemini(h: ReturnType<typeof makeHarness>) {
    dispatchOutput(geminiPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
  }

  function writeEvent(h: ReturnType<typeof makeHarness>, ev: Record<string, unknown>) {
    h.files.set(EVENT_FILE, JSON.stringify(ev));
  }

  it('maps a ToolPermission notification to blocked + critical attention', async () => {
    const h = makeHarness('gemini');
    writeEvent(h, {
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      message: 'write_file needs approval',
    });
    await startGemini(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'blocked' },
    });
    expect(h.attentionCalls).toContainEqual(
      expect.objectContaining({ level: 'critical', message: 'write_file needs approval' }),
    );
    dispatchClose(geminiPlugin, h.ctx);
  });

  it('maps AfterAgent to completed', async () => {
    const h = makeHarness('gemini');
    writeEvent(h, { hook_event_name: 'AfterAgent' });
    await startGemini(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'completed' },
    });
    dispatchClose(geminiPlugin, h.ctx);
  });

  it('installs hook entries into ~/.gemini/settings.json when enabled', async () => {
    const h = makeHarness('gemini', {}, {}, { installHooks: true });
    await startGemini(h);
    await vi.waitFor(() => {
      expect(h.files.has(`${TEST_HOME}/.gemini/settings.json`)).toBe(true);
    });
    const config = JSON.parse(h.files.get(`${TEST_HOME}/.gemini/settings.json`)!);
    const command = `'${TEST_HOME}/.axn-term/agent-hook.sh' gemini`;
    for (const event of GEMINI_HOOK_EVENTS) {
      expect(config.hooks[event]).toEqual([{ hooks: [{ type: 'command', command: `${command} '${event}'` }] }]);
    }
    dispatchClose(geminiPlugin, h.ctx);
  });

  it('keeps a completed badge on process end, resets mid-run exits', async () => {
    const done = makeHarness('gemini', { status: 'completed' });
    dispatchProcessEnd(geminiPlugin, done.ctx);
    expect(done.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);

    const mid = makeHarness('gemini', { status: 'blocked' });
    dispatchProcessEnd(geminiPlugin, mid.ctx);
    expect(mid.updateSessionCalls).toContainEqual({
      sessionId: mid.session.id,
      patch: { status: 'idle' },
    });
  });
});

function decodePromptArg(line: string): string | undefined {
  const m = line.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/);
  return m ? atob(m[1]) : undefined;
}

describe('gemini agent launcher', () => {
  it('folds instructions into the seed prompt when writeGeminiMd is off', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: false });
    geminiPlugin.onOutput?.(h.ctx, 'x');
    const line = await agentLaunchLine(
      'gemini',
      { instructions: 'be terse' },
      'do it',
      h.ctx,
      '/repo',
    );
    expect(decodePromptArg(line)).toBe('be terse\n\ndo it');
    expect(h.files.has('/repo/GEMINI.md')).toBe(false);
  });

  it('writes a NEW GEMINI.md when writeGeminiMd is on; the prompt stays the seed', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: true });
    geminiPlugin.onOutput?.(h.ctx, 'x');
    const line = await agentLaunchLine(
      'gemini',
      { instructions: 'be terse' },
      'do it',
      h.ctx,
      '/repo',
    );
    expect(h.files.get('/repo/GEMINI.md')).toBe('be terse\n');
    expect(decodePromptArg(line)).toBe('do it');
  });

  it('reads instructions-file for the GEMINI.md body', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: true });
    h.files.set('/repo/AGENT.md', 'file instructions\n');
    geminiPlugin.onOutput?.(h.ctx, 'x');
    await agentLaunchLine(
      'gemini',
      { instructionsFile: '/repo/AGENT.md' },
      undefined,
      h.ctx,
      '/repo',
    );
    expect(h.files.get('/repo/GEMINI.md')).toBe('file instructions\n');
  });

  it('refuses when GEMINI.md exists and never modifies it', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: true });
    h.files.set('/repo/GEMINI.md', 'user content\n');
    (h.ctx as { statPath: unknown }).statPath = async (p: string) =>
      h.files.has(p) ? { path: p, isFile: true, isDir: false } : null;
    geminiPlugin.onOutput?.(h.ctx, 'x');
    await expect(
      agentLaunchLine('gemini', { instructions: 'new' }, undefined, h.ctx, '/repo'),
    ).rejects.toThrow(/GEMINI\.md already exists/);
    expect(h.files.get('/repo/GEMINI.md')).toBe('user content\n');
  });

  it('propagates write failures', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: true });
    (h.ctx as { writeFile: unknown }).writeFile = async () => {
      throw new Error('read-only fs');
    };
    geminiPlugin.onOutput?.(h.ctx, 'x');
    await expect(
      agentLaunchLine('gemini', { instructions: 'x' }, undefined, h.ctx, '/repo'),
    ).rejects.toThrow('read-only fs');
  });

  it('no instructions → plain launch line regardless of the setting', async () => {
    const h = makeHarness('gemini', {}, {}, { writeGeminiMd: true });
    geminiPlugin.onOutput?.(h.ctx, 'x');
    const line = await agentLaunchLine('gemini', {}, 'hi', h.ctx, '/repo');
    expect(line).toMatch(/^gemini -- /);
    expect(h.files.has('/repo/GEMINI.md')).toBe(false);
  });
});
