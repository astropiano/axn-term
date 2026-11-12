import { describe, expect, it, vi } from 'vitest';
import {
  createLookupCache,
  createOsc8LeakGuard,
  createOsc8LinkHandler,
  extractLinkTokens,
  extendWrappedUrl,
  findWrappedUrlThrough,
  type GetLinkLine,
  type LinkLine,
  wrappedSelectionCandidates,
} from './terminalLinks';

function lines(rows: (string | { text: string; isWrapped?: boolean })[]): GetLinkLine {
  const infos: LinkLine[] = rows.map((r) =>
    typeof r === 'string' ? { text: r.trimEnd(), isWrapped: false } : { text: r.text.trimEnd(), isWrapped: r.isWrapped ?? false },
  );
  return (i) => infos[i];
}

describe('extractLinkTokens', () => {
  it('strips punctuation and border chars from token edges', () => {
    const toks = extractLinkTokens('│ https://example.com/a │ done.');
    expect(toks.map((t) => t.token)).toEqual(['https://example.com/a', 'done']);
    expect(toks[0].start).toBe(2);
  });

  it('respects the minimum length filter', () => {
    expect(extractLinkTokens('a bb c', 64, 2).map((t) => t.token)).toEqual(['bb']);
    expect(extractLinkTokens('a bb c').map((t) => t.token)).toEqual(['a', 'bb', 'c']);
  });
});

