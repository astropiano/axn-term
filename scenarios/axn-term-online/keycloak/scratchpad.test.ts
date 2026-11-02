// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import type { DirEntry, PathStat } from '@axn-term/session-backend';
import type { ShellSession } from '../../types';
import type { PluginApi, SessionViewContext } from './plugin';
import {
  scratchpadPlugin,
  parsePatterns,
  dirsForRepo,
  remoteRepoName,
  draftFileName,
  findDraft,
  resolveScratchpad,
  listDrafts,
  runScratch,
  agentHintLines,
  type ScratchpadLocation,
} from './scratchpad';

type Ctx = SessionViewContext & PluginApi;

const REPO = '/home/tester/axn-term';

interface Harness {
  ctx: Ctx;
  session: ShellSession;
  store: Record<string, unknown>;
  banners: Array<Record<string, unknown> | null>;
  openedTabs: Array<{ path: string; kind: string }>;
  openedBrowsers: string[];
  writtenFiles: Record<string, string>;
  dirs: Set<string>;
  listing: Record<string, DirEntry[]>;
  /** Repo-relative dirs that exist (plus '/'-prefixed absolutes). */
  existing: Set<string>;
}

function dirEntry(name: string, isFile = true): DirEntry {
  return { name, isFile, isDirectory: !isFile, isSymlink: false };
}

function makeHarness(
  overrides: Partial<ShellSession> = {},
  pluginState: Record<string, unknown> = {},
  pluginSettings: Record<string, unknown> = {},
): Harness {
  const session: ShellSession = {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    cwd: REPO,
    repo: {
      name: 'axn-term-feat-foo',
      branch: 'feat/foo',
      ahead: 0,
      behind: 0,
      dirty: false,
      untracked: 0,
      remoteBranchMissing: false,
      root: REPO,
      remote: 'git@gitlab.example.com:axn/axn-term.git',
    },
    ...overrides,
  };
  const h: Harness = {
    session,
    store: { scratchpad: pluginState },
    banners: [],
    openedTabs: [],
    openedBrowsers: [],
    writtenFiles: {},
    dirs: new Set(),
    listing: {},
    existing: new Set(),
    ctx: undefined as unknown as Ctx,
  };
  const statFor = (path: string, cwd?: string): PathStat | null => {
    const abs = path.startsWith('/') ? path : `${cwd ?? ''}/${path}`;
    if (h.existing.has(path) || h.existing.has(abs)) {
      return { path: abs, isFile: false, isDir: true };
    }
    if (h.writtenFiles[abs] !== undefined || h.existing.has(`file:${abs}`)) {
      return { path: abs, isFile: true, isDir: false };
    }
    return null;
  };
  h.ctx = {
    session,
    updateSession: () => {},
    writeToSession: async () => {},
    updatePluginState: (patch: unknown) => {
      h.store.scratchpad = {
        ...(h.store.scratchpad as Record<string, unknown>),
        ...(patch as Record<string, unknown>),
      };
    },
    get pluginState() {
      return h.store.scratchpad;
    },
    pluginSettings,
    getSession: () => session,
    getSessionCount: () => 1,
    exec: async (command: string, cwd?: string) => {
      if (command.includes('rev-parse --show-toplevel')) return cwd ?? REPO;
      if (command.includes('remote get-url')) return 'git@gitlab.example.com:axn/axn-term.git';
      return '';
    },
    waitForSessionOutput: async () => true,
    getCwd: async () => session.cwd ?? null,
    getTty: async () => null,
    openBrowser: (path: string) => {
      h.openedBrowsers.push(path);
    },
    isProgressHandled: () => false,
    getScreenLines: () => [],
    setAttention: () => {},
    setBanner: (b) => {
      h.banners.push(b as Record<string, unknown> | null);
    },
    setRestoring: () => {},
    openTab: (tab: { path: string; kind: string }) => {
      h.openedTabs.push(tab);
    },
    openSubShell: () => undefined,
    openSession: () => {},
    getWorkspace: () => undefined,
    readFile: async () => '',
    writeFile: async (path: string, contents: string, cwd?: string) => {
      const abs = path.startsWith('/') ? path : `${cwd ?? ''}/${path}`;
      h.writtenFiles[abs] = contents;
    },
    statPath: async (path: string, cwd?: string) => statFor(path, cwd),
    mkdir: async (path: string, cwd?: string) => {
      const abs = path.startsWith('/') ? path : `${cwd ?? ''}/${path}`;
      h.dirs.add(abs);
      h.existing.add(abs);
      h.existing.add(path);
      return true;
    },
    listDir: async (path: string, cwd?: string) => {
      const abs = path.startsWith('/') ? path : `${cwd ?? ''}/${path}`;
      return h.listing[abs] ?? null;
    },
    repoMenuItems: () => [],
    appState: undefined,
    updateAppState: () => {},
  } as unknown as Ctx;
  return h;
}

