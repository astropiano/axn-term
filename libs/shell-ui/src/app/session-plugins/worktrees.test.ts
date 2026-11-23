import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { findSessionField } from './plugin';
import type { ShellSession, Workspace } from '../../types';
import type { PluginApi, SessionViewContext } from './plugin';
import {
  worktreesPlugin,
  slugify,
  worktreeDirFor,
  worktreeBranchFor,
  parseAgentList,
  agentResumeCommand,
  addWorktreeCmd,
  removeWorktreeCmd,
  deleteBranchCmd,
  nameAgentCmd,
} from './worktrees';
import { shellQuote } from '../../shellQuote';

type Ctx = SessionViewContext & PluginApi;

const REPO = '/home/tester/axn-term';

interface Harness {
  ctx: Ctx;
  session: ShellSession;
  store: Record<string, unknown>;
  banners: Array<Record<string, unknown> | null>;
  execCalls: Array<{ command: string; cwd?: string }>;
  openedSessions: Array<{ cwd?: string; name?: string }>;
  openedTabs: Array<{ path: string; kind: string }>;
  writes: string[];
  execReplies: Record<string, string>;
}

function makeHarness(
  overrides: Partial<ShellSession> = {},
  pluginState: Record<string, unknown> = {},
  pluginSettings: Record<string, unknown> = {},
  workspaces: Workspace[] = [],
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
    ...overrides,
  };
  const h: Harness = {
    session,
    store: { worktrees: pluginState },
    banners: [],
    execCalls: [],
    openedSessions: [],
    openedTabs: [],
    writes: [],
    execReplies: {},
    ctx: undefined as unknown as Ctx,
  };
  h.ctx = {
    session,
    updateSession: () => {},
    writeToSession: async (data: string) => {
      h.writes.push(data);
    },
    updatePluginState: (patch: unknown) => {
      h.store.worktrees = {
        ...(h.store.worktrees as Record<string, unknown>),
        ...(patch as Record<string, unknown>),
      };
    },
    get pluginState() {
      return h.store.worktrees;
    },
    pluginSettings,
    getSession: () => session,
    getSessionCount: () => 1,
    exec: async (command: string, cwd?: string) => {
      h.execCalls.push({ command, cwd });
      for (const [match, reply] of Object.entries(h.execReplies)) {
        if (command.includes(match)) return reply;
      }
      if (command.includes('rev-parse --show-toplevel')) return REPO;
      if (command.includes('rev-parse --git-dir')) return 'main';
      return '';
    },
    waitForSessionOutput: async () => true,
    getCwd: async () => session.cwd ?? null,
    getTty: async () => null,
    openBrowser: () => {},
    isProgressHandled: () => false,
    getScreenLines: () => [],
    setAttention: () => {},
    setBanner: (b) => {
      h.banners.push(b as Record<string, unknown> | null);
      h.store.worktrees = { ...(h.store.worktrees as Record<string, unknown>), banner: b };
    },
    setRestoring: () => {},
    openTab: (tab: { path: string; kind: string }) => {
      h.openedTabs.push(tab);
    },
    openSubShell: () => undefined,
    openSession: (cwd?: string, name?: string) => {
      h.openedSessions.push({ cwd, name });
    },
    getWorkspace: () => workspaces.find((w) => w.id === session.workspaceId),
    readFile: async () => '',
    writeFile: async () => {},
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    appState: undefined,
    updateAppState: () => {},
  } as unknown as Ctx;
  return h;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// --------------------------------------------------------------------------
// pure helpers
// --------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces unsafe chars', () => {
    expect(slugify('Fix The Bug!')).toBe('fix-the-bug');
    expect(slugify('feat/login flow')).toBe('feat-login-flow');
  });
  it('collapses separators and trims', () => {
    expect(slugify('--a  b--')).toBe('a-b');
    expect(slugify('.dot.')).toBe('dot');
  });
  it('returns empty for unusable input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('worktreeDirFor', () => {
  it('defaults to <repo-parent>/worktrees/<repo>-<slug>', () => {
    expect(worktreeDirFor(REPO, 'fix')).toBe('/home/tester/worktrees/axn-term-fix');
  });
  it('honors a root override', () => {
    expect(worktreeDirFor(REPO, 'fix', '/tmp/wt')).toBe('/tmp/wt/axn-term-fix');
  });
});

