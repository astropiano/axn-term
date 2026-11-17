import { describe, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import { acquirePty, nudgePtyRedraw, REDRAW_NUDGE_MS, syncRetainedPtys } from './ptyLifetime';

function harness() {
  const live = new Set<string>();
  const exits: string[] = [];
  const backend: SessionBackend = {
    createSession: vi.fn(async (id) => {
      if (live.has(id)) return false;
      live.add(id);
      return true;
    }),
    close: vi.fn((id) => {
      if (live.delete(id)) exits.push(id);
    }),
    write() {}, resize() {}, onOutput: () => () => {},
  };
  const acquire = (id = 'main') => acquirePty(backend, id, () =>
    backend.createSession(id, { cols: 80, rows: 24 }));
  return { backend, live, exits, acquire };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PTY view lifetime', () => {
  it('survives StrictMode setup/cleanup/setup without an exit or duplicate spawn', async () => {
    const { backend, live, exits, acquire } = harness();
    const first = acquire();
    const abandonedReady = first.start();
    first.release();
    const replay = acquire();
    expect(await replay.start()).toBe(true);
    expect(await abandonedReady).toBe(false);
    await flush();
    expect(backend.createSession).toHaveBeenCalledTimes(1);
    expect(backend.close).not.toHaveBeenCalled();
    expect(live.has('main')).toBe(true);
    expect(exits).toEqual([]);
    replay.release();
    await flush();
    expect(exits).toEqual(['main']);
  });

  it('uses the replacement view rather than the disposed view to start', async () => {
    const { backend } = harness();
    const disposedSpawn = vi.fn(async () => true);
    const liveSpawn = vi.fn(async () => true);
    const first = acquirePty(backend, 'main', disposedSpawn);
    const ready = first.start();
    first.release();
    const second = acquirePty(backend, 'main', liveSpawn);
    await second.start();
    await ready;
    expect(disposedSpawn).not.toHaveBeenCalled();
    expect(liveSpawn).toHaveBeenCalledTimes(1);
    second.release();
    await flush();
  });

  it('does not start a hidden sub-shell or a view removed before startup', async () => {
    const { backend, acquire } = harness();
    const hidden = acquire('hidden');
    const removed = acquire('removed');
    const ready = removed.start();
    hidden.release();
    removed.release();
    await ready;
    await flush();
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
  });

  it('closes a late-created PTY after a real unmount', async () => {
    const { backend } = harness();
    const pending = deferred();
    const lease = acquirePty(backend, 'main', () => pending.promise);
    const ready = lease.start();
    await Promise.resolve(); // backend creation has started
    lease.release();
    await flush();
    expect(backend.close).not.toHaveBeenCalled();
    pending.resolve(true);
    expect(await ready).toBe(false);
    await flush();
    expect(backend.close).toHaveBeenCalledExactlyOnceWith('main');
  });

  it('reclaims an in-flight spawn and delivers the ready hook to its live owner once', async () => {
    const { backend } = harness();
    const pending = deferred();
    const spawn = vi.fn(() => pending.promise);
    const first = acquirePty(backend, 'main', spawn);
    const abandonedReady = first.start();
    await Promise.resolve();
    first.release();
    const second = acquirePty(backend, 'main', spawn);
    const ready = second.start();
    pending.resolve(true);
    expect(await abandonedReady).toBe(false);
    expect(await ready).toBe(true);
    expect(await second.start()).toBe(false);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(backend.close).not.toHaveBeenCalled();
    second.release();
    await flush();
  });

  it('reattaches a promoted PTY without closing it or rerunning ready hooks', async () => {
    const { backend, live, acquire } = harness();
    const original = acquire();
    expect(await original.start()).toBe(true);
    original.release(true);
    await flush();
    expect(live.has('main')).toBe(true);
    const promoted = acquire();
    expect(await promoted.start()).toBe(false);
    expect(backend.close).not.toHaveBeenCalled();
    promoted.release();
    await flush();
    expect(live.size).toBe(0);
  });

  it('does not let a keep-alive handoff suppress a later genuine close', async () => {
    const { live, acquire } = harness();
    const original = acquire();
    await original.start();
    original.release(true);
    const promoted = acquire();
    await promoted.start();
    promoted.release();
    await flush();
    expect(live.size).toBe(0);
  });

  it('restarts an exited sub-shell explicitly, but does not restart a released view', async () => {
    const { backend, live, acquire } = harness();
    const tab = acquire('sub');
    await tab.start();
    live.delete('sub'); // the command exited normally
    expect(await tab.restart()).toBe(true);
    expect(live.has('sub')).toBe(true);
    expect(backend.createSession).toHaveBeenCalledTimes(2);
    tab.release();
    await flush();
    expect(await tab.restart()).toBe(false);
    expect(backend.createSession).toHaveBeenCalledTimes(2);
  });

  it('keeps a keep-alive release sticky across other owners (session-owned PTYs)', async () => {
    const { backend, live, acquire } = harness();
    const view = acquire();
    const session = acquire(); // the permanent session-level owner
    await view.start();
    view.release(true); // window move marks the PTY keep-alive…
    session.release(); // …then the session owner drops — the flag must stick
    await flush();
    expect(live.has('main')).toBe(true);
    expect(backend.close).not.toHaveBeenCalled();
  });

  it('a retained PTY survives a last-owner release — the session closes it explicitly', async () => {
    const { backend, live, acquire } = harness();
    try {
      syncRetainedPtys(['sub']);
      const view = acquire('sub');
      await view.start();
      view.release();
      await flush();
      expect(live.has('sub')).toBe(true);
      expect(backend.close).not.toHaveBeenCalled();
      // Once the session drops the retention, the same release closes it —
      // the re-acquired resource reattaches to the still-live PTY first.
      syncRetainedPtys([]);
      const gone = acquire('sub');
      expect(await gone.start()).toBe(false);
      gone.release();
      await flush();
      expect(backend.close).toHaveBeenCalledExactlyOnceWith('sub');
      expect(live.has('sub')).toBe(false);
    } finally {
      syncRetainedPtys([]);
    }
  });

  it('keeps backend instances isolated even when PTY ids are equal', async () => {
    const left = harness();
    const right = harness();
    const a = left.acquire();
    const b = right.acquire();
    await Promise.all([a.start(), b.start()]);
    a.release();
    await flush();
    expect(left.live.size).toBe(0);
    expect(right.live.has('main')).toBe(true);
    b.release();
    await flush();
  });
});

