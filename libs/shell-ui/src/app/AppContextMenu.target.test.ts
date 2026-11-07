import { describe, expect, it } from 'vitest';
import type { SelectionResolver } from '../terminalRegistry';
import { resolveSelectionTarget } from './AppContextMenu';

const forPaths = (paths: Record<string, { isDir?: boolean; isUrl?: boolean }>): SelectionResolver => {
  return async (token) => {
    const hit = paths[token];
    return hit
      ? { stat: { path: token, isDir: hit.isDir ?? false }, isUrl: hit.isUrl ?? false }
      : null;
  };
};

describe('resolveSelectionTarget', () => {
  it('finds a URL', async () => {
    expect(await resolveSelectionTarget(forPaths({ 'https://x.io/a': { isUrl: true } }), 'https://x.io/a')).toEqual({
      path: 'https://x.io/a',
      isUrl: true,
      isDir: false,
    });
  });

  it('strips quotes and punctuation around a path', async () => {
    expect(
      await resolveSelectionTarget(forPaths({ '/tmp/a.txt': {} }), '"/tmp/a.txt",'),
    ).toEqual({ path: '/tmp/a.txt', isUrl: false, isDir: false });
  });

  it('picks the resolvable token out of a multi-token selection', async () => {
    expect(
      await resolveSelectionTarget(forPaths({ '/etc/hosts': {} }), 'see /etc/hosts for details'),
    ).toEqual({ path: '/etc/hosts', isUrl: false, isDir: false });
  });

  it('rejoins a hard-wrapped path', async () => {
    expect(
      await resolveSelectionTarget(forPaths({ '/very/long/path': {} }), '/very/long/\n  path'),
    ).toEqual({ path: '/very/long/path', isUrl: false, isDir: false });
  });

  it('returns null when nothing resolves', async () => {
    expect(await resolveSelectionTarget(forPaths({}), 'just some words')).toBeNull();
  });
});
