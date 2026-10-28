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
  /** Connected client roster — the /viewers model plane. An entry lives
   *  while the viewer holds a stream or a claim; reportViewer fills
   *  name/platform. */
  private viewers = new Map<string, { name?: string; platform?: string; since: number }>();
  private outputUnsubs = new Map<string, () => void>();
  /** Output captured before any viewer attaches — replayed on stream open
   *  (remote-spawned PTYs have no xterm buffer for ptyTail to serialize). */
  private outputBuffers = new Map<string, (string | Uint8Array)[]>();
  private backendUnsubs: (() => void)[] = [];
  private started = false;
  private reconnecting = false;
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

    const token = await this.opts.getToken?.();
    let url = this.opts.url;
    if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;

    const authority = await RamphastosAuthority.connect(url, {
      auth: token,
      // Tenant-scoped session id: '<sub>/<id>' makes ownership self-proving
      // on the gateway — survives restarts, needs no shared state.
      sessionId: scopeSessionId(this.opts.sessionId, token),
      webSocketOnly: this.opts.webSocketOnly,
      meta: { app: 'axn-term', ...this.opts.meta },
    });
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

    // (Re-)publish after every (re)connect — onReady fires on first
    // connect and after each reconnect+resume.
    this.publishSnapshot();
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
      this.authority?.publishPatch([
        { op: 'replace', path: '/workspaces', value: [...this.workspaces].map(([id, name]) => ({ id, name })) },
      ]);
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
    this.started = false;
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
      workspaces: [...this.workspaces].map(([id, name]) => ({ id, name })),
      viewportClaims,
      viewers: Object.fromEntries(
        [...this.viewers].map(([id, v]) => [id, { name: v.name, platform: v.platform }]),
      ),
    };
  }

  private publishSnapshot(): void {
    this.authority?.publishSnapshot(this.snapshot());
  }

  private patchPtys(): void {
    // Whole-array replace — the set is small and the diff bookkeeping of
    // index-addressed ops buys nothing here.
    this.authority?.publishPatch([
      { op: 'replace', path: '/ptys', value: [...this.ptys.values()].map(publicEntry) },
    ]);
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
  }

  /** Smallest geometry among all claims plus the owner's live size. */
  private effectiveSize(id: string): { cols: number; rows: number } | undefined {
    const e = this.ptys.get(id);
    const own = this.opts.getPtySize?.(id)
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
    this.authority?.publishPatch([
      { op: 'replace', path: '/viewportClaims', value },
    ]);
    this.refreshConsole();
  }

  private patchViewers(): void {
    this.authority?.publishPatch([
      {
        op: 'replace',
        path: '/viewers',
        value: Object.fromEntries(
          [...this.viewers].map(([id, v]) => [id, { name: v.name, platform: v.platform }]),
        ),
      },
    ]);
    this.refreshConsole();
  }

  private touchViewer(viewer: string, name?: string, platform?: string): void {
    if (viewer === 'anon') return;
    const cur = this.viewers.get(viewer);
    if (cur) {
      if (name !== undefined) cur.name = name;
      if (platform !== undefined) cur.platform = platform;
    } else {
      this.viewers.set(viewer, { name, platform, since: Date.now() });
    }
    this.patchViewers();
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
    if (buffered?.length) {
      for (const d of buffered) s.write(d);
      this.outputBuffers.delete(id);
    }
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
