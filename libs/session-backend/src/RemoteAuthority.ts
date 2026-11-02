import { RamphastosAuthority, RamphastosStream } from '@ramphastos/ramphastos-client';
import type { RemoteConsole, RemoteConsoleSnapshot, SessionBackend, Unsubscribe } from './types';
import { scopeSessionId } from './remoteScope.ts';

/** One published terminal in the authority's replicated model. */
export interface PublishedPty {
  id: string;
  /** Display name (session title / tab label). */
  name?: string;
  /** `sh -c` command for one-shot PTYs; absent = interactive shell. */
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Owning workspace/session ids — extra context for richer consumers. */
  workspaceId?: string;
  sessionId?: string;
  kind?: 'session' | 'subshell' | 'detached';
  /**
   * App-level session status (idle/running/blocked/completed) — mirrors
   * render it verbatim. Kept apart from the PTY-lifecycle `status`, which
   * is only 'running' | 'exited'.
   */
  appStatus?: string;
  /** Foreground process name, for the panel's process column. */
  process?: string;
}

export interface RemoteAuthorityOptions {
  /**
   * Hub hosting client-authoritative sessions — e.g. the gateway's `/remote`
   * endpoint or a session-host `/ramphastos` for testing.
   */
  url: string;
  /** Bearer/token for hello.auth + the access_token query param. */
  getToken?: () => Promise<string | undefined> | string | undefined;
  /**
   * Stable session id the authority pins — remote clients attach to it.
   * Defaults to a hostname-derived id.
   */
  sessionId?: string;
  /** Connection identity, e.g. { app:'axn-term', kind:'desktop', window:'main' }. */
  meta?: Record<string, unknown>;
  /** Skip the SignalR negotiate POST — required through raw-WS proxies. */
  webSocketOnly?: boolean;
  backend: SessionBackend;
  /**
   * Scrollback source for `ptyTail` — the backend port has no history, so
   * the desktop supplies the live terminal's serialized buffer; viewers
   * replay it on attach instead of opening a black screen.
   */
  getScrollback?: (ptyId: string) => string | Uint8Array | undefined;
  /** Live local terminal geometry — the owner's own size claim. */
  getPtySize?: (ptyId: string) => { cols: number; rows: number } | undefined;
  /**
   * Fired when a client writes shared state via `setPluginState` — lets the
   * host apply shared settings (e.g. `app:icons`) into its own config.
   * Local `setSharedState` writes do not re-fire it.
   */
  onSharedState?: (key: string, data: string | undefined) => void;
}

type PtyStatus = 'running' | 'exited';

interface PtyEntry extends PublishedPty {
  status: PtyStatus;
  exitCode?: number | null;
  spawnedAt: string;
  /** Remote-spawned PTYs are not in window state — kept separately. */
  remote?: boolean;
}

/**
 * The authority side of a client-authoritative session: this process owns
 * the PTYs and the model, publishes snapshots/patches upstream, answers
 * forwarded invokes against `backend`, and serves `pty:<id>` duplex streams
 * the server tunnels to remote clients.
 *
 * The published model deliberately mirrors AxnHostVm's shape
 * ({ ptys, defaultShell, defaultCwd, hostname } + the same /vm/* commands),
 * so RemoteBackend and any ramphastos consumer work unchanged against a
 * desktop authority and a hosted session alike.
 */
export class RemoteAuthority {
  private authority?: RamphastosAuthority;
  private ptys = new Map<string, PtyEntry>();
  private workspaces = new Map<string, string | undefined>();
  /** Per-client viewport claims: ptyId -> viewerId -> geometry. Every
   *  active client (desktop owner, web, phone) is an equal claimant; the
   *  effective PTY size is the smallest claim in the collection, and a
   *  client's claim is removed when it leaves the session. */
  private claims = new Map<string, Map<string, { cols: number; rows: number }>>();
  private streams = new Map<string, Set<RamphastosStream>>();
  /** Stream -> {ptyId, viewerId} so a stream close drops the right claim.
   *  A plain Map — entries are removed on close, and we iterate it to count
   *  a viewer's live streams for the /viewers roster. */
  private streamViewers = new Map<RamphastosStream, { id: string; viewer: string }>();
  /** Connected client roster — the /viewers model plane. A client proves
   *  liveness via reportViewer heartbeats (re-invoked every ~10s) plus
   *  claims and live streams; lastSeen past the TTL (~30s) with no live
   *  stream means the conn died without telling us — the entry expires. */
  private viewers = new Map<string, { name?: string; platform?: string; since: number; lastSeen: number }>();
  /** Stale-viewer sweep interval — see `viewers`. */
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Shared plugin-state plane — opaque JSON strings keyed `app:`/`sess:`. */
  private pluginStates = new Map<string, string>();
  private outputUnsubs = new Map<string, () => void>();
  /** Output captured before any viewer attaches — replayed on stream open
   *  (remote-spawned PTYs have no xterm buffer for ptyTail to serialize). */
  private outputBuffers = new Map<string, (string | Uint8Array)[]>();
  /** Last payload published per replace-path — identical patches are
   *  skipped instead of waking every viewer on each upstream save. */
  private lastPublished = new Map<string, string>();
  private backendUnsubs: (() => void)[] = [];
  private started = false;
  private reconnecting = false;
  /** Retry state for a failed start() — a denied hello must surface and
   *  retry (fresh token per attempt), not strand the console at 'idle'. */
  private stopped = false;
  private startRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private startRetryDelay = 3000;
  private stateCbs = new Set<(state: string) => void>();
  private lastConnState = 'idle';
  private consoleCbs = new Set<() => void>();
  private consoleSnapshot: RemoteConsoleSnapshot = {
    role: 'authority', state: 'idle', ptys: [], claims: {},
  };
  private defaultShell = '/bin/sh';
  private readonly opts: RemoteAuthorityOptions;

