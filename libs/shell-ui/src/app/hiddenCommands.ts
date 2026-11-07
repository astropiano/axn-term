/** Matches terminalRenderer's OSC_COLOR_REPORT_RE — kept local so this
 * module stays free of the xterm import chain (its tests run in node). */
const OSC_COLOR_REPORT_RE = /^(\x1b\]1[012];[^\x07\x1b]+(?:\x07|\x1b\\))+$/;

/**
 * Shared "hidden command" interception for PTY-backed views (ShellTerminal,
 * SubShellView): tracks the user's current input line so `axn-*` commands can
 * be intercepted on Enter before they reach the shell, and offers Tab
 * completion for `axn-*` command names/arguments.
 *
 * The returned handler consumes input data: it returns `false` when the
 * caller should write the whole chunk to the PTY normally, and `true` when
 * the handler took care of it (Tab completion, or a chunk with an
 * intercepted line — the handler writes the text around that line itself,
 * in order, and holds later input while an async line outcome is pending).
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
   * sub-shell tab, not the session). Return true when the line was handled;
   * the typed line is then cleared.
   */
  onLocalCommand?: (line: string) => boolean;
  onEditorRequest?: (path: string) => void;
  onBrowserRequest?: (path: string) => void;
  onPreviewRequest?: (path: string) => void;
  onIdeRequest?: (path: string) => void;
  /**
   * Session-level command dispatch (axn-session*, axn-workspace-*, axn-sh,
   * axn-install, plugin commands, /exit in agent mode). `undefined` passes
   * the line through to the shell; a string replaces it; `false` swallows it.
   */
  onSessionCommand?: (
    line: string,
  ) => string | false | undefined | Promise<string | false | undefined>;
  /**
   * Write to the terminal's output side (xterm `term.write`) — used to make
   * intercepted commands look like they really ran: the typed line is
   * re-drawn below the prompt and the command's message follows it as
   * output, before the shell's next prompt. Without it, feedback falls
   * back to injecting `echo …` into the shell.
   */
  writeDisplay?: (data: string) => void;
  /**
   * Gated write for OSC color-report bytes found inside a mixed input
   * chunk — callers route it through `sendTerminalInput` so the same
   * raw-mode/alive gating applies as for pure report chunks. Falls back
   * to `write` when absent.
   */
  writeReport?: (data: string) => void;
  /** Tab completion — returns full replacement lines for the buffer. */
  onCompleteInput?: (line: string) => Promise<string[]>;
}

/** `axn-session-summary` text cap — a few scannable lines, not a README. */
export const SESSION_SUMMARY_MAX = 400;

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
 * The `echo "<msg>"` feedback convention: `onSessionCommand` results of
 * that shape are messages for the user, not commands for the shell — the
 * remote CLI path (`controlReply`) parses the same pattern. Returns the
 * unquoted message or `undefined` for non-feedback results.
 */
export function parseFeedbackEcho(
  result: string | false | undefined,
): string | undefined {
  if (typeof result !== 'string') return undefined;
  const m = /^echo\s+("(?:[^"\\]|\\.)*")\s*$/.exec(result);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
}

/**
 * Apply an intercepted line's outcome while the typed line is still in the
 * shell's input:
 * - `undefined` submits it as typed (the Enter goes through)
 * - `false` swallows it — silent command: the typed line stays on screen
 *   and a fresh prompt follows, like running `true`
 * - an `echo "<msg>"` string is user feedback: the typed line stays on
 *   screen and `<msg>` appears below it as the command's output
 * - any other string replaces the line and is submitted to the shell
 *
 * Display writes go BEFORE the PTY write: they land synchronously while
 * the \x15 kill echoes back asynchronously — so the shell's line erase
 * hits the empty line under our output, never the output itself. Without
 * a display channel the legacy behavior remains: feedback is typed into
 * the shell as a literal `echo` command.
 */
