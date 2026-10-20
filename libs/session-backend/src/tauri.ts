import { invoke } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import {
  exists,
  mkdir,
  readDir,
  readFile as readBinaryFile,
  readTextFile,
  watch,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
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

interface ShellOutput {
  session_id: string;
  data: string;
}

interface SubshellExited {
  id: string;
  exit_code: number | null;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** SessionBackend over Tauri commands/events — used by the desktop app. */
export class TauriBackend implements SessionBackend {
  private outputCbs = new Map<string, Set<(data: Uint8Array) => void>>();
  private unlistenPromise: Promise<UnlistenFn> | null = null;

  private ensureOutputListener(): void {
    this.unlistenPromise ??= listen('shell-output', (event: Event<ShellOutput>) => {
      const cbs = this.outputCbs.get(event.payload.session_id);
      if (!cbs?.size) return;
      const bytes = decodeBase64(event.payload.data);
      for (const cb of cbs) cb(bytes);
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

  resize(sessionId: string, cols: number, rows: number): void {
    invoke('resize_session', { sessionId, cols, rows }).catch(() => {});
  }

  close(sessionId: string): void {
    invoke('close_session', { sessionId }).catch(() => {});
  }

  onOutput(sessionId: string, cb: (data: Uint8Array) => void): Unsubscribe {
    let set = this.outputCbs.get(sessionId);
    if (!set) this.outputCbs.set(sessionId, (set = new Set()));
    set.add(cb);
    this.ensureOutputListener();
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
    const p = listen<ShellOutput>('shell-output', (event) =>
      cb(event.payload.session_id, decodeBase64(event.payload.data)),
    );
    return () => void p.then((fn) => fn());
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
    writeText(text).catch((e: unknown) => console.warn('[clipboard] write failed:', e)),
  pasteText: () => readText().then((t) => t ?? undefined),
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
