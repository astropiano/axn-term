import { describe, expect, it } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import { setPtyPaused } from './ptyPause';

function backend() {
  const calls: string[] = [];
  return {
    calls,
    b: {
      pause: (id: string) => calls.push(`pause:${id}`),
      resume: (id: string) => calls.push(`resume:${id}`),
    } as unknown as SessionBackend,
  };
}

describe('setPtyPaused', () => {
  it('pauses on the first vote and resumes when the last is withdrawn', () => {
    const { b, calls } = backend();
    setPtyPaused(b, 'p', 'view', true);
    setPtyPaused(b, 'p', 'buffer', true);
    setPtyPaused(b, 'p', 'view', false);
    expect(calls).toEqual(['pause:p']);
    setPtyPaused(b, 'p', 'buffer', false);
    expect(calls).toEqual(['pause:p', 'resume:p']);
  });

  it('ignores a repeated vote and a withdrawal without a vote', () => {
    const { b, calls } = backend();
    setPtyPaused(b, 'p', 'view', false);
    setPtyPaused(b, 'p', 'view', true);
    setPtyPaused(b, 'p', 'view', true);
    expect(calls).toEqual(['pause:p']);
  });

  it('keeps PTYs apart', () => {
    const { b, calls } = backend();
    setPtyPaused(b, 'a', 'view', true);
    setPtyPaused(b, 'b', 'view', true);
    setPtyPaused(b, 'a', 'view', false);
    expect(calls).toEqual(['pause:a', 'pause:b', 'resume:a']);
  });
});
