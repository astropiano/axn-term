import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';
import { bindAppRuntime } from '../appRuntime';
import {
  isUrl,
  kindOf,
  matchesQuery,
  readItems,
  splitCommandSpec,
  awesomeListPlugin,
} from './awesomeList';

const statPath = vi.fn();
bindAppRuntime({
  exec: () => Promise.reject(new Error('no exec in tests')),
  statPath,
  resolveSessionId: () => 's1',
});

/** Minimal ctx: the command needs session.cwd, getCwd, appState and updateAppState. */
function makeCtx(appData: Record<string, unknown>, cwd = '/work/proj') {
  const session = { id: 's1', workspaceId: 'w1', cwd } as ShellSession;
  const ctx = {
    session,
    getCwd: async () => cwd,
    appState: appData,
    updateAppState: (patch: Record<string, unknown>) => {
      Object.assign(appData, patch);
    },
  } as unknown as SessionViewContext & PluginApi;
  return ctx;
}

const awesome = () =>
  pluginCommands(awesomeListPlugin).find((c) => c.name === 'axn-awesome')!;

describe('isUrl', () => {
  it('matches scheme URLs', () => {
    expect(isUrl('https://example.com/x')).toBe(true);
    expect(isUrl('http://localhost:8080')).toBe(true);
    expect(isUrl('file:///etc/hosts')).toBe(true);
  });
  it('rejects paths', () => {
    expect(isUrl('/home/user/file')).toBe(false);
    expect(isUrl('~/config.yaml')).toBe(false);
    expect(isUrl('a:b')).toBe(false);
  });
});

describe('readItems', () => {
  it('returns [] for missing or malformed state', () => {
    expect(readItems(undefined)).toEqual([]);
    expect(readItems({})).toEqual([]);
    expect(readItems({ items: 'nope' })).toEqual([]);
    expect(readItems({ items: [{}, { path: '' }, { path: '/x' }, null] })).toEqual([
      { path: '/x' },
    ]);
  });
  it('keeps id, label and command type', () => {
    const items = readItems({
      items: [
        { id: 'a', path: '/x', label: 'X' },
        { id: 'b', path: 'make test', type: 'command' },
      ],
    });
    expect(items).toEqual([
      { id: 'a', path: '/x', label: 'X' },
      { id: 'b', path: 'make test', type: 'command' },
    ]);
  });
});

describe('kindOf', () => {
  it('classifies urls before stat', () => {
    expect(kindOf({ path: 'https://x.dev' }, { path: '', isDir: true, isFile: false })).toBe('url');
  });
  it('classifies commands before anything else', () => {
    expect(kindOf({ path: 'make test', type: 'command' })).toBe('command');
    expect(
      kindOf({ path: 'https://x.dev', type: 'command' }, { path: '', isDir: false, isFile: true }),
    ).toBe('command');
  });
  it('uses stat for paths', () => {
    expect(kindOf({ path: '/d' }, { path: '/d', isDir: true, isFile: false })).toBe('dir');
    expect(kindOf({ path: '/f' }, { path: '/f', isDir: false, isFile: true })).toBe('file');
    expect(kindOf({ path: '/gone' }, null)).toBe('missing');
    expect(kindOf({ path: '/gone' })).toBe('missing');
  });
});

