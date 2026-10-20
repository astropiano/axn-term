import type { Terminal } from '@xterm/xterm';

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

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string, term: Terminal): void {
  if (terminals.get(sessionId) === term) terminals.delete(sessionId);
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

/** The terminal whose container holds `target`, if any. */
export function terminalAt(target: EventTarget | null): Terminal | undefined {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const term = terminalElements.get(el);
    if (term) return term;
  }
  return undefined;
}