describe('nudgePtyRedraw', () => {
  const resizer = () => {
    const resize = vi.fn();
    return { resize, backend: { resize } as unknown as SessionBackend };
  };

  it('shrinks by one row, then restores the size after the delay', () => {
    vi.useFakeTimers();
    try {
      const { resize, backend } = resizer();
      nudgePtyRedraw(backend, 'p1', () => ({ cols: 230, rows: 50 }));
      expect(resize.mock.calls).toEqual([['p1', 230, 49]]);
      vi.advanceTimersByTime(REDRAW_NUDGE_MS);
      expect(resize.mock.calls).toEqual([['p1', 230, 49], ['p1', 230, 50]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces back-to-back nudges and restores the latest size', () => {
    vi.useFakeTimers();
    try {
      const { resize, backend } = resizer();
      let size = { cols: 230, rows: 50 };
      nudgePtyRedraw(backend, 'p2', () => size);
      nudgePtyRedraw(backend, 'p2', () => size);
      size = { cols: 200, rows: 40 };
      vi.advanceTimersByTime(REDRAW_NUDGE_MS);
      expect(resize.mock.calls).toEqual([['p2', 230, 49], ['p2', 200, 40]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the last known size when the view is gone', () => {
    vi.useFakeTimers();
    try {
      const { resize, backend } = resizer();
      let size: { cols: number; rows: number } | null = { cols: 120, rows: 30 };
      nudgePtyRedraw(backend, 'p3', () => size);
      size = null;
      vi.advanceTimersByTime(REDRAW_NUDGE_MS);
      expect(resize).toHaveBeenLastCalledWith('p3', 120, 30);
    } finally {
      vi.useRealTimers();
    }
  });
});
