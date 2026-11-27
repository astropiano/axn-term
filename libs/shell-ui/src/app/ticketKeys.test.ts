import { describe, expect, it } from 'vitest';
import {
  extractTicketFromTitle,
  findIssueKey,
  findIssueKeys,
  issueKeyFromUrl,
  scanIssueKeys,
} from './ticketKeys';

const KEYS = ['AIACC', 'MGNL'];

describe('scanIssueKeys', () => {
  it('reports every key with its range, uppercased', () => {
    const text = 'fix aiacc-12 and MGNL-7 (see AIACC-12)';
    expect(scanIssueKeys(text, KEYS)).toEqual([
      { key: 'AIACC-12', start: 4, end: 12 },
      { key: 'MGNL-7', start: 17, end: 23 },
      { key: 'AIACC-12', start: 29, end: 37 },
    ]);
  });

  it('finds keys inside branch names but not glued to longer words or numbers', () => {
    expect(scanIssueKeys('feat/AIACC-3-foo', KEYS).map((m) => m.key)).toEqual(['AIACC-3']);
    expect(scanIssueKeys('XAIACC-1 AIACC-12345x', KEYS).map((m) => m.key)).toEqual(['AIACC-12345']);
    expect(scanIssueKeys('UTF-8', KEYS)).toEqual([]);
  });

  it('matches nothing without project keys', () => {
    expect(scanIssueKeys('AIACC-1', [])).toEqual([]);
  });
});

describe('findIssueKey(s)', () => {
  it('keeps the first key and the distinct keys in order', () => {
    expect(findIssueKey('MGNL-2 AIACC-1', KEYS)).toBe('MGNL-2');
    expect(findIssueKeys('MGNL-2 AIACC-1 mgnl-2', KEYS)).toEqual(['MGNL-2', 'AIACC-1']);
  });
});

describe('issueKeyFromUrl', () => {
  const base = 'https://example.atlassian.net';
  it('reads browse links, with or without query and fragment', () => {
    expect(issueKeyFromUrl(`${base}/browse/AIACC-717`, base, KEYS)).toBe('AIACC-717');
    expect(issueKeyFromUrl(`${base}/browse/aiacc-717?focused=1#c`, base, KEYS)).toBe('AIACC-717');
  });

  it('reads selectedIssue from board links', () => {
    expect(
      issueKeyFromUrl(`${base}/jira/software/projects/AIACC/boards/1?selectedIssue=AIACC-9`, base, KEYS),
    ).toBe('AIACC-9');
  });

  it('ignores other hosts, other projects and keys with a tail', () => {
    expect(issueKeyFromUrl('https://evil.example/browse/AIACC-1', base, KEYS)).toBeUndefined();
    expect(issueKeyFromUrl(`${base}/browse/OTHER-1`, base, KEYS)).toBeUndefined();
    expect(issueKeyFromUrl(`${base}/browse/AIACC-1x`, base, KEYS)).toBeUndefined();
    expect(issueKeyFromUrl('not a url', base, KEYS)).toBeUndefined();
  });
});

describe('extractTicketFromTitle', () => {
  it('takes the first group, else the match, uppercased', () => {
    expect(extractTicketFromTitle('[aiacc-5] thing', '\\[([a-z]+-\\d+)\\]')).toBe('AIACC-5');
    expect(extractTicketFromTitle('AIACC-5: thing', '[A-Z]+-\\d+')).toBe('AIACC-5');
  });

  it('is undefined for no match or an invalid pattern', () => {
    expect(extractTicketFromTitle('nothing', '[A-Z]+-\\d+')).toBeUndefined();
    expect(extractTicketFromTitle('AIACC-5', '(')).toBeUndefined();
  });
});
