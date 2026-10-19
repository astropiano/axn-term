import { describe, expect, it } from 'vitest';
import {
  defaultTabLabel,
  planSubShellPromote,
  planTurnIntoWorkspace,
} from './subshellPromote';
import type { ShellSession } from '../types';

function makeSession(overrides: Partial<ShellSession> = {}): ShellSession {
  return {
    id: 's1',
    workspaceId: 'w1',
    name: 'my-session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    ...overrides,
  };
}

describe('planSubShellPromote', () => {
  const editors = [
    { id: 'ed-1', path: '/tmp/a.ts' },
    { id: 'sh-1', path: '', kind: 'shell' as const, label: 'devin' },
    { id: 'sh-2', path: '', kind: 'shell' as const, command: 'make test' },
  ];

  it('swaps the sub-shell tab with the main shell', () => {
    const plan = planSubShellPromote(makeSession({ editors }), 'sh-1');
    expect(plan).not.toBeNull();
    expect(plan!.patch.mainPtyId).toBe('sh-1');
    expect(plan!.patch.activeTab).toBe('shell');
    // The promoted tab is replaced by the demoted main PTY (session.id),
    // labeled with the session name; other tabs are untouched.
    expect(plan!.patch.editors).toEqual([
      { id: 'ed-1', path: '/tmp/a.ts' },
      { id: 's1', path: '', kind: 'shell', label: 'my-session' },
      { id: 'sh-2', path: '', kind: 'shell', command: 'make test' },
    ]);
    // The promoted PTY detaches to root; the demoted main re-parents to it.
    expect(plan!.reparent).toEqual([
      ['sh-1', null],
      ['s1', 'sh-1'],
    ]);
    expect(plan!.keepAlive).toEqual(['sh-1', 's1']);
  });

  it('re-parents against the current main PTY when already promoted', () => {
    // s1 was already promoted once: sub2 is main, s1 is a tab.
    const session = makeSession({
      mainPtyId: 'sh-1',
      editors: [
        { id: 's1', path: '', kind: 'shell' as const },
        { id: 'sh-2', path: '', kind: 'shell' as const },
      ],
    });
    const plan = planSubShellPromote(session, 'sh-2');
    expect(plan).not.toBeNull();
    expect(plan!.patch.mainPtyId).toBe('sh-2');
    // The previous main (sh-1), not session.id, becomes the sub-shell tab.
    expect(plan!.patch.editors).toEqual([
      { id: 's1', path: '', kind: 'shell' },
      { id: 'sh-1', path: '', kind: 'shell', label: 'my-session' },
    ]);
    expect(plan!.reparent).toEqual([
      ['sh-2', null],
      ['sh-1', 'sh-2'],
    ]);
  });

  it('promoting the demoted main back restores the swap', () => {
    const session = makeSession({
      mainPtyId: 'sh-1',
      editors: [{ id: 's1', path: '', kind: 'shell' as const }],
    });
    const plan = planSubShellPromote(session, 's1');
    expect(plan).not.toBeNull();
    expect(plan!.patch.mainPtyId).toBe('s1');
    expect(plan!.patch.editors).toEqual([
      { id: 'sh-1', path: '', kind: 'shell', label: 'my-session' },
    ]);
  });

  it('returns null for missing, non-shell, or already-main tabs', () => {
    const session = makeSession({ editors });
    expect(planSubShellPromote(session, 'nope')).toBeNull();
    expect(planSubShellPromote(session, 'ed-1')).toBeNull();
    expect(planSubShellPromote(session, 's1')).toBeNull();
    expect(planSubShellPromote(makeSession({ editors, mainPtyId: 'sh-1' }), 'sh-1')).toBeNull();
  });
});

describe('planTurnIntoWorkspace', () => {
  it('adopts every sub-shell tab in order, keeping the session name', () => {
    const session = makeSession({
      editors: [
        { id: 'sh-1', path: '', kind: 'shell' as const, label: 'devin' },
        { id: 'ed-1', path: '/tmp/a.ts' },
        { id: 'sh-2', path: '', kind: 'shell' as const, command: 'make test' },
      ],
    });
    const plan = planTurnIntoWorkspace(session);
    expect(plan).not.toBeNull();
    expect(plan!.workspaceName).toBe('my-session');
    expect(plan!.sessions).toEqual([
      { id: 'sh-1', name: 'devin', cwd: undefined },
      { id: 'sh-2', name: 'make test', cwd: undefined },
    ]);
    // Non-shell tabs stay on the original session.
    expect(plan!.patch.editors).toEqual([{ id: 'ed-1', path: '/tmp/a.ts' }]);
    expect(plan!.patch.activeTab).toBe('shell');
  });

  it('falls back to command/cwd labels', () => {
    const session = makeSession({
      editors: [
        { id: 'sh-1', path: '', kind: 'shell' as const, cwd: '/home/x/proj' },
      ],
    });
    const plan = planTurnIntoWorkspace(session)!;
    expect(plan.sessions[0]).toEqual({ id: 'sh-1', name: 'sh · proj', cwd: '/home/x/proj' });
  });

  it('returns null without sub-shell tabs', () => {
    expect(planTurnIntoWorkspace(makeSession())).toBeNull();
    expect(
      planTurnIntoWorkspace(makeSession({ editors: [{ id: 'e1', path: '/a' }] })),
    ).toBeNull();
  });
});

describe('defaultTabLabel', () => {
  it('prefers command, then cwd dir name, then sh', () => {
    expect(defaultTabLabel({ id: 'a', path: '', command: 'make test' })).toBe('make test');
    expect(defaultTabLabel({ id: 'b', path: '', cwd: '/x/proj' })).toBe('sh · proj');
    expect(defaultTabLabel({ id: 'c', path: '' })).toBe('sh');
  });
});
