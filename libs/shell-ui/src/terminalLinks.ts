/**
 * Link tokenization and wrapped-URL reconstruction for the terminal link
 * provider.
 *
 * The provider tokenizes each buffer line on its own, so a URL split across a
 * line break — a soft wrap on a narrow terminal, a hard wrap inside a table
 * cell, or a folded prose line — only ever resolves the fragment on a single
 * row. The helpers here
 * reconstruct the full URL in both directions: extending a `scheme://` token
 * into the lines below, and recognizing a hovered fragment as the continuation
 * of a URL that starts on a line above.
 */

/** A buffer line as seen by the link provider. */
export interface LinkLine {
  /** Line content, right-trimmed (`IBufferLine.translateToString(true)`). */
  text: string;
  /** True when the line is a soft-wrapped continuation of the previous line. */
  isWrapped: boolean;
}

export interface LinkToken {
  /** 0-based column where the (stripped) token starts. */
  start: number;
  /** Token text with surrounding punctuation and border chars stripped. */
  token: string;
}

export interface LinkSegment {
  /** 0-based buffer line index. */
  line: number;
  /** 0-based start column, inclusive. */
  start: number;
  /** 0-based end column, exclusive. */
  end: number;
}

export interface WrappedUrl {
  /** The reconstructed URL across all segments. */
  url: string;
  segments: LinkSegment[];
}

export type GetLinkLine = (index: number) => LinkLine | undefined;

const TOKEN_RE = /[^\s'"]+/g;
// Border chars are stripped like other punctuation so `│https://x│` linkifies.
const BORDER_CHARS = '|│┃║┆┇┊┋┤├';
const LEAD_STRIP_RE = new RegExp(`^[.,;:'"()[\\]{}<>*${BORDER_CHARS}]+`);
const TAIL_STRIP_RE = new RegExp(`[.,;:'"()[\\]{}<>*@|=${BORDER_CHARS}]+$`);
const BORDER_RE = new RegExp(`[${BORDER_CHARS}]`);

/** A token that begins a URL — full or a fragment cut at a line break. */
export const URL_START_RE = /^(?:https?|file):\/\/\S+$/i;

const MAX_WRAP_LINES = 10;
const MAX_URL_LENGTH = 4096;

/**
 * Split a line into stripped tokens. Tokens that end up empty (pure
 * punctuation/borders) are skipped. `minLength` filters short tokens for
 * linkification; continuation matching passes 1 so single-char tail rows still
 * resolve.
 */
export function extractLinkTokens(text: string, limit = 64, minLength = 1): LinkToken[] {
  const tokens: LinkToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null && tokens.length < limit) {
    const lead = LEAD_STRIP_RE.exec(m[0])?.[0].length ?? 0;
    const token = m[0].replace(LEAD_STRIP_RE, '').replace(TAIL_STRIP_RE, '');
    if (token.length >= minLength) {
      tokens.push({ start: m.index + lead, token });
    }
  }
  return tokens;
}

/** The token ends at the right edge of its content or a table cell border. */
function atBoundary(text: string, end: number): boolean {
  return end >= text.length || BORDER_RE.test(text[end]);
}

/** Column indexes of all border characters on a line. */
function borderCols(text: string): number[] {
  const cols: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (BORDER_RE.test(text[i])) cols.push(i);
  }
  return cols;
}

/**
 * The `[left, right)` border columns of the cell containing `[start, end)`,
 * or null when the token does not sit between two borders.
 */
function cellOf(cols: number[], start: number, end: number): [number, number] | null {
  let left = -1;
  for (const c of cols) {
    if (c < start) left = c;
  }
  const right = cols.find((c) => c >= end);
  return left >= 0 && right !== undefined ? [left, right] : null;
}

/** Every cell except `[b1, b2]` — and the line edges — is blank. */
function otherCellsBlank(text: string, cols: number[], b1: number, b2: number): boolean {
  if (text.slice(0, cols[0]).trim() !== '') return false;
  if (text.slice(cols[cols.length - 1] + 1).trim() !== '') return false;
  for (let i = 0; i + 1 < cols.length; i++) {
    if (cols[i] === b1 && cols[i + 1] === b2) continue;
    if (text.slice(cols[i] + 1, cols[i + 1]).trim() !== '') return false;
  }
  return true;
}

