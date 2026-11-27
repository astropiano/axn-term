import { describe, expect, it } from 'vitest';
import { createOutputScheduler, type BufferTarget } from './outputScheduler';

/** A buffer whose writes finish only when the test says so. */
function fakeBuffer() {
  const written: number[][] = [];
  const pending: Array<() => void> = [];
  const target: BufferTarget = {
    write(data, done) {
      written.push([...data]);
      if (done) pending.push(done);
    },
  };
  return {
    target,
    written,
    flat: () => written.flat(),
    finish: (n = 1) => {
      for (let i = 0; i < n; i++) pending.shift()?.();
    },
    inFlight: () => pending.length,
  };
}

const bytes = (...n: number[]) => new Uint8Array(n);

function setup(opts: Parameters<typeof createOutputScheduler>[0] = {}) {
  const deferred: Array<() => void> = [];
  const events: string[] = [];
  const s = createOutputScheduler({
    maxConcurrent: 2,
    defer: (fn) => deferred.push(fn),
    pause: (id) => events.push(`pause:${id}`),
    resume: (id) => events.push(`resume:${id}`),
    ...opts,
  });
  const runDeferred = () => {
    while (deferred.length) deferred.shift()!();
  };
  return { s, events, runDeferred };
}

describe('createOutputScheduler', () => {
  it('writes straight through while a permit is free', () => {
    const { s } = setup();
    const a = fakeBuffer();
    s.register('a', a.target);
    s.push('a', bytes(1));
    s.push('a', bytes(2));
    expect(a.flat()).toEqual([1, 2]);
    expect(s.stats().queuedBytes).toBe(0);
  });

  it('queues once all permits are in flight and drains as writes finish, in order', () => {
    const { s, runDeferred } = setup();
    const a = fakeBuffer();
    s.register('a', a.target);
    s.push('a', bytes(1));
    s.push('a', bytes(2)); // two in flight
    s.push('a', bytes(3));
    s.push('a', bytes(4));
    expect(a.flat()).toEqual([1, 2]);
    expect(s.stats().queuedBytes).toBe(2);
    a.finish(2);
    runDeferred();
    // both waiting chunks went out as one batch
    expect(a.flat()).toEqual([1, 2, 3, 4]);
    expect(s.stats().queuedBytes).toBe(0);
  });

  it('never lets more than maxConcurrent writes run across sessions', () => {
    const { s, runDeferred } = setup({ maxConcurrent: 2 });
    const bufs = ['a', 'b', 'c', 'd'].map((id) => {
      const b = fakeBuffer();
      s.register(id, b.target);
      return [id, b] as const;
    });
    for (const [id] of bufs) s.push(id, bytes(1));
    const inFlight = () => bufs.reduce((n, [, b]) => n + b.inFlight(), 0);
    expect(inFlight()).toBe(2);
    bufs[0][1].finish();
    runDeferred();
    expect(inFlight()).toBeLessThanOrEqual(2);
    expect(s.stats().queuedSessions).toBeGreaterThan(0);
  });

  it('serves the priority session before the others', () => {
    const { s, runDeferred } = setup({ maxConcurrent: 1 });
    const a = fakeBuffer();
    const b = fakeBuffer();
    const c = fakeBuffer();
    s.register('a', a.target);
    s.register('b', b.target);
    s.register('c', c.target);
    s.push('a', bytes(1)); // takes the only permit
    s.push('b', bytes(2));
    s.push('c', bytes(3));
    s.setPriority('c');
    a.finish();
    runDeferred();
    expect(c.flat()).toEqual([3]);
    expect(b.flat()).toEqual([]);
  });

  it('rotates between waiting sessions so none starves', () => {
    const { s, runDeferred } = setup({ maxConcurrent: 1 });
    const a = fakeBuffer();
    const b = fakeBuffer();
    s.register('a', a.target);
    s.register('b', b.target);
    s.push('a', bytes(1));
    s.push('a', bytes(2));
    s.push('b', bytes(10));
    s.push('b', bytes(11));
    a.finish();
    runDeferred();
    expect(a.flat()).toEqual([1, 2]);
    a.finish();
    runDeferred();
    // a has nothing left, so b gets its turn — as one batch
    expect(b.flat()).toEqual([10, 11]);
  });

  it('pauses a session past the high watermark and resumes below the low one', () => {
    const { s, events, runDeferred } = setup({ maxConcurrent: 1, highWater: 10, lowWater: 3, maxBatchBytes: 4 });
    const a = fakeBuffer();
    s.register('a', a.target);
    s.push('a', new Uint8Array(1)); // in flight
    s.push('a', new Uint8Array(12)); // queued 12 > 10
    expect(events).toEqual(['pause:a']);
    for (let i = 0; i < 10 && s.stats().queuedBytes >= 3; i++) {
      a.finish();
      runDeferred();
    }
    expect(events).toEqual(['pause:a', 'resume:a']);
  });

  it('drain hands the queue to the buffer at once', () => {
    const { s, events } = setup({ maxConcurrent: 1, highWater: 2 });
    const a = fakeBuffer();
    s.register('a', a.target);
    s.push('a', bytes(1));
    s.push('a', bytes(2, 3, 4));
    expect(events).toEqual(['pause:a']);
    s.drain('a');
    expect(a.flat()).toEqual([1, 2, 3, 4]);
    expect(s.stats().queuedBytes).toBe(0);
    expect(events).toEqual(['pause:a', 'resume:a']);
  });

  it('unregister drops the queue and releases a pause', () => {
    const { s, events } = setup({ maxConcurrent: 1, highWater: 1 });
    const a = fakeBuffer();
    s.register('a', a.target);
    s.push('a', bytes(1));
    s.push('a', bytes(2, 3));
    s.unregister('a');
    expect(events).toEqual(['pause:a', 'resume:a']);
    s.push('a', bytes(9)); // unknown id: ignored
    expect(a.flat()).toEqual([1]);
  });
});
