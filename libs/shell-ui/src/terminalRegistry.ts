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
