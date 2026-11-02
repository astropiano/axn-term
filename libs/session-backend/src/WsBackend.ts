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

interface PendingRequest {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

interface WsConn {
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
  serverSessionId?: string;
  openPromise: Promise<void>;
  /** Set when the close was initiated by this client — not a PTY exit. */
  intentionalClose?: boolean;
}

/**
 * Close code the session host sends (reason `pty-exited`) when the shell
 * process exits; the gateway forwards it unchanged. Every other close is a
 * lost connection, not a shell exit.
 */
export const PTY_EXITED_CLOSE_CODE = 4001;

/** Written (dim) into a session's terminal when its connection drops. */
const CONNECTION_LOST_NOTICE =
  '\r\n\x1b[2m[axn-term: connection lost — reload to reconnect]\x1b[0m\r\n';

export interface WsBackendOptions {
  /** WebSocket URL of the gateway/session-host `/ws` endpoint. */
  url: string;
  /** Optional auth token appended as `?access_token=` (e.g. Keycloak). */
  getToken?: () => Promise<string | undefined> | string | undefined;
}

/**
 * SessionBackend over the session-host WebSocket protocol: binary frames
 * carry PTY output (client input is sent binary as well), JSON text frames
 * carry control messages (`session`, `resize`, `fs-read`/`fs-write`/
 * `fs-stat`/`cwd` and their `*-result`s). Text frames are *only* control —
 * that separation keeps terminal output that happens to be JSON from being
 * sniffed as protocol. One WS connection == one PTY session.
 */
export class WsBackend implements SessionBackend {
  private conns = new Map<string, WsConn>();
  // Output listeners are keyed by client id — independent of the conn
  // instance. A StrictMode remount can replace the conn under a listener;
  // per-conn storage left the replacement with no callbacks (dead output).
  private outputListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private assignedCbs = new Set<(clientId: string, serverId: string) => void>();
  private controlHandlers = new Set<ControlCommandHandler>();

  onControlCommand(cb: ControlCommandHandler): Unsubscribe {
    this.controlHandlers.add(cb);
    return () => this.controlHandlers.delete(cb);
  }
  private closedCbs = new Map<string, Set<() => void>>();
  // Sub-shell bookkeeping: a sub-shell is just another /ws conn whose PTY was
  // spawned with a command/cwd override; parent linkage is client-side so
  // closing a session also closes its sub-shells.
  private subshells = new Set<string>();
  private parents = new Map<string, string>();
  private sessionExitCbs = new Set<(ptyId: string) => void>();
  private subshellExitCbs = new Set<(ptyId: string, exitCode: number | null) => void>();
  private anyOutputCbs = new Set<(sessionId: string, data: Uint8Array) => void>();
  private encoder = new TextEncoder();

  constructor(private opts: WsBackendOptions) {}

  /** Server-assigned session id (arrives via the `session` control message). */
  serverSessionId(clientId: string): string | undefined {
    return this.conns.get(clientId)?.serverSessionId;
  }

  /** Notified when the backend assigns a server session id for a client id. */
  onSessionAssigned(cb: (clientId: string, serverId: string) => void): Unsubscribe {
    this.assignedCbs.add(cb);
    return () => this.assignedCbs.delete(cb);
  }

