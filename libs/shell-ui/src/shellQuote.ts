/**
 * The one place shell words are quoted for the `sh -c` command lines axn-term
 * builds (launch lines, resume commands, workflow commands, git/worktree
 * calls). POSIX single-quoting: nothing inside '…' is special, and an
 * embedded ' becomes '\'' — safe for any byte except NUL.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Like shellQuote, but leaves plain words (`a-z0-9_./:@-`) bare for readability. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : shellQuote(value);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * A long, multi-line argument (an agent prompt) as one shell word: carried
 * base64-encoded and decoded at run time — `"$(printf %s '<b64>' | base64 -d)"`
 * — so no quoting, newline or metacharacter in it can break or extend the
 * command line. NULs are dropped (not representable in an argv).
 */
export function promptArg(text: string): string {
  return `"$(printf %s '${toBase64(text.replace(/\x00/g, ''))}' | base64 -d)"`;
}

/** A pre-built command fragment `sh` splices in verbatim (see `shellRaw`). */
export interface ShellRaw {
  readonly shellRaw: string;
}

/**
 * Mark a fragment as already-safe shell text for `sh` — a user-configured
 * command (`nameAgent`), a fixed flag. Never wrap a value that came from a
 * forge, a repo file or terminal output.
 */
export function shellRaw(text: string): ShellRaw {
  return { shellRaw: text };
}

/**
 * Tagged template for command lines: every interpolation goes in as one
 * shell word (`shellWord` — plain values stay bare, anything else is
 * single-quoted) unless wrapped in `shellRaw`. The default is the safe
 * one, so a hostile MR title or scenario name cannot extend the command.
 *
 *   sh`axn-dev start -s ${scenario.name}`   // → axn-dev start -s 'x;rm -rf ~'
 */
export function sh(strings: TemplateStringsArray, ...values: Array<string | number | ShellRaw>): string {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const word = typeof v === 'object' ? v.shellRaw : shellWord(String(v));
    return out + word + s;
  }, '');
}

/**
 * The `axn-*` feedback convention: a command result of `echo '…'` either
 * prints the message at the shell or is parsed back by `controlReply` /
 * `parseFeedbackEcho` (display channel). Single-quoted on purpose: the
 * earlier `echo "<json>"` form left `$()`, backticks and `\` inside the
 * payload (a page title, a branch name) live for command substitution when
 * the line was typed into a session.
 */
export function echoReply(msg: string): string {
  return `echo ${shellQuote(msg)}`;
}

/** Matches an `echo` feedback line — the current `'…'` form and the
 * legacy JSON `"…"` form external plugins may still emit. */
const ECHO_REPLY_RE = /^echo\s+('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*")\s*$/;

/**
 * The message an `echo` feedback line carries, or `undefined` when the
 * line is not a feedback echo. Accepts both quote styles: `'…'` unescapes
 * POSIX `'\''`, `"…"` parses as one JSON string (the old protocol).
 */
export function parseEchoReply(result: string | false | undefined): string | undefined {
  if (typeof result !== 'string') return undefined;
  const m = ECHO_REPLY_RE.exec(result);
  if (!m) return undefined;
  const quoted = m[1];
  if (quoted.startsWith(`'`)) {
    return quoted.slice(1, -1).replace(/'\\''/g, `'`);
  }
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `text` in bracketed-paste markers for an agent's input. ESC (and the
 * 8-bit CSI) are dropped from the text first so a payload carrying
 * `ESC[201~` cannot end the paste early and arrive as raw keystrokes.
 */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/[\x1b\x9b]/g, '')}\x1b[201~`;
}
