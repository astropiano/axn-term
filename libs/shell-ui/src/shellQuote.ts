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
