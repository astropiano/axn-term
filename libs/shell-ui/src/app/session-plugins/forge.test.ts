import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  classifyCliError,
  cliMissingMarker,
  forgeCliCommand,
  forgeOfRemote,
  forgeRailMode,
  parseRemote,
  remoteOwner,
} from './forge';

describe('parseRemote / remoteOwner', () => {
  it('parses https, ssh and scp-like remotes', () => {
    expect(parseRemote('https://github.com/BurntSushi/ripgrep.git')).toEqual({
      host: 'github.com',
      path: 'BurntSushi/ripgrep',
    });
    expect(parseRemote('git@github.com:junegunn/fzf.git')).toEqual({
      host: 'github.com',
      path: 'junegunn/fzf',
    });
    expect(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/proj.git')).toEqual({
      host: 'gitlab.example.com',
      path: 'group/sub/proj',
    });
    expect(parseRemote('https://user:token@GitHub.com/a/b/')).toEqual({ host: 'github.com', path: 'a/b' });
  });

  it('rejects local paths and empty values', () => {
    expect(parseRemote('/srv/git/repo.git')).toBeUndefined();
    expect(parseRemote('../sibling')).toBeUndefined();
    expect(parseRemote('')).toBeUndefined();
    expect(parseRemote(undefined)).toBeUndefined();
  });

  it('takes the owner from the first path segment, lowercased', () => {
    expect(remoteOwner('git@github.com:BurntSushi/ripgrep.git')).toBe('burntsushi');
    expect(remoteOwner('/local/path')).toBeUndefined();
  });
});

describe('forgeOfRemote', () => {
  it('recognizes github and gitlab hosts', () => {
    expect(forgeOfRemote('git@github.com:a/b.git')).toBe('github');
    expect(forgeOfRemote('https://gitlab.com/g/p.git')).toBe('gitlab');
    expect(forgeOfRemote('git@gitlab.company.net:g/p.git')).toBe('gitlab');
  });

  it('honours a configured hostname (GHES / self-hosted GitLab)', () => {
    expect(forgeOfRemote('git@code.acme.io:a/b.git')).toBeUndefined();
    expect(forgeOfRemote('git@code.acme.io:a/b.git', { github: 'code.acme.io' })).toBe('github');
    expect(forgeOfRemote('https://git.acme.io/g/p', { gitlab: 'GIT.ACME.IO' })).toBe('gitlab');
  });

  it('is undefined for unknown or missing remotes', () => {
    expect(forgeOfRemote('https://bitbucket.org/a/b.git')).toBeUndefined();
    expect(forgeOfRemote(undefined)).toBeUndefined();
  });
});

describe('classifyCliError', () => {
  // Messages captured from real runs (gh 2.x / glab 1.x, bash and dash).
  it('detects a missing CLI', () => {
    expect(classifyCliError('gh', cliMissingMarker('gh'))).toBe('missing');
    expect(classifyCliError('gh', 'sh: line 1: gh: command not found')).toBe('missing');
    expect(classifyCliError('glab', 'sh: 1: glab: not found')).toBe('missing');
  });

  it('detects a signed-out CLI', () => {
    expect(
      classifyCliError(
        'gh',
        'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
      ),
    ).toBe('signed-out');
    expect(classifyCliError('glab', '{"errors":[{"message":"Invalid token"}]}glab: Invalid token')).toBe(
      'signed-out',
    );
    expect(classifyCliError('glab', 'no currentUser — run `glab auth login`')).toBe('signed-out');
  });

  it('keeps everything else an error', () => {
    expect(
      classifyCliError('gh', 'gh: This query requests up to 620,640 possible nodes which exceeds the maximum limit of 500,000.'),
    ).toBe('error');
    expect(classifyCliError('glab', 'glab: 404 Not Found')).toBe('error');
    expect(classifyCliError('gh', 'error connecting to api.github.com')).toBe('error');
  });

  it("does not mistake one CLI's marker for the other's", () => {
    expect(classifyCliError('gh', cliMissingMarker('glab'))).toBe('error');
  });
});

describe('forgeCliCommand', () => {
  it('fails with the missing marker through a real sh when the CLI is absent', () => {
    const res = spawnSync('/bin/sh', ['-c', forgeCliCommand('gh', 'api graphql')], {
      env: { PATH: '/nonexistent' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(127);
    expect(classifyCliError('gh', res.stderr.trim())).toBe('missing');
  });

  it('runs the CLI when present', () => {
    const res = spawnSync('/bin/sh', ['-c', forgeCliCommand('glab' as const, 'x').replace(/glab/g, 'echo')], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('x');
  });
});

describe('forgeRailMode', () => {
  it('hides the rail without the CLI and before the first result', () => {
    expect(forgeRailMode({ failure: 'missing' })).toBe('hidden');
    expect(forgeRailMode({})).toBe('hidden');
  });

  it('shows a muted sign-in hint, a red error, or the counters', () => {
    expect(forgeRailMode({ failure: 'signed-out' })).toBe('signed-out');
    expect(forgeRailMode({ failure: 'error', fetchedAt: 1 })).toBe('error');
    expect(forgeRailMode({ fetchedAt: 1 })).toBe('counts');
  });
});
