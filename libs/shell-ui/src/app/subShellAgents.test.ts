import { describe, it, expect, vi } from 'vitest';
import type { EditorTab } from '../types';
import {
  agentOfProcess,
  captureAgentResume,
  registerSubShellCloser,
  runSubShellClosers,
  subShellSpawnCommand,
} from './subShellAgents';

const tab = (patch: Partial<EditorTab>): EditorTab => ({ id: 't1', path: '', kind: 'shell', ...patch });

describe('agentOfProcess', () => {
  it('recognises claude and devin, nothing else', () => {
    expect(agentOfProcess('claude')).toBe('claude');
    expect(agentOfProcess('devin')).toBe('devin');
    expect(agentOfProcess('vim')).toBeUndefined();
    expect(agentOfProcess(null)).toBeUndefined();
  });
});

describe('captureAgentResume', () => {
  it('turns claude’s exit hint into an exact resume line', () => {
    const out = '\x1b[2m\r\nResume this session with:\r\nclaude --resume 2d05aba3-98eb-4a17\r\n';
    expect(captureAgentResume('claude', out)).toBe('claude --resume 2d05aba3-98eb-4a17');
    expect(
      captureAgentResume('claude', 'Resume this session with:\nclaude --worktree "wt-a" --resume x1\n'),
    ).toBe("claude --worktree 'wt-a' --resume x1");
  });

  it('turns devin’s exit hint into devin -r <name>', () => {
    const out = ' devin -r gray-party\n resumes this session · devin -r lists recent sessions\n';
    expect(captureAgentResume('devin', out)).toBe('devin -r gray-party');
  });

  it('ignores output without a complete hint', () => {
    expect(captureAgentResume('claude', 'Resume this session with:\nclaude --resume 2d0')).toBeUndefined();
  });
});

describe('subShellSpawnCommand', () => {
  it('resumes the exact conversation of an agent running at close', () => {
    expect(
      subShellSpawnCommand(tab({ agentActive: 'claude', agentResume: 'claude --resume abc' })),
    ).toBe('claude --resume abc; exec "${SHELL:-sh}" -l');
  });

  it('falls back to "continue latest" without a captured id, and ignores another agent’s id', () => {
    expect(subShellSpawnCommand(tab({ agentActive: 'claude' }))).toBe('claude -c; exec "${SHELL:-sh}" -l');
    expect(subShellSpawnCommand(tab({ agentActive: 'devin', agentResume: 'claude --resume abc' }))).toBe(
      'devin -c; exec "${SHELL:-sh}" -l',
    );
  });

  it('starts a plain shell (or the tab’s own command) when no agent was running', () => {
    expect(subShellSpawnCommand(tab({}))).toBeUndefined();
    expect(subShellSpawnCommand(tab({ command: 'make test' }))).toBe('make test');
    expect(subShellSpawnCommand(tab({ agentResume: 'claude --resume abc' }))).toBeUndefined();
  });

  it('keeps talk tabs on their own resumeCommand', () => {
    expect(
      subShellSpawnCommand(
        tab({ agent: 'claude', agentActive: 'claude', resumeCommand: 'claude --resume x; exec "${SHELL:-sh}" -l' }),
      ),
    ).toBe('claude --resume x; exec "${SHELL:-sh}" -l');
  });
});

describe('runSubShellClosers', () => {
  it('awaits every registered closer, bounded by a timeout', async () => {
    vi.useFakeTimers();
    try {
      const ran: string[] = [];
      const off1 = registerSubShellCloser('a', async () => {
        ran.push('a');
      });
      const off2 = registerSubShellCloser('b', () => new Promise(() => ran.push('b-hung')));
      const done = runSubShellClosers(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(ran).toEqual(['a', 'b-hung']);
      off1();
      off2();
    } finally {
      vi.useRealTimers();
    }
  });
});
