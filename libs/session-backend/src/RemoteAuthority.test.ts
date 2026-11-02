import { describe, expect, it, vi } from 'vitest';

// Fake the hub client: connect() resolves with a spied authority whose
// 'ready' state already fired — mirroring the real client, where ready
// lands inside connect() before callers can subscribe.
const connectMock = vi.fn();
/** Every FakeAuthority connect() created — lets tests inspect zombies. */
const created: FakeAuthority[] = [];
class FakeAuthority {
  sessionId?: string;
  state = 'ready';
  invokeCb?: (i: { path: string; args: unknown[] }) => unknown;
  streamCb?: (s: FakeStream) => void;
  publishSnapshot = vi.fn();
  publishPatch = vi.fn();
  disconnect = vi.fn(async () => {});
  onInvoke(cb: FakeAuthority['invokeCb']) {
    this.invokeCb = cb;
    return () => {};
  }
  onStream(cb: (s: FakeStream) => void) {
    this.streamCb = cb;
    return () => {};
  }
  onStreamRequest() {
    return () => {};
  }
  onReady() {
    return () => {};
  }
  onStateChange() {
    return () => {};
  }
}
class FakeStream {
  closed = false;
  private dataCb?: (d: Uint8Array, seq: number) => void;
  private closeCb?: (r?: string) => void;
  constructor(public name: string) {}
  onData(cb: (d: Uint8Array, seq: number) => void) {
    this.dataCb = cb;
    return this;
  }
  onClose(cb: (r?: string) => void) {
    this.closeCb = cb;
    return this;
  }
  write() {}
  close(r?: string) {
    this.closed = true;
    this.closeCb?.(r);
  }
  emit(d: Uint8Array) {
    this.dataCb?.(d, 0);
  }
}
vi.mock('@ramphastos/ramphastos-client', () => ({
  RamphastosAuthority: class {
    static connect(url: string, opts: Record<string, unknown>) {
      const a = new FakeAuthority();
      a.sessionId = opts.sessionId as string;
      created.push(a);
      // Propagate connectMock's resolution — mockRejectedValueOnce must
      // surface as a failed connect(), not an unhandled rejection.
      return Promise.resolve(connectMock(url, opts)).then(() => a);
    }
  },
  RamphastosStream: FakeStream,
}));

const { RemoteAuthority } = await import('./RemoteAuthority.ts');

type RA = InstanceType<typeof RemoteAuthority>;
const inner = (a: RA) => (a as unknown as { authority: FakeAuthority }).authority;

