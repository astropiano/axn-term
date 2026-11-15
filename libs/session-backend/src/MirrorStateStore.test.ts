import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RamphastosSession } from 'ramphastos-client';
import { createMirrorStateStore } from './MirrorStateStore.ts';

function fakeSession() {
  const changeCbs = new Set<() => void>();
  const stateCbs = new Set<(s: string) => void>();
  const s = {
    sessionId: 'x',
    state: 'ready',
    vm: () => ({}),
    onChange: (cb: () => void) => {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    onStateChange: (cb: (st: string) => void) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    change: () => [...changeCbs].forEach((f) => f()),
    close: () => {
      s.state = 'closed';
      [...stateCbs].forEach((f) => f('closed'));
    },
    listeners: () => changeCbs.size + stateCbs.size,
  };
  return s;
}
type Fake = ReturnType<typeof fakeSession>;

describe('MirrorStateStore.watch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the backend to the new session after a reconnect', async () => {
    // Regression: watch subscribed to the first session only — after a
    // transport drop + reconnect the tab list never updated again.
    const s1 = fakeSession();
    const s2 = fakeSession();
    let cur: Fake = s1;
    const store = createMirrorStateStore(async () => cur as unknown as RamphastosSession);
    const cb = vi.fn();
    const stop = store.watch!('w', cb);
    await vi.advanceTimersByTimeAsync(0);
    s1.change();
    await vi.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);

    cur = s2; // transport dropped, backend reconnected
    s1.close();
    expect(s1.listeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    cb.mockClear();
    s2.change();
    await vi.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);

    stop();
    expect(s2.listeners()).toBe(0);
    s2.change();
    await vi.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('retries while the backend is still reconnecting', async () => {
    const s2 = fakeSession();
    let fail = true;
    const store = createMirrorStateStore(async () => {
      if (fail) throw new Error('offline');
      return s2 as unknown as RamphastosSession;
    });
    const cb = vi.fn();
    const stop = store.watch!('w', cb);
    await vi.advanceTimersByTimeAsync(3_000);
    fail = false;
    await vi.advanceTimersByTimeAsync(5_000);
    cb.mockClear();
    s2.change();
    await vi.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not rebind once unsubscribed', async () => {
    // A disposed backend closes its session, then React drops the watch in
    // the same commit — the pending rebind must not reconnect it.
    const s1 = fakeSession();
    const connect = vi.fn(async () => s1 as unknown as RamphastosSession);
    const store = createMirrorStateStore(connect);
    const stop = store.watch!('w', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    s1.close();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
