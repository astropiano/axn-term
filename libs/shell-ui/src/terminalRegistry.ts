import type { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Live xterm instances keyed by session id. ShellTerminal registers itself so
 * plugins can inspect the real screen instead of guessing from the output
 * stream (ANSI cursor movement is stripped before onOutput sees it).
 */
const terminals = new Map<string, Terminal>();

/**
 * PTY ids that must survive the next terminal-view unmount. Marked before a
 * state change that unmounts a view but keeps the backend process alive —
 * promoting a sub-shell to main shell (both views unmount), or turning
 * sub-shell tabs into standalone sessions. One-shot: the first unmount
 * consumes the flag.
 */
const keptAlivePtys = new Set<string>();

export function keepPtyAlive(ptyId: string): void {
  keptAlivePtys.add(ptyId);
}

export function takePtyKeepAlive(ptyId: string): boolean {
  return keptAlivePtys.delete(ptyId);
}

/**
 * The terminal's scrollback and screen as one ANSI string (colors, modes and
 * the alternate screen of a running TUI included), or undefined when the id
 * has no live terminal. Used to carry a session's history into the window it
 * moves to — the PTY itself stays put and only replays new output.
 */
export function serializeTerminal(id: string): string | undefined {
  const term = terminals.get(id);
  if (!term) return undefined;
  try {
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    const data = addon.serialize();
    addon.dispose();
    return data || undefined;
  } catch {
    return undefined;
  }
}

// History handed over with a session that moved here from another window,
// keyed like `terminals` (session id for the main shell, tab id for a
// sub-shell). The terminal that reattaches to the PTY writes it once, before
// any live output.
const pendingReplays = new Map<string, string>();

export function setPendingReplay(id: string, data: string): void {
  pendingReplays.set(id, data);
}

export function takePendingReplay(id: string): string | undefined {
  const data = pendingReplays.get(id);
  pendingReplays.delete(id);
  return data;
}

// Reload replays live in sessionStorage under one JSON map keyed like
// `terminals`. sessionStorage survives `location.reload()` but not an app
// restart — exactly the lifetime of the backend PTYs, so a respawned shell
// never sees a dead terminal's stale screen.
const REPLAY_STORAGE_KEY = 'axn-term:terminal-replays';

function replayStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Serialize every live terminal for the next page load — called from the
 * Reload window path before `location.reload()`. PTYs survive the reload,
 * so each reattaching terminal restores its screen (scrollback, colors,
 * the alternate screen of a running TUI) instead of coming back blank.
 */
export function stashTerminalReplays(storage: Storage | null = replayStorage()): void {
  if (!storage) return;
  const replays: Record<string, string> = {};
  for (const id of terminals.keys()) {
    const data = serializeTerminal(id);
    if (data) replays[id] = data;
  }
  try {
    storage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(replays));
  } catch {
    // Quota exceeded — reload without replays rather than not reloading.
  }
}

/** One-shot reload replay for `id`, mirroring `takePendingReplay`. */
export function takeReloadReplay(id: string, storage: Storage | null = replayStorage()): string | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(REPLAY_STORAGE_KEY);
    if (!raw) return undefined;
    const replays = JSON.parse(raw) as Record<string, unknown>;
    const data = replays[id];
    delete replays[id];
    storage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(replays));
    return typeof data === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

export function terminalSize(id: string): { cols: number; rows: number } | undefined {
  const term = terminals.get(id);
  return term ? { cols: term.cols, rows: term.rows } : undefined;
}

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string, term: Terminal): void {
  if (terminals.get(sessionId) === term) terminals.delete(sessionId);
}

/** The id `term` is registered under (session id, or a sub-shell's tab id). */
export function terminalIdOf(term: Terminal): string | undefined {
  for (const [id, t] of terminals) if (t === term) return id;
  return undefined;
}

/**
 * The session's live screen text — the bottom-most `rows` buffer lines,
 * trimmed right — regardless of scroll position. Empty when the session has
 * no terminal.
 */
export function getScreenLines(sessionId: string): string[] {
  const term = terminals.get(sessionId);
  if (!term) return [];
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < term.rows; row++) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
  }
  return lines;
}

// Terminal by DOM element — the app-wide context menu resolves the terminal
// under the pointer (main shell or sub-shell tab) to copy from / paste into.
const terminalElements = new WeakMap<Element, Terminal>();

