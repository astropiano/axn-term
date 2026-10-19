import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';
import { bindAppRuntime } from '../appRuntime';
import { isUrl, kindOf, readItems, awesomeListPlugin } from './awesomeList';

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
  it('keeps id and label', () => {
    const items = readItems({ items: [{ id: 'a', path: '/x', label: 'X' }] });
    expect(items).toEqual([{ id: 'a', path: '/x', label: 'X' }]);
  });
});

describe('kindOf', () => {
  it('classifies urls before stat', () => {
    expect(kindOf('https://x.dev', { path: '', isDir: true, isFile: false })).toBe('url');
  });
  it('uses stat for paths', () => {
    expect(kindOf('/d', { path: '/d', isDir: true, isFile: false })).toBe('dir');
    expect(kindOf('/f', { path: '/f', isDir: false, isFile: true })).toBe('file');
    expect(kindOf('/gone', null)).toBe('missing');
    expect(kindOf('/gone')).toBe('missing');
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

  it('ls prints a numbered list', async () => {
    const ctx = makeCtx({
      items: [
        { path: '/a', label: 'A' },
        { path: 'https://x.dev' },
      ],
    });
    const out = await awesome().run?.(ctx, 'ls', 'axn-awesome ls');
    expect(out).toBe(`printf '%s\\n' '1. A — /a' '2. https://x.dev'`);
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