  /** Notified when a session's connection closes. */
  onSessionClosed(clientId: string, cb: () => void): Unsubscribe {
    let set = this.closedCbs.get(clientId);
    if (!set) this.closedCbs.set(clientId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  async createSession(clientId: string, opts: PtySpawnOptions): Promise<boolean> {
    return this.connect(clientId, opts);
  }

  private async connect(
    clientId: string,
    opts: PtySpawnOptions & { command?: string },
  ): Promise<boolean> {
    const existing = this.conns.get(clientId);
    if (existing && existing.ws.readyState <= WebSocket.OPEN) {
      await existing.openPromise;
      return false;
    }

    let url = this.opts.url;
    const params = new URLSearchParams();
    const token = await this.opts.getToken?.();
    if (token) params.set('access_token', token);
    if (opts.command) params.set('cmd', opts.command);
    if (opts.cwd) params.set('cwd', opts.cwd);
    const qs = params.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;

    const ws = new WebSocket(url);
    // PTY output arrives as binary — deliver bytes, never Blob objects.
    ws.binaryType = 'arraybuffer';
    const conn: WsConn = {
      ws,
      pending: new Map(),
      openPromise: Promise.resolve(),
    };
    conn.openPromise = new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: opts.cols, rows: opts.rows }));
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
    });
    ws.onmessage = (event) => this.handleMessage(clientId, conn, event);
    ws.onclose = (event) => {
      for (const p of conn.pending.values()) p.reject(new Error('session closed'));
      conn.pending.clear();
      // A remount may already have created a replacement conn — only treat
      // this close as the session's death when the conn is still current.
      if (this.conns.get(clientId) !== conn) return;
      this.conns.delete(clientId);
      for (const cb of this.closedCbs.get(clientId) ?? []) cb();
      // Client-initiated closes (unmount, page unload, explicit close) are
      // not exits.
      if (conn.intentionalClose) return;
      // Only the session host's PTY_EXITED_CLOSE_CODE (forwarded by the
      // gateway) means the shell exited. Anything else — network drop,
      // gateway restart, failed connect — keeps the session and tells the
      // user in its terminal instead of deleting it.
      if (event.code !== PTY_EXITED_CLOSE_CODE) {
        const notice = this.encoder.encode(CONNECTION_LOST_NOTICE);
        for (const cb of this.outputListeners.get(clientId) ?? []) cb(notice);
        return;
      }
      // PTY exit: session conns surface `session-exited`, sub-shell conns
      // `subshell-exited` (exit code unknown over WS).
      if (this.subshells.has(clientId)) {
        this.subshells.delete(clientId);
        this.parents.delete(clientId);
        for (const cb of this.subshellExitCbs) cb(clientId, null);
      } else {
        for (const cb of this.sessionExitCbs) cb(clientId);
      }
    };
    this.conns.set(clientId, conn);
    await conn.openPromise;
    return true;
  }

  write(clientId: string, data: string): void {
    const ws = this.conns.get(clientId)?.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(this.encoder.encode(data));
  }

  resize(clientId: string, cols: number, rows: number): void {
    const ws = this.conns.get(clientId)?.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  close(clientId: string): void {
    const conn = this.conns.get(clientId);
    if (!conn) return;
    conn.intentionalClose = true;
    conn.ws.close();
    // Closing a session also closes its sub-shell PTYs (client-side parent
    // tracking — the desktop backend does this via parent_id links).
    for (const [childId, parentId] of this.parents) {
      if (parentId === clientId) this.close(childId);
    }
  }

  onOutput(clientId: string, cb: (data: Uint8Array) => void): Unsubscribe {
    let set = this.outputListeners.get(clientId);
    if (!set) this.outputListeners.set(clientId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  private request(
    clientId: string,
    type: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const conn = this.conns.get(clientId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('session not connected'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      conn.pending.set(requestId, { resolve, reject });
      try {
        conn.ws.send(JSON.stringify({ type, requestId, ...extra }));
      } catch (e) {
        conn.pending.delete(requestId);
        reject(e);
      }
    });
  }

  async readFile(clientId: string, path: string): Promise<FsResult> {
    const msg = await this.request(clientId, 'fs-read', { path });
    return {
      ok: msg.ok === true,
      contents: msg.contents as string,
      error: msg.error as string,
      resolved: msg.resolved as string,
    };
  }

  async writeFile(clientId: string, path: string, contents: string): Promise<FsResult> {
    const msg = await this.request(clientId, 'fs-write', { path, contents });
    return { ok: msg.ok === true, error: msg.error as string, resolved: msg.resolved as string };
  }

  async statPath(clientId: string, _cwd: string, path: string): Promise<PathStat | null> {
    try {
      const msg = await this.request(clientId, 'fs-stat', { path });
      if (msg.ok !== true) return null;
      return { path: msg.resolved as string, isFile: msg.isFile === true, isDir: msg.isDir === true };
    } catch {
      return null;
    }
  }

  async getCwd(clientId: string): Promise<string | null> {
    try {
      const msg = await this.request(clientId, 'cwd', {});
      return msg.ok === true ? (msg.cwd as string) : null;
    } catch {
      return null;
    }
  }

  async getForegroundProcess(clientId: string): Promise<string | null> {
    try {
      const msg = await this.request(clientId, 'fg-process', {});
      return msg.ok === true ? ((msg.process as string) ?? null) : null;
    } catch {
      return null;
    }
  }

  /** `sh -c` in the session host, resolved against the PTY's live cwd. */
  async exec(clientId: string, command: string, cwd?: string): Promise<string> {
    const msg = await this.request(clientId, 'exec', { command, cwd });
    if (msg.ok !== true) throw new Error((msg.error as string) ?? 'exec failed');
    return ((msg.stdout as string) ?? '').trimEnd();
  }

  /** `git` argv (no shell) in `cwd`. */
  async execGit(clientId: string, cwd: string, args: string[]): Promise<string> {
    const msg = await this.request(clientId, 'exec', { argv: ['git', ...args], cwd });
    if (msg.ok !== true) throw new Error((msg.error as string) ?? 'git failed');
    return (msg.stdout as string) ?? '';
  }

  async listDir(clientId: string, path: string): Promise<DirEntry[]> {
    const msg = await this.request(clientId, 'fs-list', { path });
    if (msg.ok !== true) throw new Error((msg.error as string) ?? 'fs-list failed');
    return msg.entries as DirEntry[];
  }

  async mkdir(clientId: string, path: string): Promise<void> {
    const msg = await this.request(clientId, 'fs-mkdir', { path });
    if (msg.ok !== true) throw new Error((msg.error as string) ?? 'fs-mkdir failed');
  }

  async fsExists(clientId: string, path: string): Promise<boolean> {
    try {
      const msg = await this.request(clientId, 'fs-stat', { path });
      return msg.ok === true;
    } catch {
      return false;
    }
  }

  async readBytes(clientId: string, path: string): Promise<Uint8Array> {
    const msg = await this.request(clientId, 'fs-read', { path, encoding: 'base64' });
    if (msg.ok !== true) throw new Error((msg.error as string) ?? 'fs-read failed');
    const binary = atob(msg.contents as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * A sub-shell is a second /ws conn; `?cmd=`/`?cwd=` tell the session host
   * to spawn a different command/directory for this PTY.
   */
  async createSubshell(ptyId: string, opts: SubshellSpawnOptions): Promise<boolean> {
    this.subshells.add(ptyId);
    this.parents.set(ptyId, opts.parentId);
    try {
      return await this.connect(ptyId, {
        cols: opts.cols,
        rows: opts.rows,
        command: opts.command,
        cwd: opts.cwd,
      });
    } catch (e) {
      this.subshells.delete(ptyId);
      this.parents.delete(ptyId);
      throw e;
    }
  }

  /**
   * Client-side reparent: only affects which conn's close cascades to this
   * sub-shell. The remote PTY graph has no parent links.
   */
  setSubshellParent(subshellId: string, parentId: string | null): void {
    if (parentId === null) {
      this.parents.delete(subshellId);
      this.subshells.delete(subshellId);
    } else {
      this.parents.set(subshellId, parentId);
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

  private handleMessage(clientId: string, conn: WsConn, event: MessageEvent): void {
    // Binary frame = PTY output. It bypasses JSON sniffing entirely, so a
    // program printing {"type":"control-command",…} just shows up as text —
    // output can neither be swallowed as protocol nor inject a command.
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      for (const cb of this.outputListeners.get(clientId) ?? []) cb(bytes);
      for (const cb of this.anyOutputCbs) cb(clientId, bytes);
      return;
    }
    if (typeof event.data !== 'string') return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'session' && typeof msg.sessionId === 'string') {
        conn.serverSessionId = msg.sessionId;
        for (const cb of this.assignedCbs) cb(clientId, msg.sessionId);
        return;
      }
      // `axn-term session …` from inside this PTY (host ControlBroker): the
      // frame arrives on this PTY's own connection, so it is ours by id.
      if (msg.type === 'control-command' && typeof msg.requestId === 'string' && typeof msg.line === 'string') {
        const requestId = msg.requestId;
        void answerControl(this.controlHandlers, { ptyId: clientId, line: msg.line }).then((reply) => {
          if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({ type: 'control-reply', requestId, ...reply }));
          }
        });
        return;
      }
      if (typeof msg.type === 'string' && msg.type.endsWith('-result') && msg.requestId) {
        const p = conn.pending.get(msg.requestId);
        if (p) {
          conn.pending.delete(msg.requestId);
          p.resolve(msg);
        }
        return;
      }
    } catch {
      // not JSON — PTY output below
    }
    // Unmatched text: treated as output for backward compatibility with
    // session hosts that still send PTY output as text frames.
    const bytes = this.encoder.encode(event.data);
    for (const cb of this.outputListeners.get(clientId) ?? []) cb(bytes);
    for (const cb of this.anyOutputCbs) cb(clientId, bytes);
  }
}