function applySessionCommandResult(
  write: (data: string) => void,
  writeDisplay: ((data: string) => void) | undefined,
  result: string | false | undefined,
): void {
  if (result === undefined) {
    write('\r');
    return;
  }
  const feedback = parseFeedbackEcho(result);
  if (writeDisplay && (feedback !== undefined || result === false)) {
    writeDisplay(`\r\n${feedback !== undefined ? `${feedback.replace(/\n/g, '\r\n')}\r\n` : ''}`);
    write('\x15\r');
    return;
  }
  write('\x15');
  if (typeof result === 'string' && result) write(`${result}\r`);
}

export function createHiddenCommandInput(
  deps: HiddenCommandInputDeps,
): (data: string) => boolean {
  let lineBuffer: string | null = '';
  // Input that arrived while an async line outcome is pending — held so it
  // reaches the shell after the line's Enter, in order.
  let held: string[] | null = null;

  const releaseHeld = () => {
    const queue = held ?? [];
    held = null;
    // A chunk that starts another async line re-arms `held`, and handle()
    // then queues the remaining chunks behind it.
    for (const chunk of queue) {
      if (!handle(chunk)) deps.write(chunk);
    }
  };

  // A pending escape sequence — may span not only characters of one chunk
  // but whole `handle` calls. 'one' = bare \x1b seen (the next char picks
  // csi/osc/single), 'csi' until a final byte (@-~), 'osc' until BEL or
  // \x1b\\, 'osc-esc' inside an OSC after \x1b. The sequence accumulates in
  // escBuf and the decision happens on completion: bracketed-paste markers
  // (\x1b[200~/\x1b[201~) and OSC color reports are input-side data, not
  // cursor moves — tracking keeps going. Anything else while a partial
  // line exists desyncs (lineBuffer=null) as before.
  let escState: 'one' | 'csi' | 'osc' | 'osc-esc' | null = null;
  let escBuf = '';
  const escDone = () => {
    const benign = /\[20[01]~$/.test(escBuf) || /^\x1b\]1[012];/.test(escBuf);
    if (!benign && lineBuffer !== '') lineBuffer = null;
    escState = null;
    escBuf = '';
  };

  const handle = (data: string): boolean => {
    // OSC color-report replies (xterm answers a program's `ESC ] 1x ; ?`
    // query on the input channel) are terminal-generated data, not user
    // input — passing them through untouched keeps the line buffer
    // intact; the \x1b inside would otherwise desync tracking and
    // silently drop interception for the whole next line. The raw-mode
    // gating in sendTerminalInput still applies downstream.
    if (OSC_COLOR_REPORT_RE.test(data)) return false;

    if (held) {
      held.push(data);
      return true;
    }

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

    // 'off' mode (a foreground program owns input) still tracks the line:
    // `axn-*` is our own namespace — a shell answering `command not found`
    // is always wrong, so those lines are intercepted even then (the claim
    // below writes \x15 to clear the typed line at the prompt; in a real
    // TUI that sends a stray Ctrl-U, an accepted trade-off). Everything
    // else passes straight through.
    const axnOnly = mode === 'off';

    // Chars of `data` already written by this handler. Nothing is written
    // until a line is intercepted, so a plain chunk goes back to the caller
    // whole.
    let flushed = 0;
    const flush = (to: number) => {
      if (to > flushed) deps.write(data.slice(flushed, to));
      flushed = Math.max(flushed, to);
    };
    let i = 0;
    let skip = 0;
    for (const ch of data) {
      const at = i;
      i += ch.length;
      if (skip > 0) {
        skip -= ch.length;
        continue;
      }
      if (escState !== null) {
        escBuf += ch;
        if (escState === 'one') {
          escState = ch === '[' ? 'csi' : ch === ']' ? 'osc' : null;
          if (escState === null) escDone();
        } else if (escState === 'csi') {
          if (ch >= '@' && ch <= '~') escDone();
        } else if (escState === 'osc') {
          if (ch === '\x07') escDone();
          else if (ch === '\x1b') escState = 'osc-esc';
        } else if (ch !== '\x1b') {
          // osc-esc
          escState = ch === '\\' ? null : 'osc';
          if (escState === null) escDone();
        }
        continue;
      }
      if (ch === '\x1b') {
        // An OSC color report embedded in a mixed chunk is terminal data:
        // write it out (ordering preserved) and skip it — it must not
        // desync the tracked line the way arrows do. writeReport applies
        // the same raw-mode/alive gating as pure report chunks.
        const rep = /^\x1b\]1[012];[^\x07\x1b]+(?:\x07|\x1b\\)/.exec(data.slice(at));
        if (rep) {
          flush(at);
          (deps.writeReport ?? deps.write)(rep[0]);
          skip = rep[0].length - 1;
          continue;
        }
        // Any other escape goes through the pending-sequence state machine:
        // paste markers and OSC reports complete without touching the
        // buffer, arrows mid-line complete to a desync.
        escState = 'one';
        escBuf = '\x1b';
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
        if (line === null) continue;
        if (mode === 'agent') {
          if (line.trim() === '/exit') deps.onSessionCommand?.(line);
          // Agent TUIs keep non-axn input — a stale or misdetected
          // foreground agent would otherwise swallow our own commands at
          // a real shell prompt ('command not found').
          if (!/^\s*axn-/.test(line)) continue;
        }
        // 'off': only our own namespace is intercepted — the foreground
        // program keeps every other line.
        if (axnOnly && !/^\s*axn-/.test(line)) continue;
        // An intercepted line: the chunk's text up to this Enter goes to the
        // shell first, so the typed line is there to submit or clear, and
        // the rest of the chunk is handled after the outcome.
        const rest = data.slice(i);
        const claimed = (apply: () => void): true => {
          flush(at);
          apply();
          if (rest && !handle(rest)) deps.write(rest);
          return true;
        };
        if (deps.onLocalCommand?.(line)) return claimed(() => deps.write('\x15'));
        const editMatch = /^\s*axn-edit\s+(.+?)\s*$/.exec(line);
        if (editMatch) {
          // Clear the typed line and open the editor instead of executing
          // the command in the shell.
          return claimed(() => {
            deps.write('\x15');
            deps.onEditorRequest?.(editMatch[1]);
          });
        }
        const browseMatch = /^\s*axn-browse\s+(.+?)\s*$/.exec(line);
        if (browseMatch) {
          return claimed(() => {
            deps.write('\x15');
            deps.onBrowserRequest?.(browseMatch[1]);
          });
        }
        const previewMatch = /^\s*axn-preview\s+(.+?)\s*$/.exec(line);
        if (previewMatch) {
          return claimed(() => {
            deps.write('\x15');
            deps.onPreviewRequest?.(previewMatch[1]);
          });
        }
        // Optional dir arg: bare `axn-ide` opens the IDE at the live cwd.
        const ideMatch = /^\s*axn-ide(?:\s+(.+?))?\s*$/.exec(line);
        if (ideMatch) {
          return claimed(() => {
            deps.write('\x15');
            deps.onIdeRequest?.(ideMatch[1] ?? '.');
          });
        }
        const command = deps.onSessionCommand?.(line);
        if (command instanceof Promise) {
          // Async outcome: keep the typed line in the shell until it is
          // known — `undefined` (or a failed handler) submits it unchanged,
          // so a pass-through never loses what the user typed. The rest of
          // the chunk and any later input wait behind it.
          flush(at);
          held = rest ? [rest] : [];
          const settle = (resolved: SessionCommandResult) => {
            try {
              applySessionCommandResult(deps.write, deps.writeDisplay, resolved);
            } finally {
              releaseHeld();
            }
          };
          void command.then(settle, () => settle(undefined));
          return true;
        }
        if (command !== undefined) {
          // Clear the typed line; handlers may replace it with a different
          // command or swallow it entirely.
          return claimed(() => applySessionCommandResult(deps.write, deps.writeDisplay, command));
        }
        continue;
      }
      if (lineBuffer !== null && ch >= ' ') lineBuffer += ch;
    }
    if (flushed > 0) {
      // Parts of the chunk were already written (e.g. an embedded OSC
      // report); returning false would make the caller write the whole
      // chunk again — finish the tail here and claim the chunk.
      flush(data.length);
      return true;
    }
    return false;
  };

  return handle;
}