// ---------------------------------------------------------------------------

describe('parsePatterns', () => {
  it('parses repo: dirs entries', () => {
    const p = parsePatterns('axn-term: .local-drafts, drafts; *: .scratchpad');
    expect(p).toHaveLength(2);
    expect(p[0].repo).toBe('axn-term');
    expect(p[0].dirs).toEqual(['.local-drafts', 'drafts']);
    expect(p[1].repo).toBe('*');
  });

  it('treats an entry without repo part as all-repos', () => {
    const p = parsePatterns('.drafts, notes');
    expect(p).toHaveLength(1);
    expect(p[0].repo).toBe('*');
    expect(p[0].dirs).toEqual(['.drafts', 'notes']);
  });

  it('splits on newlines and strips slashes', () => {
    const p = parsePatterns('axn-term: /drafts/\nother: tmp/notes/');
    expect(p[0].dirs).toEqual(['drafts']);
    expect(p[1].dirs).toEqual(['tmp/notes']);
  });

  it('skips malformed regexes', () => {
    const p = parsePatterns('([: drafts; *: ok');
    expect(p).toHaveLength(1);
    expect(p[0].dirs).toEqual(['ok']);
  });

  it('returns nothing when unset — the user configures their own patterns', () => {
    expect(parsePatterns(undefined)).toEqual([]);
    expect(parsePatterns('')).toEqual([]);
    expect(parsePatterns('   ')).toEqual([]);
  });
});

describe('dirsForRepo', () => {
  const patterns = parsePatterns('*: .local-drafts; axn-.*: .ai; myapp: hw-notes');

  it('matches against any repo name (checkout dir or remote)', () => {
    expect(dirsForRepo(patterns, ['axn-term-feat-foo', 'axn-term'])).toEqual([
      '.local-drafts',
      '.ai',
    ]);
  });

  it('unions matching entries, deduped in order', () => {
    const p = parsePatterns('*: a, b; repo: b, c');
    expect(dirsForRepo(p, ['repo'])).toEqual(['a', 'b', 'c']);
  });

  it('returns empty when nothing matches', () => {
    expect(dirsForRepo(patterns, ['other-repo'])).toEqual(['.local-drafts']);
    expect(dirsForRepo(parsePatterns('only-x: drafts'), ['other'])).toEqual([]);
  });
});

describe('remoteRepoName', () => {
  it('extracts the repo name from ssh and https remotes', () => {
    expect(remoteRepoName('git@gitlab.com:group/sub/axn-term.git')).toBe('axn-term');
    expect(remoteRepoName('https://gitlab.com/group/axn-term/')).toBe('axn-term');
    expect(remoteRepoName('')).toBe('');
  });
});

describe('draftFileName', () => {
  it('slugifies a title and appends the default extension', () => {
    expect(draftFileName('Bug Notes!', 'md')).toBe('bug-notes.md');
  });
  it('keeps an explicit extension', () => {
    expect(draftFileName('Raw Data.TXT', 'md')).toBe('raw-data.txt');
  });
  it('timestamps empty names', () => {
    expect(draftFileName('   ', 'md')).toMatch(/^draft-\d{8}-\d{4}\.md$/);
  });
});

