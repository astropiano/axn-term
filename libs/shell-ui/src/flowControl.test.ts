import { describe, expect, it } from 'vitest';
import { createFlowControl } from './flowControl';

function harness() {
  const calls: string[] = [];
  const fc = createFlowControl(() => calls.push('pause'), () => calls.push('resume'), 100, 20);
  return { calls, fc };
}

describe('createFlowControl', () => {
  it('pauses above the high watermark and resumes below the low one', () => {
    const { calls, fc } = harness();
    const done = [fc.track(60), fc.track(60)];
    expect(calls).toEqual(['pause']);
    done[0]();
    expect(calls).toEqual(['pause']); // 60 pending: still above low
    done[1]();
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('never pauses while xterm keeps up', () => {
    const { calls, fc } = harness();
    for (let i = 0; i < 50; i++) fc.track(30)();
    expect(calls).toEqual([]);
  });

  it('resumes on dispose and ignores late write callbacks', () => {
    const { calls, fc } = harness();
    const done = fc.track(200);
    fc.dispose();
    done();
    fc.track(500);
    expect(calls).toEqual(['pause', 'resume']);
  });
});
