import { describe, it, expect } from 'vitest';
import { controlReply, sessionForPty } from './controlCommands';
import type { ShellSession } from '../types';

describe('controlReply', () => {
  it('turns a swallowed line into success', () => {
    expect(controlReply('axn-session-summary hi', false)).toEqual({ ok: true });
  });

  it('passes an echoed message back', () => {
    expect(controlReply('axn-focus x', 'echo "axn-focus: no such tab: x"')).toEqual({
      ok: true,
      message: 'axn-focus: no such tab: x',
    });
  });

  it('refuses shell replacements and unknown commands', () => {
    expect(controlReply('axn-claude-resume', 'claude -c').ok).toBe(false);
    expect(controlReply('axn-nope a', undefined)).toEqual({ ok: false, error: 'not an axn-term command: axn-nope' });
  });
});

describe('sessionForPty', () => {
  const sessions = [
    { id: 's1', name: 'a', mainPtyId: 'tab-9', editors: [{ id: 'tab-2', path: '', kind: 'shell' }] },
    { id: 's2', name: 'b' },
  ] as unknown as ShellSession[];

  it('finds the main shell, a promoted main shell and a sub-shell tab', () => {
    expect(sessionForPty(sessions, 'tab-9')?.id).toBe('s1');
    expect(sessionForPty(sessions, 'tab-2')?.id).toBe('s1');
    expect(sessionForPty(sessions, 's2')?.id).toBe('s2');
    expect(sessionForPty(sessions, 'zzz')).toBeUndefined();
  });
});
