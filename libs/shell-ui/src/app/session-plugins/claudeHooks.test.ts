import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENTS,
  claudeEventFile,
  mapClaudeHookEvent,
  mergeClaudeHookSettings,
  parseClaudeHookEvent,
  removeClaudeHookSettings,
} from './claudeHooks';

const SCRIPT = '/home/u/.axn-term/agent-hook.sh';
const COMMAND = `'${SCRIPT}' claude`;

describe('claudeEventFile', () => {
  it('maps a tty to its event file', () => {
    expect(claudeEventFile('/home/u', '/dev/ttys003')).toBe(
      '/home/u/.axn-term/claude-events/ttys003.json',
    );
    expect(claudeEventFile('/home/u', '/dev/pts/0')).toBe(
      '/home/u/.axn-term/claude-events/pts_0.json',
    );
  });
});

describe('mergeClaudeHookSettings', () => {
  it('adds an entry for every subscribed event', () => {
    const merged = mergeClaudeHookSettings({}, SCRIPT);
    const hooks = merged.hooks as Record<string, unknown[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: `${COMMAND} '${event}'`, timeout: 10 }] },
      ]);
    }
  });

  it('preserves unrelated settings and foreign hooks', () => {
    const merged = mergeClaudeHookSettings(
      {
        model: 'opus',
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-lint.sh' }] }],
          CustomEvent: [{ matcher: 'x', hooks: [{ type: 'command', command: 'c.sh' }] }],
        },
      },
      SCRIPT,
    );
    expect(merged.model).toBe('opus');
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.Stop[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: 'my-lint.sh' }],
    });
    expect(hooks.CustomEvent[0]).toEqual({
      matcher: 'x',
      hooks: [{ type: 'command', command: 'c.sh' }],
    });
  });

  it('is idempotent', () => {
    const once = mergeClaudeHookSettings({}, SCRIPT);
    const twice = mergeClaudeHookSettings(once, SCRIPT);
    expect(twice).toEqual(once);
    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1);
  });
});

describe('removeClaudeHookSettings', () => {
  it('preserves foreign handlers in a group that also contains an axn hook', () => {
    const foreign = { type: 'command', command: 'my-lint.sh' };
    const input = { hooks: { Stop: [{ matcher: 'test', hooks: [foreign, { type: 'command', command: COMMAND }] }] } };
    expect(removeClaudeHookSettings(input)).toEqual({ hooks: { Stop: [{ matcher: 'test', hooks: [foreign] }] } });
    const merged = mergeClaudeHookSettings(input, SCRIPT);
    expect((merged.hooks as Record<string, unknown[]>).Stop[0]).toEqual({ matcher: 'test', hooks: [foreign] });
  });
  it('removes axn entries, keeps foreign hooks, drops empty events', () => {
    const settings = {
      model: 'opus',
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'my-lint.sh' }] },
          { hooks: [{ type: 'command', command: COMMAND }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: COMMAND }] }],
      },
    };
    const cleaned = removeClaudeHookSettings(settings);
    const hooks = cleaned.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'my-lint.sh' }] },
    ]);
    expect(hooks.SessionStart).toBeUndefined();
    expect(cleaned.model).toBe('opus');
  });

  it('drops the hooks key entirely when nothing remains', () => {
    const cleaned = removeClaudeHookSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }],
      },
      other: 1,
    });
    expect(cleaned.hooks).toBeUndefined();
    expect(cleaned.other).toBe(1);
  });

  it('removes legacy claude-hook.sh entries too', () => {
    const cleaned = removeClaudeHookSettings({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] },
          {
            matcher: '',
            hooks: [{ type: 'command', command: '/home/u/.axn-term/claude-hook.sh' }],
          },
        ],
      },
    });
    expect((cleaned.hooks as Record<string, unknown[]>).Stop).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] },
    ]);
  });

  it('round-trips with merge', () => {
    const base = { model: 'opus', hooks: {} };
    const merged = mergeClaudeHookSettings(base, SCRIPT);
    expect(removeClaudeHookSettings(merged)).toEqual({ model: 'opus' });
  });
});

describe('mapClaudeHookEvent', () => {
  it('maps activity events to running + clear', () => {
    for (const name of ['UserPromptSubmit', 'PreToolUse', 'SubagentStop']) {
      expect(mapClaudeHookEvent({ hook_event_name: name })).toEqual({
        status: 'running',
        attention: null,
      });
    }
  });

  it('maps PermissionRequest to blocked + critical attention with the tool name', () => {
    expect(
      mapClaudeHookEvent({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
    ).toEqual({
      status: 'blocked',
      attention: { level: 'critical', message: 'claude needs permission: Bash' },
    });
  });

  it('maps Notification to blocked + warning attention with the message', () => {
    expect(
      mapClaudeHookEvent({ hook_event_name: 'Notification', message: 'Claude is waiting' }),
    ).toEqual({
      status: 'blocked',
      attention: { level: 'warning', message: 'Claude is waiting' },
    });
    // Missing message → generic text.
    expect(mapClaudeHookEvent({ hook_event_name: 'Notification' })?.attention).toEqual({
      level: 'warning',
      message: 'claude needs input',
    });
  });

  it('maps Stop to completed + clear', () => {
    expect(mapClaudeHookEvent({ hook_event_name: 'Stop' })).toEqual({
      status: 'completed',
      attention: null,
    });
  });

  it('maps StopFailure to blocked + critical', () => {
    expect(mapClaudeHookEvent({ hook_event_name: 'StopFailure' })).toEqual({
      status: 'blocked',
      attention: { level: 'critical', message: 'claude turn failed' },
    });
  });

  it('SessionStart is idle + clear; SessionEnd clears attention only', () => {
    expect(mapClaudeHookEvent({ hook_event_name: 'SessionStart' })).toEqual({
      status: 'idle',
      attention: null,
    });
    expect(mapClaudeHookEvent({ hook_event_name: 'SessionEnd' })).toEqual({
      attention: null,
    });
  });

  it('ignores unknown events', () => {
    expect(mapClaudeHookEvent({ hook_event_name: 'PostToolUse' })).toBeNull();
    expect(mapClaudeHookEvent({})).toBeNull();
  });
});

describe('parseClaudeHookEvent', () => {
  it('parses a hook payload', () => {
    expect(parseClaudeHookEvent('{"hook_event_name":"Stop","session_id":"x"}')).toEqual({
      hook_event_name: 'Stop',
      session_id: 'x',
    });
  });

  it('rejects garbage, non-objects and payloads without an event name', () => {
    expect(parseClaudeHookEvent('not json')).toBeNull();
    expect(parseClaudeHookEvent('')).toBeNull();
    expect(parseClaudeHookEvent('[1,2]')).toBeNull();
    expect(parseClaudeHookEvent('{"foo":1}')).toBeNull();
  });
});