describe('extendWrappedUrl', () => {
  it('returns null for a complete URL that ends mid-line', () => {
    const get = lines(['open https://example.com/a now']);
    expect(extendWrappedUrl(get, 0, 5, 5 + 'https://example.com/a'.length)).toBeNull();
  });

  it('returns null when no continuation row follows', () => {
    const get = lines(['open https://example.com/a', '$ next']);
    expect(extendWrappedUrl(get, 0, 5, 'open https://example.com/a'.length)).toBeNull();
  });

  it('joins a URL soft-wrapped onto the next buffer line', () => {
    const get = lines([
      'curl https://example.com/ver',
      { text: 'y/long/path?q=1 next', isWrapped: true },
    ]);
    const url = extendWrappedUrl(get, 0, 5, 'curl https://example.com/ver'.length);
    expect(url?.url).toBe('https://example.com/very/long/path?q=1');
    expect(url?.segments).toEqual([
      { line: 0, start: 5, end: 28 },
      { line: 1, start: 0, end: 'y/long/path?q=1'.length },
    ]);
  });

  it('joins a URL wrapped over three soft-wrapped rows', () => {
    const get = lines([
      'see https://example.com/aa',
      { text: 'bb/cc', isWrapped: true },
      { text: 'dd?x=1', isWrapped: true },
      'done',
    ]);
    const url = extendWrappedUrl(get, 0, 4, 'see https://example.com/aa'.length);
    expect(url?.url).toBe('https://example.com/aabb/ccdd?x=1');
    expect(url?.segments).toHaveLength(3);
  });

  it('stops at a wrapped row that does not continue the URL', () => {
    const get = lines([
      'curl https://example.com/ver',
      { text: 'y/long', isWrapped: true },
      'unrelated',
    ]);
    const url = extendWrappedUrl(get, 0, 5, 'curl https://example.com/ver'.length);
    expect(url?.url).toBe('https://example.com/very/long');
  });

  it('joins a URL hard-wrapped inside a table cell', () => {
    const get = lines([
      '│ name │ https://example.com/really/long│ x │',
      '│ n2   │ path?x=1                     │ y │',
    ]);
    const start = '│ name │ '.length;
    const url = extendWrappedUrl(get, 0, start, start + 'https://example.com/really/long'.length);
    expect(url?.url).toBe('https://example.com/really/longpath?x=1');
    expect(url?.segments[1]).toEqual({ line: 1, start, end: start + 'path?x=1'.length });
  });

  it('joins a URL in the last table column against the right border', () => {
    const get = lines([
      '│ https://example.com/aaa│',
      '│ bbb                    │',
    ]);
    const url = extendWrappedUrl(get, 0, 2, 2 + 'https://example.com/aaa'.length);
    expect(url?.url).toBe('https://example.com/aaabbb');
  });

  it('joins an aligned continuation under a label prefix', () => {
    const get = lines(['URL: https://example.com/aaa', '     bbb']);
    const url = extendWrappedUrl(get, 0, 5, 'URL: https://example.com/aaa'.length);
    expect(url?.url).toBe('https://example.com/aaabbb');
  });

  it('does not join an aligned word that is followed by more columns', () => {
    const get = lines(['see  https://example.com/a', '     word more']);
    expect(extendWrappedUrl(get, 0, 5, 'see  https://example.com/a'.length)).toBeNull();
  });

  it('does not join a next row whose prefix has unrelated content', () => {
    const get = lines(['open https://example.com/a', 'then cont']);
    expect(extendWrappedUrl(get, 0, 5, 'open https://example.com/a'.length)).toBeNull();
  });

  it('does not join when the head segment is padded inside its cell', () => {
    const get = lines([
      '│ https://example.com/aaa  │',
      '│ bbb                    │',
    ]);
    expect(extendWrappedUrl(get, 0, 2, 2 + 'https://example.com/aaa'.length)).toBeNull();
  });

  it('joins a URL padded inside a cell and wrapped to the next table row', () => {
    // glab-style wrap: the cell content overflows and continues on a row
    // whose other cells are blank.
    const get = lines([
      '│ !6 (https://gitlab.com/a/b/-/  │ dev │',
      '│ merge_requests/6)'.padEnd(33) + '│     │',
    ]);
    const start = 6;
    const end = start + 'https://gitlab.com/a/b/-/'.length;
    const url = extendWrappedUrl(get, 0, start, end);
    expect(url?.url).toBe('https://gitlab.com/a/b/-/merge_requests/6');
    expect(url?.segments).toEqual([
      { line: 0, start: 6, end: 31 },
      { line: 1, start: 2, end: 18 },
    ]);
  });

  it('joins a padded cell wrap without parentheses', () => {
    const get = lines([
      '│ https://gitlab.com/a/b/-/     │ dev │',
      '│ merge_requests/6'.padEnd(32) + '│     │',
    ]);
    const start = 2;
    const end = start + 'https://gitlab.com/a/b/-/'.length;
    const url = extendWrappedUrl(get, 0, start, end);
    expect(url?.url).toBe('https://gitlab.com/a/b/-/merge_requests/6');
  });

  it('does not join when the next row is a new table row', () => {
    // Other cells carry content — `merged` is a value, not a continuation.
    const get = lines([
      '│ 1 │ !6 (https://gitlab.com/a/b/-/  │ dev  │',
      '│ 2 │ merged'.padEnd(37) + '│ feat │',
    ]);
    const start = '│ 1 │ !6 ('.length;
    const end = start + 'https://gitlab.com/a/b/-/'.length;
    expect(extendWrappedUrl(get, 0, start, end)).toBeNull();
  });

  it('joins a URL wrapped over three rows inside a cell', () => {
    const get = lines([
      '│ (https://gitlab.com/a/ver │ x │',
      '│ y/long/'.padEnd(28) + '│   │',
      '│ path)'.padEnd(28) + '│   │',
    ]);
    const start = 3;
    const end = start + 'https://gitlab.com/a/ver'.length;
    const url = extendWrappedUrl(get, 0, start, end);
    expect(url?.url).toBe('https://gitlab.com/a/very/long/path');
    expect(url?.segments).toHaveLength(3);
  });

  it('does not join a continuation cell holding extra content', () => {
    const get = lines([
      '│ (https://gitlab.com/a/b/-/  │ dev │',
      '│ frag) extra'.padEnd(30) + '│     │',
    ]);
    const start = 3;
    expect(
      extendWrappedUrl(get, 0, start, start + 'https://gitlab.com/a/b/-/'.length),
    ).toBeNull();
  });

  it('joins a padded single-column cell wrap when an open paren precedes the URL', () => {
    const get = lines([
      '│ (https://example.com/aaa  │',
      '│ bbb)'.padEnd(28) + '│',
    ]);
    const start = 3;
    const url = extendWrappedUrl(get, 0, start, start + 'https://example.com/aaa'.length);
    expect(url?.url).toBe('https://example.com/aaabbb');
  });

  // Real-world table where every column wraps at once: continuation rows
  // blank the leading cells but later cells carry their own wrapped text.
  const mrRow = (repo: string, mr: string, change: string) =>
    `│ ${repo.padEnd(20)}│ ${mr.padEnd(62)}│ ${change.padEnd(40)}│`;

  it('joins a cell wrap when a later column carries its own wrapped text', () => {
    const head = mrRow(
      'keycloak-theme',
      '!9 (https://gitlab.acme.io/dev/keycloak-theme/-/',
      'Logo pinned top, realm name centred',
    );
    const cont = mrRow('', 'merge_requests/9)', 'below; dead rules removed');
    const get = lines([head, cont]);
    const start = head.indexOf('https://');
    const end = start + 'https://gitlab.acme.io/dev/keycloak-theme/-/'.length;
    const url = extendWrappedUrl(get, 0, start, end);
    expect(url?.url).toBe(
      'https://gitlab.acme.io/dev/keycloak-theme/-/merge_requests/9',
    );
    expect(url?.segments).toHaveLength(2);
  });

  it('joins wraps across a whole four-row table', () => {
    const rows = [
      mrRow('keycloak-theme', '!9 (https://gitlab.acme.io/dev/keycloak-theme/-/', 'Logo pinned top'),
      mrRow('', 'merge_requests/9)', 'centred below'),
      mrRow('frontend-app', '!75 (https://gitlab.acme.io/dev/frontend-app/-/merg', 'realm: Dev →'),
      mrRow('', 'e_requests/75)', 'store'),
      mrRow('backend-svc', '!34 (https://gitlab.acme.io/dev/backend-svc/-/merge_r', 'realm rename'),
      mrRow('', 'equests/34)', ''),
      mrRow('integ-tests', '!19 (https://gitlab.acme.io/dev/integ-tests/-/merge_req', 'full rename'),
      mrRow('', 'uests/19)', ''),
    ];
    const get = lines(rows);
    const expectWrap = (headRow: number, frag: string, want: string) => {
      const start = rows[headRow].indexOf('https://');
      const end = start + frag.length;
      const url = extendWrappedUrl(get, headRow, start, end);
      expect(url?.url).toBe(want);
    };
    expectWrap(0, 'https://gitlab.acme.io/dev/keycloak-theme/-/',
      'https://gitlab.acme.io/dev/keycloak-theme/-/merge_requests/9');
    expectWrap(2, 'https://gitlab.acme.io/dev/frontend-app/-/merg',
      'https://gitlab.acme.io/dev/frontend-app/-/merge_requests/75');
    expectWrap(4, 'https://gitlab.acme.io/dev/backend-svc/-/merge_r',
      'https://gitlab.acme.io/dev/backend-svc/-/merge_requests/34');
    expectWrap(6, 'https://gitlab.acme.io/dev/integ-tests/-/merge_req',
      'https://gitlab.acme.io/dev/integ-tests/-/merge_requests/19');
  });

  it('does not join a new data row that fills the leading cell', () => {
    const head = mrRow('keycloak-theme', '!9 (https://gitlab.acme.io/dev/kt/-/', 'x');
    const next = mrRow('frontend-app', '!75 (https://gitlab.acme.io/dev/fa/-/', 'y');
    const get = lines([head, next]);
    const start = head.indexOf('https://');
    const end = start + 'https://gitlab.acme.io/dev/kt/-/'.length;
    expect(extendWrappedUrl(get, 0, start, end)).toBeNull();
  });

  it('does not join a leading-blank row whose fragment does not close the paren', () => {
    const head = mrRow('keycloak-theme', '!9 (https://gitlab.acme.io/dev/kt/-/', 'x');
    const next = mrRow('', 'merged', 'y');
    const get = lines([head, next]);
    const start = head.indexOf('https://');
    const end = start + 'https://gitlab.acme.io/dev/kt/-/'.length;
    expect(extendWrappedUrl(get, 0, start, end)).toBeNull();
  });

  // Folded plain text: the URL runs to the row's right edge and the next row
  // carries only the remainder — indented, at a different column.
  it('joins a URL folded onto an indented next row', () => {
    const head =
      'Re-applied on develop (resolved vs family-column-create) → MR: https://gitlab.com/a/b/-/';
    const get = lines([head, ' merge_requests/87']);
    const start = head.indexOf('https://');
    const url = extendWrappedUrl(get, 0, start, head.length);
    expect(url?.url).toBe('https://gitlab.com/a/b/-/merge_requests/87');
    expect(url?.segments).toEqual([
      { line: 0, start, end: head.length },
      { line: 1, start: 1, end: 1 + 'merge_requests/87'.length },
    ]);
  });

  it('chains multiple folded continuation rows', () => {
    const get = lines([
      'open https://example.com/aa',
      '  bb/cc',
      'dd?x=1',
      'done',
    ]);
    const url = extendWrappedUrl(get, 0, 5, 'open https://example.com/aa'.length);
    expect(url?.url).toBe('https://example.com/aabb/ccdd?x=1');
    expect(url?.segments).toHaveLength(3);
  });

  it('does not join a sole next-row word without URL characters', () => {
    // `file.txt` has no path/query char — it is prose, not a URL tail.
    const get = lines(['open https://example.com/a', 'file.txt']);
    expect(extendWrappedUrl(get, 0, 5, 'open https://example.com/a'.length)).toBeNull();
  });

  it('does not join a folded fragment followed by more prose', () => {
    const get = lines(['open https://example.com/a/', 'merge_requests/87 notes']);
    expect(extendWrappedUrl(get, 0, 5, 'open https://example.com/a/'.length)).toBeNull();
  });

  it('does not join a folded row that starts a fresh URL', () => {
    const get = lines(['open https://example.com/a/', 'https://other.com/x']);
    expect(extendWrappedUrl(get, 0, 5, 'open https://example.com/a/'.length)).toBeNull();
  });
});