  constructor(opts: RemoteAuthorityOptions) {
    this.opts = opts;
  }

  get sessionId(): string | undefined {
    return this.authority?.sessionId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    const token = await this.opts.getToken?.();
    let url = this.opts.url;
    if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;

    let authority: RamphastosAuthority;
    try {
      authority = await RamphastosAuthority.connect(url, {
        auth: token,
        // Tenant-scoped session id: '<sub>/<id>' makes ownership self-proving
        // on the gateway — survives restarts, needs no shared state.
        sessionId: scopeSessionId(this.opts.sessionId, token),
        webSocketOnly: this.opts.webSocketOnly,
        meta: { app: 'axn-term', ...this.opts.meta },
      });
    } catch (e) {
      // A denied hello (stale token, issuer drift, gateway restart) used to
      // strand the console at 'idle' forever — no visible failure, no
      // retry. Surface it and retry with a fresh token; stop() cancels.
      this.started = false;
      if (this.stopped) throw e;
      this.emitState('failed');
      this.startRetryTimer ??= setTimeout(() => {
        this.startRetryTimer = undefined;
        // reconnect()'s loop owns retries while it's active.
        if (!this.stopped && !this.reconnecting) void this.start().catch(() => {});
      }, this.startRetryDelay);
      this.startRetryDelay = Math.min(this.startRetryDelay * 2, 30_000);
      throw e;
    }
    // stop() ran while connect() was still in flight — nothing held a
    // reference to the new conn, so it would attach upstream and live on
    // as a zombie authority (stale model, dead subscriptions, competing
    // for _authorityConnId with the live instance — the parallel-authority
    // failure that corrupted remote I/O). Disconnect it and bail.
    if (this.stopped) {
      this.started = false;
      await authority.disconnect().catch(() => {});
      return;
    }
    this.startRetryDelay = 3000;
    this.authority = authority;

    this.defaultShell = (await this.opts.backend.getDefaultShell?.()) ?? '/bin/sh';

    authority.onInvoke((invoke) => this.handleInvoke(invoke.path, invoke.args));
    authority.onStreamRequest((req) => this.handleStreamRequest(req.stream));
    authority.onStream((s) => this.onStreamAnnounced(s));
    authority.onReady(() => this.publishSnapshot());
    this.subscribeBackendExit();

    // The connection's token was baked into the URL at connect() time and
    // JWTs expire — a dropped transport (gateway restart, network blip)
    // must trigger a FULL reconnect with a fresh token, not a reuse of the
    // dead connection. Without this the server reports authority_offline
    // forever while our status stays stale-'connected'.
    let reconnectGrace: ReturnType<typeof setTimeout> | undefined;
    authority.onStateChange?.((state) => {
      this.emitState(state);
      if (state === 'ready') {
        if (reconnectGrace) { clearTimeout(reconnectGrace); reconnectGrace = undefined; }
        return;
      }
      if (!this.started || this.authority !== authority) return;
      // 'closed' is the terminal state — reconnect now.
      if (state === 'closed') { void this.reconnect(); return; }
      // 'reconnecting' can livelock: SignalR keeps the transport up while
      // our re-hello is denied (expired JWT baked into hello.auth) — the
      // retries exhaust and the session stays offline forever. If a grace
      // period passes without 'ready', drop the whole connection and
      // reconnect with a fresh token.
      if (state === 'reconnecting' && !reconnectGrace) {
        reconnectGrace = setTimeout(() => {
          reconnectGrace = undefined;
          if (this.started && this.authority === authority) void this.reconnect();
        }, 12000);
      }
    });

    // 'ready' fired inside connect() — before our subscription landed — so
    // seed the console state here; without this it sits at 'idle' forever
    // and the rail dot never turns green.
    this.emitState(authority.state);

    // (Re-)publish after every (re)connect — onReady fires on first
    // connect and after each reconnect+resume.
    this.publishSnapshot();

    // The roster/claims are only as live as the clients that feed them —
    // without a sweep a dead conn's entries linger forever.
    this.sweepTimer ??= setInterval(() => this.sweepViewers(), 10_000);
  }

