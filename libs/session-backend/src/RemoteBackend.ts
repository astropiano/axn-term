import { RamphastosSession, RamphastosStream } from 'ramphastos-client';
import { answerControl } from './types.ts';
import { listRemoteSessions, scopeSessionId, type RemoteSessionInfo } from './remoteScope.ts';
import type {
  ControlCommandHandler,
  DirEntry,
  FsResult,
  PathStat,
  PtySpawnOptions,
  RemoteConsole,
  RemoteConsoleSnapshot,
  SessionBackend,
  SubshellSpawnOptions,
  Unsubscribe,
} from './types';

export interface RemoteBackendOptions {
  /**
   * Ramphastos hub URL — session-host direct (`http://<host>:7682/ramphastos`)
   * or through the gateway (`ws(s)://<gateway>/ramphastos`).
   */
  url: string;
  /** Optional auth token for the hello handshake (`auth` field). */
  getToken?: () => Promise<string | undefined> | string | undefined;
  /**
   * Reattach/pin a session id — e.g. a persisted id so a reload keeps the
   * same projection. The assigned id is readable via `sessionId`.
   */
  sessionId?: string;
  /** "controller" (default, interactive) or "viewer" (watch-only). */
  role?: 'controller' | 'viewer';
  /** Display name this device reports into the /viewers roster. */
  viewerName?: string;
  /**
   * Set when `url` goes through a proxy that forwards WebSocket frames only
   * (the axn-term gateway) — skips the SignalR negotiate POST.
   */
  webSocketOnly?: boolean;
}

interface PtyEntry {
  stream?: RamphastosStream;
  intentionalClose?: boolean;
  /** Stream closed because the tab was hidden — re-pull when shown. */
  released?: boolean;
  /** Stream died with the transport — re-pull on the next session. */
  lost?: boolean;
  /** Tail replay + stream re-pull in flight. */
  reacquiring?: boolean;
}

/** RIS — clears screen and scrollback before a re-acquire replays the tail. */
const RESET = '\x1bc';

/** A connect attempt overtaken by chooseSession/disconnect. */
class SupersededError extends Error {
  constructor() {
    super('remote connect superseded');
  }
}

/** Per-device viewer identity — stable across reloads (localStorage) so a
 *  refreshed page reattaches as the same roster/claims entry instead of
 *  ghosting the roster with a new id every load. */