describe('findWrappedUrlThrough', () => {
  const table = [
    '│ name │ https://example.com/really/long│ x │',
    '│ n2   │ path?x=1                     │ y │',
  ];

  it('resolves a hard-wrapped continuation fragment to the full URL', () => {
    const get = lines(table);
    const start = '│ n2   │ '.length;
    const url = findWrappedUrlThrough(get, 1, start, start + 'path?x=1'.length);
    expect(url?.url).toBe('https://example.com/really/longpath?x=1');
    expect(url?.segments[0].line).toBe(0);
  });

  it('resolves a soft-wrapped continuation fragment', () => {
    const get = lines([
      'curl https://example.com/ver',
      { text: 'y/long/path?q=1 next', isWrapped: true },
    ]);
    const url = findWrappedUrlThrough(get, 1, 0, 'y/long/path?q=1'.length);
    expect(url?.url).toBe('https://example.com/very/long/path?q=1');
  });

  it('ignores tokens that are not continuation columns', () => {
    const get = lines(table);
    // 'y' sits in a different column — it is not part of the URL.
    const yStart = table[1].indexOf('y │');
    expect(findWrappedUrlThrough(get, 1, yStart, yStart + 1)).toBeNull();
  });

  it('ignores ordinary output below a URL that did not wrap', () => {
    const get = lines(['$ curl https://example.com/a', '{"ok":true}']);
    const tok = extractLinkTokens('{"ok":true}')[0];
    expect(findWrappedUrlThrough(get, 1, tok.start, tok.start + tok.token.length)).toBeNull();
  });

  it('resolves a fragment on a padded cell-wrapped continuation row', () => {
    const get = lines([
      '│ !6 (https://gitlab.com/a/b/-/  │ dev │',
      '│ merge_requests/6)'.padEnd(33) + '│     │',
    ]);
    const url = findWrappedUrlThrough(get, 1, 2, 2 + 'merge_requests/6'.length);
    expect(url?.url).toBe('https://gitlab.com/a/b/-/merge_requests/6');
    expect(url?.segments[0]).toEqual({ line: 0, start: 6, end: 31 });
  });

  it('resolves a middle fragment of a three-row cell wrap', () => {
    const get = lines([
      '│ (https://gitlab.com/a/ver │ x │',
      '│ y/long/'.padEnd(28) + '│   │',
      '│ path)'.padEnd(28) + '│   │',
    ]);
    const url = findWrappedUrlThrough(get, 2, 2, 2 + 'path'.length);
    expect(url?.url).toBe('https://gitlab.com/a/very/long/path');
    expect(url?.segments).toHaveLength(3);
  });

  it('does not resolve a fragment in a real next table row', () => {
    const get = lines([
      '│ 1 │ !6 (https://gitlab.com/a/b/-/  │ dev  │',
      '│ 2 │ merged'.padEnd(37) + '│ feat │',
    ]);
    const start = '│ 2 │ '.length;
    expect(
      findWrappedUrlThrough(get, 1, start, start + 'merged'.length),
    ).toBeNull();
  });

  it('resolves a fragment when a later column carries its own wrapped text', () => {
    const mrRow = (repo: string, mr: string, change: string) =>
      `│ ${repo.padEnd(20)}│ ${mr.padEnd(62)}│ ${change.padEnd(40)}│`;
    const head = mrRow(
      'keycloak-theme',
      '!9 (https://gitlab.acme.io/dev/keycloak-theme/-/',
      'Logo pinned top, realm name centred',
    );
    const cont = mrRow('', 'merge_requests/9)', 'below; dead rules removed');
    const get = lines([head, cont]);
    const start = cont.indexOf('merge_requests');
    const url = findWrappedUrlThrough(get, 1, start, start + 'merge_requests/9'.length);
    expect(url?.url).toBe(
      'https://gitlab.acme.io/dev/keycloak-theme/-/merge_requests/9',
    );
    expect(url?.segments[0].line).toBe(0);
  });

  it('resolves a folded indented fragment to the full URL', () => {
    const get = lines([
      '… → MR: https://gitlab.com/example/project/-/',
      ' merge_requests/87',
    ]);
    const url = findWrappedUrlThrough(get, 1, 1, 1 + 'merge_requests/87'.length);
    expect(url?.url).toBe(
      'https://gitlab.com/example/project/-/merge_requests/87',
    );
    expect(url?.segments[0].line).toBe(0);
  });

  it('resolves a middle fragment across folded rows', () => {
    const get = lines([
      'open https://example.com/aa',
      '  bb/cc',
      ' dd?x=1',
    ]);
    const url = findWrappedUrlThrough(get, 2, 1, 1 + 'dd?x=1'.length);
    expect(url?.url).toBe('https://example.com/aabb/ccdd?x=1');
    expect(url?.segments).toHaveLength(3);
  });

  it('ignores a sole fragment under a row that does not end in a URL', () => {
    const get = lines(['curl https://x/a now', ' merge/87']);
    expect(findWrappedUrlThrough(get, 1, 1, 1 + 'merge/87'.length)).toBeNull();
  });

  it('ignores a sole non-URL word under an edge-cut URL', () => {
    const get = lines(['open https://example.com/a', 'notes']);
    expect(findWrappedUrlThrough(get, 1, 0, 'notes'.length)).toBeNull();
  });

  it('ignores a folded row that is itself a fresh URL', () => {
    const get = lines(['open https://example.com/a/', 'https://other.com/x']);
    expect(findWrappedUrlThrough(get, 1, 0, 'https://other.com/x'.length)).toBeNull();
  });
});

