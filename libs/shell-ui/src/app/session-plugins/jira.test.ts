import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYCHAIN_SERVICE,
  buildRequestScript,
  findIssueKey,
  issueEnrichment,
  jiraConfig,
  matchSubject,
  parseBulkFetch,
  parseProjectKeys,
  splitStatus,
  type JiraConfig,
} from './jira';

const base = {
  enabled: true,
  baseUrl: 'https://example.atlassian.net/',
  email: 'me@example.com',
  projectKeys: 'AIACC, mgnl',
};

describe('parseProjectKeys', () => {
  it('accepts comma/space lists and YAML lists, uppercases, dedupes', () => {
    expect(parseProjectKeys('AIACC, mgnl;AIACC  VECTORDB')).toEqual(['AIACC', 'MGNL', 'VECTORDB']);
    expect(parseProjectKeys(['aiacc', 'MGNL'])).toEqual(['AIACC', 'MGNL']);
    expect(parseProjectKeys('1BAD, A')).toEqual([]);
  });
});

describe('jiraConfig', () => {
  it('is inactive unless enabled', () => {
    expect(jiraConfig({ ...base, enabled: false, token: 't' })).toEqual({ ok: false, reason: 'disabled' });
    expect(jiraConfig(undefined).ok).toBe(false);
  });

  it('takes a literal token', () => {
    const r = jiraConfig({ ...base, token: 'abc' });
    expect(r.ok && r.config).toEqual({
      baseUrl: 'https://example.atlassian.net',
      email: 'me@example.com',
      projectKeys: ['AIACC', 'MGNL'],
      auth: { kind: 'token', value: 'abc' },
      statusColors: {},
    });
  });

  it('reads the keychain with service/account defaults', () => {
    const r = jiraConfig({ ...base, tokenFrom: 'keychain' });
    expect(r.ok && r.config.auth).toEqual({
      kind: 'keychain',
      service: DEFAULT_KEYCHAIN_SERVICE,
      account: 'me@example.com',
    });
    const custom = jiraConfig({ ...base, tokenFrom: 'keychain', keychainService: 'jira', keychainAccount: 'x' });
    expect(custom.ok && custom.config.auth).toEqual({ kind: 'keychain', service: 'jira', account: 'x' });
  });

  it('refuses ambiguous or missing credentials and bad settings', () => {
    expect(jiraConfig({ ...base, token: 't', tokenFrom: 'keychain' })).toEqual({
      ok: false,
      reason: 'set either token or token-from, not both',
    });
    expect(jiraConfig({ ...base }).ok).toBe(false);
    expect(jiraConfig({ ...base, tokenFrom: 'vault' }).ok).toBe(false);
    expect(jiraConfig({ ...base, token: 't', baseUrl: 'http://x' }).ok).toBe(false);
    expect(jiraConfig({ ...base, token: 't', projectKeys: '' }).ok).toBe(false);
  });
});

describe('findIssueKey', () => {
  const keys = ['AIACC', 'MGNL'];
  it('finds keys of configured projects in titles and branch names', () => {
    expect(findIssueKey('feat(rest): AIACC-717 embeddings endpoint', keys)).toBe('AIACC-717');
    expect(findIssueKey('feature/aiacc-42_vector-store', keys)).toBe('AIACC-42');
    expect(findIssueKey('MGNL-1234-ai-accelerator', keys)).toBe('MGNL-1234');
  });
  it('ignores other projects and glued words', () => {
    expect(findIssueKey('Fix UTF-8 handling', keys)).toBeUndefined();
    expect(findIssueKey('XAIACC-1', keys)).toBeUndefined();
    expect(findIssueKey(undefined, keys)).toBeUndefined();
    expect(findIssueKey('AIACC-1', [])).toBeUndefined();
  });
});

describe('matchSubject', () => {
  const keys = ['AIACC'];
  it('prefers the MR title, then branch, then vars, then the session', () => {
    expect(matchSubject({ mr: { title: 'AIACC-1 x', sourceBranch: 'AIACC-2', url: '' } }, keys)).toBe('AIACC-1');
    expect(matchSubject({ mr: { title: 'no key', sourceBranch: 'AIACC-2-x', url: '' } }, keys)).toBe('AIACC-2');
    expect(matchSubject({ vars: { ticket: 'AIACC-3' }, session: { name: 'AIACC-4' } }, keys)).toBe('AIACC-3');
    expect(matchSubject({ session: { cwd: '/w/worktrees/AIACC-5-repo' } }, keys)).toBe('AIACC-5');
    expect(matchSubject({ mr: { title: 'plain', url: '' } }, keys)).toBeUndefined();
  });
});

