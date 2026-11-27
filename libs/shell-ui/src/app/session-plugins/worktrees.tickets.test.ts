import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TargetActionContext, TicketTarget } from '../textTargets';
import type { ShellSession } from '../../types';
import {
  findTicketWorktree,
  prepareTicketWorktree,
  ticketNameAgentCmd,
  ticketSlug,
  ticketWorktreeName,
  worktreesPlugin,
} from './worktrees';

vi.mock('../pickerHost', () => ({ pickFromList: vi.fn(async () => null) }));

describe('ticket worktree names', () => {
  it('slugs the summary, cut at a word boundary', () => {
    expect(ticketSlug('Embeddings: REST endpoint (v2)')).toBe('embeddings-rest-endpoint-v2');
    expect(ticketSlug('Support the very long summary that keeps on going and going')).toBe(
      'support-the-very-long-summary-that-keeps',
    );
    expect(ticketSlug('v1.2_release')).toBe('v1-2-release');
    expect(ticketSlug('!!!')).toBe('');
    expect(ticketSlug(undefined)).toBe('');
  });

  it('is <KEY>-<slug>, or the bare key', () => {
    expect(ticketWorktreeName('aiacc-7', 'Fix the thing')).toBe('AIACC-7-fix-the-thing');
    expect(ticketWorktreeName('AIACC-7')).toBe('AIACC-7');
  });

  it('quotes the ticket summary into one prompt word', () => {
    expect(ticketNameAgentCmd('claude --model haiku', 'AIACC-7', "it's $(rm -rf /)")).toBe(
      `claude --model haiku -p 'reply with only a short kebab-case git branch slug (max 5 words) for ticket AIACC-7: it'\\''s $(rm -rf /)'`,
    );
  });
});

describe('findTicketWorktree', () => {
  const porcelain = [
    'worktree /g/repo\nHEAD 1\nbranch refs/heads/main',
    'worktree /g/worktrees/repo-AIACC-70\nHEAD 2\nbranch refs/heads/wt/AIACC-70',
    'worktree /g/worktrees/repo-wt-aiacc-7-old\nHEAD 3\nbranch refs/heads/wt/aiacc-7-old',
    'worktree /g/worktrees/repo-other\nHEAD 4\nbranch refs/heads/feat/AIACC-8-x',
  ].join('\n\n');

  it('matches the key in the folder or branch, not a longer number', () => {
    expect(findTicketWorktree(porcelain, 'AIACC-7')).toEqual({
      path: '/g/worktrees/repo-wt-aiacc-7-old',
      branch: 'wt/aiacc-7-old',
    });
    expect(findTicketWorktree(porcelain, 'AIACC-8')?.path).toBe('/g/worktrees/repo-other');
    expect(findTicketWorktree(porcelain, 'AIACC-9')).toBeUndefined();
  });

  it('never returns the main checkout', () => {
    expect(findTicketWorktree('worktree /g/AIACC-1\nbranch refs/heads/main', 'AIACC-1')).toBeUndefined();
  });
});