describe('createOsc8LeakGuard', () => {
  const OPEN = '\x1b]8;;https://example.com\x07';
  const CLOSE = '\x1b]8;;\x07';

  function harness() {
    const leaks: number[] = [];
    const guard = createOsc8LeakGuard(() => leaks.push(1), 64);
    return { guard, leaks };
  }

  it('does not fire for a properly closed link', () => {
    const { guard, leaks } = harness();
    guard(`${OPEN}link text${CLOSE}`);
    guard('x'.repeat(1000));
    expect(leaks).toHaveLength(0);
  });

  it('fires once a link stays open past the byte threshold', () => {
    const { guard, leaks } = harness();
    guard(OPEN);
    guard('x'.repeat(100));
    expect(leaks).toHaveLength(1);
    // And only once per leak — more output must not re-trigger.
    guard('y'.repeat(100));
    expect(leaks).toHaveLength(1);
  });

  it('recognizes a sequence split across chunks', () => {
    const { guard, leaks } = harness();
    guard('\x1b]8;;https://exa');
    guard('mple.com\x07');
    guard('x'.repeat(100));
    expect(leaks).toHaveLength(1);
  });

  it('accepts ST-terminated links and params before the URI', () => {
    const { guard, leaks } = harness();
    guard('\x1b]8;id=1;https://example.com\x1b\\text\x1b]8;;\x1b\\');
    guard('x'.repeat(1000));
    expect(leaks).toHaveLength(0);
  });

  it('a real close after the injected one stays quiet', () => {
    const { guard, leaks } = harness();
    guard(OPEN);
    guard('x'.repeat(100));
    expect(leaks).toHaveLength(1);
    guard(CLOSE);
    guard(OPEN + 'short' + CLOSE);
    guard('z'.repeat(100));
    expect(leaks).toHaveLength(1);
  });
});

