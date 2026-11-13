import { describe, expect, it } from 'vitest';
import { normalizeHostInput, suggestForgeHost } from './forgeSetup';
import type { ShellSession } from '../../types';

const session = (id: string, remote?: string) =>
  ({ id, repo: remote ? { remote } : undefined }) as unknown as Pick<ShellSession, 'id' | 'repo'>;

describe('suggestForgeHost', () => {
  it('offers a self-hosted GitLab remote, the selected session first', () => {
    const sessions = [
      session('a', 'git@gitlab.one.example:group/repo.git'),
      session('b', 'https://git.two.example/group/repo.git'),
    ];
    expect(suggestForgeHost('gitlab', sessions)).toBe('gitlab.one.example');
    expect(suggestForgeHost('gitlab', sessions, 'b')).toBe('git.two.example');
  });

  it('never suggests the public default or a remote of the other forge', () => {
    expect(suggestForgeHost('gitlab', [session('a', 'git@gitlab.com:group/repo.git')])).toBeUndefined();
    expect(suggestForgeHost('gitlab', [session('a', 'git@github.com:owner/repo.git')])).toBeUndefined();
    expect(suggestForgeHost('github', [session('a', 'git@github.com:owner/repo.git')])).toBeUndefined();
    expect(suggestForgeHost('gitlab', [session('a')])).toBeUndefined();
  });

  it('suggests a GitHub Enterprise host only when the name says so', () => {
    expect(suggestForgeHost('github', [session('a', 'git@github.acme.example:owner/repo.git')])).toBe(
      'github.acme.example',
    );
    // An unknown host could be anything — for GitHub that is not enough.
    expect(suggestForgeHost('github', [session('a', 'git@git.acme.example:owner/repo.git')])).toBeUndefined();
  });
});

describe('normalizeHostInput', () => {
  it('reduces a pasted URL to its host', () => {
    expect(normalizeHostInput(' https://GitLab.Example.com/group/project ')).toBe('gitlab.example.com');
    expect(normalizeHostInput('gitlab.example.com')).toBe('gitlab.example.com');
    expect(normalizeHostInput('')).toBe('');
  });
});