describe('findDraft', () => {
  const drafts = [
    { dir: '.local-drafts', name: 'a.md', path: '/r/.local-drafts/a.md' },
    { dir: '.local-drafts', name: 'b notes.md', path: '/r/.local-drafts/b notes.md' },
  ];
  it('matches index, filename and stem', () => {
    expect(findDraft(drafts, '1')?.name).toBe('a.md');
    expect(findDraft(drafts, 'b notes.md')?.name).toBe('b notes.md');
    expect(findDraft(drafts, 'b notes')?.name).toBe('b notes.md');
    expect(findDraft(drafts, 'nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('resolveScratchpad', () => {
  it('matches the remote repo name so worktrees inherit the config', async () => {
    const h = makeHarness({}, {}, { patterns: 'axn-term: .local-drafts' });
    const loc = await resolveScratchpad(h.ctx);
    expect(loc?.repoRoot).toBe(REPO);
    expect(loc?.dirs).toEqual(['.local-drafts']);
    expect(loc?.existing).toEqual([]);
    expect(loc?.primary).toBe('.local-drafts');
  });

  it('prefers an existing dir as primary', async () => {
    const h = makeHarness({}, {}, { patterns: '*: .local-drafts, drafts' });
    h.existing.add(`${REPO}/drafts`);
    const loc = await resolveScratchpad(h.ctx);
    expect(loc?.existing).toEqual(['drafts']);
    expect(loc?.primary).toBe('drafts');
  });

  it('returns null when no pattern matches the repo', async () => {
    const h = makeHarness({}, {}, { patterns: 'other-repo: drafts' });
    expect(await resolveScratchpad(h.ctx)).toBeNull();
  });

  it('returns null outside a repo', async () => {
    const h = makeHarness({ repo: undefined, cwd: '/tmp' });
    h.ctx.exec = async () => {
      throw new Error('not a repo');
    };
    expect(await resolveScratchpad(h.ctx)).toBeNull();
  });
});

describe('listDrafts', () => {
  it('lists files in existing dirs, skipping .gitignore and folders', async () => {
    const h = makeHarness({}, {}, { patterns: '*: .local-drafts, drafts' });
    h.existing.add(`${REPO}/.local-drafts`);
    h.listing[`${REPO}/.local-drafts`] = [
      dirEntry('a.md'),
      dirEntry('.gitignore'),
      dirEntry('sub', false),
      dirEntry('b.txt'),
    ];
    const loc = await resolveScratchpad(h.ctx);
    const drafts = await listDrafts(h.ctx, loc!);
    expect(drafts.map((d) => d.name)).toEqual(['a.md', 'b.txt']);
    expect(drafts[0].path).toBe(`${REPO}/.local-drafts/a.md`);
  });
});

describe('runScratch', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({}, {}, { patterns: '*: .local-drafts, drafts' });
  });

  it('prints an error outside repos/pattern matches', async () => {
    const h2 = makeHarness({}, {}, { patterns: 'zzz-other: drafts' });
    const out = await runScratch(h2.ctx, '');
    expect(out).toContain('axn-scratch: not inside a git repo');
  });

  it('dir prints the primary drafts folder', async () => {
    const out = await runScratch(h.ctx, 'dir');
    expect(out).toContain(`${REPO}/.local-drafts`);
  });

  it('ls prints the dir and a numbered draft list', async () => {
    h.existing.add(`${REPO}/.local-drafts`);
    h.listing[`${REPO}/.local-drafts`] = [dirEntry('a.md'), dirEntry('b.md')];
    const out = await runScratch(h.ctx, 'ls');
    expect(out).toContain(`${REPO}/.local-drafts`);
    expect(out).toContain('1. a.md');
    expect(out).toContain('2. b.md');
  });

  it('new creates the dir, seeds .gitignore, writes the file and opens it', async () => {
    const out = await runScratch(h.ctx, 'new bug notes');
    expect(h.dirs.has(`${REPO}/.local-drafts`)).toBe(true);
    expect(h.writtenFiles[`${REPO}/.local-drafts/.gitignore`]).toBe('*\n');
    expect(h.writtenFiles[`${REPO}/.local-drafts/bug-notes.md`]).toBe('# bug notes\n\n');
    expect(h.openedTabs).toEqual([
      { path: `${REPO}/.local-drafts/bug-notes.md`, kind: 'editor' },
    ]);
    expect(out).toContain(`scratchpad: ${REPO}/.local-drafts/bug-notes.md`);
  });

  it('does not clobber an existing draft', async () => {
    h.existing.add(`${REPO}/.local-drafts`);
    h.listing[`${REPO}/.local-drafts`] = [dirEntry('a.md')];
    h.writtenFiles[`${REPO}/.local-drafts/a.md`] = 'keep me';
    await runScratch(h.ctx, 'new a.md');
    expect(h.writtenFiles[`${REPO}/.local-drafts/a.md`]).toBe('keep me');
    expect(h.openedTabs).toEqual([{ path: `${REPO}/.local-drafts/a.md`, kind: 'editor' }]);
  });

  it('open resolves by name and index', async () => {
    h.existing.add(`${REPO}/.local-drafts`);
    h.listing[`${REPO}/.local-drafts`] = [dirEntry('a.md'), dirEntry('b.md')];
    expect(await runScratch(h.ctx, 'open b')).toBe(false);
    expect(await runScratch(h.ctx, 'open 1')).toBe(false);
    expect(h.openedTabs.map((t) => t.path)).toEqual([
      `${REPO}/.local-drafts/b.md`,
      `${REPO}/.local-drafts/a.md`,
    ]);
  });

  it('bare name opens existing drafts and creates new ones', async () => {
    h.existing.add(`${REPO}/.local-drafts`);
    h.listing[`${REPO}/.local-drafts`] = [dirEntry('a.md')];
    expect(await runScratch(h.ctx, 'a')).toBe(false); // opens a.md
    const out = await runScratch(h.ctx, 'fresh draft');
    expect(out).toContain('fresh-draft.md');
    expect(h.openedTabs[0].path).toBe(`${REPO}/.local-drafts/a.md`);
    expect(h.openedTabs[1].path).toBe(`${REPO}/.local-drafts/fresh-draft.md`);
  });

  it('hint prints agent-facing instructions', async () => {
    const out = await runScratch(h.ctx, 'hint');
    expect(out).toContain('.local-drafts/');
    expect(out).toContain('Scratchpad');
  });
});

describe('agentHintLines', () => {
  it('mentions every configured dir and the primary', () => {
    const loc: ScratchpadLocation = {
      repoRoot: REPO,
      repoName: 'axn-term',
      names: ['axn-term'],
      dirs: ['.local-drafts', 'drafts'],
      existing: ['drafts'],
      primary: 'drafts',
    };
    const lines = agentHintLines(loc);
    expect(lines[0]).toContain('`.local-drafts/`');
    expect(lines[0]).toContain('`drafts/`');
    expect(lines[1]).toContain('`drafts/`');
  });
});

describe('plugin wiring', () => {
  it('declares axn-scratch and axn-draft with arg completion', () => {
    const names = (scratchpadPlugin.commands ?? []).map((c) =>
      typeof c === 'string' ? c : c.name,
    );
    expect(names).toEqual(['axn-scratch', 'axn-draft']);
  });

  it('is disabled by default', () => {
    expect(scratchpadPlugin.defaultEnabled).toBe(false);
  });

  it('contributes one Open <dir>/ menu row per configured folder', () => {
    const h = makeHarness(
      {},
      { dirs: ['.local-drafts', 'drafts'] },
    );
    const labels = scratchpadPlugin.sessionMenuItems!(h.ctx).map((i) => i.label);
    expect(labels).toContain('Open .local-drafts/');
    expect(labels).toContain('Open drafts/');
    expect(labels).not.toContain('Open drafts');
  });

  it('falls back to a single Open drafts row before resolution', () => {
    const h = makeHarness();
    const labels = scratchpadPlugin.sessionMenuItems!(h.ctx).map((i) => i.label);
    expect(labels).toContain('Open drafts');
    expect(labels.filter((l) => l.startsWith('Open '))).toHaveLength(1);
  });

  it('stores the repo\'s configured dirs in pluginState after a refresh', async () => {
    const h = makeHarness({}, {}, { patterns: '*: .local-drafts, drafts' });
    scratchpadPlugin.onSessionOpen?.(h.ctx);
    await new Promise((r) => setTimeout(r, 0));
    const d = (h.store.scratchpad as { dirs?: string[] }).dirs;
    expect(d).toEqual(['.local-drafts', 'drafts']);
  });
});