describe('splitStatus / parseBulkFetch', () => {
  it('splits the trailing status line', () => {
    expect(splitStatus('{"a":1}\n200\n')).toEqual({ status: 200, body: '{"a":1}' });
    expect(splitStatus('\n401')).toEqual({ status: 401, body: '' });
    expect(splitStatus('garbage')).toBeUndefined();
  });

  it('maps issues to chips and fields', () => {
    const body = JSON.stringify({
      issues: [
        {
          key: 'AIACC-717',
          fields: {
            summary: 'Embeddings REST endpoint',
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            assignee: { displayName: 'Ann' },
            issuetype: { name: 'Story' },
          },
        },
      ],
      issueErrors: [{ errorMessages: ['AIACC-9 does not exist'] }],
    });
    const out = parseBulkFetch(body, 'https://example.atlassian.net');
    expect(Object.keys(out)).toEqual(['AIACC-717']);
    expect(out['AIACC-717'].chips).toEqual([
      {
        label: 'AIACC-717 · In Progress',
        tip: 'Embeddings REST endpoint\nStory · Ann',
        href: 'https://example.atlassian.net/browse/AIACC-717',
        tone: 'progress',
      },
    ]);
    expect(out['AIACC-717'].fields?.['jira.status']).toBe('In Progress');
  });

  it('labels unassigned issues', () => {
    const e = issueEnrichment({ key: 'A-1', fields: { assignee: null } }, 'https://x');
    expect(e.chips?.[0].tip).toBe('Unassigned');
    expect(e.chips?.[0].tone).toBe('neutral');
  });
});

describe('buildRequestScript', () => {
  // Run the script with a fake `curl` that records its argv and stdin.
  function run(config: JiraConfig, body: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'axn-jira-'));
    const fake = path.join(dir, 'curl');
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\nprintf '{"issues":[]}\\n200'\n`,
    );
    chmodSync(fake, 0o755);
    const stdout = execFileSync('/bin/sh', ['-c', buildRequestScript(config, '/rest/api/3/issue/bulkfetch', body)], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    return {
      stdout,
      argv: readFileSync(path.join(dir, 'argv'), 'utf8'),
      stdin: readFileSync(path.join(dir, 'stdin'), 'utf8'),
    };
  }

  const config: JiraConfig = {
    baseUrl: 'https://example.atlassian.net',
    email: 'me@example.com',
    projectKeys: ['AIACC'],
    auth: { kind: 'token', value: 'to"k$en`\\x' },
    statusColors: {},
  };

  it('hands curl its config on stdin, token escaped and never in argv', () => {
    const r = run(config, '{"issueIdsOrKeys":["AIACC-1"],"fields":["summary"]}');
    expect(r.argv.trim().split('\n')).toEqual(['-K', '-']);
    expect(r.stdin).toContain('url = "https://example.atlassian.net/rest/api/3/issue/bulkfetch"');
    expect(r.stdin).toContain('user = "me@example.com:to\\"k$en`\\\\x"');
    expect(r.stdin).toContain('data-raw = "{\\"issueIdsOrKeys\\":[\\"AIACC-1\\"],\\"fields\\":[\\"summary\\"]}"');
    expect(r.stdin).toContain('write-out = "\\n%{http_code}"');
    expect(splitStatus(r.stdout)).toEqual({ status: 200, body: '{"issues":[]}' });
  });

  it('fails clearly when the keychain has no entry', () => {
    const script = buildRequestScript(
      { ...config, auth: { kind: 'keychain', service: 'nope-svc', account: 'nobody' } },
      '/rest/x',
      '{}',
    );
    // An empty PATH: neither `security` nor `secret-tool` resolves.
    expect(() =>
      execFileSync('/bin/sh', ['-c', script], { env: { PATH: '/nonexistent' }, stdio: 'pipe' }),
    ).toThrow(/no keychain entry for service nope-svc, account nobody/);
  });
});

import { parseSearch } from './jira';

describe('parseSearch', () => {
  it('maps search issues to tickets', () => {
    const tickets = parseSearch(
      {
        issues: [
          {
            key: 'aiacc-9',
            fields: {
              summary: 'S',
              status: { name: 'Selected', statusCategory: { key: 'new' } },
              assignee: null,
              issuetype: { name: 'Bug' },
            },
          },
        ],
      },
      'https://x.atlassian.net',
    );
    expect(tickets).toEqual([
      {
        key: 'AIACC-9',
        summary: 'S',
        status: 'Selected',
        statusCategory: 'new',
        url: 'https://x.atlassian.net/browse/aiacc-9',
        assignee: undefined,
        type: 'Bug',
        color: 'gray',
      },
    ]);
    expect(parseSearch({}, 'https://x')).toEqual([]);
  });
});

