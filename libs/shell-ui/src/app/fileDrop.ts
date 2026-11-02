import type { Terminal } from '@xterm/xterm';
import { shellWord } from '../shellQuote';
import type { ForeignDropHandler } from './dropGuard';

/**
 * Files and links dragged in from outside the app onto a terminal: their
 * paths are pasted at the prompt — what other terminals do, and how CLIs like
 * Claude Code pick up images. `dropGuard.ts` cancels every foreign drag (the
 * webview would otherwise open what was dropped) and hands them to the
 * handler built here; dropped anywhere but a terminal, they are ignored.
 *
 * What a drop carries depends on the webview. WebKitGTK shows the page a
 * file manager's drop as an empty `text/uri-list`, so on Linux the desktop
 * app takes file drops natively and `onNativeDrop` delivers the paths — the
 * terminal is the one under the last `dragover`, which the page still sees.
 * Browsers and WKWebView hand the page the contents (`Files` → saved as a
 * copy by the backend), sometimes `file://` URIs (→ the files' own paths).
 */

/** Larger files are skipped: their bytes are copied through the IPC bridge. */
export const MAX_DROP_BYTES = 64 * 1024 * 1024;

export interface FileDropDeps {
  terminalAt: (target: EventTarget | null) => Terminal | undefined;
  /** Sessions run on this machine, so `file://` URIs can be pasted as paths. */
  localPaths?: boolean;
  /** Store a dropped file's contents for the terminal's session; resolves with its path. */
  saveFile?: (term: Terminal, name: string, bytes: Uint8Array) => Promise<string>;
  /** Drops the webview took natively, with the files' local paths. */
  onNativeDrop?: (cb: (paths: string[]) => void) => () => void;
}

/**
 * A drag a drop on a terminal can paste: links/paths (`text/uri-list`), or
 * file contents where the backend can store them or sees local paths. (Web:
 * files only arrive as contents, which it cannot store — no copy cursor.)
 */
function pasteable(event: DragEvent, deps: FileDropDeps): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes('text/uri-list') || (types.includes('Files') && !!(deps.saveFile || deps.localPaths));
}

/** `text/uri-list` entries (comments and blank lines dropped). */
export function parseUriList(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Local path of a `file://` URI on this machine, else undefined. */
export function fileUriPath(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return undefined;
  const path = decodeURIComponent(url.pathname);
  // file:///C:/x → C:/x on Windows
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** Paste `words` (shell-quoted) at the prompt, with a trailing space like other terminals. */
function pasteWords(term: Terminal, words: string[]): string {
  if (!words.length) return '';
  const text = `${words.map(shellWord).join(' ')} `;
  term.paste(text);
  term.focus();
  return text;
}

/** Save the dropped files and paste their paths into `term`; resolves with the pasted text. */
export async function pasteDroppedFiles(
  term: Terminal,
  files: File[],
  saveFile: NonNullable<FileDropDeps['saveFile']>,
): Promise<string> {
  const paths: string[] = [];
  for (const file of files) {
    if (file.size > MAX_DROP_BYTES) {
      console.warn(`file drop: skipped ${file.name} (${file.size} bytes, limit ${MAX_DROP_BYTES})`);
      continue;
    }
    try {
      // A dropped directory has no readable contents — arrayBuffer() rejects.
      const bytes = new Uint8Array(await file.arrayBuffer());
      paths.push(await saveFile(term, file.name, bytes));
    } catch (e) {
      console.error(`file drop: could not save ${file.name}:`, e);
    }
  }
  return pasteWords(term, paths);
}

/** What a drop onto `term` pastes: local paths, else saved copies, else the links. */
export async function pasteDrop(term: Terminal, data: DataTransfer, deps: FileDropDeps): Promise<string> {
  const uris = parseUriList(data.getData('text/uri-list'));
  const files = Array.from(data.files ?? []);
  if (deps.localPaths) {
    const paths = uris.map(fileUriPath);
    if (paths.length && paths.every((p): p is string => !!p)) return pasteWords(term, paths);
  }
  if (files.length && deps.saveFile) return pasteDroppedFiles(term, files, deps.saveFile);
  // Links (from a browser) paste as text; file:// URIs mean nothing to a remote session.
  return pasteWords(term, uris.filter((u) => !u.toLowerCase().startsWith('file:')));
}

/**
 * The guard's handler for foreign drags: drops on a terminal paste, others
 * are ignored. `dispose` stops listening for native drops.
 */
export function createFileDrop(deps: FileDropDeps): ForeignDropHandler & { dispose(): void } {
  // Where the pointer was on the last dragover: a native drop arrives without
  // a DOM target (and after a dragleave, which GTK sends before every drop).
  let overTarget: EventTarget | null = null;
  const offNative = deps.onNativeDrop?.((paths) => {
    const term = deps.terminalAt(overTarget);
    overTarget = null;
    if (term) pasteWords(term, paths);
  });
  return {
    over(event) {
      overTarget = event.target;
      return pasteable(event, deps) && !!deps.terminalAt(event.target);
    },
    drop(event) {
      overTarget = null;
      const term = pasteable(event, deps) ? deps.terminalAt(event.target) : undefined;
      if (!term || !event.dataTransfer) return;
      void pasteDrop(term, event.dataTransfer, deps).catch((e) => console.error('file drop failed:', e));
    },
    dispose() {
      offNative?.();
    },
  };
}