function loadViewerId(): string {
  const KEY = 'axn-term:viewer-id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * SessionBackend over Ramphastos: one multiplexed SignalR connection to a
 * session host (server-authoritative `AxnHostVm`) or, later, a mirrored
 * desktop session — the wire is identical either way.
 *
 * Mapping: `createSession` → `createPty` command (idempotent — reattaches to
 * a live remote PTY); PTY IO rides the server-announced `pty:<id>` duplex
 * stream (write upstream = keystrokes, frames downstream = output); the
 * fs/exec/cwd/fg/tty surface maps to per-pty commands.
 */
export class RemoteBackend implements SessionBackend {
  private session?: RamphastosSession;
  private connectPromise?: Promise<RamphastosSession>;
  private ptys = new Map<string, PtyEntry>();

  private outputListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private anyOutputCbs = new Set<(sessionId: string, data: Uint8Array) => void>();
  // Input typed before the pty stream lands: queued per-pty, flushed on
  // adoptStream. Unbounded only while detached — a reconnecting client
  // still types and every keystroke must reach the PTY.
  private pendingWrites = new Map<string, string[]>();
  private closedCbs = new Map<string, Set<() => void>>();
  private sessionExitCbs = new Set<(ptyId: string) => void>();
  private subshellExitCbs = new Set<(ptyId: string, exitCode: number | null) => void>();
  private subshells = new Set<string>();
  private parents = new Map<string, string>();
  private remoteSpawned = new Set<string>();
  /** This device's identity in the per-session width-claims/roster
   *  collections — persisted so a page reload reattaches as the same
   *  viewer instead of ghosting the roster with a fresh id each time. */
  private viewerId = loadViewerId();
  /** Liveness ping — the authority expires viewers that stop reporting. */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private streamWaiters = new Map<string, { resolve: (s: RamphastosStream) => void; reject: (e: Error) => void }[]>();
  /** pty id → session a pull is running on (one pull per id per session). */
  private pulls = new Map<string, RamphastosSession>();
  /** Bumped by chooseSession/disconnect — an older attempt is dropped. */
  private connectGen = 0;

  private opts: RemoteBackendOptions;

  constructor(opts: RemoteBackendOptions) {
    this.opts = opts;
  }

  /** The session id the hub assigned (or reattached to). */
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /**
   * The connected RamphastosSession — exposes the replicated model (vm())
   * for mirror-state stores driving remote-session UIs.
   */
  ramphastosSession(): Promise<RamphastosSession> {
    return this.connect();
  }

  /** WsBackend parity: the server-side id IS the client-supplied pty id. */
  serverSessionId(clientId: string): string | undefined {
    return this.ptys.has(clientId) ? clientId : undefined;
  }

  // ---- remote console (viewer-side mirror of RemoteAuthority's) ----

  private consoleCbs = new Set<() => void>();
  private consoleUnsub: (() => void) | undefined;
  private consoleSession: RamphastosSession | undefined;
  private consoleSnapshot: RemoteConsoleSnapshot = {
    role: 'viewer', state: 'idle', ptys: [], claims: {},
  };
  /** Reconnect bookkeeping — a dropped transport retries with backoff. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private connErrorKind?: 'unreachable' | 'ws-broken';
  /** Mirrored sessions this account owns (filled by discovery). */
  private availableSessions: RemoteSessionInfo[] = [];

  /**
   * Viewer-side read of the shared `/viewportClaims` + published ptys —
   * same shape the desktop authority's RemoteConsole exposes, so one
   * console UI renders on host and clients alike.
   */
  readonly remoteConsole: RemoteConsole = {
    get: () => this.consoleSnapshot,
    subscribe: (cb) => {
      this.consoleCbs.add(cb);
      this.ensureConsoleFeed();
      return () => this.consoleCbs.delete(cb);
    },
    setViewportPaused: (paused) => this.setViewportPaused(paused),
    retryNow: () => this.retryNow(),
    chooseSession: (id) => this.chooseSession(id),
  };

  private ensureConsoleFeed(): void {
    if (this.consoleSession && this.consoleSession === this.session) return;
    void this.connect().then((session) => {
      if (session === this.session && this.consoleCbs.size) this.bindConsole(session);
    }).catch(() => {});
  }

  /** Feed the console from `session` — rebinding drops the old feed. */
  private bindConsole(session: RamphastosSession): void {
    if (this.consoleSession === session) return;
    this.unbindConsole();
    this.consoleSession = session;
    const unModel = session.onChange(() => this.refreshConsole());
    const unState = session.onStateChange?.(() => this.refreshConsole()) ?? (() => {});
    this.consoleUnsub = () => { unModel(); unState(); };
    this.refreshConsole();
  }

  private unbindConsole(): void {
    this.consoleUnsub?.();
    this.consoleUnsub = undefined;
    this.consoleSession = undefined;
  }

  private refreshConsole(): void {
    const session = this.session;
    const vm = session?.vm() as Record<string, unknown> | undefined;
    const ptys = Array.isArray(vm?.ptys) ? (vm!.ptys as Record<string, unknown>[]) : [];
    const claims =
      (vm?.viewportClaims as RemoteConsoleSnapshot['claims'] | undefined) ?? {};
    this.consoleSnapshot = {
      role: 'viewer',
      state: session?.state ?? 'idle',
      hostName: (vm?.hostname as string | undefined) ?? undefined,
      hostDevice: (vm?.device as string | undefined) ?? undefined,
      selfViewerId: this.viewerId,
      ptys: ptys.map((p) => ({
        id: String(p.id),
        name: p.name === undefined ? undefined : String(p.name),
        sessionId: p.sessionId === undefined ? undefined : String(p.sessionId),
        cols: typeof p.cols === 'number' ? p.cols : undefined,
        rows: typeof p.rows === 'number' ? p.rows : undefined,
      })),
      claims,
      viewers:
        (vm?.viewers as RemoteConsoleSnapshot['viewers'] | undefined) ?? {},
      paused: this.viewportPaused,
      errorKind: this.connErrorKind,
      retrying: this.reconnectTimer !== undefined,
      sessions: this.availableSessions.length
        ? this.availableSessions.map((s) => s.id)
        : undefined,
      sessionId: session?.sessionId ?? this.opts.sessionId,
      authorityUrl: this.opts.url,
    };
    for (const cb of this.consoleCbs) cb();
  }

  /** Backoff reconnect: 1s → 30s cap + jitter. A failed attempt probes the
   *  hub over HTTP to classify the failure (server down vs WS path broken),
   *  then reschedules. `retryNow` skips the wait (overlay button). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect()
        .then(() => this.refreshConsole())
        .catch(async () => {
          this.connErrorKind = await this.probe();
          this.refreshConsole();
          this.scheduleReconnect();
        });
    }, base + Math.random() * 500);
  }

  private retryNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.scheduleReconnect();
  }

  /** HTTP reachability of the hub — a response (even 4xx) means the server
   *  is up and the WS path is broken; nothing means the hub is down. */
  private async probe(): Promise<'unreachable' | 'ws-broken'> {
    try {
      const http = this.opts.url.replace(/^ws/, 'http');
      await fetch(http, { signal: AbortSignal.timeout(3_000) });
      return 'ws-broken';
    } catch {
      return 'unreachable';
    }
  }

  /** Attach to a different mirrored session (console picker). */
  private chooseSession(id: string): void {
    const old = this.session;
    this.opts.sessionId = id;
    this.session = undefined;
    this.connectPromise = undefined;
    this.connectGen++;
    // The old desktop's streams, waiters and queued input don't carry over.
    this.dropStreams(false);
    for (const [, waiters] of this.streamWaiters)
      for (const w of waiters) w.reject(new Error('remote session switched'));
    this.streamWaiters.clear();
    this.pendingWrites.clear();
    this.tailsFetched.clear();
    this.unbindConsole();
    if (old) void old.disconnect().catch(() => {});
    this.refreshConsole();
    void this.connect().then(() => this.refreshConsole()).catch(() => {
      this.refreshConsole();
      this.scheduleReconnect();
    });
  }

  private async connect(): Promise<RamphastosSession> {
    if (!this.connectPromise) {
      const gen = ++this.connectGen;
      this.connectPromise = this.openSession(gen);
    }
    const p = this.connectPromise;
    let s: RamphastosSession;
    try {
      s = await p;
    } catch (e) {
      // A failed attempt must not stick — otherwise every later connect()
      // returns this same cached rejection and no retry ever reaches the
      // network: one denied hello (expired JWT, gateway restart) would
      // brick the backend until a full page reload.
      if (this.connectPromise === p) this.connectPromise = undefined;
      // Overtaken by chooseSession — follow the newer attempt.
      if (e instanceof SupersededError && this.connectPromise) return this.connect();
      throw e;
    }
    if (s.state === 'closed') {
      // Race: the session died between resolve and return — retry once
      // with a fresh connection rather than handing back a corpse.
      if (this.connectPromise === p) this.connectPromise = undefined;
      if (this.session === s) this.session = undefined;
      return this.connect();
    }
    return s;
  }

  private async openSession(gen: number): Promise<RamphastosSession> {
    const token = await this.opts.getToken?.();
    let url = this.opts.url;
    // Browsers can't set WS headers — the gateway authorizes via the
    // access_token query param; the token also rides hello.auth for
    // endpoints that authorize at the envelope level.
    if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    // Discovery is server-side truth for "which mode am I": the account's
    // mirrored desktops always refresh the picker list — even when this
    // attach is pinned (chooseSession can switch live). An unpinned
    // attach has nothing to fall back to, so its lookup failures surface
    // the real fetch/CORS/HTTP cause instead of 'no sessions'.
    let sessionId = this.opts.sessionId;
    try {
      this.availableSessions = await listRemoteSessions(this.opts.url, token);
    } catch (e) {
      if (!sessionId)
        throw new Error(
          `remote session discovery failed: ${e instanceof Error ? e.message : e}`,
        );
    }
    // Prefer a live authority — offline mirrors stay listed (the
    // desktop may return) but attaching to a dead one fails every
    // stream open with authority_offline.
    sessionId ??= this.availableSessions.find((s) => s.online)?.id
      ?? this.availableSessions[0]?.id;
    if (!sessionId) {
      // Not terminal — 'no mirror yet' is a pending state: keep polling
      // on the reconnect backoff so a desktop publishing later attaches
      // on its own, while this attempt still reports the honest reason.
      this.scheduleReconnect();
      throw new Error(
        'no mirrored sessions for this account — is the desktop remote-enabled and signed in?',
      );
    }
    const session = await RamphastosSession.connect(url, {
      auth: token,
      role: this.opts.role ?? 'controller',
      // Tenant-scoped: viewers attach to their own account's namespace.
      sessionId: scopeSessionId(sessionId, token),
      webSocketOnly: this.opts.webSocketOnly,
    });
    if (gen !== this.connectGen) {
      // chooseSession/disconnect ran meanwhile — don't leak this one.
      void session.disconnect().catch(() => {});
      throw new SupersededError();
    }
    session.onStream((s) => this.handleStreamAnnounce(s, session));
    // Streams announced during the handshake (host Attach declares
    // pty:* before our onStream subscription lands) sit in
    // session.streams unadopted — adopt them now so waitForStream
    // finds them instead of timing out.
    for (const s of session.streams.values()) this.handleStreamAnnounce(s, session);
    this.session = session;
    this.reconnectAttempt = 0;
    this.connErrorKind = undefined;
    const report = () =>
      void this.session?.invoke('/vm/reportViewer', [
        this.viewerId,
        this.opts.viewerName ??
          (typeof navigator !== 'undefined' ? `browser — ${navigator.platform}` : 'client'),
        'web',
      ]).catch(() => {});
    report();
    // Heartbeat — the authority expires roster entries/claims that go
    // stale, so the client count tracks actually-live devices. Without
    // this a dead conn ghosts the roster forever.
    this.heartbeatTimer ??= setInterval(report, 10_000);
    // A dropped transport must not be reused — clear the cached promise
    // so the next call reconnects (and re-fetches the token). Only the
    // current session may touch shared state: a replaced one (picker
    // switch, disconnect) closing late must not kill the new one.
    session.onStateChange?.((state) => {
      if (this.session !== session) return;
      if (state === 'ready') {
        // Back from 'reconnecting' — send input queued meanwhile.
        this.flushPending();
        return;
      }
      if (state !== 'closed') return;
      this.session = undefined;
      this.connectPromise = undefined;
      // Stop pinging a dead session — the next connect() reports again.
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      // The library keeps dead streams open on transport loss — drop them
      // so the next session re-pulls instead of writing into the old conn.
      this.dropStreams(true);
      // The console feed rebinds when the next session connects.
      this.unbindConsole();
      this.refreshConsole();
      this.scheduleReconnect();
    });
    if (this.consoleCbs.size) this.bindConsole(session);
    this.resumeStreams(session);
    return session;
  }

  /** Forget every pty stream ref; `lost` marks live ones for re-pull. */
  private dropStreams(lost: boolean): void {
    for (const entry of this.ptys.values()) {
      if (!entry.stream) continue;
      delete entry.stream;
      if (lost && !entry.released) entry.lost = true;
    }
    this.pulls.clear();
    this.controlStream = undefined;
  }

  /** New session: re-pull what the old one carried or was waiting for. */
  private resumeStreams(session: RamphastosSession): void {
    const lost = [...this.ptys].filter(([, e]) => e.lost).map(([id]) => id);
    if (session.vmType !== 'client') {
      // Server-authoritative hosts re-announce pty streams on attach.
      for (const id of lost) delete this.ptys.get(id)!.lost;
      return;
    }
    for (const id of lost) this.reacquire(id);
    for (const id of this.streamWaiters.keys()) {
      if (!this.ptys.get(id)?.reacquiring && this.pulls.get(id) !== session) this.pullStream(id);
    }
    for (const id of this.pendingWrites.keys()) {
      if (!this.streamWaiters.has(id) && !this.ptys.get(id)?.reacquiring)
        void this.waitForStream(id).catch(() => {});
    }
  }

  /** Send input queued while the transport was reconnecting. */
  private flushPending(): void {
    for (const [id, queued] of this.pendingWrites) {
      const stream = this.ptys.get(id)?.stream;
      if (!stream || stream.closed) continue;
      this.pendingWrites.delete(id);
      for (const d of queued) stream.write(d);
    }
  }

  // ---- stream bookkeeping ----

  private handleStreamAnnounce(stream: RamphastosStream, session: RamphastosSession): void {
    // A replaced session's late announce must not displace live streams.
    if (this.session && this.session !== session) return;
    if (stream.name === 'control') {
      this.adoptControlStream(stream);
      return;
    }
    const id = ptyIdOf(stream.name);
    if (id === undefined) return;

    if (stream.closed) {
      this.handleStreamClosed(id, stream.closeReason);
      return;
    }
    this.adoptStream(id, stream);
  }

  // `axn-term session …` (host ControlBroker): requests arrive as JSON on
  // the duplex `control` stream, answers go back the same way.
  private controlHandlers = new Set<ControlCommandHandler>();
  private controlStream?: RamphastosStream;

  onControlCommand(cb: ControlCommandHandler): Unsubscribe {
    this.controlHandlers.add(cb);
    return () => this.controlHandlers.delete(cb);
  }

  private adoptControlStream(stream: RamphastosStream): void {
    if (this.controlStream === stream || stream.closed) return;
    this.controlStream = stream;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    stream.onData((data) => {
      let req: { requestId?: unknown; ptyId?: unknown; line?: unknown };
      try {
        req = JSON.parse(decoder.decode(data));
      } catch {
        return;
      }
      const { requestId, ptyId, line } = req;
      if (typeof requestId !== 'string' || typeof ptyId !== 'string' || typeof line !== 'string') return;
      void answerControl(this.controlHandlers, { ptyId, line }).then((reply) =>
        stream.write(encoder.encode(JSON.stringify({ requestId, ...reply }))),
      );
    });
    stream.onClose(() => {
      if (this.controlStream === stream) this.controlStream = undefined;
    });
  }

  private adoptStream(id: string, stream: RamphastosStream): void {
    const entry = this.ptys.get(id) ?? {};
    // The grant announce reaches this client via onStream too — adopting
    // twice would double-wire onData/onClose.
    if (entry.stream === stream) return;
    entry.stream = stream;
    delete entry.released;
    delete entry.lost;
    this.ptys.set(id, entry);

    const waiters = this.streamWaiters.get(id);
    if (waiters) {
      this.streamWaiters.delete(id);
      for (const w of waiters) w.resolve(stream);
    }

    const queued = this.pendingWrites.get(id);
    if (queued) {
      this.pendingWrites.delete(id);
      for (const d of queued) stream.write(d);
    }

    // A replaced stream (hidden, transport lost, re-pulled) is ignored.
    const current = () => this.ptys.get(id)?.stream === stream;
    stream.onData((data) => {
      if (!current()) return;
      for (const cb of this.outputListeners.get(id) ?? []) cb(data);
      for (const cb of this.anyOutputCbs) cb(id, data);
    });
    stream.onClose((reason) => {
      if (current()) this.handleStreamClosed(id, reason);
    });
  }

  private handleStreamClosed(id: string, reason?: string): void {
    const entry = this.ptys.get(id);
    if (!entry) return;
    entry.stream = undefined;
    this.pendingWrites.delete(id);
    this.tailsFetched.delete(id);
    for (const cb of this.closedCbs.get(id) ?? []) cb();
    if (entry.intentionalClose) return;

    // Server-initiated close = the terminal ended. reason "exited:<code>"
    // carries the process exit code; "closed" is another client's closePty.
    const code = reason?.startsWith('exited:') ? Number.parseInt(reason.slice(7), 10) : null;
    if (this.subshells.has(id)) {
      this.subshells.delete(id);
      this.parents.delete(id);
      for (const cb of this.subshellExitCbs) cb(id, Number.isNaN(code) ? null : code);
    } else {
      for (const cb of this.sessionExitCbs) cb(id);
    }
  }

  private waitForStream(id: string): Promise<RamphastosStream> {
    const existing = this.ptys.get(id)?.stream;
    // A CLOSED stream is no stream: the hub doesn't echo stream-close back
    // to the closer, so entry.stream can hold a dead object — resolving it
    // here would skip the re-pull and leave every write queued forever
    // (the "typing on the phone does nothing" failure).
    if (existing && !existing.closed) return Promise.resolve(existing);
    const promise = new Promise<RamphastosStream>((resolve, reject) => {
      const waiter = {
        resolve: (s: RamphastosStream) => { clearTimeout(timer); resolve(s); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      // A timed-out waiter leaves the list, so the next wait pulls again.
      const timer = setTimeout(() => {
        const list = this.streamWaiters.get(id);
        const i = list?.indexOf(waiter) ?? -1;
        if (i >= 0) list!.splice(i, 1);
        if (list && !list.length) this.streamWaiters.delete(id);
        reject(new Error(`stream pty:${id} never acquired`));
      }, 10_000);
      const waiters = this.streamWaiters.get(id) ?? [];
      waiters.push(waiter);
      this.streamWaiters.set(id, waiters);
    });
    // Authority-backed (client-authoritative) sessions are demand-driven:
    // nothing is announced until a client opens the stream — pull it.
    // Server-authoritative sessions announce pty:* streams eagerly, so a
    // pull there would create a second, idle stream — skip it.
    const session = this.session;
    if (session?.vmType === 'client' && this.pulls.get(id) !== session) {
      this.pullStream(id);
    }
    return promise;
  }

  /**
   * Pull a pty stream from the authority. The request can race the remote
   * spawn — the authority rejects 'pty:<id>' while its createPty is still
   * in flight — so a transient stream_rejected is retried a few times
   * before giving up to the waiter's timeout.
   */
  private pullStream(id: string, attempt = 0): void {
    const session = this.session;
    if (!session) return;
    this.pulls.set(id, session);
    const done = () => {
      if (this.pulls.get(id) === session) this.pulls.delete(id);
    };
    session.openStream(`pty:${id}@${this.viewerId}`, { direction: 'duplex' })
      .then((s) => {
        done();
        // Session replaced meanwhile — resumeStreams pulls on the new one.
        if (this.session === session) this.adoptStream(id, s);
      })
      .catch((e) => {
        if (this.session !== session) return done();
        if (attempt < 5 && this.streamWaiters.has(id) && !this.ptys.get(id)?.stream) {
          setTimeout(() => this.pullStream(id, attempt + 1), 250);
        } else {
          done();
          console.error(`[remote] openStream pty:${id} failed`, e);
        }
      });
  }

  // ---- SessionBackend ----

  async createSession(clientId: string, opts: PtySpawnOptions): Promise<boolean> {
    const session = await this.connect().catch((e) => {
      console.error(`[remote] connect failed for ${clientId}`, e);
      throw e;
    });
    const result = await invoke(session, 'createPty', clientId, opts.cols, opts.rows,
      opts.shell ? `exec ${opts.shell}` : undefined, opts.cwd,
      clientId, undefined, undefined, 'session');
    if (result.ok !== true) {
      const err = new Error(String(result.error ?? 'createPty failed'));
      console.error(`[remote] createPty ${clientId} rejected`, result);
      throw err;
    }
    this.ptys.set(clientId, this.ptys.get(clientId) ?? {});
    await this.waitForStream(clientId);
    if (result.spawned === true) this.remoteSpawned.add(clientId);
    return result.spawned === true;
  }

  write(clientId: string, data: string): void {
    const entry = this.ptys.get(clientId);
    const stream = entry?.stream && !entry.stream.closed ? entry.stream : undefined;
    const reconnecting = this.session?.state === 'reconnecting';
    if (stream && !reconnecting) {
      try {
        stream.write(data);
        return;
      } catch (e) {
        console.warn(`[remote] write to pty:${clientId} failed — re-pulling`, e);
        delete entry!.stream;
      }
    }
    // Stream not adopted yet (attach in flight / reconnect) — queue instead
    // of dropping the keystroke.
    const q = this.pendingWrites.get(clientId) ?? [];
    q.push(data);
    this.pendingWrites.set(clientId, q);
    // Reconnecting in place: flushed when the session is ready again.
    if (stream && reconnecting) return;
    if (entry?.released || entry?.lost) {
      this.reacquire(clientId);
    } else if (!entry?.reacquiring) {
      void this.waitForStream(clientId).catch((e: Error) =>
        console.warn(`[remote] input for pty:${clientId} stays queued: ${e.message}`),
      );
    }
  }

  private lastCols = 0;
  private lastRows = 0;
  private viewportPaused = false;

  /**
   * Viewer released the pty from view — closing its stream lets the
   * authority relax the geometry back to the desktop's size. Remote-spawned
   * PTYs are skipped: closing their stream would kill them outright.
   */
  releasePty(clientId: string): void {
    // Drop this device's width claim even when no stream was attached —
    // the authority recomputes the session's effective (smallest) size.
    void this.session?.invoke('/vm/unclaimViewport', [clientId, this.viewerId]);
    if (this.remoteSpawned.has(clientId)) return;
    // Only pull-based (client-authoritative) streams can be re-acquired.
    if (this.session?.vmType !== 'client') return;
    const entry = this.ptys.get(clientId);
    const s = entry?.stream;
    if (!entry || !s) return;
    delete entry.stream;
    entry.released = true;
    s.close('hidden');
  }

  /**
   * Re-pull a released/lost stream: replay the tail first (with a reset,
   * the terminal still shows the stale screen), then open the stream.
   */
  private reacquire(clientId: string): void {
    const entry = this.ptys.get(clientId);
    if (!entry || entry.reacquiring) return;
    delete entry.released;
    delete entry.lost;
    entry.reacquiring = true;
    this.tailsFetched.add(clientId);
    void this.fetchTail(clientId, true)
      .catch((e) => console.error(`[remote] ptyTail ${clientId} failed`, e))
      .then(() => this.ensureStream(clientId))
      .catch(() => {})
      .finally(() => {
        entry.reacquiring = false;
      });
  }

  resize(clientId: string, cols: number, rows: number): void {
    // Shown again after releasePty — get the live stream back.
    if (this.ptys.get(clientId)?.released) this.reacquire(clientId);
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.viewportPaused) return;
    void this.session?.invoke('/vm/resizePty', [clientId, cols, rows, this.viewerId]);
  }

  setViewportPaused(paused: boolean): void {
    this.viewportPaused = paused;
    this.refreshConsole();
    void this.session?.invoke(
      paused ? '/vm/pauseViewport' : '/vm/resumeViewport',
      paused ? [this.viewerId] : [this.viewerId, this.lastCols || 80, this.lastRows || 24],
    );
  }

  close(clientId: string): void {
    const entry = this.ptys.get(clientId);
    if (!entry) return;
    entry.intentionalClose = true;
    void this.session?.invoke('/vm/closePty', [clientId]);
    for (const [childId, parentId] of this.parents) {
      if (parentId === clientId) this.close(childId);
    }
  }

  // PTYs whose tail was already replayed to listeners — one fetch each.
  private tailsFetched = new Set<string>();

  onOutput(clientId: string, cb: (data: Uint8Array) => void): Unsubscribe {
    let set = this.outputListeners.get(clientId);
    if (!set) this.outputListeners.set(clientId, (set = new Set()));
    set.add(cb);
    const entry = this.ptys.get(clientId);
    if (entry?.released || entry?.lost) {
      // Re-attach after a hide/drop — fresh tail + stream.
      this.reacquire(clientId);
      return () => set.delete(cb);
    }
    // Late attach: replay the server-side tail so a pre-existing PTY paints
    // its scrollback before live frames (streams carry no history). The
    // stream open is sequenced AFTER the tail — firing both concurrently
    // lets live frames paint first and the snapshot land on top, which
    // freezes the dumped screen and duplicates its overlapping lines.
    const openStream = () => {
      // Attaching to a pre-existing PTY on an authority session: no stream
      // was ever announced — pull it so the listener actually gets data.
      if (!this.ptys.get(clientId)?.stream)
        void this.ensureStream(clientId).catch(() => {});
    };
    if (!this.tailsFetched.has(clientId)) {
      this.tailsFetched.add(clientId);
      void this.fetchTail(clientId)
        .catch((e) => {
          console.error(`[remote] ptyTail ${clientId} failed`, e);
          this.tailsFetched.delete(clientId);
        })
        .finally(openStream);
    } else {
      openStream();
    }
    return () => set.delete(cb);
  }

  /**
   * Wait for the connection, then invoke ptyTail. Listeners register while
   * the hub session is still connecting — an immediate invoke would reject
   * with 'not connected' and the replay would never happen (black terminal).
   */
  private async fetchTail(clientId: string, reset = false): Promise<void> {
    const session = await this.connect();
    const r = await invoke(session, 'ptyTail', clientId);
    const b64 = r.data as string | undefined;
    if (!b64) return;
    const bin = (reset ? RESET : '') + atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    for (const l of this.outputListeners.get(clientId) ?? []) l(bytes);
  }

  /** Pull the pty stream once connected (authority sessions are
   * demand-driven; server-authoritative sessions announce eagerly). */
  private async ensureStream(clientId: string): Promise<void> {
    const session = await this.connect();
    if (session.vmType === 'client' && !this.ptys.get(clientId)?.stream)
      await this.waitForStream(clientId);
  }

  /** Notified when a session's stream closes (PTY exited or closed). */
  onSessionClosed(clientId: string, cb: () => void): Unsubscribe {
    let set = this.closedCbs.get(clientId);
    if (!set) this.closedCbs.set(clientId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  onSessionAssigned(_cb: (clientId: string, serverId: string) => void): Unsubscribe {
    return () => {};
  }

  async getCwd(clientId: string): Promise<string | null> {
    try {
      const r = await this.invoke('ptyCwd', clientId);
      return r.ok === true ? (r.cwd as string) : null;
    } catch {
      return null;
    }
  }

  async getForegroundProcess(clientId: string): Promise<string | null> {
    try {
      const r = await this.invoke('ptyFgProcess', clientId);
      return r.ok === true ? ((r.process as string) ?? null) : null;
    } catch {
      return null;
    }
  }

  async getTty(clientId: string): Promise<string | null> {
    try {
      const r = await this.invoke('ptyTty', clientId);
      return r.ok === true ? ((r.tty as string) ?? null) : null;
    } catch {
      return null;
    }
  }

  async getDefaultShell(): Promise<string> {
    const session = await this.connect();
    return (session.vm().defaultShell as string) ?? '/bin/sh';
  }

  async statPath(clientId: string, _cwd: string, path: string): Promise<PathStat | null> {
    try {
      const r = await this.invoke('fsStat', clientId, path);
      if (r.ok !== true) return null;
      return { path: r.resolved as string, isFile: r.isFile === true, isDir: r.isDir === true };
    } catch {
      return null;
    }
  }

  async readFile(clientId: string, path: string): Promise<FsResult> {
    const r = await this.invoke('fsRead', clientId, path);
    return {
      ok: r.ok === true,
      contents: r.contents as string,
      error: r.error as string,
      resolved: r.resolved as string,
    };
  }

  async writeFile(clientId: string, path: string, contents: string): Promise<FsResult> {
    const r = await this.invoke('fsWrite', clientId, path, contents);
    return { ok: r.ok === true, error: r.error as string, resolved: r.resolved as string };
  }

  async exec(clientId: string, command: string, cwd?: string): Promise<string> {
    const r = await this.invoke('exec', clientId, undefined, command, cwd);
    if (r.ok !== true) throw new Error(String(r.error ?? 'exec failed'));
    return ((r.stdout as string) ?? '').trimEnd();
  }

  async execGit(clientId: string, cwd: string, args: string[]): Promise<string> {
    const r = await this.invoke('exec', clientId, ['git', ...args], undefined, cwd);
    if (r.ok !== true) throw new Error(String(r.error ?? 'git failed'));
    return (r.stdout as string) ?? '';
  }

  async listDir(clientId: string, path: string): Promise<DirEntry[]> {
    const r = await this.invoke('fsList', clientId, path);
    if (r.ok !== true) throw new Error(String(r.error ?? 'fs-list failed'));
    return r.entries as DirEntry[];
  }

  async mkdir(clientId: string, path: string): Promise<void> {
    const r = await this.invoke('fsMkdir', clientId, path);
    if (r.ok !== true) throw new Error(String(r.error ?? 'fs-mkdir failed'));
  }

  async fsExists(clientId: string, path: string): Promise<boolean> {
    try {
      const r = await this.invoke('fsStat', clientId, path);
      return r.ok === true;
    } catch {
      return false;
    }
  }

  async readBytes(clientId: string, path: string): Promise<Uint8Array> {
    const r = await this.invoke('fsRead', clientId, path, 'base64');
    if (r.ok !== true) throw new Error(String(r.error ?? 'fs-read failed'));
    const binary = atob(r.contents as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** A sub-shell is another PTY; `cmd`/`cwd` steer the spawn like /ws. */
  async createSubshell(ptyId: string, opts: SubshellSpawnOptions): Promise<boolean> {
    this.subshells.add(ptyId);
    this.parents.set(ptyId, opts.parentId);
    try {
      const session = await this.connect();
      const result = await invoke(session, 'createPty', ptyId, opts.cols, opts.rows,
        opts.command, opts.cwd,
        // kind=subshell; sessionId = owning session (resolve through the
        // parents chain in case the parent is itself a promoted subshell)
        this.sessionIdOf(opts.parentId), undefined, undefined, 'subshell');
      if (result.ok !== true) {
        const err = new Error(String(result.error ?? 'createPty failed'));
        console.error(`[remote] createPty ${ptyId} rejected`, result);
        throw err;
      }
      this.ptys.set(ptyId, this.ptys.get(ptyId) ?? {});
      await this.waitForStream(ptyId);
      if (result.spawned === true) this.remoteSpawned.add(ptyId);
      return result.spawned === true;
    } catch (e) {
      this.subshells.delete(ptyId);
      this.parents.delete(ptyId);
      throw e;
    }
  }

  /** The session id a PTY belongs to: itself for mains, resolved through
   * the parents map for sub-shells (promoted sub-shell chains walk up). */
  private sessionIdOf(ptyId: string): string {
    let id = ptyId;
    const seen = new Set<string>();
    while (this.parents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = this.parents.get(id)!;
    }
    return id;
  }

  setSubshellParent(subshellId: string, parentId: string | null): void {
    if (parentId === null) {
      this.parents.delete(subshellId);
      this.subshells.delete(subshellId);
      // Promoted to a main session — re-kind on the authority too, else
      // other devices keep rendering it as a tab under the old parent.
      void this.invoke('setPtyMeta', subshellId, subshellId, null, null, 'session')
        .catch(() => {});
    } else {
      this.parents.set(subshellId, parentId);
      void this.invoke('setPtyMeta', subshellId, this.sessionIdOf(parentId), null, null, 'subshell')
        .catch(() => {});
    }
  }

  onSessionExit(cb: (ptyId: string) => void): Unsubscribe {
    this.sessionExitCbs.add(cb);
    return () => this.sessionExitCbs.delete(cb);
  }

  onSubshellExit(cb: (ptyId: string, exitCode: number | null) => void): Unsubscribe {
    this.subshellExitCbs.add(cb);
    return () => this.subshellExitCbs.delete(cb);
  }

  onAnyOutput(cb: (sessionId: string, data: Uint8Array) => void): Unsubscribe {
    this.anyOutputCbs.add(cb);
    return () => this.anyOutputCbs.delete(cb);
  }

  private invoke(command: string, ...args: unknown[]): Promise<Record<string, unknown>> {
    const session = this.session;
    if (!session) return Promise.reject(new Error('not connected'));
    return invoke(session, command, ...args);
  }

  /** Drop the connection (all PTYs detach — the remote side keeps running). */
  async disconnect(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Detach first: the session's own 'closed' event must not reconnect.
    const session = this.session;
    this.session = undefined;
    this.connectPromise = undefined;
    this.connectGen++;
    this.unbindConsole();
    this.ptys.clear();
    this.pulls.clear();
    this.tailsFetched.clear();
    await session?.disconnect();
  }
}

type ResultBody = Record<string, unknown> & { ok?: unknown };

async function invoke(
  session: RamphastosSession,
  command: string,
  ...args: unknown[]
): Promise<ResultBody> {
  const value = await session.invoke(`/vm/${command}`, args.map((a) => a ?? null));
  return (value ?? {}) as ResultBody;
}

function ptyIdOf(streamName: string): string | undefined {
  const ref = streamName.startsWith('pty:') ? streamName.slice(4) : undefined;
  return ref?.split('@')[0];
}