import { findIssueKeys, sessionMrTitles, sessionTicketKeys } from './jira';

describe('session tickets', () => {
  const keys = ['AIACC', 'MGNL'];
  it('finds every distinct key in order', () => {
    expect(findIssueKeys('AIACC-1 and mgnl-2, again AIACC-1; AIACC-10', keys)).toEqual([
      'AIACC-1', 'MGNL-2', 'AIACC-10',
    ]);
    expect(findIssueKeys('UTF-8', keys)).toEqual([]);
  });

  it('tries MR titles, then branch, then name — first source with keys wins', () => {
    const name = 'AIACC-9 notes';
    expect(sessionTicketKeys({ mrTitles: ['fix(AIACC-755): x', 'feat(AIACC-891): y'], branch: 'AIACC-1-z', name }, keys))
      .toEqual(['AIACC-755', 'AIACC-891']);
    expect(sessionTicketKeys({ mrTitles: ['chore: release'], branch: 'feature/aiacc-42-x', name }, keys)).toEqual(['AIACC-42']);
    expect(sessionTicketKeys({ mrTitles: [], branch: 'main', name }, keys)).toEqual(['AIACC-9']);
    expect(sessionTicketKeys({ mrTitles: [], branch: null }, keys)).toEqual([]);
  });

  it('reads MR/PR titles from the forge plugins state', () => {
    expect(
      sessionMrTitles({
        'glab-mr': { mrs: [{ title: 'a' }, { title: 7 }, null] },
        'gh-pr': { prs: [{ title: 'b' }] },
        other: { mrs: [{ title: 'c' }] },
      }),
    ).toEqual(['a', 'b']);
    expect(sessionMrTitles(undefined)).toEqual([]);
  });

});

import { issueToTicket, parseStatusColors, statusColor } from './jira';

describe('status colors', () => {
  it('parses a YAML map and the one-line settings form, dropping bad colors', () => {
    expect(parseStatusColors({ 'In Progress': 'Blue', Reviewed: '#8E44AD', Bad: 'url(x)', Num: 3 })).toEqual({
      'in progress': 'blue',
      reviewed: '#8e44ad',
    });
    expect(parseStatusColors('In Progress: blue; Reviewed=#8e44ad\nindeterminate: orange; junk')).toEqual({
      'in progress': 'blue',
      reviewed: '#8e44ad',
      indeterminate: 'orange',
    });
    expect(parseStatusColors(undefined)).toEqual({});
    expect(parseStatusColors('Open: #12345')).toEqual({}); // 5 hex digits: invalid
  });

  it('prefers the exact status over its category', () => {
    const colors = { 'in progress': 'blue', indeterminate: 'orange' };
    expect(statusColor(colors, 'In Progress', 'indeterminate')).toBe('blue');
    expect(statusColor(colors, 'Reviewed', 'indeterminate')).toBe('orange');
    expect(statusColor(colors, 'Open', 'new')).toBeUndefined();
  });

  it('colors chips and tickets, falling back to the category color', () => {
    const issue = (name: string, cat: string) => ({
      key: 'A-1',
      fields: { status: { name, statusCategory: { key: cat } } },
    });
    const colors = { reviewed: '#8e44ad' };
    expect(issueEnrichment(issue('Reviewed', 'indeterminate'), 'https://x', colors).chips?.[0].color).toBe('#8e44ad');
    expect(issueEnrichment(issue('In Progress', 'indeterminate'), 'https://x', colors).chips?.[0]).toMatchObject({
      tone: 'progress',
      color: undefined,
    });
    expect(issueToTicket(issue('Reviewed', 'indeterminate'), 'https://x', colors).color).toBe('#8e44ad');
    expect(issueToTicket(issue('Closed', 'done'), 'https://x').color).toBe('green');
  });

  it('reads status-colors from the plugin section', () => {
    const r = jiraConfig({ ...base, token: 't', statusColors: 'Open: red' });
    expect(r.ok && r.config.statusColors).toEqual({ open: 'red' });
  });
});

describe('session ticket sources', () => {
  it('falls back to the cwd folder name last', () => {
    const keys = ['AIACC', 'VECTORDB'];
    expect(
      sessionTicketKeys(
        { mrTitles: [], branch: 'main', name: 'shell', cwd: '/w/worktrees/VECTORDB-29-provider-outage-resilience' },
        keys,
      ),
    ).toEqual(['VECTORDB-29']);
    // an earlier source still wins
    expect(sessionTicketKeys({ mrTitles: [], branch: 'AIACC-1-x', cwd: '/w/VECTORDB-29-y' }, keys)).toEqual(['AIACC-1']);
  });
});