describe('worktreeBranchFor', () => {
  it('namespaces under wt/', () => {
    expect(worktreeBranchFor('fix')).toBe('wt/fix');
  });
});

describe('parseAgentList', () => {
  it('defaults to the common agents', () => {
    expect(parseAgentList(undefined)).toEqual(['claude', 'devin', 'codex', 'agy', 'vibe']);
  });
  it('parses comma-separated names case-insensitively', () => {
    expect(parseAgentList(' Claude ,aider')).toEqual(['claude', 'aider']);
  });
  it('falls back to defaults for empty input', () => {
    expect(parseAgentList('  , ')).toEqual(['claude', 'devin', 'codex', 'agy', 'vibe']);
  });
});

describe('agentResumeCommand', () => {
  it('knows claude/devin/codex/agy/vibe resumes', () => {
    expect(agentResumeCommand('claude')).toBe('claude -c');
    expect(agentResumeCommand('devin')).toBe('devin -c');
    expect(agentResumeCommand('codex')).toBe('codex resume --last');
    expect(agentResumeCommand('agy')).toBe('agy -c');
    expect(agentResumeCommand('antigravity')).toBe('agy -c');
    expect(agentResumeCommand('vibe')).toBe('vibe -r');
  });
  it('returns null for unknown agents', () => {
    expect(agentResumeCommand('aider')).toBeNull();
  });
});

describe('git command builders', () => {
  it('quotes paths safely', () => {
    expect(shellQuote("/it's/here")).toBe(`'/it'\\''s/here'`);
  });
  it('builds worktree add with -b', () => {
    expect(addWorktreeCmd(REPO, '/wt/x', 'wt/x')).toBe(
      `git -C '/home/tester/axn-term' worktree add '/wt/x' -b 'wt/x'`,
    );
  });
  it('builds worktree remove, with force flag', () => {
    expect(removeWorktreeCmd(REPO, '/wt/x')).toBe(
      `git -C '/home/tester/axn-term' worktree remove '/wt/x'`,
    );
    expect(removeWorktreeCmd(REPO, '/wt/x', true)).toBe(
      `git -C '/home/tester/axn-term' worktree remove --force '/wt/x'`,
    );
  });
  it('builds branch delete', () => {
    expect(deleteBranchCmd(REPO, 'wt/x')).toBe(
      `git -C '/home/tester/axn-term' branch -D 'wt/x'`,
    );
  });
});

// --------------------------------------------------------------------------
// menus
// --------------------------------------------------------------------------

describe('sessionMenuItems', () => {
  it('offers worktree creation on a plain session', () => {
    const h = makeHarness();
    const items = worktreesPlugin.sessionMenuItems!(h.ctx);
    expect(items.map((i) => i.label)).toEqual([
      'New worktree session',
      'New worktree with claude',
    ]);
  });

  it('offers review/remove on a worktree session', () => {
    const wt = { repoRoot: REPO, path: '/home/tester/worktrees/axn-term-fix', branch: 'wt/fix' };
    const h = makeHarness({}, { worktree: wt });
    const items = worktreesPlugin.sessionMenuItems!(h.ctx);
    expect(items.map((i) => i.label)).toEqual(['Review worktree changes', 'Remove worktree']);

    items[0].onClick();
    expect(h.openedTabs).toEqual([{ path: wt.path, kind: 'git' }]);
  });

  it('uses the configured default agent in the label', () => {
    const h = makeHarness({}, {}, { defaultAgent: 'devin' });
    const items = worktreesPlugin.sessionMenuItems!(h.ctx);
    expect(items[1].label).toBe('New worktree with devin');
  });
});