  /** Connection-state passthrough for status UIs ('ready'|'reconnecting'|'closed'). */
  onStateChange(cb: (state: string) => void): Unsubscribe {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private emitState(state: string): void {
    this.lastConnState = state;
    for (const cb of this.stateCbs) cb(state);
    this.refreshConsole();
  }

  /**
   * The shared viewport/viewer state a remote console renders — claims +
   * the published PTY list + this host's identity. RemoteBackend exposes
   * the viewer-side counterpart, so the same console UI works on both.
   */
  readonly remoteConsole: RemoteConsole = {
    get: () => this.consoleSnapshot,
    subscribe: (cb) => {
      this.consoleCbs.add(cb);
      return () => this.consoleCbs.delete(cb);
    },
  };

  private refreshConsole(): void {
    const claims: Record<string, Record<string, { cols: number; rows: number }>> = {};
    for (const [id, m] of this.claims) claims[id] = Object.fromEntries(m);
    this.consoleSnapshot = {
      role: 'authority',
      state: this.lastConnState,
      hostName: hostname(),
      hostDevice: 'desktop',
      ptys: [...this.ptys.values()].map(publicEntry).map((p) => ({
        id: String(p.id),
        name: p.name === undefined ? undefined : String(p.name),
        sessionId: p.sessionId === undefined ? undefined : String(p.sessionId),
        cols: typeof p.cols === 'number' ? p.cols : undefined,
        rows: typeof p.rows === 'number' ? p.rows : undefined,
      })),
      claims,
      viewers: Object.fromEntries(
        [...this.viewers].map(([id, v]) => [id, { name: v.name, platform: v.platform }]),
      ),
    };
    for (const cb of this.consoleCbs) cb();
  }

  /**
   * Tear down the dead connection and start() again with a fresh token —
   * exponential backoff, bounded retries, then give up (status reflects
   * it via onStateChange).
   */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let i = 0; this.started; i++) {
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** Math.min(i, 5), 15000)));
        if (!this.started) return;
        try {
          this.started = false;
          const stale = this.authority;
          this.authority = undefined;
          // Kill the zombie transport before re-helloing — the server
          // rejects a second authority for an owned session.
          await stale?.disconnect().catch(() => {});
          await this.start();
          return;
        } catch (e) {
          this.emitState(`reconnect-failed:${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Feed the terminals the local app knows about — called whenever the
   * app's session/window model changes (desktop: on every stateStore.save).
   * Diffs against the published set and patches upstream.
   */
  reflectPtys(ptys: PublishedPty[], workspaces?: { id: string; name?: string }[]): void {
    if (workspaces) {
      this.workspaces.clear();
      for (const w of workspaces) this.workspaces.set(w.id, w.name);
      this.patchReplace('/workspaces', this.workspaceEntries());
    }
    const seen = new Set<string>();
    for (const p of ptys) {
      seen.add(p.id);
      const existing = this.ptys.get(p.id);
      if (existing) {
        Object.assign(existing, { name: p.name, command: p.command, cwd: p.cwd ?? existing.cwd, workspaceId: p.workspaceId, sessionId: p.sessionId, kind: p.kind ?? existing.kind, appStatus: p.appStatus, process: p.process, cols: p.cols ?? this.opts.getPtySize?.(existing.id) ?? existing.cols, rows: p.rows ?? this.opts.getPtySize?.(existing.id) ?? existing.rows });
      } else {
        this.ptys.set(p.id, {
          ...p,
          status: 'running',
          spawnedAt: new Date().toISOString(),
        });
      }
    }
    for (const id of [...this.ptys.keys()]) {
      const entry = this.ptys.get(id)!;
      // Remote-spawned PTYs aren't represented in window state — they leave
      // the model only when their PTY actually exits/closes.
      if (!seen.has(id) && !entry.remote) this.removePty(id, 'closed');
    }
    this.patchPtys();
  }

  /** Drop the connection; local PTYs keep running. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.startRetryTimer) {
      clearTimeout(this.startRetryTimer);
      this.startRetryTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const unsub of this.backendUnsubs) unsub();
    this.backendUnsubs = [];
    for (const unsub of this.outputUnsubs.values()) unsub();
    this.outputUnsubs.clear();
    this.streams.clear();
    await this.authority?.disconnect();
    this.authority = undefined;
  }

  // ---- model ----

  private snapshot(): Record<string, unknown> {
    const viewportClaims: Record<string, Record<string, { cols: number; rows: number }>> = {};
    for (const [id, m] of this.claims) viewportClaims[id] = Object.fromEntries(m);
    return {
      device: 'desktop',
      hostname: hostname(),
      defaultCwd: '/',
      defaultShell: this.defaultShell,
      ptys: [...this.ptys.values()].map(publicEntry),
      workspaces: this.workspaceEntries(),
      viewportClaims,
      pluginStates: [...this.pluginStates].map(([key, data]) => ({ key, data })),
      viewers: Object.fromEntries(
        [...this.viewers].map(([id, v]) => [id, { name: v.name, platform: v.platform }]),
      ),
    };
  }

  private publishSnapshot(): void {
    const snap = this.snapshot();
    // The snapshot is the new baseline — seed the dedupe map from it so
    // post-reconnect patches aren't skipped (or duplicated) on stale data.
    for (const [k, v] of Object.entries(snap)) {
      this.lastPublished.set(`/${k}`, JSON.stringify(v));
    }
    this.authority?.publishSnapshot(snap);
  }

  private workspaceEntries(): { id: string; name?: string }[] {
    return [...this.workspaces].map(([id, name]) => ({ id, name }));
  }

  /**
   * Whole-value replace with dedupe: every upstream save calls reflectPtys
   * and status/progress churn used to publish an identical /ptys patch on
   * each ~2s flush — every replica onChange then reloaded the mirror and
   * blanked locally-derived fields (the repo row flicker on the panel).
   */
  /**
   * Write a shared plugin-state entry — the local half of `setPluginState`,
   * callable by the host itself (e.g. publishing `app:icons` on settings
   * change). Does not fire `onSharedState` — that is for client writes.
   */
  setSharedState(key: string, data: string | undefined): void {
    if (data === undefined || data === '') this.pluginStates.delete(key);
    else this.pluginStates.set(key, data);
    this.patchReplace(
      '/pluginStates',
      [...this.pluginStates].map(([key, data]) => ({ key, data })),
    );
  }

  private patchReplace(path: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (this.lastPublished.get(path) === json) return;
    this.lastPublished.set(path, json);
    this.authority?.publishPatch([{ op: 'replace', path, value }]);
  }

  private patchPtys(): void {
    // Whole-array replace — the set is small and the diff bookkeeping of
    // index-addressed ops buys nothing here.
    this.patchReplace('/ptys', [...this.ptys.values()].map(publicEntry));
    this.refreshConsole();
  }

  private removePty(id: string, reason: string): void {
    this.ptys.delete(id);
    this.outputBuffers.delete(id);
    this.outputUnsubs.get(id)?.();
    this.outputUnsubs.delete(id);
    for (const s of this.streams.get(id) ?? []) s.close(reason);
    this.streams.delete(id);
    this.claims.delete(id);
    this.ownerSizes.delete(id);
  }

  /** Smallest geometry among all claims plus the owner's live size. */
  private effectiveSize(id: string): { cols: number; rows: number } | undefined {
    const e = this.ptys.get(id);
    const own = this.ownerSizes.get(id)
      ?? this.opts.getPtySize?.(id)
      ?? (e?.cols && e.rows ? { cols: e.cols, rows: e.rows } : undefined);
    const m = this.claims.get(id);
    if ((!m || m.size === 0) && !own) return undefined;
    let cols = own?.cols ?? Infinity;
    let rows = own?.rows ?? Infinity;
    for (const c of m?.values() ?? []) {
      cols = Math.min(cols, c.cols);
      rows = Math.min(rows, c.rows);
    }
    return { cols, rows };
  }

  private applyEffectiveSize(id: string): void {
    const size = this.effectiveSize(id);
    if (size) this.opts.backend.resize(id, size.cols, size.rows);
  }

  /** Owner-side geometry: the local terminal's size is ONE claimant like
   * any viewer — never a direct PTY write. The desktop's xterm re-asserts
   * its size on every fit/layout event; routed through here the PTY still
   * takes min(all claims), so local resizes can no longer fight remote
   * claims (the width flicker where 'sometimes the smallest wins'). */
  private ownerSizes = new Map<string, { cols: number; rows: number }>();
  claimOwnerSize(id: string, cols: number, rows: number): void {
    // Remote-spawned PTYs take the caller's geometry directly — no claims.
    if (this.ptys.get(id)?.remote) { this.opts.backend.resize(id, cols, rows); return; }
    const cur = this.ownerSizes.get(id);
    if (cur?.cols === cols && cur?.rows === rows) return;
    this.ownerSizes.set(id, { cols, rows });
    this.applyEffectiveSize(id);
  }

  private dropClaim(id: string, viewer: string): void {
    const m = this.claims.get(id);
    if (!m?.delete(viewer)) return;
    if (!m.size) this.claims.delete(id);
    this.applyEffectiveSize(id);
    this.patchClaims();
  }

  private patchClaims(): void {
    const value: Record<string, Record<string, { cols: number; rows: number }>> = {};
    for (const [id, m] of this.claims) value[id] = Object.fromEntries(m);
    this.patchReplace('/viewportClaims', value);
    this.refreshConsole();
  }

  private patchViewers(): void {
    this.patchReplace(
      '/viewers',
      Object.fromEntries(
        [...this.viewers].map(([id, v]) => [id, { name: v.name, platform: v.platform }]),
      ),
    );
    this.refreshConsole();
  }

  private touchViewer(viewer: string, name?: string, platform?: string): void {
    if (viewer === 'anon') return;
    const cur = this.viewers.get(viewer);
    if (cur) {
      cur.lastSeen = Date.now();
      if (name !== undefined) cur.name = name;
      if (platform !== undefined) cur.platform = platform;
    } else {
      const now = Date.now();
      this.viewers.set(viewer, { name, platform, since: now, lastSeen: now });
    }
    this.patchViewers();
  }

  /** Stale-viewer sweep: a conn that dies without unclaiming (app killed,
   *  tab closed, network drop before stream-close lands) leaves claims and
   *  a roster entry behind. Heartbeats (reportViewer) refresh lastSeen; a
   *  live stream also proves liveness — older clients never heartbeat but
   *  stay listed while they hold one. Everything else past the TTL expires:
   *  claims (they pin the effective viewport) and the roster entry. */
  private sweepViewers(): void {
    const cutoff = Date.now() - 30_000;
    let claimsChanged = false;
    let rosterChanged = false;
    for (const [viewer, v] of this.viewers) {
      if (v.lastSeen >= cutoff) continue;
      let streaming = false;
      for (const ref of this.streamViewers.values()) {
        if (ref.viewer === viewer) { streaming = true; break; }
      }
      if (streaming) continue;
      for (const [id, m] of this.claims) {
        if (!m.delete(viewer)) continue;
        if (!m.size) this.claims.delete(id);
        this.applyEffectiveSize(id);
        claimsChanged = true;
      }
      this.viewers.delete(viewer);
      rosterChanged = true;
    }
    if (claimsChanged) this.patchClaims();
    if (rosterChanged) this.patchViewers();
  }

  /** Drop a viewer from the roster once it holds no stream and no claim. */
  private pruneViewer(viewer: string): void {
    for (const ref of this.streamViewers.values()) if (ref.viewer === viewer) return;
    for (const m of this.claims.values()) if (m.has(viewer)) return;
    if (this.viewers.delete(viewer)) this.patchViewers();
  }

  // ---- streams (demand-driven: nothing flows while nobody watches) ----

  /**
   * Clients pull `pty:<id>` streams — granting echoes a stream-open which
   * the server announces back to us via onStream. No PTY bytes cross the
   * wire until a remote actually opens a stream.
   */
  private handleStreamRequest(name: string): boolean | { direction: 'duplex' } {
    const id = streamPtyRef(name).id;
    return id !== undefined && this.ptys.has(id)
      ? { direction: 'duplex' }
      : false;
  }

  private onStreamAnnounced(s: RamphastosStream): void {
    const ref = streamPtyRef(s.name);
    if (ref.id === undefined) return;
    const { id, viewer } = ref;
    if (!this.ptys.has(id)) {
      s.close('gone');
      return;
    }
    this.streamViewers.set(s, { id, viewer });
    if (viewer) this.touchViewer(viewer);
    let set = this.streams.get(id);
    if (!set) { set = new Set(); this.streams.set(id, set); }
    set.add(s);
    const buffered = this.outputBuffers.get(id);
    // Replay the capture buffer only when ptyTail can't serialize a
    // scrollback (remote-spawned or unmounted PTYs). A PTY with a live
    // xterm gets its history from the tail dump — replaying the buffer
    // too would paint those lines twice.
    const scrollback = this.opts.getScrollback?.(id);
    const hasTail =
      scrollback !== undefined && scrollback.length > 0;
    if (buffered?.length && !hasTail) {
      for (const d of buffered) s.write(d);
    }
    this.outputBuffers.delete(id);
    s.onData((data) => this.opts.backend.write(id, decodeUtf8(data)));
    s.onClose((reason) => this.onStreamClosed(s, reason));
    this.subscribeOutput(id);
  }

  private subscribeOutput(id: string): void {
    if (this.outputUnsubs.has(id)) return; // survives stream re-opens
    this.outputUnsubs.set(
      id,
      this.opts.backend.onOutput(id, (data) => {
        const set = this.streams.get(id);
        if (set?.size) { for (const s of set) s.write(data); return; }
        const buf = this.outputBuffers.get(id) ?? [];
        buf.push(data);
        if (buf.length > 256) buf.splice(0, buf.length - 256);
        this.outputBuffers.set(id, buf);
      }),
    );
  }

  private onStreamClosed(s: RamphastosStream, _reason?: string): void {
    const ref = this.streamViewers.get(s);
    this.streamViewers.delete(s);
    if (!ref) return;
    const { id, viewer } = ref;
    const set = this.streams.get(id);
    set?.delete(s);
    if (!set?.size) {
      this.streams.delete(id);
      // Release the output pipe so a re-attaching viewer resubscribes.
      this.outputUnsubs.get(id)?.();
      this.outputUnsubs.delete(id);
    }
    const entry = this.ptys.get(id);
    // Only PTYs this authority spawned may die with their stream — a
    // mirrored PTY belongs to the local session; a viewer detach, page
    // reload, or reconnect must never kill it (AxnHostVm's hosted semantic
    // does not transfer to the desktop mirror).
    if (entry?.remote && !set?.size) {
      this.opts.backend.close(id);
      return;
    }
    // This client's claim leaves the collection — the PTY relaxes to the
    // smallest width still claimed (or the owner's own geometry).
    if (viewer) {
      this.dropClaim(id, viewer);
      this.pruneViewer(viewer);
    }
  }

  private subscribeBackendExit(): void {
    const backend = this.opts.backend;
    this.backendUnsubs.push(
      backend.onSessionExit?.((ptyId) => this.onPtyExited(ptyId, null)) ?? (() => {}),
      backend.onSubshellExit?.((ptyId, code) => this.onPtyExited(ptyId, code)) ?? (() => {}),
    );
  }

  private onPtyExited(id: string, code: number | null): void {
    const entry = this.ptys.get(id);
    if (!entry) return;
    entry.status = 'exited';
    entry.exitCode = code;
    this.patchPtys();
    // Keep the entry — viewers see the dead terminal until it is removed
    // (state save for sessions, closePty for remote-spawned).
    for (const s of this.streams.get(id) ?? []) s.close(code !== null ? `exited:${code}` : 'exited');
    this.streams.delete(id);
    this.claims.delete(id);
    this.outputUnsubs.get(id)?.();
    this.outputUnsubs.delete(id);
  }

  // ---- forwarded invokes (same /vm/* vocabulary as AxnHostVm) ----

  private async handleInvoke(path: string, args: unknown[]): Promise<unknown> {
    const command = path.replace(/^\/?(vm\/)?/, '');
    const a = args.map((x) => (x === null ? undefined : x));
    const backend = this.opts.backend;
    switch (command) {
      case 'createPty':
        return this.createPty(
          String(a[0]),
          num(a[1]) ?? 80,
          num(a[2]) ?? 24,
          a[3] === undefined ? undefined : String(a[3]),
          a[4] === undefined ? undefined : String(a[4]),
        );
      case 'closePty': {
        const id = String(a[0]);
        const entry = this.ptys.get(id);
        if (!entry) return noSuchPty(id);
        // A remote close kills only what it spawned — a mirrored PTY is
        // owned by the local session; "closing" it remotely detaches and
        // removes it from the mirror until the next model reflect.
        if (entry.remote) backend.close(id);
        this.removePty(id, 'closed');
        this.patchPtys();
        return { ok: true };
      }
      case 'resizePty': {
        const id = String(a[0]);
        const r = this.requirePty(id);
        if ('error' in r) return r;
        const cols = num(a[1]) ?? 80;
        const rows = num(a[2]) ?? 24;
        // Remote-owned PTYs take the viewer's geometry directly.
        if (r.remote) {
          backend.resize(id, cols, rows);
          r.cols = cols;
          r.rows = rows;
          this.patchPtys();
          return { ok: true };
        }
        // Mirrored PTY: this is a viewport claim, not a size command. The
        // PTY takes the smallest geometry across all active claimants.
        const viewer = a[3] === undefined ? 'anon' : String(a[3]);
        this.touchViewer(viewer);
        let m = this.claims.get(id);
        if (!m) { m = new Map(); this.claims.set(id, m); }
        m.set(viewer, { cols, rows });
        this.applyEffectiveSize(id);
        this.patchClaims();
        return { ok: true };
      }
      case 'unclaimViewport': {
        // A client left the session (hidden/paused) — remove its claim.
        const id = String(a[0]);
        const viewer = a[1] === undefined ? 'anon' : String(a[1]);
        this.dropClaim(id, viewer);
        return { ok: true };
      }
      case 'pauseViewport': {
        // Drop every claim held by this client.
        const viewer = a[0] === undefined ? 'anon' : String(a[0]);
        for (const id of [...this.claims.keys()]) this.dropClaim(id, viewer);
        return { ok: true };
      }
      case 'resumeViewport':
        return { ok: true };
      case 'reportViewer': {
        // A client announces itself: name + platform for the /viewers roster.
        const viewer = a[0] === undefined ? 'anon' : String(a[0]);
        this.touchViewer(
          viewer,
          a[1] === undefined ? undefined : String(a[1]),
          a[2] === undefined ? undefined : String(a[2]),
        );
        return { ok: true };
      }
      case 'setPtyMeta': {
        // Session-model fields (rename, workspace move, re-parenting after
        // a sub-shell promotion). Undefined args leave the field untouched —
        // AxnHostVm's command vocabulary, mirrored for client-authoritative
        // sessions; without it every phone-side edit answers 'unknown
        // command' and never syncs back.
        const id = String(a[0]);
        const entry = this.ptys.get(id);
        if (!entry) return noSuchPty(id);
        if (a[1] !== undefined) entry.sessionId = String(a[1]);
        if (a[2] !== undefined) entry.workspaceId = String(a[2]);
        if (a[3] !== undefined) entry.name = String(a[3]);
        if (a[4] !== undefined) entry.kind = String(a[4]) as PtyEntry['kind'];
        this.patchPtys();
        return { ok: true };
      }
      case 'upsertWorkspace': {
        // Shared workspace names — rename on one device lands everywhere.
        const id = String(a[0]);
        const name = a[1] === undefined ? undefined : String(a[1]);
        this.workspaces.set(id, name ?? this.workspaces.get(id));
        this.patchReplace('/workspaces', this.workspaceEntries());
        return { ok: true };
      }
      case 'setPluginState': {
        // Generic shared plane — opaque JSON strings keyed `app:`/`sess:`.
        // Absent/empty data clears the entry (AxnHostVm semantics).
        const key = String(a[0]);
        const data = a[1] === undefined ? undefined : String(a[1]);
        this.setSharedState(key, data);
        this.opts.onSharedState?.(key, data);
        return { ok: true };
      }
      case 'ptyTail': {
        const r = this.requirePty(String(a[0]));
        if ('error' in r) return r;
        const data = this.opts.getScrollback?.(String(a[0]));
        const bytes =
          typeof data === 'string' ? new TextEncoder().encode(data) : data;
        return { ok: true, data: bytes?.length ? toB64(bytes) : undefined };
      }
      case 'ptyCwd': {
        const r = this.requirePty(String(a[0]));
        if ('error' in r) return r;
        return { ok: true, cwd: (await backend.getCwd?.(String(a[0]))) ?? r.cwd ?? null };
      }
      case 'ptyTty': {
        const r = this.requirePty(String(a[0]));
        if ('error' in r) return r;
        return { ok: true, tty: (await backend.getTty?.(String(a[0]))) ?? null };
      }
      case 'ptyFgProcess': {
        const r = this.requirePty(String(a[0]));
        if ('error' in r) return r;
        return { ok: true, process: (await backend.getForegroundProcess?.(String(a[0]))) ?? null };
      }
      case 'fsRead': {
        const id = String(a[0]);
        const path = await this.resolvePath(id, String(a[1]));
        if (path === undefined) return noSuchPty(id);
        if (a[2] === 'base64') {
          if (!backend.readBytes) return { ok: false, error: 'binary reads unsupported' };
          try {
            const bytes = await backend.readBytes(id, path);
            return { ok: true, contents: toB64(bytes), resolved: path };
          } catch (e) {
            return { ok: false, error: String(e), resolved: path };
          }
        }
        return backend.readFile ? backend.readFile(id, path) : { ok: false, error: 'fs unsupported', resolved: path };
      }
      case 'fsWrite': {
        const id = String(a[0]);
        const path = await this.resolvePath(id, String(a[1]));
        if (path === undefined) return noSuchPty(id);
        return backend.writeFile
          ? backend.writeFile(id, path, String(a[2] ?? ''))
          : { ok: false, error: 'fs unsupported', resolved: path };
      }
      case 'fsStat': {
        const id = String(a[0]);
        const entry = this.ptys.get(id);
        if (!entry) return noSuchPty(id);
        const cwd = (await backend.getCwd?.(id)) ?? entry.cwd ?? '/';
        const stat = backend.statPath ? await backend.statPath(id, cwd, String(a[1])) : null;
        return stat
          ? { ok: true, resolved: stat.path, isFile: stat.isFile, isDir: stat.isDir }
          : { ok: false, error: 'not found' };
      }
      case 'fsList': {
        const id = String(a[0]);
        const path = await this.resolvePath(id, String(a[1]));
        if (path === undefined) return noSuchPty(id);
        if (!backend.listDir) return { ok: false, error: 'fs unsupported' };
        try {
          return { ok: true, entries: await backend.listDir(id, path) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      case 'fsMkdir': {
        const id = String(a[0]);
        const path = await this.resolvePath(id, String(a[1]));
        if (path === undefined) return noSuchPty(id);
        if (!backend.mkdir) return { ok: false, error: 'fs unsupported' };
        try {
          await backend.mkdir(id, path);
          return { ok: true, resolved: path };
        } catch (e) {
          return { ok: false, error: String(e), resolved: path };
        }
      }
      case 'exec': {
        const id = String(a[0]);
        const entry = this.ptys.get(id);
        if (!entry) return noSuchPty(id);
        const argv = a[1] as string[] | undefined;
        const command = a[2] as string | undefined;
        const cwd = (a[3] as string | undefined) ?? entry.cwd;
        if (!backend.exec && !backend.execGit) return { ok: false, error: 'exec unsupported' };
        try {
          const stdout =
            command !== undefined
              ? await backend.exec!(id, command, cwd)
              : argv && argv[0] === 'git' && backend.execGit
                ? await backend.execGit(id, cwd ?? '/', argv.slice(1))
                : await backend.exec!(id, (argv ?? []).map(shellQuote).join(' '), cwd);
          return { ok: true, stdout };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      default:
        return { ok: false, error: `unknown command '${command}'` };
    }
  }

  private async createPty(
    id: string,
    cols: number,
    rows: number,
    cmd?: string,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    if (this.ptys.has(id)) return { ok: true, spawned: false, id };
    const backend = this.opts.backend;
    try {
      // One-shot commands spawn as detached sub-shell PTYs; interactive
      // terminals as ordinary sessions. Either way the desktop owns the
      // process — the remote side gets a live pty:<id> stream.
      if (cmd !== undefined && backend.createSubshell) {
        await backend.createSubshell(id, { parentId: id, command: cmd, cwd, cols, rows });
      } else {
        await backend.createSession(id, { cols, rows, cwd });
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    this.ptys.set(id, {
      id, command: cmd, cwd, cols, rows,
      status: 'running', remote: true, kind: 'detached',
      spawnedAt: new Date().toISOString(),
    });
    // Subscribe immediately — output emitted before a viewer attaches is
    // buffered and replayed on stream open instead of being lost.
    this.subscribeOutput(id);
    this.patchPtys();
    return { ok: true, spawned: true, id };
  }

  /** Resolve a possibly-relative path against the PTY's live cwd. */
  private async resolvePath(id: string, path: string): Promise<string | undefined> {
    const entry = this.ptys.get(id);
    if (!entry) return undefined;
    if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) return path;
    const cwd = (await this.opts.backend.getCwd?.(id)) ?? entry.cwd;
    return cwd ? `${cwd.replace(/\/$/, '')}/${path}` : path;
  }

  private requirePty(id: string): PtyEntry | { error: string } {
    const entry = this.ptys.get(id);
    return entry ?? { error: `no live pty '${id}'` };
  }
}

function publicEntry(e: PtyEntry): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: e.id, name: e.name, command: e.command, cwd: e.cwd,
    cols: e.cols ?? 80, rows: e.rows ?? 24,
    status: e.status, exitCode: e.exitCode ?? null,
    workspaceId: e.workspaceId, sessionId: e.sessionId, kind: e.kind,
    appStatus: e.appStatus, process: e.process,
    spawnedAt: e.spawnedAt,
  };
  // undefined is not a JSON value — drop it so the server's patch applier
  // never sees it.
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** `pty:<id>@<viewer>` -> parts (viewer optional for older clients). */
const streamPtyRef = (name: string): { id?: string; viewer: string } => {
  if (!name.startsWith('pty:')) return { viewer: '' };
  const ref = name.slice(4);
  const at = ref.lastIndexOf('@');
  return at >= 0
    ? { id: ref.slice(0, at), viewer: ref.slice(at + 1) }
    : { id: ref, viewer: '' };
};

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const noSuchPty = (id: string) => ({ ok: false, error: `no live pty '${id}'` });

const decodeUtf8 = (data: Uint8Array): string => new TextDecoder().decode(data);

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function shellQuote(arg: string): string {
  return /^[a-zA-Z0-9_\-./:=]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function hostname(): string {
  // Browser/tauri runtimes don't expose os.hostname(); the meta/device
  // identity carries the real name — this is a display fallback.
  return 'desktop';
}