// The last selection the user made in each terminal. A program in the
// terminal can make xterm drop the live selection behind the user's back
// (xterm clears it on anything it counts as input — e.g. with Claude Code
// in the foreground the selection was gone by the time the right-click
// menu read it), so Copy falls back to this. Only the user deselecting —
// a left click in the terminal or typing — forgets it.
const lastSelections = new WeakMap<Terminal, string>();

export function registerTerminalElement(el: Element, term: Terminal): () => void {
  terminalElements.set(el, term);
  const selectionSub = term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text) lastSelections.set(term, text);
  });
  const forget = () => lastSelections.delete(term);
  const onMouseDown = (event: Event) => {
    if ((event as MouseEvent).button === 0) forget();
  };
  // typing deselects; ⌘C/Ctrl+Shift+C and other shortcuts do not
  const onKeyDown = (event: Event) => {
    const key = event as KeyboardEvent;
    if (!key.metaKey && !key.ctrlKey) forget();
  };
  // capture phase: before xterm handles (and possibly re-selects on) the click
  el.addEventListener('mousedown', onMouseDown, true);
  el.addEventListener('keydown', onKeyDown, true);
  return () => {
    if (terminalElements.get(el) === term) terminalElements.delete(el);
    selectionSub.dispose();
    el.removeEventListener('mousedown', onMouseDown, true);
    el.removeEventListener('keydown', onKeyDown, true);
    forget();
  };
}

/**
 * OSC 52 "set clipboard" — the payload of `ESC ] 52 ; <targets> ; <base64>`
 * as the text to copy. Read requests (`?`), clears (empty) and malformed or
 * oversized payloads yield undefined: programs may write the clipboard,
 * never read it.
 */
export function parseOsc52(data: string): string | undefined {
  const sep = data.indexOf(';');
  if (sep < 0) return undefined;
  const payload = data.slice(sep + 1);
  if (!payload || payload === '?' || payload.length > 4 * 1024 * 1024) return undefined;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Honour OSC 52 writes from the program in the terminal. TUIs that track the
 * mouse themselves (Claude Code) draw their own selection and copy it this
 * way — xterm has no selection of its own then, so the text is also what
 * the context menu's Copy offers.
 */
export function handleClipboardWrites(term: Terminal, copy: (text: string) => void): { dispose(): void } {
  return term.parser.registerOscHandler(52, (data) => {
    const text = parseOsc52(data);
    if (text) {
      copy(text);
      lastSelections.set(term, text);
    }
    return true;
  });
}

/** What Copy should copy: the live selection, else the user's last one. */
export function terminalSelection(term: Terminal): string {
  return term.getSelection() || lastSelections.get(term) || '';
}

/**
 * A raw token resolved by a terminal's path/URL detection — the same check
 * the hover link provider runs, reused by the context menu for a manual
 * selection (which the token scan may never have seen as a link).
 */
export type SelectionResolver = (
  token: string,
) => Promise<{ stat: { path: string; isDir: boolean }; isUrl: boolean } | null>;

const selectionResolvers = new WeakMap<Terminal, SelectionResolver>();

/** Set by a terminal view that knows how to resolve tokens for its buffer. */
export function registerSelectionResolver(term: Terminal, resolve: SelectionResolver): void {
  selectionResolvers.set(term, resolve);
}

export function unregisterSelectionResolver(term: Terminal, resolve: SelectionResolver): void {
  if (selectionResolvers.get(term) === resolve) selectionResolvers.delete(term);
}

export function selectionResolver(term: Terminal): SelectionResolver | undefined {
  return selectionResolvers.get(term);
}

/** The terminal whose container holds `target`, if any. */
export function terminalAt(target: EventTarget | null): Terminal | undefined {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const term = terminalElements.get(el);
    if (term) return term;
  }
  return undefined;
}

/**
 * Input handle for a PTY-backed view, keyed by registration id (session id
 * for main shells, tab id for sub-shells). `send` injects bytes through the
 * view's normal onData pipeline — hidden-command interception, sub-shell
 * exit/re-run handling — instead of writing the PTY directly. Used by the
 * touch key bar.
 */
export interface TerminalInput {
  send: (data: string) => void;
  /** Focus the terminal — also summons the soft keyboard on touch devices. */
  focus: () => void;
}

const terminalInputs = new Map<string, TerminalInput>();

export function registerTerminalInput(id: string, input: TerminalInput): void {
  terminalInputs.set(id, input);
}

export function unregisterTerminalInput(id: string, input: TerminalInput): void {
  if (terminalInputs.get(id) === input) terminalInputs.delete(id);
}

export function terminalInput(id: string): TerminalInput | undefined {
  return terminalInputs.get(id);
}
