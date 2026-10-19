import { RamphastosAuthority, RamphastosStream } from '@astropiano/ramphastos-client';
import type { SessionBackend } from './types';

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
  private streams = new Map<string, RamphastosStream>();
  private outputUnsubs = new Map<string, () => void>();
  private backendUnsubs: (() => void)[] = [];
  private started = false;
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
      sessionId: this.opts.sessionId,
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

    // (Re-)publish after every (re)connect — onReady fires on first
    // connect and after each reconnect+resume.
    this.publishSnapshot();
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
        Object.assign(existing, { name: p.name, command: p.command, cwd: p.cwd ?? existing.cwd, workspaceId: p.workspaceId, sessionId: p.sessionId, kind: p.kind ?? existing.kind });
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
    return {
      device: 'desktop',
      hostname: hostname(),
      defaultCwd: '/',
      defaultShell: this.defaultShell,
      ptys: [...this.ptys.values()].map(publicEntry),
      workspaces: [...this.workspaces].map(([id, name]) => ({ id, name })),
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
  }

  private removePty(id: string, reason: string): void {
    this.ptys.delete(id);
    this.outputUnsubs.get(id)?.();
    this.outputUnsubs.delete(id);
    this.streams.get(id)?.close(reason);
    this.streams.delete(id);
  }

  // ---- streams (demand-driven: nothing flows while nobody watches) ----

  /**
   * Clients pull `pty:<id>` streams — granting echoes a stream-open which
   * the server announces back to us via onStream. No PTY bytes cross the
   * wire until a remote actually opens a stream.
   */
  private handleStreamRequest(name: string): boolean | { direction: 'duplex' } {
    return name.startsWith('pty:') && this.ptys.has(name.slice(4))
      ? { direction: 'duplex' }
      : false;
  }

  private onStreamAnnounced(s: RamphastosStream): void {
    if (!s.name.startsWith('pty:')) return;
    const id = s.name.slice(4);
    if (!this.ptys.has(id)) {
      s.close('gone');
      return;
    }
    this.streams.set(id, s);
    s.onData((data) => this.opts.backend.write(id, decodeUtf8(data)));
    s.onClose((reason) => this.onStreamClosed(id, reason));
    this.subscribeOutput(id);
  }

  private subscribeOutput(id: string): void {
    if (this.outputUnsubs.has(id)) return; // survives stream re-opens
    this.outputUnsubs.set(
      id,
      this.opts.backend.onOutput(id, (data) => {
        this.streams.get(id)?.write(data);
      }),
    );
  }

  private onStreamClosed(id: string, _reason?: string): void {
    this.streams.delete(id);
    // A closed pty stream means the terminal is done — same semantic as
    // AxnHostVm's /ws disconnect. Leave model cleanup to the next reflect
    // or the exit callback.
    this.opts.backend.close(id);
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
    this.streams.get(id)?.close(code !== null ? `exited:${code}` : 'exited');
    this.streams.delete(id);
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
        if (!this.ptys.has(id)) return noSuchPty(id);
        backend.close(id);
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
        backend.resize(id, cols, rows);
        r.cols = cols;
        r.rows = rows;
        this.patchPtys();
        return { ok: true };
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
    spawnedAt: e.spawnedAt,
  };
  // undefined is not a JSON value — drop it so the server's patch applier
  // never sees it.
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

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
