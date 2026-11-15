import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerChannel } from '../platform';
import type { ShellSession } from '../types';
import { BUILTIN_COMMANDS } from './builtinCommands';
import { requestAdopt, TOPIC_ADOPT, TOPIC_ADOPT_ACK, type AdoptRequest } from './windowPeers';
import {
  TOPIC_WINDOW_READY,
  openTearOffWindow,
  createDragExitTracker,
  dragEndedOutside,
  encodeBootIntent,
  parseBootIntent,
  tearOffPlacement,
  waitForWindowReady,
  type WindowBootIntent,
} from './sessionTearOff';

/** In-memory stand-in for Tauri's app-wide events (delivered to everyone). */
function fakeChannel(): PeerChannel {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  return {
    publish: (topic, payload) => {
      for (const cb of [...(subs.get(topic) ?? [])]) cb(payload);
    },
    subscribe: (topic, cb) => {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic)!.add(cb);
      return () => subs.get(topic)!.delete(cb);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('boot intent', () => {
  const intent: WindowBootIntent = {
    kind: 'tear-off',
    requestId: 'main:1:abc',
    from: 'main',
    workspaceName: 'api & "docs" #2',
  };

  it('round-trips through a URL fragment with only URL-safe characters', () => {
    const fragment = encodeBootIntent(intent);
    // The Rust side splices this into the window URL and accepts only these.
    expect(fragment).toMatch(/^[A-Za-z0-9\-._~%=&]+$/);
    expect(parseBootIntent(`#${fragment}`)).toEqual(intent);
    expect(parseBootIntent(fragment)).toEqual(intent);
  });

  it('is null for windows opened without one', () => {
    expect(parseBootIntent('')).toBeNull();
    expect(parseBootIntent(undefined)).toBeNull();
    expect(parseBootIntent('#/settings')).toBeNull();
  });

  it('rejects malformed or foreign payloads', () => {
    expect(parseBootIntent('#axn-boot=not-json')).toBeNull();
    const enc = (v: unknown) => `#axn-boot=${encodeURIComponent(JSON.stringify(v))}`;
    expect(parseBootIntent(enc({ kind: 'other', requestId: 'r', from: 'main' }))).toBeNull();
    expect(parseBootIntent(enc({ kind: 'tear-off', from: 'main' }))).toBeNull();
    expect(parseBootIntent(enc({ kind: 'tear-off', requestId: '', from: 'main' }))).toBeNull();
    expect(parseBootIntent(enc({ kind: 'tear-off', requestId: 'r', from: 7 }))).toBeNull();
  });

  it('drops a blank workspace name and caps a long one', () => {
    const enc = (v: unknown) => `#axn-boot=${encodeURIComponent(JSON.stringify(v))}`;
    expect(parseBootIntent(enc({ kind: 'tear-off', requestId: 'r', from: 'main', workspaceName: '  ' })))
      .toEqual({ kind: 'tear-off', requestId: 'r', from: 'main' });
    const long = parseBootIntent(enc({ kind: 'tear-off', requestId: 'r', from: 'main', workspaceName: 'x'.repeat(500) }));
    expect(long?.workspaceName).toHaveLength(200);
  });
});

describe('waitForWindowReady', () => {
  const ready = { windowId: 'w-3', requestId: 'req-1', workspace: { id: 'ws-9', name: 'api' } };

  it('resolves with the announcement for its own request only', async () => {
    const peers = fakeChannel();
    const { promise } = waitForWindowReady(peers, 'req-1', 1000);
    peers.publish(TOPIC_WINDOW_READY, { ...ready, requestId: 'someone-else' });
    peers.publish(TOPIC_WINDOW_READY, { windowId: 'w-4', requestId: 'req-1' }); // no workspace
    peers.publish(TOPIC_WINDOW_READY, ready);
    peers.publish(TOPIC_WINDOW_READY, { ...ready, windowId: 'w-late' }); // repeats are ignored
    await expect(promise).resolves.toEqual(ready);
  });

  it('times out with null when the window never comes up', async () => {
    vi.useFakeTimers();
    const { promise } = waitForWindowReady(fakeChannel(), 'req-1', 1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null on cancel and stops listening', async () => {
    const peers = fakeChannel();
    const subscribe = vi.spyOn(peers, 'subscribe');
    const { promise, cancel } = waitForWindowReady(peers, 'req-1', 1000);
    const unsubscribe = subscribe.mock.results[0].value as () => boolean;
    cancel();
    await expect(promise).resolves.toBeNull();
    // Already unsubscribed: a second removal finds nothing.
    expect(unsubscribe()).toBe(false);
  });
});

describe('tearOffPlacement', () => {
  const viewport = { width: 1200, height: 800 };

  it('keeps the source size and lets the window manager place a drop inside the window', () => {
    expect(tearOffPlacement({ screenX: 500, screenY: 300, clientX: 100, clientY: 100 }, viewport)).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('opens at the drop point when it is outside the window', () => {
    expect(tearOffPlacement({ screenX: 2500, screenY: 400, clientX: 1500, clientY: 100 }, viewport)).toEqual({
      width: 1200,
      height: 800,
      x: 2440,
      y: 380,
    });
  });

  it('ignores a zero screen point (Wayland reports none)', () => {
    expect(tearOffPlacement({ screenX: 0, screenY: 0, clientX: -5, clientY: 10 }, viewport)).toEqual({
      width: 1200,
      height: 800,
    });
  });
});

describe('createDragExitTracker', () => {
  /** A document stand-in whose events we fire by hand, in "tasks". */
  function harness() {
    const listeners = new Map<string, Set<() => void>>();
    const deferred: (() => void)[] = [];
    const doc = {
      addEventListener: (type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
    } as unknown as Document;
    const tracker = createDragExitTracker(doc, (fn) => deferred.push(fn));
    /** One native event batch: fire the events, then run deferred tasks. */
    const task = (...types: string[]) => {
      for (const t of types) for (const cb of [...(listeners.get(t) ?? [])]) cb();
      for (const fn of deferred.splice(0)) fn();
    };
    return { tracker, task, listeners };
  }

  it('stays inside while moving between elements (enter + leave in one task)', () => {
    const { tracker, task } = harness();
    tracker.start();
    task('dragenter'); // the row itself
    task('dragover');
    task('dragenter', 'dragleave'); // row → terminal
    task('dragover');
    expect(tracker.stop()).toBe(false);
  });

  it('reports outside after a lone dragleave (pointer left the window)', () => {
    const { tracker, task } = harness();
    tracker.start();
    task('dragenter');
    task('dragleave');
    expect(tracker.stop()).toBe(true);
  });

  it('is inside again once the pointer comes back', () => {
    const { tracker, task } = harness();
    tracker.start();
    task('dragleave');
    task('dragenter');
    expect(tracker.stop()).toBe(false);
  });

  it('removes its listeners on stop and answers false when not started', () => {
    const { tracker, task, listeners } = harness();
    expect(tracker.stop()).toBe(false);
    tracker.start();
    tracker.stop();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    task('dragleave');
  });
});

describe('dragEndedOutside', () => {
  const viewport = { width: 1000, height: 700 };
  it('trusts the tracker, else the coordinates', () => {
    expect(dragEndedOutside({ clientX: 10, clientY: 10 }, viewport, true)).toBe(true);
    expect(dragEndedOutside({ clientX: 10, clientY: 10 }, viewport, false)).toBe(false);
    expect(dragEndedOutside({ clientX: -3, clientY: 10 }, viewport, false)).toBe(true);
    expect(dragEndedOutside({ clientX: 10, clientY: 701 }, viewport, false)).toBe(true);
  });
});

describe('axn-session-window', () => {
  it('is a built-in hidden command', () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === 'axn-session-window')).toBe(true);
    expect(BUILTIN_COMMANDS.some((c) => c.name === 'axn-session-windows')).toBe(false);
  });
});

describe('openTearOffWindow + adopt (two windows over one channel)', () => {
  /**
   * A stand-in for a freshly booted tear-off window: it reads its boot intent
   * from the URL fragment (as the desktop platform does), announces itself
   * like ShellApp, and adopts whatever is handed to it.
   */
  function bootWindow(peers: PeerChannel, windowId: string, fragment: string) {
    const intent = parseBootIntent(`#${fragment}`)!;
    const workspace = { id: `${windowId}-ws`, name: intent.workspaceName ?? 'workspace-1' };
    const adopted: AdoptRequest[] = [];
    peers.subscribe(TOPIC_ADOPT, (payload) => {
      const req = payload as AdoptRequest;
      if (req.to !== windowId) return;
      adopted.push(req);
      peers.publish(TOPIC_ADOPT_ACK, { to: req.from, requestId: req.requestId, ok: true });
    });
    peers.publish(TOPIC_WINDOW_READY, { windowId, requestId: intent.requestId, workspace });
    return { intent, workspace, adopted };
  }

  it('opens the window, waits for it, and hands the session over', async () => {
    const peers = fakeChannel();
    let booted: ReturnType<typeof bootWindow> | undefined;
    const createWindow = vi.fn(async (options: { boot: WindowBootIntent; x?: number; width?: number }) => {
      // Rust only passes the encoded fragment on; boot asynchronously.
      const fragment = encodeBootIntent(options.boot);
      queueMicrotask(() => {
        booted = bootWindow(peers, 'w-2', fragment);
      });
      return 'w-2';
    });

    const opened = await openTearOffWindow(peers, createWindow, {
      from: 'main',
      workspaceName: 'api',
      placement: { x: 900, y: 40, width: 1000, height: 700 },
    });
    expect(opened).toEqual({ ok: true, ready: { windowId: 'w-2', requestId: expect.any(String), workspace: { id: 'w-2-ws', name: 'api' } } });
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 900, y: 40, width: 1000, height: 700 }));
    expect(booted?.intent).toMatchObject({ kind: 'tear-off', from: 'main', workspaceName: 'api' });

    if (!opened.ok) throw new Error('unreachable');
    const session = { id: 'pty-7', name: 'build', workspaceId: 'ws-main' } as ShellSession;
    const result = await requestAdopt(peers, {
      to: opened.ready.windowId,
      from: 'main',
      workspaceId: opened.ready.workspace.id,
      session: { ...session, workspaceId: opened.ready.workspace.id },
    });
    expect(result).toEqual({ ok: true });
    expect(booted?.adopted.map((r) => [r.session.id, r.workspaceId])).toEqual([['pty-7', 'w-2-ws']]);
  });

  it('reports a window that could not be created', async () => {
    const opened = await openTearOffWindow(fakeChannel(), () => Promise.reject(new Error('no display')), { from: 'main' });
    expect(opened).toEqual({ ok: false, error: 'the window could not be opened (Error: no display)' });
  });

  it('reports a window that never announces itself', async () => {
    vi.useFakeTimers();
    const pending = openTearOffWindow(fakeChannel(), async () => 'w-2', { from: 'main' }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ ok: false, error: 'the new window did not start' });
  });

  it('refuses an announcement from a different window', async () => {
    const peers = fakeChannel();
    const opened = await openTearOffWindow(
      peers,
      async (options) => {
        const fragment = encodeBootIntent(options.boot);
        queueMicrotask(() => bootWindow(peers, 'w-9', fragment));
        return 'w-2';
      },
      { from: 'main' },
    );
    expect(opened).toEqual({ ok: false, error: 'a different window answered' });
  });
});
