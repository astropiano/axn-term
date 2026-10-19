import { describe, expect, it } from 'vitest';
import { foregroundStatusPatch } from './foregroundStatus';

describe('foreground status polling', () => {
  for (const process of ['claude', 'codex']) {
    for (const status of ['idle', 'blocked', 'completed'] as const) {
      it(`preserves ${process}'s hook-owned ${status} badge on repeated polls`, () => {
        expect(foregroundStatusPatch({ process, status }, process)).toEqual({});
      });
    }
  }
  it('initializes a new process as running', () => {
    expect(foregroundStatusPatch({ status: 'completed' }, 'codex')).toEqual({ process: 'codex', status: 'running' });
  });
  it('retains completion after an agent exits and clears an interrupted run', () => {
    expect(foregroundStatusPatch({ process: 'codex', status: 'completed' }, undefined)).toEqual({ process: undefined, status: 'completed' });
    expect(foregroundStatusPatch({ process: 'claude', status: 'blocked' }, undefined)).toEqual({ process: undefined, status: 'idle' });
  });
});
