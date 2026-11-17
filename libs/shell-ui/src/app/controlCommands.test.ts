import { describe, it, expect } from 'vitest';
import { controlReply, dispatchAppCommand, sessionForPty } from './controlCommands';
import type { SessionViewPlugin } from './session-plugins/plugin';
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

describe('dispatchAppCommand', () => {
  const plugin = (commands: SessionViewPlugin['commands']): SessionViewPlugin => ({
    id: 'p',
    title: 'P',
    commands,
  });
  const run = (plugins: SessionViewPlugin[], line: string) =>
    dispatchAppCommand(plugins, line, () => undefined);

  it('runs a command declaring appRun, without a session', async () => {
    const reply = await run([plugin([{ name: 'axn-x', appRun: (_ctx, arg) => `echo ${JSON.stringify(`got ${arg}`)}` }])], 'axn-x hi');
    expect(reply).toEqual({ ok: true, message: 'got hi' });
  });
  it('refuses a session-only command', async () => {
    const reply = await run([plugin([{ name: 'axn-x', run: () => false }])], 'axn-x');
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('not an app-level');
  });
  it('refuses unknown commands', async () => {
    expect((await run([], 'axn-nope')).ok).toBe(false);
  });
  it('reports a throwing handler as an error', async () => {
    const reply = await run([plugin([{ name: 'axn-x', appRun: () => { throw new Error('boom'); } }])], 'axn-x');
    expect(reply).toEqual({ ok: false, error: 'axn-x: boom' });
  });
});
