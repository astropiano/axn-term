import { RamphastosSession, RamphastosStream } from '@ramphastos/ramphastos-client';
import { answerControl } from './types.ts';
import type {
  ControlCommandHandler,
  DirEntry,
  FsResult,
  PathStat,
  PtySpawnOptions,
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
  /**
   * Set when `url` goes through a proxy that forwards WebSocket frames only
   * (the axn-term gateway) — skips the SignalR negotiate POST.
   */
  webSocketOnly?: boolean;
}

interface PtyEntry {
  stream?: RamphastosStream;
  intentionalClose?: boolean;
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
  /** This device's identity in the per-session width-claims collection. */
  private viewerId = crypto.randomUUID();
  private streamWaiters = new Map<string, { resolve: (s: RamphastosStream) => void; reject: (e: Error) => void }[]>();

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

  private async connect(): Promise<RamphastosSession> {
    this.connectPromise ??= (async () => {
      const token = await this.opts.getToken?.();
      let url = this.opts.url;
      // Browsers can't set WS headers — the gateway authorizes via the
      // access_token query param; the token also rides hello.auth for
      // endpoints that authorize at the envelope level.
      if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
      const session = await RamphastosSession.connect(url, {
        auth: token,
        role: this.opts.role ?? 'controller',
        sessionId: this.opts.sessionId,
        webSocketOnly: this.opts.webSocketOnly,
      });
      session.onStream((s) => this.handleStreamAnnounce(s));
      // Streams announced during the handshake (host Attach declares
      // pty:* before our onStream subscription lands) sit in
      // session.streams unadopted — adopt them now so waitForStream
      // finds them instead of timing out.
      for (const s of session.streams.values()) this.handleStreamAnnounce(s);
      this.session = session;
      // A dropped transport must not be reused — clear the cached promise
      // so the next call reconnects (and re-fetches the token).
      session.onStateChange?.((state) => {
        if (state !== 'closed') return;
        if (this.session === session) this.session = undefined;
        this.connectPromise = undefined;
      });
      return session;
    })();
    const s = await this.connectPromise;
    if (s.state === 'closed') {
      // Race: the session died between resolve and return — retry once
      // with a fresh connection rather than handing back a corpse.
      this.connectPromise = undefined;
      this.session = undefined;
      return this.connect();
    }
    return s;
  }

  // ---- stream bookkeeping ----

  private handleStreamAnnounce(stream: RamphastosStream): void {
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

    stream.onData((data) => {
      for (const cb of this.outputListeners.get(id) ?? []) cb(data);
      for (const cb of this.anyOutputCbs) cb(id, data);
    });
    stream.onClose((reason) => this.handleStreamClosed(id, reason));
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
    if (existing) return Promise.resolve(existing);
    const promise = new Promise<RamphastosStream>((resolve, reject) => {
      const waiters = this.streamWaiters.get(id) ?? [];
      waiters.push({ resolve, reject });
      this.streamWaiters.set(id, waiters);
      setTimeout(() => reject(new Error(`stream pty:${id} never acquired`)), 10_000);
    });
    // Authority-backed (client-authoritative) sessions are demand-driven:
    // nothing is announced until a client opens the stream — pull it.
    // Server-authoritative sessions announce pty:* streams eagerly, so a
    // pull there would create a second, idle stream — skip it.
    if (this.session?.vmType === 'client' && this.streamWaiters.get(id)?.length === 1) {
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
    this.session?.openStream(`pty:${id}@${this.viewerId}`, { direction: 'duplex' })
      .then((s) => this.adoptStream(id, s))
      .catch((e) => {
        if (attempt < 5 && this.streamWaiters.has(id) && !this.ptys.get(id)?.stream) {
          setTimeout(() => this.pullStream(id, attempt + 1), 250);
        } else {
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
    const stream = this.ptys.get(clientId)?.stream;
    if (stream && !stream.closed) { stream.write(data); return; }
    // Stream not adopted yet (attach in flight / reconnect) — queue instead
    // of dropping the keystroke.
    const q = this.pendingWrites.get(clientId) ?? [];
    q.push(data);
    this.pendingWrites.set(clientId, q);
    void this.waitForStream(clientId).catch(() => {});
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
    const entry = this.ptys.get(clientId);
    const s = entry?.stream;
    if (!s) return;
    delete entry!.stream;
    s.close('hidden');
  }

  resize(clientId: string, cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.viewportPaused) return;
    void this.session?.invoke('/vm/resizePty', [clientId, cols, rows, this.viewerId]);
  }

  setViewportPaused(paused: boolean): void {
    this.viewportPaused = paused;
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
    // Late attach: replay the server-side tail so a pre-existing PTY paints
    // its scrollback before live frames (streams carry no history).
    if (!this.tailsFetched.has(clientId)) {
      this.tailsFetched.add(clientId);
      void this.fetchTail(clientId).catch((e) => {
        console.error(`[remote] ptyTail ${clientId} failed`, e);
        this.tailsFetched.delete(clientId);
      });
    }
    // Attaching to a pre-existing PTY on an authority session: no stream
    // was ever announced — pull it so the listener actually gets data.
    if (!this.ptys.get(clientId)?.stream)
      void this.ensureStream(clientId).catch(() => {});
    return () => set.delete(cb);
  }

  /**
   * Wait for the connection, then invoke ptyTail. Listeners register while
   * the hub session is still connecting — an immediate invoke would reject
   * with 'not connected' and the replay would never happen (black terminal).
   */
  private async fetchTail(clientId: string): Promise<void> {
    const session = await this.connect();
    const r = await invoke(session, 'ptyTail', clientId);
    const b64 = r.data as string | undefined;
    if (!b64) return;
    const bin = atob(b64);
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
    await this.session?.disconnect();
    this.session = undefined;
    this.connectPromise = undefined;
    this.ptys.clear();
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