describe('createLookupCache', () => {
  it('caches hits', async () => {
    const lookup = vi.fn(async (k: string) => `stat:${k}`);
    const cached = createLookupCache(lookup);
    expect(await cached('a')).toBe('stat:a');
    expect(await cached('a')).toBe('stat:a');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('re-checks misses once their TTL expires', async () => {
    let t = 0;
    let exists = false;
    const lookup = vi.fn(async () => (exists ? 'file' : null));
    const cached = createLookupCache(lookup, { missTtlMs: 1000, now: () => t });
    expect(await cached('new.txt')).toBeNull();
    exists = true;
    t = 500;
    expect(await cached('new.txt')).toBeNull(); // still within the TTL
    t = 1500;
    expect(await cached('new.txt')).toBe('file');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('treats a failed lookup as a miss', async () => {
    const cached = createLookupCache(async () => {
      throw new Error('boom');
    });
    expect(await cached('x')).toBeNull();
  });

  it('evicts the least recently used entry beyond max', async () => {
    const lookup = vi.fn(async (k: string) => k);
    const cached = createLookupCache(lookup, { max: 2 });
    await cached('a');
    await cached('b');
    await cached('a'); // a is now most recent
    await cached('c'); // evicts b
    lookup.mockClear();
    await cached('a');
    await cached('c');
    expect(lookup).not.toHaveBeenCalled();
    await cached('b');
    expect(lookup).toHaveBeenCalledWith('b');
  });
});

describe('wrappedSelectionCandidates', () => {
  it('rejoins a path an agent TUI hard-wrapped onto an indented row', () => {
    const selection =
      '/Volumes/MgnlDevExtended/Mgnl/Git/worktrees/AIACC-631-dashboard-docs-count\n' +
      '  /.local-drafts/VECTORDB-context-dashboard-translation-ticket.md,';
    expect(wrappedSelectionCandidates(selection)[0]).toBe(
      '/Volumes/MgnlDevExtended/Mgnl/Git/worktrees/AIACC-631-dashboard-docs-count' +
        '/.local-drafts/VECTORDB-context-dashboard-translation-ticket.md',
    );
  });

  it('finds the wrapped path inside surrounding prose, longest first', () => {
    const selection = "It's now at /Volumes/a/b-very-long\n  /c/file.md, renamed to match.";
    expect(wrappedSelectionCandidates(selection)).toEqual(['/Volumes/a/b-very-long/c/file.md']);
  });

  it('rejoins a wrapped URL', () => {
    expect(
      wrappedSelectionCandidates('see https://gitlab.example.com/group/proj/-/merge_\n  requests/12'),
    ).toEqual(['https://gitlab.example.com/group/proj/-/merge_requests/12']);
  });

  it('offers nothing for a single row or prose without paths', () => {
    expect(wrappedSelectionCandidates('/one/row/only')).toEqual([]);
    expect(wrappedSelectionCandidates('two lines of\n  plain prose')).toEqual([]);
  });
});

describe('createOsc8LinkHandler', () => {
  const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
  const click = (button = 0) => ({ button }) as MouseEvent;

  it('opens http(s) and mailto URIs, gates everything else', () => {
    const open = vi.fn();
    const h = createOsc8LinkHandler({ open });
    h.activate(click(), 'https://example.com/page', range);
    h.activate(click(), 'http://example.com', range);
    h.activate(click(), 'mailto:a@b.c', range);
    h.activate(click(), 'javascript:alert(1)', range);
    h.activate(click(), 'ssh://host', range);
    h.activate(click(), 'ftp://x', range);
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/page',
      'http://example.com',
      'mailto:a@b.c',
    ]);
  });

  it('opts into non-http protocols itself — xterm would filter them', () => {
    expect(createOsc8LinkHandler({ open: vi.fn() }).allowNonHttpProtocols).toBe(true);
  });

  it('routes a file:// link to openFile with the decoded path', () => {
    const open = vi.fn();
    const openFile = vi.fn();
    const h = createOsc8LinkHandler({ open, openFile });
    h.activate(click(), 'file://host/home/u/my%20dir/f.txt', range);
    expect(openFile).toHaveBeenCalledWith(expect.anything(), '/home/u/my dir/f.txt');
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to open(uri) for file:// without openFile', () => {
    const open = vi.fn();
    createOsc8LinkHandler({ open }).activate(click(), 'file:///tmp/x', range);
    expect(open).toHaveBeenCalledWith('file:///tmp/x');
  });

  it('strips the leading slash on windows drive paths', () => {
    const openFile = vi.fn();
    createOsc8LinkHandler({ open: vi.fn(), openFile }).activate(
      click(),
      'file:///C:/work/a.ts',
      range,
    );
    expect(openFile).toHaveBeenCalledWith(expect.anything(), 'C:/work/a.ts');
  });

  it('ignores non-left buttons — right-click opens the context menu', () => {
    const open = vi.fn();
    const h = createOsc8LinkHandler({ open });
    h.activate(click(2), 'https://example.com', range);
    h.activate(click(1), 'https://example.com', range);
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores malformed file URIs', () => {
    const open = vi.fn();
    const openFile = vi.fn();
    createOsc8LinkHandler({ open, openFile }).activate(click(), 'file://%zz', range);
    expect(open).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });
});
