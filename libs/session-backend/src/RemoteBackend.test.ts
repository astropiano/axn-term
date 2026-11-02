import { describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn();
// Behaves like the real RamphastosStream: a local close() does not fire
// onClose (only a server close does), and a transport drop closes nothing.
class FakeStream {
  closed = false;
  writes: (Uint8Array | string)[] = [];
  private closeCb?: (r?: string) => void;
  private dataCb?: (d: Uint8Array) => void;
  constructor(public name: string) {}
  onData(cb: (d: Uint8Array) => void) {
    this.dataCb = cb;
    return this;
  }
  onClose(cb: (r?: string) => void) {
    this.closeCb = cb;
    return this;
  }
  write(d: Uint8Array | string) {
    if (this.closed) return;
    this.writes.push(d);
  }
  close() {
    this.closed = true;
  }
  /** Server → client frame. */
  emit(text: string) {
    this.dataCb?.(new TextEncoder().encode(text));
  }
  /** Server-initiated close. */
  serverClose(r?: string) {
    this.closed = true;
    this.closeCb?.(r);
  }
}
vi.mock('@ramphastos/ramphastos-client', () => ({
  RamphastosSession: { connect: connectMock },
  RamphastosStream: FakeStream,
}));

const listSessionsMock = vi.fn(async () => [] as { id: string; online: boolean }[]);
vi.mock('./remoteScope.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./remoteScope.ts')>();
  return { ...mod, listRemoteSessions: listSessionsMock };
});

const { RemoteBackend } = await import('./RemoteBackend.ts');

