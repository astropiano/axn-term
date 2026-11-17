import { describe, it, expect, vi } from 'vitest';
import { mrRole, parseMrUrl } from './forge';
import { createMrPeopleCache } from './mrActions';

describe('mrRole', () => {
  const p = (author: string, assignees: string[] = [], reviewers: string[] = []) => ({ author, assignees, reviewers });

  it('an assignee drives the MR — author, even on someone else’s MR', () => {
    expect(mrRole(p('bob', ['me']), 'me')).toBe('author');
    expect(mrRole(p('bob', ['me'], ['me']), 'me')).toBe('author');
  });

  it('a requested reviewer is a reviewer', () => {
    expect(mrRole(p('bob', ['bob'], ['me']), 'me')).toBe('reviewer');
  });

  it('nobody assigned: the creator is the author, unclaimed MRs make everyone a reviewer', () => {
    expect(mrRole(p('me'), 'me')).toBe('author');
    expect(mrRole(p('me', [], ['alice']), 'me')).toBe('author');
    expect(mrRole(p('bob'), 'me')).toBe('reviewer');
  });

  it('someone else drives it and I am not reviewing — other', () => {
    expect(mrRole(p('bob', ['bob']), 'me')).toBe('other');
    expect(mrRole(p('bob', [], ['alice']), 'me')).toBe('other');
    expect(mrRole(p('me', ['alice']), 'me')).toBe('other');
  });

  it('is case-insensitive and unknown without me', () => {
    expect(mrRole(p('Bob', [], ['ME']), 'me')).toBe('reviewer');
    expect(mrRole(p('bob'), '')).toBeUndefined();
    expect(mrRole(p('bob'), undefined)).toBeUndefined();
  });
});

describe('parseMrUrl', () => {
  it('reads GitLab MRs and GitHub PRs', () => {
    expect(parseMrUrl('https://gitlab.example.com/g/sub/p/-/merge_requests/749')).toEqual({
      forge: 'gitlab',
      host: 'gitlab.example.com',
      project: 'g/sub/p',
      iid: 749,
    });
    expect(parseMrUrl('https://GitHub.com/o/r/pull/12/files')).toEqual({
      forge: 'github',
      host: 'github.com',
      project: 'o/r',
      iid: 12,
    });
    expect(parseMrUrl('!12')).toBeUndefined();
  });
});

describe('createMrPeopleCache', () => {
  const url = 'https://gitlab.example.com/g/p/-/merge_requests/7';
  const make = (over: Partial<Parameters<typeof createMrPeopleCache>[0]> = {}) => {
    const fetchOne = vi.fn(async () => ({ author: 'bob', assignees: [], reviewers: ['me'] }));
    const fetchMe = vi.fn(async () => 'me');
    const cache = createMrPeopleCache({ forge: 'gitlab', knownMe: () => undefined, fetchOne, fetchMe, ...over });
    return { cache, fetchOne, fetchMe };
  };

  it('serves filled entries without fetching and computes the role', async () => {
    const { cache, fetchOne } = make({ knownMe: () => 'me' });
    cache.fill(url, { author: 'me', assignees: [], reviewers: [] });
    expect(cache.peek(url)?.role).toBe('author');
    expect((await cache.resolve(url))?.role).toBe('author');
    expect(fetchOne).not.toHaveBeenCalled();
  });

  it('fetches a miss once, even for concurrent callers, and notifies', async () => {
    const { cache, fetchOne, fetchMe } = make();
    const listener = vi.fn();
    cache.subscribe(listener);
    const [a, b] = await Promise.all([cache.resolve(url), cache.resolve(url)]);
    expect(a?.role).toBe('reviewer');
    expect(b?.role).toBe('reviewer');
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    expect(cache.peek(url)?.me).toBe('me');
  });

  it('remembers a failed fetch instead of retrying on every call', async () => {
    const fetchOne = vi.fn(async () => {
      throw new Error('offline');
    });
    const { cache } = make({ fetchOne });
    expect(await cache.resolve(url)).toBeUndefined();
    expect(await cache.resolve(url)).toBeUndefined();
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('only handles URLs of its own forge', () => {
    const { cache } = make();
    expect(cache.handles(url)).toBe(true);
    expect(cache.handles('https://github.com/o/r/pull/1')).toBe(false);
  });
});
