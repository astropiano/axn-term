import { describe, expect, it } from 'vitest';
import { createRestoreQueue, createSettleSignal } from './restoreQueue';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createRestoreQueue', () => {
  it('starts at most `concurrency` sessions at once and releases the next on readiness', async () => {
    const q = createRestoreQueue({ concurrency: 2 });
    const readies = new Map<string, () => void>();
    const started: string[] = [];
    for (const id of ['a', 'b', 'c', 'd']) {
      q.enqueue(id, async () => {
        started.push(id);
        return { ready: new Promise<void>((r) => readies.set(id, r)) };
      });
    }
    await flush();
    expect(started).toEqual(['a', 'b']);
    readies.get('a')!();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    readies.get('b')!();
    readies.get('c')!();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(q.stats()).toMatchObject({ queued: 0 });
  });

  it('a session with nothing to wait for settles at once', async () => {
    const q = createRestoreQueue({ concurrency: 1 });
    const started: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      q.enqueue(id, async () => {
        started.push(id);
        // already running / failed to spawn: nothing to wait for
      });
    }
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(q.stats().done).toBe(3);
  });

  it('moves on after the readiness timeout', async () => {
    const q = createRestoreQueue({ concurrency: 1, readyTimeoutMs: 20 });
    const started: string[] = [];
    q.enqueue('a', async () => {
      started.push('a');
      return { ready: new Promise<void>(() => {}) }; // never ready
    });
    q.enqueue('b', async () => {
      started.push('b');
    });
    await flush();
    expect(started).toEqual(['a']);
    await new Promise((r) => setTimeout(r, 40));
    expect(started).toEqual(['a', 'b']);
  });

  it('moves on when a job fails', async () => {
    const q = createRestoreQueue({ concurrency: 1 });
    const started: string[] = [];
    q.enqueue('a', async () => {
      started.push('a');
      throw new Error('spawn failed');
    });
    q.enqueue('b', async () => {
      started.push('b');
    });
    await flush();
    expect(started).toEqual(['a', 'b']);
  });

  it('prioritize puts a waiting session first; cancel drops it; repeats are ignored', async () => {
    const q = createRestoreQueue({ concurrency: 1 });
    const started: string[] = [];
    q.enqueue('a', async () => {
      started.push('a');
      return { ready: new Promise<void>((r) => setTimeout(r, 15)) };
    });
    for (const id of ['b', 'c', 'd']) {
      q.enqueue(id, async () => {
        started.push(id);
      });
    }
    q.enqueue('b', async () => {
      started.push('b-again');
    });
    q.prioritize('d');
    q.cancel('c');
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual(['a', 'd', 'b']);
  });
});

describe('createSettleSignal', () => {
  it('settles only after output, once it has been quiet', async () => {
    const sig = createSettleSignal({ quietMs: 20, isBusy: () => false });
    let done = false;
    void sig.settled.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false); // no output yet
    sig.touch();
    await new Promise((r) => setTimeout(r, 10));
    sig.touch(); // more output restarts the clock
    await new Promise((r) => setTimeout(r, 12));
    expect(done).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(true);
  });

  it('keeps waiting while a plugin restore is still running', async () => {
    let busy = true;
    const sig = createSettleSignal({ quietMs: 10, isBusy: () => busy });
    let done = false;
    void sig.settled.then(() => (done = true));
    sig.touch();
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    busy = false;
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(true);
  });
});