describe('workspaceMenuItems', () => {
  const ws: Workspace = { id: 'w1', name: 'ws' };

  it('offers nothing without a defaultFolder', () => {
    const h = makeHarness();
    expect(worktreesPlugin.workspaceMenuItems!(h.ctx, ws)).toEqual([]);
  });

  it('offers creation bound to the defaultFolder', () => {
    const folderWs: Workspace = { ...ws, defaultFolder: '/home/tester/axn-term' };
    const h = makeHarness();
    const items = worktreesPlugin.workspaceMenuItems!(h.ctx, folderWs);
    expect(items.map((i) => i.label)).toEqual([
      'New worktree session',
      'New worktree with claude',
    ]);
  });

  it('resolves the repo from defaultFolder, not the session', async () => {
    // Session is not in a repo; defaultFolder is.
    const folderWs: Workspace = { ...ws, defaultFolder: REPO };
    const h = makeHarness({ cwd: '/tmp/elsewhere' });
    h.execReplies = { 'rev-parse --show-toplevel': REPO };
    const items = worktreesPlugin.workspaceMenuItems!(h.ctx, folderWs);
    items[0].onClick();
    await flush();
    expect(h.execCalls[0].cwd).toBe(REPO);
    expect(h.openedSessions).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// creation flow
// --------------------------------------------------------------------------

describe('worktree creation', () => {
  it('adds the worktree, opens a session there, and tags it on open', async () => {
    const h = makeHarness();
    const items = worktreesPlugin.sessionMenuItems!(h.ctx);
    items[0].onClick();
    await flush();
    await flush();

    expect(h.execCalls.some((c) => c.command.includes('worktree add'))).toBe(true);
    const add = h.execCalls.find((c) => c.command.includes('worktree add'))!;
    expect(add.command).toContain('-b');
    expect(h.openedSessions).toHaveLength(1);
    const dir = h.openedSessions[0].cwd!;

    // The new session opens in the worktree → pending state lands on it.
    const h2 = makeHarness({ cwd: dir }, {});
    worktreesPlugin.onSessionOpen!(h2.ctx);
    const wt = (h2.store.worktrees as { worktree?: { path: string; branch: string } }).worktree;
    expect(wt?.path).toBe(dir);
    expect(wt?.branch).toMatch(/^wt\//);
  });

  it('seeds the agent command into the new session', async () => {
    const h = makeHarness();
    const items = worktreesPlugin.sessionMenuItems!(h.ctx);
    items[1].onClick(); // New worktree with claude
    await flush();
    await flush();
    const dir = h.openedSessions[0].cwd!;
    const h2 = makeHarness({ cwd: dir });
    worktreesPlugin.onSessionOpen!(h2.ctx);
    await flush();
    expect(h2.writes).toContain('claude\n');
  });

  it('names the worktree from axn-worktree <name>', async () => {
    const h = makeHarness();
    const cmd = worktreesPlugin.commands![0];
    const out = await (cmd as { run: (c: Ctx, a?: string) => Promise<unknown> }).run(h.ctx, 'My Fix');
    expect(out).toBe(false);
    const dir = `/home/tester/worktrees/axn-term-wt-my-fix`;
    expect(h.execCalls.some((c) => c.command.includes(`'${dir}'`))).toBe(true);
    expect(h.execCalls.some((c) => c.command.includes(`-b 'wt/my-fix'`))).toBe(true);
    expect(h.openedSessions[0]).toEqual({ cwd: dir, name: 'my-fix' });
  });

  it('echoes an error outside a repo', async () => {
    const h = makeHarness({ cwd: '/tmp' });
    h.execReplies = { 'rev-parse': '' };
    h.ctx.exec = async () => {
      throw new Error('not a repo');
    };
    const cmd = worktreesPlugin.commands![0];
    const out = await (cmd as { run: (c: Ctx, a?: string) => Promise<unknown> }).run(h.ctx, 'x');
    expect(out).toBe(`echo 'axn-worktree: not inside a git repository'`);
  });

  it('banners on worktree add failure', async () => {
    const h = makeHarness();
    h.execReplies = { 'worktree add': '' };
    const realExec = h.ctx.exec;
    h.ctx.exec = async (cmd: string, cwd?: string) => {
      if (cmd.includes('worktree add')) throw new Error('branch exists');
      return realExec(cmd, cwd);
    };
    worktreesPlugin.sessionMenuItems!(h.ctx)[0].onClick();
    await flush();
    await flush();
    expect(h.openedSessions).toHaveLength(0);
    expect(h.banners.at(-1)).toMatchObject({ level: 'error' });
  });
});

// --------------------------------------------------------------------------
// removal
// --------------------------------------------------------------------------

describe('worktree removal', () => {
  const wt = { repoRoot: REPO, path: '/home/tester/worktrees/axn-term-fix', branch: 'wt/fix' };

  it('removes and offers branch deletion', async () => {
    const h = makeHarness({}, { worktree: wt });
    worktreesPlugin.sessionMenuItems!(h.ctx)[1].onClick();
    await flush();
    expect(h.execCalls.some((c) => c.command === removeWorktreeCmd(REPO, wt.path))).toBe(true);
    expect((h.store.worktrees as { worktree?: unknown }).worktree).toBeNull();
    const banner = h.banners.at(-1) as { level: string; actions: { id: string }[] };
    expect(banner.level).toBe('info');
    expect(banner.actions[0].id).toBe('remove-branch');
  });

  it('offers force-remove on failure', async () => {
    const h = makeHarness({}, { worktree: wt });
    h.ctx.exec = async (cmd: string) => {
      if (cmd.includes('worktree remove')) throw new Error('dirty');
      return '';
    };
    worktreesPlugin.sessionMenuItems!(h.ctx)[1].onClick();
    await flush();
    const banner = h.banners.at(-1) as { level: string; actions: { id: string }[] };
    expect(banner.level).toBe('error');
    expect(banner.actions[0].id).toBe('remove-force');
  });

  it('remove-force retries with --force', async () => {
    const h = makeHarness({}, { worktree: wt });
    worktreesPlugin.onBannerAction!(h.ctx, 'remove-force');
    await flush();
    expect(h.execCalls.some((c) => c.command === removeWorktreeCmd(REPO, wt.path, true))).toBe(true);
  });

  it('remove-branch deletes the kept branch after removal', async () => {
    const h = makeHarness({}, { worktree: wt });
    worktreesPlugin.sessionMenuItems!(h.ctx)[1].onClick(); // Remove worktree
    await flush();
    // pluginState.worktree is cleared by removal — the action falls back to
    // the stashed record.
    expect((h.store.worktrees as { worktree?: unknown }).worktree).toBeNull();
    worktreesPlugin.onBannerAction!(h.ctx, 'remove-branch');
    await flush();
    expect(h.execCalls.some((c) => c.command === deleteBranchCmd(REPO, wt.branch))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// isolation nudge
// --------------------------------------------------------------------------

describe('agent isolation banner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('raises the warning once for an agent in the main checkout', async () => {
    const h = makeHarness({ process: 'claude' });
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    await flush();
    const banner = h.banners.at(-1) as { level: string; message: string };
    expect(banner.level).toBe('warning');
    expect(banner.message).toContain('claude');
    h.banners.length = 0;
    worktreesPlugin.onOutput!(h.ctx, 'chunk2');
    await flush();
    expect(h.banners).toHaveLength(0);
  });

  it('stays quiet inside a worktree', async () => {
    const h = makeHarness({ process: 'claude' });
    const realExec = h.ctx.exec;
    h.ctx.exec = async (cmd: string, cwd?: string) =>
      cmd.includes('--git-dir') ? 'worktree' : realExec(cmd, cwd);
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    await flush();
    expect(h.banners).toHaveLength(0);
  });

  it('stays quiet for non-agent processes and when disabled', async () => {
    const h = makeHarness({ process: 'vim' });
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    expect(h.banners).toHaveLength(0);

    const h2 = makeHarness({ process: 'claude' }, {}, { suggestIsolation: false });
    worktreesPlugin.onOutput!(h2.ctx, 'chunk');
    await flush();
    expect(h2.banners).toHaveLength(0);
  });

  it('stays quiet after "don\'t ask again"', async () => {
    const h = makeHarness({ process: 'claude' }, { dismissed: true });
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    expect(h.banners).toHaveLength(0);
  });

  it('isolate action creates a worktree seeded with the resume command', async () => {
    const h = makeHarness({ process: 'claude' });
    worktreesPlugin.onBannerAction!(h.ctx, 'isolate');
    await flush();
    await flush();
    expect(h.execCalls.some((c) => c.command.includes('worktree add'))).toBe(true);
    expect(h.openedSessions).toHaveLength(1);
    const dir = h.openedSessions[0].cwd!;
    const h2 = makeHarness({ cwd: dir });
    worktreesPlugin.onSessionOpen!(h2.ctx);
    await flush();
    expect(h2.writes).toContain('claude -c\n');
  });

  it('never-isolate persists dismissal', () => {
    const h = makeHarness({ process: 'claude' });
    worktreesPlugin.onBannerAction!(h.ctx, 'never-isolate');
    expect((h.store.worktrees as { dismissed?: boolean }).dismissed).toBe(true);
  });

  it('clears the banner once the agent is no longer foreground', async () => {
    const h = makeHarness({ process: 'devin' });
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    await flush();
    expect(
      (h.banners.at(-1) as { message: string }).message,
    ).toContain('devin');

    // Agent exits — the shell is foreground again (process undefined).
    h.session.process = undefined;
    h.banners.length = 0;
    worktreesPlugin.onOutput!(h.ctx, 'chunk2');
    await flush();
    expect(h.banners.at(-1)).toBeNull();
  });

  it('clears a restored banner on a session without an agent', async () => {
    const h = makeHarness(
      { process: undefined },
      {
        banner: {
          level: 'warning',
          message: 'devin is running in the main checkout',
          actions: [{ id: 'isolate', label: 'New worktree session' }],
        },
      },
    );
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    expect(h.banners.at(-1)).toBeNull();
  });

  it('clears a restored banner on session open, before any output', async () => {
    const h = makeHarness(
      { process: undefined },
      {
        banner: {
          level: 'warning',
          message: 'devin is running in the main checkout',
          actions: [{ id: 'isolate', label: 'New worktree session' }],
        },
      },
    );
    worktreesPlugin.onSessionOpen!(h.ctx);
    await flush();
    expect(h.banners.at(-1)).toBeNull();
  });

  it('keeps the banner while the agent is still foreground', async () => {
    const h = makeHarness(
      { process: 'devin' },
      {
        banner: {
          level: 'warning',
          message: 'devin is running in the main checkout',
          actions: [{ id: 'isolate', label: 'New worktree session' }],
        },
      },
    );
    worktreesPlugin.onSessionOpen!(h.ctx);
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    await flush();
    // Never cleared — it may re-raise (this session was never nudged), but
    // no null is pushed while the agent is still foreground.
    expect(h.banners.every((b) => b !== null)).toBe(true);
    expect(
      (h.store.worktrees as { banner?: unknown }).banner,
    ).not.toBeNull();
  });

  it('leaves unrelated banners alone', async () => {
    const h = makeHarness(
      { process: undefined },
      {
        banner: {
          level: 'info',
          message: 'worktree removed',
          actions: [{ id: 'remove-branch', label: 'Delete wt/x' }],
        },
      },
    );
    worktreesPlugin.onOutput!(h.ctx, 'chunk');
    await flush();
    expect(h.banners).toHaveLength(0);
  });
});

describe('rowTip', () => {
  it('explains the worktree badge in the session tooltip', () => {
    const h = makeHarness(
      {},
      { worktree: { repoRoot: REPO, path: `${REPO}-wt-feat`, branch: 'wt/feat' } },
    );
    expect(findSessionField(worktreesPlugin, 'worktree')!.tip!(h.ctx)).toBe(
      `⎇ wt/feat: linked worktree — ${REPO}-wt-feat`,
    );
  });

  it('returns null without a worktree', () => {
    expect(findSessionField(worktreesPlugin, 'worktree')!.tip!(makeHarness().ctx)).toBeNull();
  });
});

describe('nameAgentCmd', () => {
  it('passes a hostile MR title to the agent as one inert prompt word', () => {
    const title = 'fix $(touch pwned) `id` "q" \\ it\'s';
    const cmd = nameAgentCmd(`printf '%s\\n'`, '!12', title);
    expect(cmd.startsWith(`printf '%s\\n' -p '`)).toBe(true);
    const out = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    expect(out).toBe(`-p\nreply with only a short kebab-case git branch slug for merge request !12: ${title}\n`);
  });

  it('keeps a user agent command with flags as-is', () => {
    expect(nameAgentCmd('claude --model haiku', '#3', 'x')).toMatch(/^claude --model haiku -p '/);
  });
});
