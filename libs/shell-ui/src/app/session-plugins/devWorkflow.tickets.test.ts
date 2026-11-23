import { describe, expect, it } from 'vitest';
import { parseWorkflows, ticketDrift, ticketRange } from './devWorkflow';

const [def] = parseWorkflows({
  workflows: {
    development: {
      start: 'triage',
      states: ['triage', 'adr', 'adr-review', 'plan', 'plan-review', 'implement', 'impl-review', 'done'],
      tickets: {
        'status-map': {
          Open: 'triage',
          Selected: 'triage',
          Reopened: 'triage',
          'In Progress': 'adr',
          Reviewed: 'done',
          'pre-integration QA': 'done',
          Closed: 'done',
          Bogus: 'no-such-state',
        },
      },
    },
    plain: { states: ['a', 'b'] },
  },
});

describe('tickets link', () => {
  it('parses defaults and keeps status names verbatim (case-insensitive)', () => {
    expect(def.tickets?.source).toBe('jira');
    expect(def.tickets?.var).toBe('ticket');
    expect(def.tickets?.statusMap['pre-integration qa']).toBe('done');
    expect(def.tickets?.statusMap.bogus).toBeUndefined();
    expect(parseWorkflows({ workflows: { plain: { states: ['a'] } } })[0].tickets).toBeUndefined();
  });

  it('a mapped status covers its entry state up to the next mapped entry', () => {
    expect(ticketRange(def, 'In Progress', 'indeterminate')?.states).toEqual([
      'adr', 'adr-review', 'plan', 'plan-review', 'implement', 'impl-review',
    ]);
    expect(ticketRange(def, 'open', 'new')).toEqual({ entry: 'triage', states: ['triage'] });
    expect(ticketRange(def, 'Closed', 'done')).toEqual({ entry: 'done', states: ['done'] });
  });

  it('unmapped statuses fall back to the status category', () => {
    expect(ticketRange(def, 'In QA', 'indeterminate')?.states).toEqual([
      'adr', 'adr-review', 'plan', 'plan-review', 'implement', 'impl-review',
    ]);
    expect(ticketRange(def, 'Resolved', 'done')?.states).toEqual(['done']);
    expect(ticketRange(def, 'Whatever', undefined)).toBeUndefined();
  });

  it('flags drift only outside the range', () => {
    expect(ticketDrift(def, 'plan-review', 'In Progress', 'indeterminate')).toBeUndefined();
    expect(ticketDrift(def, 'implement', 'Closed', 'done')).toBe(
      "Ticket is 'Closed' — that covers done, the session is in implement",
    );
    expect(ticketDrift(def, 'triage', 'In Progress', 'indeterminate')).toMatch(/covers adr…impl-review/);
    expect(ticketDrift(def, 'implement', undefined, undefined)).toBeUndefined();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backlogTickets, parseWorkflowTickets, ticketWorktreeScript } from './devWorkflow';

describe('backlog', () => {
  const ticket = (key: string) => ({ key, summary: '', status: 'Open', statusCategory: 'new', url: '' });

  it('parses the query', () => {
    expect(parseWorkflowTickets({ query: ' assignee = currentUser() ' }, ['a'])?.query).toBe(
      'assignee = currentUser()',
    );
    expect(parseWorkflowTickets({}, ['a'])?.query).toBeUndefined();
  });

  it('drops tickets a session of this workflow is bound to', () => {
    const out = backlogTickets(def, [ticket('AIACC-1'), ticket('AIACC-2'), ticket('AIACC-3')], {
      s1: { workflow: 'development', state: 'adr', updatedAt: 0, vars: { ticket: 'aiacc-1' } },
      s2: { workflow: 'other', state: 'x', updatedAt: 0, vars: { ticket: 'AIACC-2' } },
    });
    expect(out.map((t) => t.key)).toEqual(['AIACC-2', 'AIACC-3']);
  });
});

describe('ticketWorktreeScript', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

  it('creates the worktree off the default branch, then reuses it', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'axn-ticket-'));
    const origin = path.join(base, 'origin');
    const repo = path.join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    execFileSync('git', ['clone', '-q', origin, repo]);
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'local');
    const dir = path.join(base, 'worktrees', 'repo-AIACC-7');
    const script = ticketWorktreeScript(repo, dir, 'wt/AIACC-7');
    execFileSync('/bin/sh', ['-c', script]);
    expect(existsSync(dir)).toBe(true);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/AIACC-7');
    // Branched off origin/main, not the checkout's own HEAD.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/main'));
    execFileSync('/bin/sh', ['-c', script]); // second start: reuse, no error
  });

  it('keeps a hostile branch name out of the shell', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'axn-ticket-'));
    const repo = path.join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const branch = 'wt/x$(touch${IFS}pwned)';
    const dir = path.join(base, 'worktrees', 'repo-x');
    execFileSync('/bin/sh', ['-c', ticketWorktreeScript(repo, dir, branch)], { cwd: base });
    expect(existsSync(path.join(base, 'pwned'))).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
  });
});
