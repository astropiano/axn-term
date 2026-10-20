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