describe('splitCommandSpec', () => {
  it('returns the bare command', () => {
    expect(splitCommandSpec('git status')).toEqual({ command: 'git status', label: undefined });
    expect(splitCommandSpec('FOO=bar make test')).toEqual({
      command: 'FOO=bar make test',
      label: undefined,
    });
  });
  it('splits an optional label on " = "', () => {
    expect(splitCommandSpec('deploy = ./deploy.sh prod')).toEqual({
      command: './deploy.sh prod',
      label: 'deploy',
    });
  });
  it('returns null for empty input', () => {
    expect(splitCommandSpec('')).toBeNull();
    expect(splitCommandSpec('   ')).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('matches label and path, case-insensitive', () => {
    expect(matchesQuery({ path: '/work/Proj' }, 'proj')).toBe(true);
    expect(matchesQuery({ path: '/x', label: 'Deploy' }, 'dep')).toBe(true);
    expect(matchesQuery({ path: 'make test', type: 'command' }, 'TEST')).toBe(true);
    expect(matchesQuery({ path: '/x' }, 'nope')).toBe(false);
    expect(matchesQuery({ path: '/x' }, '  ')).toBe(true);
  });
});

describe('axn-awesome command', () => {
  beforeEach(() => {
    statPath.mockReset();
    statPath.mockImplementation(async (raw: string, _cwd?: string) => ({
      path: `/work/proj/${raw}`,
      isDir: true,
      isFile: false,
    }));
  });

  it('ls prints a numbered list, commands marked with $', async () => {
    const ctx = makeCtx({
      items: [
        { path: '/a', label: 'A' },
        { path: 'https://x.dev' },
        { path: 'make test', type: 'command', label: 'test' },
        { path: 'docker ps', type: 'command' },
      ],
    });
    const out = await awesome().run?.(ctx, 'ls', 'axn-awesome ls');
    expect(out).toBe(
      `printf '%s\\n' '1. A — /a' '2. https://x.dev' '3. test — $ make test' '4. $ docker ps'`,
    );
  });

  it('add resolves paths via stat_path and merges app state', async () => {
    const appData: Record<string, unknown> = { items: [{ path: '/a' }] };
    const out = await awesome().run?.(
      makeCtx(appData),
      'add sub/dir',
      'axn-awesome add sub/dir',
    );
    expect(statPath).toHaveBeenCalledWith('sub/dir', '/work/proj');
    expect(readItems(appData).map((i) => i.path)).toEqual(['/a', '/work/proj/sub/dir']);
    expect(out).toBe(`echo 'awesome: added /work/proj/sub/dir'`);
  });

  it('add keeps URLs verbatim and stores a quoted label', async () => {
    const appData: Record<string, unknown> = {};
    await awesome().run?.(
      makeCtx(appData),
      `add https://x.dev 'My Site'`,
      'axn-awesome add https://x.dev My Site',
    );
    expect(statPath).not.toHaveBeenCalled();
    expect(readItems(appData)).toEqual([
      { id: expect.any(String), path: 'https://x.dev', label: 'My Site' },
    ]);
  });

  it('cmd stores a command with optional label', async () => {
    const appData: Record<string, unknown> = {};
    await awesome().run?.(makeCtx(appData), 'cmd git status', 'axn-awesome cmd git status');
    await awesome().run?.(
      makeCtx(appData),
      'cmd deploy = ./deploy.sh prod',
      'axn-awesome cmd deploy = ./deploy.sh prod',
    );
    expect(readItems(appData)).toEqual([
      { id: expect.any(String), path: 'git status', type: 'command', label: undefined },
      { id: expect.any(String), path: './deploy.sh prod', type: 'command', label: 'deploy' },
    ]);
    expect(statPath).not.toHaveBeenCalled();
  });

  it('run replaces the typed line with the stored command', async () => {
    const appData: Record<string, unknown> = {
      items: [
        { path: '/a' },
        { path: 'make test', type: 'command', label: 'test' },
      ],
    };
    const ctx = makeCtx(appData);
    expect(await awesome().run?.(ctx, 'run 2', 'axn-awesome run 2')).toBe('make test');
    expect(await awesome().run?.(ctx, 'run test', 'axn-awesome run test')).toBe('make test');
    expect(readItems(appData)).toHaveLength(2);
  });

  it('run dispatches stored commands through runCommand when available', async () => {
    const ctx = makeCtx({ items: [{ path: 'axn-git', type: 'command' }] });
    // Swallowed by the dispatch (e.g. an axn-* command that handled itself).
    ctx.runCommand = vi.fn(async () => false as const);
    expect(await awesome().run?.(ctx, 'run 1', 'axn-awesome run 1')).toBe(false);
    expect(ctx.runCommand).toHaveBeenCalledWith('axn-git');
    // A replacement/feedback string from the dispatch is returned verbatim.
    ctx.runCommand = vi.fn(async () => 'echo "hi"');
    expect(await awesome().run?.(ctx, 'run 1', 'axn-awesome run 1')).toBe('echo "hi"');
    // Pass-through — a plain command replaces the typed line as before.
    ctx.runCommand = vi.fn(async () => undefined);
    expect(await awesome().run?.(ctx, 'run 1', 'axn-awesome run 1')).toBe('axn-git');
  });

  it('completes subcommands and run/rm targets', async () => {
    const ctx = makeCtx({
      items: [
        { path: '/a/b', label: 'Bee' },
        { path: 'make test', type: 'command', label: 'test' },
        { path: 'docker ps', type: 'command', label: 'two words' },
      ],
    });
    const cmd = awesome();
    expect(cmd.completeArg?.(ctx, '')).toEqual(['ls', 'add', 'cmd', 'run', 'rm']);
    expect(cmd.completeArg?.(ctx, 'r')).toEqual(['run', 'rm']);
    // run offers command items only — index and label.
    expect(await cmd.completeArg?.(ctx, 'run ')).toEqual([
      'run 2',
      'run test',
      'run 3',
      'run "two words"',
    ]);
    expect(await cmd.completeArg?.(ctx, 'run te')).toEqual(['run test']);
    // rm offers every item — index, label, basename for path bookmarks.
    expect(await cmd.completeArg?.(ctx, 'rm ')).toEqual([
      'rm 1',
      'rm Bee',
      'rm b',
      'rm 2',
      'rm test',
      'rm 3',
      'rm "two words"',
    ]);
    expect(await cmd.completeArg?.(ctx, 'ls anything')).toEqual([]);
  });

  it('run refuses bookmarks and unknown names', async () => {
    const ctx = makeCtx({ items: [{ path: '/a', label: 'A' }] });
    expect(await awesome().run?.(ctx, 'run A', 'axn-awesome run A')).toBe(
      `echo 'awesome: A is a bookmark, not a command'`,
    );
    expect(await awesome().run?.(ctx, 'run 9', 'axn-awesome run 9')).toBe(
      `echo 'awesome: no item 9'`,
    );
  });

  it('rm removes by index, label or path suffix', async () => {
    const appData: Record<string, unknown> = {
      items: [{ path: '/a', label: 'A' }, { path: '/b/c' }],
    };
    const ctx = makeCtx(appData);
    await awesome().run?.(ctx, 'rm c', 'axn-awesome rm c');
    expect(readItems(appData).map((i) => i.path)).toEqual(['/a']);
    const out = await awesome().run?.(ctx, 'rm 1', 'axn-awesome rm 1');
    expect(readItems(appData)).toEqual([]);
    expect(out).toBe(`echo 'awesome: removed A'`);
  });

  it('rm echoes an error for unknown bookmarks', async () => {
    const out = await awesome().run?.(makeCtx({ items: [] }), 'rm 9', 'axn-awesome rm 9');
    expect(out).toBe(`echo 'awesome: no bookmark 9'`);
  });
});