function fakeSession(overrides: Record<string, unknown> = {}) {
  const stateCbs = new Set<(s: string) => void>();
  const changeCbs = new Set<() => void>();
  const s = {
    sessionId: 'sess-1',
    state: 'ready',
    vmType: 'client',
    streams: new Map(),
    vm: () => ({ defaultShell: '/bin/zsh' }),
    invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true })),
    openStream: vi.fn(async (name: string) => new FakeStream(name)),
    onStream: vi.fn(() => () => {}),
    onChange: vi.fn((cb: () => void) => {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    }),
    onStateChange: vi.fn((cb: (s: string) => void) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    }),
    // Like the real session: disconnect() reports 'closed' synchronously.
    disconnect: vi.fn(async () => s.fireState('closed')),
    fireState(state: string) {
      s.state = state;
      for (const cb of [...stateCbs]) cb(state);
    },
    fireChange() {
      for (const cb of [...changeCbs]) cb();
    },
    changeListeners: () => changeCbs.size,
    ...overrides,
  };
  return s;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('RemoteBackend', () => {
  it('retries a failed connect — a rejected attempt is not cached forever', async () => {
    // Regression: one denied hello (expired JWT, gateway restart) left a
    // rejected connectPromise — every retry returned it instantly and no
    // attempt ever reached the network again ("no sync back").
    const session = fakeSession();
    connectMock.mockRejectedValueOnce(new Error('hello denied'));
    connectMock.mockResolvedValueOnce(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    await expect(b.ramphastosSession()).rejects.toThrow('hello denied');
    await expect(b.ramphastosSession()).resolves.toBe(session);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('queues writes while the stream attaches, then flushes them upstream', async () => {
    const stream = new FakeStream('pty:p1@v');
    const session = fakeSession({ openStream: vi.fn(async () => stream) });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    await b.ramphastosSession();
    b.write('p1', 'echo hi\n');
    await vi.waitFor(() => expect(stream.writes).toContain('echo hi\n'));
    expect(session.openStream).toHaveBeenCalledWith(
      expect.stringMatching(/^pty:p1@/),
      { direction: 'duplex' },
    );
  });

  it('re-pulls a stream when the stored one is closed', async () => {
    // Regression: the hub doesn't echo stream-close to the closer, so a
    // closed stream could stay in the pty entry — waitForStream resolved it
    // and every later write queued forever (dead input after a detach).
    const dead = new FakeStream('pty:p1@v');
    dead.close('hidden');
    const fresh = new FakeStream('pty:p1@v');
    const session = fakeSession({ openStream: vi.fn(async () => fresh) });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    await b.ramphastosSession();
    (b as unknown as { ptys: Map<string, { stream?: FakeStream }> }).ptys.set('p1', {
      stream: dead,
    });
    b.write('p1', 'echo again\n');
    await vi.waitFor(() => expect(fresh.writes).toContain('echo again\n'));
    expect(session.openStream).toHaveBeenCalled();
  });

  it('replays the pty tail before pulling the live stream', async () => {
    const order: string[] = [];
    const stream = new FakeStream('pty:p1@v');
    const session = fakeSession({
      invoke: vi.fn(async (path: string) => {
        order.push(`invoke:${path}`);
        return { ok: true, data: btoa('TAIL\n') };
      }),
      openStream: vi.fn(async () => {
        order.push('openStream');
        return stream;
      }),
    });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    const out: string[] = [];
    b.onOutput('p1', (d) => out.push(decode(d)));
    await vi.waitFor(() =>
      // reportViewer rides the same invoke channel on connect — ignore it.
      expect(order.filter((o) => o !== 'invoke:/vm/reportViewer')).toEqual([
        'invoke:/vm/ptyTail',
        'openStream',
      ]),
    );
    expect(out).toContain('TAIL\n');
  });

  it('reuses a stable per-device viewerId across instances', async () => {
    // Regression: a random id per page load ghosted the /viewers roster —
    // every reload added a stale entry and the client count grew forever.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    try {
      const s1 = fakeSession();
      const s2 = fakeSession();
      connectMock.mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
      const b1 = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
      const b2 = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's2' });
      await b1.ramphastosSession();
      await b2.ramphastosSession();
      const reported = (s: ReturnType<typeof fakeSession>) =>
        s.invoke.mock.calls.find((c) => c[0] === '/vm/reportViewer')?.[1]?.[0];
      expect(reported(s1)).toBeTruthy();
      expect(reported(s1)).toBe(reported(s2));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('heartbeats reportViewer and stops pinging after disconnect', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      connectMock.mockResolvedValue(session);
      const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
      await b.ramphastosSession();
      const reports = () =>
        session.invoke.mock.calls.filter((c) => c[0] === '/vm/reportViewer').length;
      expect(reports()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reports()).toBeGreaterThanOrEqual(4);
      await b.disconnect();
      const stoppedAt = reports();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reports()).toBe(stoppedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers the account session when none is pinned', async () => {
    // `?remote` bare: the session name was never load-bearing — the
    // gateway's /remote/sessions lists what the account owns and a single
    // owned session auto-attaches.
    listSessionsMock.mockResolvedValueOnce([{ id: 'sub-1/mac', online: true }]);
    const session = fakeSession();
    connectMock.mockResolvedValueOnce(session);
    const b = new RemoteBackend({ url: 'ws://h/remote' });
    await b.ramphastosSession();
    expect(listSessionsMock).toHaveBeenCalled();
    expect(connectMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sub-1/mac' }),
    );
  });

  it('attaches the first of several discovered sessions — picker switches', async () => {
    listSessionsMock.mockResolvedValueOnce([{ id: 'sub-1/mac', online: true }, { id: 'sub-1/work', online: true }]);
    const session = fakeSession();
    connectMock.mockResolvedValueOnce(session);
    const b = new RemoteBackend({ url: 'ws://h/remote' });
    await b.ramphastosSession();
    expect(connectMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sub-1/mac' }),
    );
  });

  it('prefers an online session over an offline one regardless of order', async () => {
    // Dead mirrors stay discoverable (authority may return) — attaching
    // the first-listed blindly could pin a dead one forever.
    listSessionsMock.mockResolvedValueOnce([
      { id: 'sub-1/dead', online: false },
      { id: 'sub-1/live', online: true },
    ]);
    const session = fakeSession();
    connectMock.mockResolvedValueOnce(session);
    const b = new RemoteBackend({ url: 'ws://h/remote' });
    await b.ramphastosSession();
    expect(connectMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: 'sub-1/live' }),
    );
  });

  it('fails discovery instead of sending a null-session hello', async () => {
    // Regression: an unpinned hello went out with session=(null) — the
    // gateway rejects it forever and the app shows a dead 'failed to start
    // session' loop. Empty discovery must throw before connect().
    listSessionsMock.mockResolvedValueOnce([]);
    connectMock.mockClear();
    const b = new RemoteBackend({ url: 'ws://h/remote' });
    await expect(b.ramphastosSession()).rejects.toThrow(/no mirrored sessions/);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('RemoteBackend stream lifecycle', () => {
  const tailInvoke = (tail: string, order?: string[]) =>
    vi.fn(async (path: string): Promise<unknown> => {
      order?.push(path);
      return path === '/vm/ptyTail' ? { ok: true, data: btoa(tail) } : { ok: true };
    });
  const recordStreams = (streams: FakeStream[], order?: string[]) =>
    vi.fn(async (name: string) => {
      order?.push('openStream');
      const s = new FakeStream(name);
      streams.push(s);
      return s;
    });

  it('re-acquires the stream and replays the tail when a hidden tab is shown again', async () => {
    // Regression: releasePty closed the stream on hide and nothing re-pulled
    // it on show — output froze until a keypress and the hidden-time output
    // was never replayed.
    connectMock.mockReset();
    const order: string[] = [];
    const streams: FakeStream[] = [];
    const session = fakeSession({
      invoke: tailInvoke('TAIL', order),
      openStream: recordStreams(streams, order),
    });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    const out: string[] = [];
    b.onOutput('p1', (d) => out.push(decode(d)));
    await b.createSession('p1', { cols: 80, rows: 24 });
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    b.releasePty('p1'); // tab hidden
    expect(streams[0].closed).toBe(true);
    order.length = 0;
    out.length = 0;

    b.resize('p1', 100, 30); // tab shown → fit → resize
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(order.filter((o) => o === '/vm/ptyTail' || o === 'openStream')).toEqual([
      '/vm/ptyTail',
      'openStream',
    ]);
    // Reset first: the terminal still shows the pre-hide screen.
    expect(out[0]).toBe('\x1bcTAIL');
    streams[1].emit('live');
    expect(out).toContain('live');
    b.write('p1', 'x');
    expect(streams[1].writes).toEqual(['x']);
    await b.disconnect();
  });

  it('a keypress on a released tab re-acquires (tail first) and delivers the input', async () => {
    connectMock.mockReset();
    const streams: FakeStream[] = [];
    const session = fakeSession({ invoke: tailInvoke('TAIL'), openStream: recordStreams(streams) });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    const out: string[] = [];
    b.onOutput('p1', (d) => out.push(decode(d)));
    await b.createSession('p1', { cols: 80, rows: 24 });
    b.releasePty('p1');
    out.length = 0;
    b.write('p1', 'ls\n');
    await vi.waitFor(() => expect(streams[1]?.writes).toEqual(['ls\n']));
    expect(out).toEqual(['\x1bcTAIL']);
    expect(streams).toHaveLength(2);
    await b.disconnect();
  });

  it('a remount (onOutput) after a hide re-acquires the stream', async () => {
    connectMock.mockReset();
    const streams: FakeStream[] = [];
    const session = fakeSession({ invoke: tailInvoke('TAIL'), openStream: recordStreams(streams) });
    connectMock.mockResolvedValue(session);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    const unsub = b.onOutput('p1', () => {});
    await b.createSession('p1', { cols: 80, rows: 24 });
    b.releasePty('p1');
    unsub();
    const out: string[] = [];
    b.onOutput('p1', (d) => out.push(decode(d)));
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(out[0]).toBe('\x1bcTAIL');
    await b.disconnect();
  });

  it('re-pulls streams on the new session after a transport drop', async () => {
    // Regression: the library keeps streams open on transport loss, so the
    // dead stream stayed in the pty entry — input went to the old
    // connection and output never resumed until a page reload.
    connectMock.mockReset();
    const s1Streams: FakeStream[] = [];
    const s2Streams: FakeStream[] = [];
    const s1 = fakeSession({ openStream: recordStreams(s1Streams) });
    const s2 = fakeSession({ invoke: tailInvoke('TAIL2'), openStream: recordStreams(s2Streams) });
    connectMock.mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    const exits = vi.fn();
    b.onSessionExit(exits);
    const out: string[] = [];
    b.onOutput('p1', (d) => out.push(decode(d)));
    await b.createSession('p1', { cols: 80, rows: 24 });
    await vi.waitFor(() => expect(s1Streams).toHaveLength(1));

    s1.fireState('closed'); // transport gone; s1's stream object stays "open"
    b.write('p1', 'ls\n');
    expect(s1Streams[0].writes).toEqual([]);
    expect(await b.ramphastosSession()).toBe(s2);

    await vi.waitFor(() => expect(s2Streams[0]?.writes).toEqual(['ls\n']));
    expect(s2Streams).toHaveLength(1);
    expect(out).toContain('\x1bcTAIL2');
    s2Streams[0].emit('back');
    expect(out).toContain('back');
    // The old stream closing late neither ends the session nor wins.
    s1Streams[0].serverClose('gone');
    expect(exits).not.toHaveBeenCalled();
    b.write('p1', 'x');
    expect(s2Streams[0].writes).toContain('x');
    await b.disconnect();
  });

  it('re-pulls a stream that is idle after the drop as soon as the new session lands', async () => {
    connectMock.mockReset();
    const s2Streams: FakeStream[] = [];
    const s1 = fakeSession();
    const s2 = fakeSession({ openStream: recordStreams(s2Streams) });
    connectMock.mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
    const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
    b.onOutput('p1', () => {});
    await b.createSession('p1', { cols: 80, rows: 24 });
    s1.fireState('closed');
    await b.ramphastosSession(); // the backoff reconnect, without waiting
    await vi.waitFor(() => expect(s2Streams).toHaveLength(1));
    await b.disconnect();
  });

  it('pulls again after a stream waiter timed out', async () => {
    // Regression: the timed-out waiter stayed in streamWaiters and pulls
    // only fired for the first waiter — all later input queued forever.
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      connectMock.mockReset();
      let fail = true;
      const streams: FakeStream[] = [];
      const session = fakeSession({
        openStream: vi.fn(async (name: string) => {
          if (fail) throw new Error('stream_rejected');
          const s = new FakeStream(name);
          streams.push(s);
          return s;
        }),
      });
      connectMock.mockResolvedValue(session);
      const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
      await b.ramphastosSession();
      b.write('p1', 'a');
      await vi.advanceTimersByTimeAsync(11_000);
      expect(session.openStream).toHaveBeenCalledTimes(6);
      fail = false; // authority is up now
      b.write('p1', 'b');
      await vi.advanceTimersByTimeAsync(0);
      expect(streams).toHaveLength(1);
      expect(streams[0].writes).toEqual(['a', 'b']);
      await b.disconnect();
    } finally {
      err.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('switching sessions disconnects the old one and keeps the new one alive', async () => {
    // Regression: chooseSession leaked the old connection, left the console
    // bound to it, and the old session's late close killed the new
    // session's heartbeat and scheduled a needless reconnect.
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const s1 = fakeSession();
      const s2 = fakeSession({ sessionId: 'sess-2' });
      connectMock.mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
      const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
      const consoleCb = vi.fn();
      b.remoteConsole.subscribe(consoleCb);
      await vi.advanceTimersByTimeAsync(0);
      expect(s1.changeListeners()).toBe(1);

      b.remoteConsole.chooseSession!('s2');
      await vi.advanceTimersByTimeAsync(0);
      expect(s1.disconnect).toHaveBeenCalled();
      expect(await b.ramphastosSession()).toBe(s2);
      expect(s1.changeListeners()).toBe(0);
      expect(s2.changeListeners()).toBe(1);
      consoleCb.mockClear();
      s2.fireChange();
      expect(consoleCb).toHaveBeenCalled();

      s1.fireState('closed'); // late close of the replaced session
      const reports = () =>
        s2.invoke.mock.calls.filter((c) => c[0] === '/vm/reportViewer').length;
      const before = reports();
      await vi.advanceTimersByTimeAsync(35_000);
      expect(reports()).toBeGreaterThan(before);
      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(b.remoteConsole.get().sessionId).toBe('sess-2');
      await b.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect does not reconnect when the session reports closed', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockReset();
      const session = fakeSession();
      connectMock.mockResolvedValue(session);
      const b = new RemoteBackend({ url: 'ws://h/remote', sessionId: 's1' });
      await b.ramphastosSession();
      await b.disconnect(); // fires 'closed' on the session
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