describe('prepareTicketWorktree', () => {
  const host = (replies: Record<string, string | Error>) => {
    const calls: string[] = [];
    return {
      calls,
      exec: async (command: string) => {
        calls.push(command);
        for (const [needle, reply] of Object.entries(replies)) {
          if (command.includes(needle)) {
            if (reply instanceof Error) throw reply;
            return reply;
          }
        }
        return '';
      },
    };
  };

  it('reuses an existing worktree of the ticket', async () => {
    const h = host({
      'worktree list': 'worktree /g/repo\n\nworktree /g/worktrees/repo-AIACC-7\nbranch refs/heads/wt/AIACC-7\n',
    });
    await expect(prepareTicketWorktree(h, '/g/repo', { key: 'AIACC-7', summary: 'x' })).resolves.toEqual({
      dir: '/g/worktrees/repo-AIACC-7',
      branch: 'wt/AIACC-7',
      reused: true,
    });
    expect(h.calls.some((c) => c.includes('worktree add'))).toBe(false);
  });

  it('creates <repo>-<KEY>-<slug> on wt/<KEY>-<slug>', async () => {
    const h = host({});
    const out = await prepareTicketWorktree(
      h,
      '/g/repo',
      { key: 'AIACC-7', summary: 'Fix the thing' },
      { worktreeRoot: '/w' },
    );
    expect(out).toEqual({ dir: '/w/repo-AIACC-7-fix-the-thing', branch: 'wt/AIACC-7-fix-the-thing', reused: false });
    expect(h.calls.some((c) => c.includes("worktree add -b 'wt/AIACC-7-fix-the-thing' '/w/repo-AIACC-7-fix-the-thing'"))).toBe(true);
  });

  it("takes the name agent's slug, falling back to the summary when it fails", async () => {
    const ok = host({ ' -p ': 'rest-endpoint\nextra chatter' });
    expect((await prepareTicketWorktree(ok, '/g/repo', { key: 'A-1', summary: 'Long summary' }, { nameAgent: 'claude' })).dir).toBe(
      '/g/worktrees/repo-A-1-rest-endpoint',
    );
    const bad = host({ ' -p ': new Error('no agent') });
    expect((await prepareTicketWorktree(bad, '/g/repo', { key: 'A-1', summary: 'Long summary' }, { nameAgent: 'claude' })).dir).toBe(
      '/g/worktrees/repo-A-1-long-summary',
    );
  });

  it('really creates and then reuses the worktree (git)', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'axn-ticket-wt-')));
    const origin = path.join(base, 'origin');
    const repo = path.join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    execFileSync('git', ['clone', '-q', origin, repo]);
    const real = {
      exec: async (command: string, cwd?: string) =>
        execFileSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(),
    };
    const first = await prepareTicketWorktree(real, repo, { key: 'AIACC-7', summary: 'Do it' });
    expect(first.reused).toBe(false);
    expect(first.dir).toBe(path.join(base, 'worktrees', 'repo-AIACC-7-do-it'));
    expect(existsSync(first.dir)).toBe(true);
    expect(git(first.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/AIACC-7-do-it');
    // A later start — even with another summary — lands on the same worktree.
    const again = await prepareTicketWorktree(real, repo, { key: 'aiacc-7', summary: 'Renamed' });
    expect(again).toMatchObject({ reused: true, branch: 'wt/AIACC-7-do-it' });
    expect(again.dir).toBe(first.dir);
  });
});

describe('Start worktree action', () => {
  const target: TicketTarget = { kind: 'ticket', key: 'AIACC-7', source: 'jira', summary: 'Fix it' };

  function tctx(over: Partial<TargetActionContext> = {}) {
    const calls: string[] = [];
    const opened: Array<{ cwd?: string; name?: string }> = [];
    const banners: unknown[] = [];
    const session = { id: 's1', cwd: '/g/repo', repo: { root: '/g/repo' } } as ShellSession;
    const api = {
      session,
      getSession: () => session,
      exec: async (command: string) => {
        calls.push(command);
        if (command.includes('--git-common-dir')) return '/g/repo/.git';
        return '';
      },
      openSession: (cwd?: string, name?: string) => opened.push({ cwd, name }),
      setBanner: (b: unknown) => banners.push(b),
    };
    const ctx: TargetActionContext = {
      pluginSettings: {},
      settings: {},
      originSessionId: 's1',
      api: () => api as never,
      sessions: [session],
      selectSession: vi.fn(),
      ...over,
    };
    return { ctx, calls, opened, banners };
  }

  it('offers one action on tickets only', () => {
    const { ctx } = tctx();
    expect(worktreesPlugin.targetActions!(target, ctx).map((a) => a.id)).toEqual(['start-worktree']);
  });

  it("creates the worktree in the hovered session's repo and opens a session there", async () => {
    const t = tctx();
    await worktreesPlugin.targetActions!(target, t.ctx)[0].run();
    expect(t.calls.some((c) => c.includes("worktree add -b 'wt/AIACC-7-fix-it' '/g/worktrees/repo-AIACC-7-fix-it'"))).toBe(true);
    expect(t.opened).toEqual([{ cwd: '/g/worktrees/repo-AIACC-7-fix-it', name: 'AIACC-7 Fix it' }]);
    expect(t.banners).toEqual([]);
  });

  it('selects a session already open in the worktree', async () => {
    const t = tctx();
    const existing = { id: 's9', cwd: '/g/worktrees/repo-AIACC-7-fix-it' } as ShellSession;
    t.ctx.sessions = [...t.ctx.sessions, existing];
    await worktreesPlugin.targetActions!(target, t.ctx)[0].run();
    expect(t.ctx.selectSession).toHaveBeenCalledWith('s9');
    expect(t.opened).toEqual([]);
  });
});