/**
 * Every cell *before* the one starting at border `b1` — and the line edge —
 * is blank. Tables that wrap all columns at once empty the leading cells of
 * a continuation row while later cells carry their own wrapped text, unlike
 * a fresh data row which fills them again.
 */
function cellsBeforeBlank(text: string, cols: number[], b1: number): boolean {
  if (text.slice(0, cols[0]).trim() !== '') return false;
  const upto = cols.indexOf(b1);
  for (let i = 0; i < upto; i++) {
    if (text.slice(cols[i] + 1, cols[i + 1]).trim() !== '') return false;
  }
  return true;
}

// A bare fragment must at least look like a URL tail (`path/x`, `.y`,
// `?q=1`) — a plain word is more likely a fresh row value than a wrapped
// URL piece. (Only consulted when there is no `(`-context to close.)
const URL_TAIL_RE = /[/._?&=%#-]/;
// Stricter variant for folded plain-text continuations: a sole next-row
// token may simply be unrelated prose, so it must carry a path/query
// character — `merge_requests/87` joins, `file.txt` or `notes` do not.
const URL_TAIL_STRICT_RE = /[/=?&%#]/;

/** True when `text` contains an unmatched `(` — e.g. `!6 (https://…`. */
function unclosedParen(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

// A cell gap counts as "blank" when it holds only whitespace plus the
// punctuation tokens strip from their edges — e.g. the `)` a table cell's
// continuation closes with sits between the stripped token and the border.
const PAD_RE = new RegExp(`^[\\s.,;:'"()\\[\\]{}<>*@|=${BORDER_CHARS}]*$`);
function blankish(text: string): boolean {
  return PAD_RE.test(text);
}

/**
 * Whether a continuation row may carry on a URL that started after
 * `headPrefix`. Aligned continuation rows have a blank prefix; table cells
 * repeat the row's border layout, so the border positions must match.
 */
function continuationPrefixOk(nextPrefix: string, headPrefix: string): boolean {
  if (!/\S/.test(nextPrefix)) return true;
  if (!BORDER_RE.test(nextPrefix)) return false;
  const skeleton = (s: string) =>
    s.replace(new RegExp(`[^\\s${BORDER_CHARS}]`, 'g'), ' ');
  return skeleton(nextPrefix) === skeleton(headPrefix);
}

/**
 * Extend a `scheme://` token at `[start, end)` on `line` into the rows below
 * when it looks cut off: it reaches the end of the trimmed line or sits flush
 * against a cell border, and the next row continues it — at column 0 for a
 * soft-wrapped line, or at the same column under a compatible prefix for a
 * hard-wrapped table cell. Returns null when the token stands alone.
 */
export function extendWrappedUrl(
  getLine: GetLinkLine,
  line: number,
  start: number,
  end: number,
): WrappedUrl | null {
  const head = getLine(line);
  if (!head) return null;
  const headBorders = borderCols(head.text);
  const cell = cellOf(headBorders, start, end);
  // Cut off at the line edge or flush against a border — or padded by spaces
  // up to the cell's right border, the way table renderers wrap cell content.
  const padded = cell !== null && end < cell[1] && blankish(head.text.slice(end, cell[1]));
  if (!atBoundary(head.text, end) && !padded) return null;
  const headPrefix = head.text.slice(0, start);
  const segments: LinkSegment[] = [{ line, start, end }];
  let url = head.text.slice(start, end);
  let cur = line;
  // Whether the previous segment ran to its row's right edge — folded
  // plain-text continuations are only plausible after an edge cut.
  let prevAtEdge = end >= head.text.length;
  while (segments.length <= MAX_WRAP_LINES && url.length <= MAX_URL_LENGTH) {
    const next = getLine(cur + 1);
    if (!next) break;
    let seg: { start: number; end: number } | null = null;
    if (next.isWrapped) {
      const m = /^\S+/.exec(next.text);
      if (m) {
        const token = m[0].replace(TAIL_STRIP_RE, '');
        if (token) seg = { start: 0, end: token.length };
      }
    } else {
      const toks = extractLinkTokens(next.text);
      // For a padded head the wrap is only plausible when the next row really
      // looks like a wrapped table row — same border layout and either all
      // other cells blank (single-column wraps, e.g. glab) or the leading
      // cells blank plus a closing paren/URL-ish fragment (tables that wrap
      // every column at once); single-cell tables need the extra confidence
      // of an unmatched `(` before the URL.
      let wrappedRow = false;
      let ct: LinkToken | undefined;
      if (cell) {
        const [b1, b2] = cell;
        const nb = borderCols(next.text);
        const sameLayout =
          nb.length === headBorders.length && headBorders.every((c, i) => c === nb[i]);
        const cand = toks.find((t) => t.start > b1 && t.start < b2);
        const headParen = unclosedParen(head.text.slice(b1 + 1, start));
        // `!9 (https://…` leaves a `(` open; the wrapped fragment closes it.
        const closesParen =
          cand !== undefined &&
          next.text
            .slice(cand.start + cand.token.length, b2)
            .trimStart()
            .startsWith(')');
        // All-column wraps (markdown-ish tables) blank the cells before the
        // URL's but later cells keep their own wrapped text — accept them
        // when the fragment closes the head's `(` or at least looks like a
        // URL tail, so a fresh row's `merged`-style value can't sneak in.
        wrappedRow =
          sameLayout &&
          (otherCellsBlank(next.text, nb, b1, b2) ||
            (nb.length >= 3
              ? cellsBeforeBlank(next.text, nb, b1) &&
                (headParen ? closesParen : URL_TAIL_RE.test(cand?.token ?? ''))
              : headParen));
        if (
          wrappedRow &&
          cand &&
          // A fresh `scheme://` token is a new cell value, not a URL tail.
          !URL_START_RE.test(cand.token) &&
          blankish(next.text.slice(b1 + 1, cand.start)) &&
          blankish(next.text.slice(cand.start + cand.token.length, b2))
        ) {
          ct = cand;
        }
      }
      const tok = toks.find((t) => t.start === start);
      if (
        tok &&
        !URL_START_RE.test(tok.token) &&
        continuationPrefixOk(next.text.slice(0, start), headPrefix) &&
        // A whitespace-prefixed continuation must be the row's only content —
        // otherwise it is an ordinary column value that happens to align.
        (BORDER_RE.test(next.text.slice(0, start)) || toks[toks.length - 1] === tok) &&
        (!padded || wrappedRow)
      ) {
        seg = { start: tok.start, end: tok.start + tok.token.length };
      } else if (ct) {
        seg = { start: ct.start, end: ct.start + ct.token.length };
      } else if (
        prevAtEdge &&
        toks.length === 1 &&
        !URL_START_RE.test(toks[0].token) &&
        URL_TAIL_STRICT_RE.test(toks[0].token)
      ) {
        // Folded plain text: the URL ran to the end of its row and the
        // next row holds only the remainder, however indented — e.g.
        // `→ MR: https://x/-/` followed by ` merge_requests/87`.
        seg = { start: toks[0].start, end: toks[0].start + toks[0].token.length };
      }
    }
    if (!seg) break;
    segments.push({ line: cur + 1, ...seg });
    url += next.text.slice(seg.start, seg.end);
    cur++;
    prevAtEdge = seg.end >= next.text.length;
    const cellPadded =
      cell !== null && seg.end < cell[1] && blankish(next.text.slice(seg.end, cell[1]));
    if (!atBoundary(next.text, seg.end) && !cellPadded) break;
  }
  // Borders can never be part of a URL; a stray one inside means the "segments"
  // were table artifacts rather than a wrapped link.
  if (segments.length === 1 || BORDER_RE.test(url)) return null;
  return { url, segments };
}

function coversToken(wrapped: WrappedUrl, line: number, start: number, end: number): boolean {
  return wrapped.segments.some((s) => s.line === line && s.start === start && s.end === end);
}

/**
 * The reverse lookup: whether the token at `[start, end)` on `line` is a
 * continuation fragment of a URL that starts on a line above. Returns the same
 * reconstruction as {@link extendWrappedUrl} so the whole wrapped URL is
 * clickable no matter which fragment is hovered.
 */
export function findWrappedUrlThrough(
  getLine: GetLinkLine,
  line: number,
  start: number,
  end: number,
): WrappedUrl | null {
  const here = getLine(line);
  if (!here) return null;
  if (here.isWrapped) {
    // A soft-wrapped URL continues at column 0; anything else on the row is
    // trailing content after the link.
    if (start !== 0) return null;
    let headIdx = line - 1;
    while (getLine(headIdx)?.isWrapped) headIdx--;
    const head = getLine(headIdx);
    if (!head) return null;
    const toks = extractLinkTokens(head.text);
    const tail = toks[toks.length - 1];
    if (!tail || !URL_START_RE.test(tail.token)) return null;
    const tailEnd = tail.start + tail.token.length;
    if (!atBoundary(head.text, tailEnd)) return null;
    const wrapped = extendWrappedUrl(getLine, headIdx, tail.start, tailEnd);
    return wrapped && coversToken(wrapped, line, start, end) ? wrapped : null;
  }
  // Hard wrap: walk upward along same-column segments cut at a boundary until
  // one of them is the scheme start, then re-derive the full URL downward so
  // the prefix rules are applied consistently.
  for (let p = line - 1; p >= 0 && line - p <= MAX_WRAP_LINES; p--) {
    const lp = getLine(p);
    if (!lp || lp.isWrapped) return null;
    const tok = extractLinkTokens(lp.text).find((t) => t.start === start);
    if (!tok || !atBoundary(lp.text, tok.start + tok.token.length)) break;
    if (URL_START_RE.test(tok.token)) {
      const wrapped = extendWrappedUrl(getLine, p, tok.start, tok.start + tok.token.length);
      return wrapped && coversToken(wrapped, line, start, end) ? wrapped : null;
    }
  }
  // Folded plain text: the hovered token is its row's only content — the
  // indented remainder of a URL that ran to the previous row's edge (e.g.
  // ` merge_requests/87` under `…→ MR: https://x/-/`). Walk up rows whose
  // last token reaches the edge until the `scheme://` start appears, then
  // re-derive downward so the head's own rules apply.
  const hereToks = extractLinkTokens(here.text);
  const sole = hereToks.length === 1 ? hereToks[0] : undefined;
  if (
    sole &&
    sole.start === start &&
    sole.start + sole.token.length === end &&
    !URL_START_RE.test(sole.token) &&
    URL_TAIL_STRICT_RE.test(sole.token)
  ) {
    for (let p = line - 1; p >= 0 && line - p <= MAX_WRAP_LINES; p--) {
      const lp = getLine(p);
      if (!lp || lp.isWrapped) break;
      const pToks = extractLinkTokens(lp.text);
      const last = pToks[pToks.length - 1];
      if (!last || last.start + last.token.length < lp.text.length) break;
      if (URL_START_RE.test(last.token)) {
        const wrapped = extendWrappedUrl(getLine, p, last.start, last.start + last.token.length);
        return wrapped && coversToken(wrapped, line, start, end) ? wrapped : null;
      }
      if (pToks.length !== 1 || !URL_TAIL_STRICT_RE.test(last.token)) break;
    }
  }
  // Wrapped table cell: the fragment sits inside a border-delimited cell whose
  // continuation starts at the cell's left edge — not at the head token's
  // column. Walk up rows with the same border layout: middle rows must look
  // like wrapped rows (other cells blank), the head row carries the URL start.
  const cols = borderCols(here.text);
  const cell = cellOf(cols, start, end);
  if (!cell) return null;
  const [b1, b2] = cell;
  for (let p = line - 1; p >= 0 && line - p <= MAX_WRAP_LINES; p--) {
    const lp = getLine(p);
    if (!lp || lp.isWrapped) return null;
    const pb = borderCols(lp.text);
    if (pb.length !== cols.length || !cols.every((c, i) => c === pb[i])) return null;
    const cellToks = extractLinkTokens(lp.text).filter((t) => t.start > b1 && t.start < b2);
    const urlTok = cellToks.find((t) => URL_START_RE.test(t.token));
    if (urlTok) {
      const urlEnd = urlTok.start + urlTok.token.length;
      const boundary =
        urlEnd >= lp.text.length ||
        BORDER_RE.test(lp.text[urlEnd]) ||
        blankish(lp.text.slice(urlEnd, b2));
      if (!boundary) return null;
      const wrapped = extendWrappedUrl(getLine, p, urlTok.start, urlEnd);
      return wrapped && coversToken(wrapped, line, start, end) ? wrapped : null;
    }
    // Middle fragment row: must hold exactly one padded token in the cell and
    // nothing elsewhere — or, for all-column wraps, blank leading cells with
    // later cells carrying their own wrapped text — otherwise it is a new
    // data row and the walk stops.
    const frag = cellToks[0];
    if (!frag) return null;
    const wrappedRowOk =
      otherCellsBlank(lp.text, pb, b1, b2) ||
      (cellToks.length === 1 &&
        cellsBeforeBlank(lp.text, pb, b1) &&
        blankish(lp.text.slice(b1 + 1, frag.start)) &&
        blankish(lp.text.slice(frag.start + frag.token.length, b2)));
    if (!wrappedRowOk) return null;
  }
  return null;
}

// ── OSC 8 leak guard ──────────────────────────────────────────────
// xterm.js tags every cell written while an OSC 8 hyperlink is open with
// the link's urlId, which renders as a dashed underline. A producer that
// emits `ESC]8;;<uri> ST` but never the closing `ESC]8;; ST` — truncated
// output, a killed process — leaves every following cell underlined.
// The guard tracks open/close across output chunks; once a link has been
// open for more than `maxOpenBytes` of output it is treated as leaked and
// `onLeak` fires so the caller can inject OSC8_CLOSE into the terminal
// parser (renderer-local — nothing is written to the PTY).

/** Sequence that closes any open OSC 8 link (written to xterm, not the PTY). */
export const OSC8_CLOSE = '\x1b]8;;\x07';

const OSC8_RE = /\x1b\]8;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// An OSC 8 sequence split across PTY chunks must still be recognized on the
// next one — carry an unterminated tail forward, capped so unbounded
// `ESC]8` garbage cannot grow without limit.
const OSC8_CARRY_MAX = 512;

export function createOsc8LeakGuard(onLeak: () => void, maxOpenBytes = 8192) {
  let linkOpen = false;
  let openBytes = 0;
  let carry = '';

  return (chunk: string) => {
    if (!chunk) return;
    const text = carry + chunk;
    carry = '';
    let consumed = 0;
    OSC8_RE.lastIndex = 0;
    for (const m of text.matchAll(OSC8_RE)) {
      // Payload is `params;uri` — an empty URI closes the link.
      const uri = m[1].slice(m[1].indexOf(';') + 1);
      linkOpen = uri.length > 0;
      if (linkOpen) openBytes = 0;
      consumed = m.index! + m[0].length;
    }
    const tail = text.indexOf('\x1b]8', consumed);
    if (tail >= 0) carry = text.slice(tail, tail + OSC8_CARRY_MAX);
    if (linkOpen) {
      openBytes += chunk.length;
      if (openBytes > maxOpenBytes) {
        linkOpen = false;
        openBytes = 0;
        // A real close arriving later is a harmless no-op.
        onLeak();
      }
    }
  };
}

/**
 * Memoize an async lookup (the link provider's path stat). Hits stay cached
 * in a bounded LRU; misses expire after `missTtlMs` — a path that does not
 * exist yet (a file a command is about to create) must become clickable once
 * it does. A failed lookup counts as a miss.
 */
export function createLookupCache<T>(
  lookup: (key: string) => Promise<T | null>,
  { max = 500, missTtlMs = 5000, now = () => Date.now() } = {},
): (key: string) => Promise<T | null> {
  const cache = new Map<string, { value: T | null; expires: number }>();
  return async (key) => {
    const entry = cache.get(key);
    cache.delete(key);
    if (entry && entry.expires > now()) {
      // Re-insert so the Map's insertion order tracks recency.
      cache.set(key, entry);
      return entry.value;
    }
    let value: T | null = null;
    try {
      value = await lookup(key);
    } catch {
      value = null;
    }
    cache.set(key, { value, expires: value === null ? now() + missTtlMs : Infinity });
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return value;
  };
}

/**
 * Path/URL candidates in a multi-line selection. Agent TUIs hard-wrap long
 * paths onto an indented continuation row (`…/docs-count` ⏎ `  /.local-…md`),
 * so no single row holds the whole path. The rows are rejoined without their
 * wrap indentation and without a separator, and every path- or URL-like word
 * of the result is offered, longest first. Joining two ordinary words at a
 * row break yields nothing path-like — and callers still verify each
 * candidate (stat / URL check) before using it.
 */
export function wrappedSelectionCandidates(selection: string): string[] {
  const rows = selection
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 2) return [];
  const strip = (t: string) =>
    t.replace(/^[.,;:'"()[\]{}<>*]+/, '').replace(/[.,;:'"()[\]{}<>*@|=]+$/, '');
  const words = rows
    .join('')
    .split(/\s+/)
    .map(strip)
    .filter((w) => w.length > 1 && (w.includes('/') || w.startsWith('~')));
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}
