/**
 * Shared "hidden command" interception for PTY-backed views (ShellTerminal,
 * SubShellView): tracks the user's current input line so `axn-*` commands can
 * be intercepted on Enter before they reach the shell, and offers Tab
 * completion for `axn-*` command names/arguments.
 *
 * The returned handler consumes input data: it returns `true` when the data
 * was fully consumed (Tab completion or an intercepted Enter — the caller
 * must NOT write it to the PTY) and `false` when it should be written to the
 * PTY normally.
 *
 * Tracking desyncs on escape sequences (arrows, history navigation — the
 * buffer contents can no longer be trusted) and resumes on the next Enter.
 */

export type HiddenCommandMode = 'full' | 'agent' | 'off';

export interface HiddenCommandInputDeps {
  /** Write raw data to the view's PTY (used for the \x15 line-clear). */
  write: (data: string) => void;
  /**
   * Interception mode, evaluated per input event:
   * - 'full':  no foreground process — all axn-* commands are intercepted.
   * - 'agent': a plugin-declared `agentInput` program is foreground — only
   *            `/exit` is tracked.
   * - 'off':   another program owns input — nothing is intercepted.
   */
  mode: () => HiddenCommandMode;
  /**
   * View-local command hook, tried first (e.g. `axn-rename` renames the
   * sub-shell tab, not the session). Return true when the line was handled.
   */
  onLocalCommand?: (line: string) => boolean;
  onEditorRequest?: (path: string) => void;
  onBrowserRequest?: (path: string) => void;
  onPreviewRequest?: (path: string) => void;
  /**
   * Session-level command dispatch (axn-session*, axn-workspace-*, axn-sh,
   * axn-install, plugin commands, /exit in agent mode). `undefined` passes
   * the line through to the shell; a string replaces it; `false` swallows it.
   */
  onSessionCommand?: (
    line: string,
  ) => string | false | undefined | Promise<string | false | undefined>;
  /** Tab completion — returns full replacement lines for the buffer. */
  onCompleteInput?: (line: string) => Promise<string[]>;
}

/** `axn-session-summary` text cap — one scannable line, not a README. */
export const SESSION_SUMMARY_MAX = 200;

/**
 * Parse an `axn-session-summary` line → the summary to set on the session.
 * `undefined` when the line is not this command; otherwise the (possibly
 * empty) summary — bare `axn-session-summary` clears it, matching
 * `axn-rename`. Matching outer quotes are stripped and the text is capped at
 * SESSION_SUMMARY_MAX.
 */
export function parseSessionSummary(line: string): string | undefined {
  const match = /^\s*axn-session-summary(?:\s+(.*?))?\s*$/.exec(line);
  if (!match) return undefined;
  return (match[1]?.trim().replace(/^["']+|["']+$/g, '') ?? '').slice(0, SESSION_SUMMARY_MAX);
}

/** Longest shared prefix across completion candidates. */
export function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

export type SessionCommandResult = string | false | undefined;

/**
 * Run line handlers (plugin `onCommand` hooks) in order until one claims the
 * line with a string or `false`. A handler returning — or resolving —
 * `undefined`/`void`, or failing, hands the line on to the next one, so an
 * async pass-through never ends the chain early.
 */
export function runCommandChain<T>(
  items: readonly T[],
  run: (item: T) => string | false | void | Promise<string | false | void> | undefined,
  onError: (item: T, error: unknown) => void,
): SessionCommandResult | Promise<SessionCommandResult> {
  const from = (start: number): SessionCommandResult | Promise<SessionCommandResult> => {
    for (let i = start; i < items.length; i++) {
      const item = items[i];
      try {
        const result = run(item);
        if (result instanceof Promise) {
          return result.then(
            (r) => r ?? from(i + 1),
            (e) => {
              onError(item, e);
              return from(i + 1);
            },
          );
        }
        if (result !== undefined) return result;
      } catch (e) {
        onError(item, e);
      }
    }
    return undefined;
  };
  return from(0);
}

/**
 * Apply an intercepted line's outcome while the typed line is still in the
 * shell's input: `undefined` submits it as typed, a string replaces it,
 * `false` (or an empty string) clears it.
 */
function applySessionCommandResult(
  write: (data: string) => void,
  result: string | false | undefined,
): void {
  if (result === undefined) {
    write('\r');
    return;
  }
  write('\x15');
  if (typeof result === 'string' && result) write(`${result}\r`);
}

export function createHiddenCommandInput(
  deps: HiddenCommandInputDeps,
): (data: string) => boolean {
  let lineBuffer: string | null = '';

  return (data: string): boolean => {
    const mode = deps.mode();

    // Tab-completion for axn-* hidden commands. The '\t' is swallowed so the
    // shell never sees it; the completed line replaces the input via Ctrl-U
    // (kill line) plus the new text.
    if (
      data === '\t' &&
      mode === 'full' &&
      lineBuffer !== null &&
      /^\s*axn-\S*(\s+\S*)?$/.test(lineBuffer)
    ) {
      const line = lineBuffer;
      void deps.onCompleteInput?.(line).then((candidates) => {
        if (!candidates || candidates.length === 0) return;
        const replacement =
          candidates.length === 1 ? candidates[0] : commonPrefix(candidates);
        if (replacement && replacement !== line) {
          lineBuffer = replacement;
          deps.write(`\x15${replacement}`);
        }
      });
      return true;
    }

    if (mode === 'off') return false;

    for (const ch of data) {
      if (ch === '\x1b') {
        // Escape sequences (arrows, etc.) desync the line buffer — tracking
        // resumes on the next submitted line.
        lineBuffer = null;
        continue;
      }
      if (ch === '\x03') {
        lineBuffer = '';
        continue;
      }
      if (ch === '\x7f') {
        if (lineBuffer !== null) lineBuffer = lineBuffer.slice(0, -1);
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const line = lineBuffer;
        lineBuffer = '';
        if (line !== null) {
          if (mode === 'agent') {
            if (line.trim() === '/exit') deps.onSessionCommand?.(line);
            continue;
          }
          if (deps.onLocalCommand?.(line)) return true;
          const editMatch = /^\s*axn-edit\s+(.+?)\s*$/.exec(line);
          if (editMatch) {
            // Clear the typed line and open the editor instead of executing
            // the command in the shell.
            deps.write('\x15');
            deps.onEditorRequest?.(editMatch[1]);
            return true;
          }
          const browseMatch = /^\s*axn-browse\s+(.+?)\s*$/.exec(line);
          if (browseMatch) {
            deps.write('\x15');
            deps.onBrowserRequest?.(browseMatch[1]);
            return true;
          }
          const previewMatch = /^\s*axn-preview\s+(.+?)\s*$/.exec(line);
          if (previewMatch) {
            deps.write('\x15');
            deps.onPreviewRequest?.(previewMatch[1]);
            return true;
          }
          const command = deps.onSessionCommand?.(line);
          if (command instanceof Promise) {
            // Async outcome: keep the typed line in the shell until it is
            // known — `undefined` (or a failed handler) submits it unchanged,
            // so a pass-through never loses what the user typed.
            void command.then(
              (resolved) => applySessionCommandResult(deps.write, resolved),
              () => applySessionCommandResult(deps.write, undefined),
            );
            return true;
          }
          if (command !== undefined) {
            // Clear the typed line; handlers may replace it with a different
            // command or swallow it entirely.
            applySessionCommandResult(deps.write, command);
            return true;
          }
        }
        continue;
      }
      if (lineBuffer !== null && ch >= ' ') lineBuffer += ch;
    }
    return false;
  };
}
