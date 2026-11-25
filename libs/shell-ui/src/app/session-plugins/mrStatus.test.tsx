import { describe, expect, it } from 'vitest';
import { mrStatusTone, type MrStatusFacts } from './glabMr';
import { worstTone } from './mrStatus';

const f = (x: Partial<MrStatusFacts> = {}): MrStatusFacts => ({
  draft: false,
  conflicts: false,
  pipeline: 'success',
  mergeStatus: 'not_approved',
  openThreads: 0,
  discussionsResolved: true,
  ...x,
});

describe('mrStatusTone', () => {
  it('green when there is nothing to do', () => {
    expect(mrStatusTone(f()).tone).toBe('green');
  });
  it('red on a failing pipeline or conflicts', () => {
    expect(mrStatusTone(f({ pipeline: 'failed' })).tone).toBe('red');
    expect(mrStatusTone(f({ conflicts: true })).tone).toBe('red');
  });
  it('red when a thread waits on me, yellow when only others can answer', () => {
    const open = { openThreads: 2, mergeStatus: 'discussions_not_resolved' };
    expect(mrStatusTone(f({ ...open, threadSummary: { waitingForMe: 1, waitingForOther: 1 } })).tone).toBe('red');
    expect(mrStatusTone(f({ ...open, threadSummary: { waitingForMe: 0, waitingForOther: 2 } })).tone).toBe('yellow');
  });
  it('red when all green and ready to merge (GitLab mergeable, GitHub clean)', () => {
    expect(mrStatusTone(f({ mergeStatus: 'mergeable' })).tone).toBe('red');
    expect(mrStatusTone(f({ mergeStatus: 'clean' })).tone).toBe('red');
    expect(mrStatusTone(f({ mergeStatus: 'mergeable', draft: true })).tone).toBe('gray');
  });
  it('orange when blocked by another MR or behind', () => {
    expect(mrStatusTone(f({ mergeStatus: 'blocked_status' })).tone).toBe('orange');
    expect(mrStatusTone(f({ mergeStatus: 'behind' })).tone).toBe('orange');
  });
  it('red wins over orange; changes requested is red', () => {
    expect(mrStatusTone(f({ mergeStatus: 'blocked_status', pipeline: 'failed' })).tone).toBe('red');
    expect(mrStatusTone(f({ changesRequested: true })).tone).toBe('red');
  });
  it('yellow while the pipeline runs; orange when threads could not be loaded', () => {
    expect(mrStatusTone(f({ pipeline: 'running' })).tone).toBe('yellow');
    expect(mrStatusTone(f({ openThreads: undefined, discussionsResolved: false })).tone).toBe('orange');
  });
  it('worstTone picks the most urgent', () => {
    expect(worstTone(['green', 'yellow', 'red'])).toBe('red');
    expect(worstTone(['green', 'gray'])).toBe('green');
  });
});