function fakeBackend() {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onSessionExit: vi.fn(() => () => {}),
    createSession: vi.fn(async () => true),
    getCwd: vi.fn(async () => '/home/dev'),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    exec: vi.fn(async () => 'out'),
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const patchesFor = (auth: FakeAuthority, path: string) =>
  auth.publishPatch.mock.calls
    .map((c) => c[0] as { path: string; value: unknown }[])
    .flat()
    .filter((o) => o.path === path);

describe('RemoteAuthority', () => {
  it('reports the connected state — ready fired inside connect(), before subscriptions', async () => {
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
    await a.start();
    // Regression: lastConnState stayed 'idle' → the rail dot stayed gray.
    expect(a.remoteConsole.get().state).toBe('ready');
  });

  it('disconnects a connection that resolves after stop() — no zombie authority', async () => {
    // Regression: an effect teardown racing an in-flight connect() left
    // the resolved conn attached forever — stale model + dead subs
    // competing for _authorityConnId with the live instance corrupted
    // remote I/O (parallel authority conns to one session).
    let release: () => void = () => {};
    connectMock.mockImplementationOnce(
      () => new Promise<void>((res) => { release = res; }),
    );
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
    const starting = a.start();
    await a.stop();
    release();
    await starting;
    const zombie = created[created.length - 1];
    expect(zombie.disconnect).toHaveBeenCalled();
    expect(inner(a)).toBeUndefined();
  });

  it('dedupes identical replace patches', async () => {
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
    await a.start();
    const auth = inner(a);
    const ptys = [{ id: 'p1', name: 'shell', cwd: '/x', kind: 'session' as const }];
    a.reflectPtys(ptys);
    a.reflectPtys(ptys);
    a.reflectPtys([...ptys]);
    expect(patchesFor(auth, '/ptys')).toHaveLength(1);
    a.reflectPtys([{ ...ptys[0], name: 'renamed' }]);
    expect(patchesFor(auth, '/ptys')).toHaveLength(2);
  });

  it('forwards viewer stream input to the backend (sync-back)', async () => {
    const backend = fakeBackend();
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend });
    await a.start();
    const auth = inner(a);
    a.reflectPtys([{ id: 'p1', kind: 'session' as const }]);
    const stream = new FakeStream('pty:p1@viewer-1');
    auth.streamCb!(stream);
    stream.emit(enc('hello\n'));
    expect(backend.write).toHaveBeenCalledWith('p1', 'hello\n');
  });

  it('answers setPtyMeta/upsertWorkspace/setPluginState', async () => {
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
    await a.start();
    const auth = inner(a);
    a.reflectPtys([{ id: 'p1', kind: 'session' as const }], [{ id: 'ws-a', name: 'old' }]);
    const invoke = auth.invokeCb!;

    const meta = (await invoke({
      path: '/vm/setPtyMeta',
      args: ['p1', 's-1', 'ws-a', 'renamed', null],
    })) as { ok: boolean };
    expect(meta.ok).toBe(true);
    const pty = a.remoteConsole.get().ptys.find((p) => p.id === 'p1');
    expect(pty?.name).toBe('renamed');
    expect(pty?.sessionId).toBe('s-1');

    const ws = (await invoke({ path: '/vm/upsertWorkspace', args: ['ws-a', 'new-name'] })) as { ok: boolean };
    expect(ws.ok).toBe(true);
    expect(patchesFor(auth, '/workspaces').at(-1)?.value).toContainEqual({
      id: 'ws-a',
      name: 'new-name',
    });

    const ps = (await invoke({
      path: '/vm/setPluginState',
      args: ['app:git-status', '{"x":1}'],
    })) as { ok: boolean };
    expect(ps.ok).toBe(true);
    expect(patchesFor(auth, '/pluginStates').at(-1)?.value).toContainEqual({
      key: 'app:git-status',
      data: '{"x":1}',
    });
    // empty data clears the entry
    await invoke({ path: '/vm/setPluginState', args: ['app:git-status', ''] });
    expect(patchesFor(auth, '/pluginStates').at(-1)?.value).toEqual([]);
  });

  it('surfaces a failed hello and retries instead of stranding at idle', async () => {
    // Regression: connect() threw on a denied hello → emitState never ran
    // → the rail showed 'idle' forever with no retry.
    vi.useFakeTimers();
    try {
      connectMock.mockClear();
      connectMock.mockRejectedValueOnce(new Error('hello denied'));
      connectMock.mockResolvedValueOnce(undefined);
      const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
      await expect(a.start()).rejects.toThrow('hello denied');
      expect(a.remoteConsole.get().state).toBe('failed');
      await vi.advanceTimersByTimeAsync(3000);
      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(a.remoteConsole.get().state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry after stop()', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockClear();
      connectMock.mockRejectedValueOnce(new Error('denied'));
      const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
      await expect(a.start()).rejects.toThrow();
      await a.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connectMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('effective size is the SMALLEST claim, never the last — and relaxes on unclaim', async () => {
    // The mirrored PTY must fit every viewer: owner 200 + phone 40 → 40.
    // A later/wider claim must not grow it (that would clip the phone),
    // and releasing the small claim must restore the owner's geometry.
    const backend = fakeBackend();
    const a = new RemoteAuthority({
      url: 'ws://h', sessionId: 's1', backend,
      getPtySize: () => ({ cols: 200, rows: 50 }),
    });
    await a.start();
    const auth = inner(a);
    a.reflectPtys([{ id: 'p1', kind: 'session' as const }]);
    const invoke = auth.invokeCb!;
    const resizes = () => backend.resize.mock.calls.map((c) => c.slice(1));

    await invoke({ path: '/vm/resizePty', args: ['p1', 40, 10, 'v-phone'] });
    expect(resizes()).toEqual([[40, 10]]);

    // A later, WIDER claim must not override — smallest still wins.
    await invoke({ path: '/vm/resizePty', args: ['p1', 120, 40, 'v-tablet'] });
    expect(resizes()).toEqual([[40, 10], [40, 10]]);

    // Drop the small claim → relax to min(200, 120) = 120.
    await invoke({ path: '/vm/unclaimViewport', args: ['p1', 'v-phone'] });
    expect(resizes()).toEqual([[40, 10], [40, 10], [120, 40]]);

    // Last claim out → back to the owner's live size.
    await invoke({ path: '/vm/unclaimViewport', args: ['p1', 'v-tablet'] });
    expect(resizes()).toEqual([[40, 10], [40, 10], [120, 40], [200, 50]]);
  });

  it('owner resizes are claims too — a local relayout cannot fight a viewer', async () => {
    // Regression (the width flicker): the desktop xterm re-asserted its
    // size via a direct backend.resize on every fit/layout event while
    // applyEffectiveSize wrote min — two writers racing → 'sometimes
    // luckily the smallest wins'. Routed through claimOwnerSize the PTY
    // only ever takes min(all claims).
    const backend = fakeBackend();
    const a = new RemoteAuthority({
      url: 'ws://h', sessionId: 's1', backend,
      getPtySize: () => ({ cols: 200, rows: 50 }),
    });
    await a.start();
    const auth = inner(a);
    a.reflectPtys([{ id: 'p1', kind: 'session' as const }]);
    const invoke = auth.invokeCb!;
    const resizes = () => backend.resize.mock.calls.map((c) => c.slice(1));

    // Owner lays out at 200, phone claims 40 → PTY stays 40.
    a.claimOwnerSize('p1', 200, 50);
    await invoke({ path: '/vm/resizePty', args: ['p1', 40, 10, 'v-phone'] });
    expect(resizes()).toEqual([[200, 50], [40, 10]]);

    // Owner re-asserts 200 (a fit/layout event) → deduped, no write at all.
    a.claimOwnerSize('p1', 200, 50);
    expect(resizes()).toEqual([[200, 50], [40, 10]]);

    // Owner grows to 250 → PTY still 40 — never above the smallest claim
    // (the re-application is idempotent: same value, no flicker).
    a.claimOwnerSize('p1', 250, 60);
    expect(resizes()).toEqual([[200, 50], [40, 10], [40, 10]]);

    // Viewer leaves → owner size wins again.
    await invoke({ path: '/vm/unclaimViewport', args: ['p1', 'v-phone'] });
    expect(resizes()).toEqual([[200, 50], [40, 10], [40, 10], [250, 60]]);
  });

  it('sweeps stale viewers + their claims once the heartbeat TTL expires', async () => {
    // Regression: a dead conn never unclaims/reports again — without a
    // heartbeat TTL the roster (rail client count) and stale viewport
    // claims accumulated forever.
    vi.useFakeTimers();
    try {
      const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
      await a.start();
      const auth = inner(a);
      a.reflectPtys([{ id: 'p1', kind: 'session' as const }]);
      const invoke = auth.invokeCb!;
      const roster = () => Object.keys(a.remoteConsole.get().viewers ?? {});

      await invoke({ path: '/vm/reportViewer', args: ['v-1', 'phone', 'web'] });
      await invoke({ path: '/vm/resizePty', args: ['p1', 80, 24, 'v-1'] });
      expect(roster()).toContain('v-1');

      // Heartbeat keeps it alive through sweeps.
      await vi.advanceTimersByTimeAsync(20_000);
      await invoke({ path: '/vm/reportViewer', args: ['v-1', 'phone', 'web'] });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(roster()).toContain('v-1');

      // Silence > TTL → claim + roster entry expire.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(roster()).not.toContain('v-1');
      expect(a.remoteConsole.get().claims['p1'] ?? {}).not.toHaveProperty('v-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a streaming viewer past the TTL, drops it once the stream dies', async () => {
    vi.useFakeTimers();
    try {
      const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
      await a.start();
      const auth = inner(a);
      a.reflectPtys([{ id: 'p1', kind: 'session' as const }]);
      const roster = () => Object.keys(a.remoteConsole.get().viewers ?? {});

      // Older clients never heartbeat — a live stream proves liveness.
      const stream = new FakeStream('pty:p1@v-2');
      auth.streamCb!(stream);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(roster()).toContain('v-2');

      stream.close('gone');
      await vi.advanceTimersByTimeAsync(40_000);
      expect(roster()).not.toContain('v-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown commands and missing ptys', async () => {
    const a = new RemoteAuthority({ url: 'ws://h', sessionId: 's1', backend: fakeBackend() });
    await a.start();
    const invoke = inner(a).invokeCb!;
    expect(((await invoke({ path: '/vm/nope', args: [] })) as { ok: boolean }).ok).toBe(false);
    expect(
      ((await invoke({ path: '/vm/setPtyMeta', args: ['ghost', 'x', null, null, null] })) as {
        ok: boolean;
      }).ok,
    ).toBe(false);
  });
});
