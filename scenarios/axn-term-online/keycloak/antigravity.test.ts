import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentEventFile } from './agentHookBridge';
import { antigravityPlugin, parseAgyConversationId } from './antigravity';
import { agentLaunchLine } from './devWorkflow';
import { AGY_HOOK_EVENTS, mapAgyHookEvent } from './antigravityHooks';
import {
  dispatchClose,
  dispatchOutput,
  dispatchProcessEnd,
  makeHarness,
  TEST_HOME,
  TEST_TTY,
} from './agentTestkit';

const EVENT_FILE = agentEventFile(TEST_HOME, 'antigravity', TEST_TTY);

/** The wrapped shape agy-hook.sh logs: discriminator + original payload. */
function wrapped(hookEventName: string, payload: Record<string, unknown> = {}) {
  return { hook_event_name: hookEventName, axn_payload: payload };
}

describe('mapAgyHookEvent', () => {
  it('maps activity events to running + clear', () => {
    for (const name of ['PreInvocation', 'PostToolUse']) {
      expect(mapAgyHookEvent(wrapped(name))).toEqual({ status: 'running', attention: null });
    }
  });

  it('maps Stop to completed, USER_CANCELED/ERROR to idle', () => {
    expect(mapAgyHookEvent(wrapped('Stop'))).toEqual({ status: 'completed', attention: null });
    expect(mapAgyHookEvent(wrapped('Stop', { terminationReason: 'USER_CANCELED' }))).toEqual({
      status: 'idle',
      attention: null,
    });
    expect(mapAgyHookEvent(wrapped('Stop', { terminationReason: 'ERROR' }))).toEqual({
      status: 'idle',
      attention: null,
    });
  });

  it('maps SessionStart to idle + clear', () => {
    expect(mapAgyHookEvent(wrapped('SessionStart'))).toEqual({ status: 'idle', attention: null });
  });

  it('ignores unknown events and unwrapped payloads', () => {
    expect(mapAgyHookEvent(wrapped('PreToolUse'))).toBeNull();
    expect(mapAgyHookEvent({ hook_event_name: 'Stop' })).toEqual({
      status: 'completed',
      attention: null,
    });
    expect(mapAgyHookEvent({})).toBeNull();
  });
});

describe('parseAgyConversationId', () => {
  it('captures the last agy --conversation id, through ANSI noise', () => {
    expect(
      parseAgyConversationId(
        'Resume with: agy --conversation 055a398f-db14-4c5f-abbb-1bf03f8120a7\nbye',
      ),
    ).toBe('055a398f-db14-4c5f-abbb-1bf03f8120a7');
    expect(
      parseAgyConversationId('agy --conversation aaa\nlater\nagy --conversation bbb\n'),
    ).toBe('bbb');
    expect(parseAgyConversationId('no hint here')).toBeUndefined();
  });
});

describe('antigravity hook bridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Trigger detection, then let tty/home resolution + the first poll land. */
  async function startAgy(h: ReturnType<typeof makeHarness>) {
    dispatchOutput(antigravityPlugin, h.ctx);
    await vi.advanceTimersByTimeAsync(10);
  }

  function writeEvent(h: ReturnType<typeof makeHarness>, ev: Record<string, unknown>) {
    h.files.set(EVENT_FILE, JSON.stringify(ev));
  }

  it('maps a Stop event to completed', async () => {
    const h = makeHarness('antigravity');
    writeEvent(h, wrapped('Stop'));
    await startAgy(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'completed' },
    });
    dispatchClose(antigravityPlugin, h.ctx);
  });

  it('maps a user-cancelled Stop to idle', async () => {
    const h = makeHarness('antigravity', { status: 'running' });
    writeEvent(h, wrapped('Stop', { terminationReason: 'USER_CANCELED' }));
    await startAgy(h);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.updateSessionCalls).toContainEqual({
      sessionId: h.session.id,
      patch: { status: 'idle' },
    });
    dispatchClose(antigravityPlugin, h.ctx);
  });

  it('installs the named hook group into ~/.gemini/config/hooks.json when enabled', async () => {
    const h = makeHarness('antigravity', {}, {}, { installHooks: true });
    await startAgy(h);
    await vi.waitFor(() => {
      expect(h.files.has(`${TEST_HOME}/.gemini/config/hooks.json`)).toBe(true);
    });
    const config = JSON.parse(h.files.get(`${TEST_HOME}/.gemini/config/hooks.json`)!);
    const group = config['axn-term'];
    expect(group.enabled).toBe(true);
    const wrapper = `'${TEST_HOME}/.axn-term/agy-hook.sh' '${TEST_HOME}/.axn-term/agent-hook.sh'`;
    for (const event of AGY_HOOK_EVENTS) {
      const list = group[event] as unknown[];
      const hooks =
        event === 'PostToolUse'
          ? (list[0] as { matcher: string; hooks: { command: string }[] }).hooks
          : (list as { command: string }[]);
      if (event === 'PostToolUse') {
        expect((list[0] as { matcher: string }).matcher).toBe('*');
      }
      expect(hooks).toEqual([
        { type: 'command', command: `${wrapper} '${event}'`, timeout: 10 },
      ]);
    }
    // Existing foreign hook groups survive the merge.
    expect(Object.keys(config)).toEqual(['axn-term']);
    dispatchClose(antigravityPlugin, h.ctx);
  });

  it('keeps a completed badge on process end, resets mid-run exits', async () => {
    const done = makeHarness('antigravity', { status: 'completed' });
    dispatchProcessEnd(antigravityPlugin, done.ctx);
    expect(done.updateSessionCalls.filter((c) => c.patch.status)).toEqual([]);

    const mid = makeHarness('antigravity', { status: 'blocked' });
    dispatchProcessEnd(antigravityPlugin, mid.ctx);
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

describe('antigravity agent launcher', () => {
  it('folds instructions into the seed prompt and passes it via -i', async () => {
    const h = makeHarness('antigravity');
    antigravityPlugin.onOutput?.(h.ctx, 'x');
    const line = await agentLaunchLine(
      'agy',
      { instructions: 'be terse' },
      'do it',
      h.ctx,
      '/repo',
    );
    expect(line).toMatch(/^agy -i /);
    expect(decodePromptArg(line)).toBe('be terse\n\ndo it');
  });

  it('no prompt → bare agy launch line (positional prompts are ignored by agy)', async () => {
    const h = makeHarness('antigravity');
    const line = await agentLaunchLine('agy', { model: 'gemini-3-pro' }, undefined, h.ctx, '/repo');
    expect(line).toBe('agy --model gemini-3-pro');
  });

  it('the antigravity alias resolves to the same launcher', async () => {
    const h = makeHarness('antigravity');
    const line = await agentLaunchLine('antigravity', {}, 'hi', h.ctx, '/repo');
    expect(line).toMatch(/^agy -i /);
  });
});
