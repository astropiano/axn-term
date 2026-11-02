import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  exists,
  mkdir,
  readDir,
  readFile as readBinaryFile,
  readTextFile,
  watch,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type {
  DirEntry,
  FileReader,
  FsResult,
  MemoryStats,
  PathStat,
  PtySpawnOptions,
  SessionBackend,
  ShellServices,
  SubshellSpawnOptions,
  Unsubscribe,
} from './types';

interface SubshellExited {
  id: string;
  exit_code: number | null;
}

const idDecoder = new TextDecoder();
/** Acknowledge received output in steps of this much… */
const ACK_BATCH_BYTES = 64 * 1024;
/** …or after this long, whichever comes first. */
const ACK_DELAY_MS = 30;

/**
 * Splits an `attach_output` frame: big-endian u16 id length, the session
 * id, then the raw PTY bytes.
 */
export function parseOutputFrame(frame: ArrayBuffer | Uint8Array): { sessionId: string; data: Uint8Array } {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const idLen = (bytes[0] << 8) | bytes[1];
  return {
    sessionId: idDecoder.decode(bytes.subarray(2, 2 + idLen)),
    data: bytes.subarray(2 + idLen),
  };
}

/** SessionBackend over Tauri commands/events — used by the desktop app. */
export class TauriBackend implements SessionBackend {
  readonly localFiles = true;
  private outputCbs = new Map<string, Set<(data: Uint8Array) => void>>();
  private anyOutputCbs = new Set<(sessionId: string, data: Uint8Array) => void>();
  private outputChannel: Channel<ArrayBuffer> | null = null;
  private unackedBytes = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tell the backend how much output this webview has taken off the
   * channel; it holds further output while too much is unacknowledged.
   */
  private ackOutput(bytes: number): void {
    this.unackedBytes += bytes;
    if (this.unackedBytes >= ACK_BATCH_BYTES) {
      this.flushAck();
    } else if (this.ackTimer === null) {
      this.ackTimer = setTimeout(() => this.flushAck(), ACK_DELAY_MS);
    }
  }

  private flushAck(): void {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    const bytes = this.unackedBytes;
    if (bytes === 0) return;
    this.unackedBytes = 0;
    invoke('ack_output', { bytes }).catch(() => {});
  }

  /**
   * One raw-byte channel per webview carries every session's output. Its
   * `attach_output` invoke goes out before any `create_session` that follows,
   * and both run in order on the backend, so no early output is missed.
   */
  private ensureOutputChannel(): void {
    if (this.outputChannel) return;
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (frame) => {
      // Acknowledge first: a throwing callback must not stall the output.
      this.ackOutput(frame.byteLength);
      const { sessionId, data } = parseOutputFrame(frame);
      const cbs = this.outputCbs.get(sessionId);
      if (cbs) for (const cb of cbs) cb(data);
      for (const cb of this.anyOutputCbs) cb(sessionId, data);
    };
    this.outputChannel = channel;
    invoke('attach_output', { channel }).catch((e: unknown) => {
      console.error('[tauri] attach_output failed:', e);
      if (this.outputChannel === channel) this.outputChannel = null;
    });
  }

  createSession(sessionId: string, opts: PtySpawnOptions): Promise<boolean> {
    return invoke<boolean>('create_session', {
      sessionId,
      shell: opts.shell,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  write(sessionId: string, data: string): void {
    invoke('write_session', { sessionId, data }).catch(() => {});
  }

  writeWhenRaw(sessionId: string, data: string): void {
    invoke('write_when_raw', { sessionId, data }).catch(() => {});
  }

  resize(sessionId: string, cols: number, rows: number): void {
    invoke('resize_session', { sessionId, cols, rows }).catch(() => {});
  }

  pause(sessionId: string): void {
    invoke('pause_session', { sessionId }).catch(() => {});
  }

  resume(sessionId: string): void {
    invoke('resume_session', { sessionId }).catch(() => {});
  }

  close(sessionId: string): void {
    invoke('close_session', { sessionId }).catch(() => {});
  }

  onOutput(sessionId: string, cb: (data: Uint8Array) => void): Unsubscribe {
    let set = this.outputCbs.get(sessionId);
    if (!set) this.outputCbs.set(sessionId, (set = new Set()));
    set.add(cb);
    this.ensureOutputChannel();
    return () => set.delete(cb);
  }

  getForegroundProcess(sessionId: string): Promise<string | null> {
    return invoke<string | null>('get_foreground_process', { sessionId });
  }

  getTty(sessionId: string): Promise<string | null> {
    return invoke<string | null>('get_session_tty', { sessionId });
  }

  getCwd(sessionId: string): Promise<string | null> {
    return invoke<string | null>('get_session_cwd', { sessionId });
  }

  getDefaultShell(): Promise<string> {
    return invoke<string>('get_default_shell');
  }

  statPath(_sessionId: string, cwd: string, path: string): Promise<PathStat | null> {
    return invoke<PathStat | null>('stat_path', { cwd, path });
  }

  async readFile(_sessionId: string, path: string): Promise<FsResult> {
    try {
      return { ok: true, contents: await readTextFile(path), resolved: path };
    } catch (e) {
      return { ok: false, error: String(e), resolved: path };
    }
  }

  async writeFile(_sessionId: string, path: string, contents: string): Promise<FsResult> {
    try {
      await writeTextFile(path, contents);
      return { ok: true, resolved: path };
    } catch (e) {
      return { ok: false, error: String(e), resolved: path };
    }
  }

  exec(_sessionId: string, command: string, cwd?: string): Promise<string> {
    return invoke<string>('plugin_exec', { command, cwd });
  }

  execGit(_sessionId: string, cwd: string, args: string[]): Promise<string> {
    return invoke<string>('git_exec', { cwd, args });
  }

  async listDir(_sessionId: string, path: string): Promise<DirEntry[]> {
    const entries = await readDir(path);
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile,
      isDirectory: e.isDirectory,
      isSymlink: e.isSymlink,
    }));
  }

  async mkdir(_sessionId: string, path: string): Promise<void> {
    await mkdir(path);
  }

  async readBytes(_sessionId: string, path: string): Promise<Uint8Array> {
    return new Uint8Array(await readBinaryFile(path));
  }

  saveDroppedFile(_sessionId: string, name: string, bytes: Uint8Array): Promise<string> {
    // Raw IPC body (no JSON/base64 copy of the bytes); the name rides in a header.
    return invoke<string>('save_dropped_file', bytes, {
      headers: { 'x-file-name': encodeURIComponent(name) },
    });
  }

  watchDir(_sessionId: string, path: string, cb: () => void): Promise<Unsubscribe> {
    return watch(path, cb, { delayMs: 250 });
  }

  createSubshell(ptyId: string, opts: SubshellSpawnOptions): Promise<boolean> {
    return invoke<boolean>('create_subshell', {
      parentSessionId: opts.parentId,
      subshellId: ptyId,
      command: opts.command ?? null,
      cwd: opts.cwd ?? null,
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  setSubshellParent(subshellId: string, parentId: string | null): void {
    invoke('set_subshell_parent', { subshellId, parentId }).catch(() => {});
  }

  onSessionExit(cb: (ptyId: string) => void): Unsubscribe {
    const p = listen<string>('session-exited', (event) => cb(event.payload));
    return () => void p.then((fn) => fn());
  }

  onSubshellExit(cb: (ptyId: string, exitCode: number | null) => void): Unsubscribe {
    const p = listen<SubshellExited>('subshell-exited', (event) =>
      cb(event.payload.id, event.payload.exit_code),
    );
    return () => void p.then((fn) => fn());
  }

  onAnyOutput(cb: (sessionId: string, data: Uint8Array) => void): Unsubscribe {
    this.anyOutputCbs.add(cb);
    this.ensureOutputChannel();
    return () => void this.anyOutputCbs.delete(cb);
  }

  getMemoryStats(): Promise<MemoryStats> {
    return invoke<MemoryStats>('get_memory_stats');
  }

  /** True when the path exists (host filesystem). */
  async fsExists(_sessionId: string, path: string): Promise<boolean> {
    return exists(path);
  }
}

/** Singleton backend — Tauri invoke/listen are process-global anyway. */
export const tauriBackend = new TauriBackend();

export const tauriServices: ShellServices = {
  copyText: (text) =>
    invoke<void>('clipboard_write_text', { text }).catch((e: unknown) =>
      console.warn('[clipboard] write failed:', e),
    ),
  pasteText: () => invoke<string | null>('clipboard_read_text').then((t) => t ?? undefined),
  openExternal: (url) => openUrl(url).catch(() => {}),
  openDirectory: (path) => invoke('open_directory', { path }).catch(() => {}),
  revealPath: (path) => invoke('reveal_path', { path }).catch(() => {}),
  storage: {
    get: (key) => invoke<string | null>('kv_get', { key }),
    set: (key, value) => invoke<void>('kv_set', { key, value }),
  },
  notify: (title, body) => {
    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (granted) sendNotification({ title, body });
      } catch {
        // notifications unavailable — ignore
      }
    })();
  },
  onFileDrop: (cb) => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'drop' && event.payload.paths.length) cb(event.payload.paths);
    });
    return () => void unlisten.then((off) => off()).catch(() => {});
  },
};

/** FileReader over the Tauri fs plugin, resolving relative paths against cwd. */
export function tauriFileReader(cwd?: string): FileReader {
  const resolve = (p: string) => {
    if (p.startsWith('/')) return p;
    const base = cwd && cwd.length > 0 ? cwd : '/';
    const parts = `${base.replace(/\/+$/, '')}/${p}`.split('/');
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return `/${out.join('/')}`;
  };
  return {
    readText: (p) => readTextFile(resolve(p)),
    readBytes: (p) => readBinaryFile(resolve(p)).then((b) => new Uint8Array(b)),
    writeText: (p, c) => writeTextFile(resolve(p), c),
  };
}
