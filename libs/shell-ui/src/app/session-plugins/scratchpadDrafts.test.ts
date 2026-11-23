import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupeEntries,
  filterEntries,
  groupByRepo,
  olderThan,
  repoNames,
  trashScript,
  type DraftEntry,
} from './scratchpadDrafts';
import { relativeAgo } from './relativeTime';

const e = (repo: string, name: string, modifiedAt?: number, extra: Partial<DraftEntry> = {}): DraftEntry => ({
  repo,
  dir: '.local-drafts',
  inRepo: true,
  name,
  path: `/x/${repo}/${name}`,
  modifiedAt,
  sessionId: 's',
  ...extra,
});

describe('groupByRepo', () => {
  it('sorts repos by name and drafts newest first, unknown age last', () => {
    const groups = groupByRepo([
      e('mls', 'b.md', 10),
      e('ai-accelerator', 'old.md', 1),
      e('ai-accelerator', 'unknown.md'),
      e('ai-accelerator', 'new.md', 99),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(['ai-accelerator', 'mls']);
    expect(groups[0].entries.map((x) => x.name)).toEqual(['new.md', 'old.md', 'unknown.md']);
  });
});

describe('filterEntries / repoNames / dedupeEntries', () => {
  const all = [e('ai-accelerator', 'AIACC-757-notes.md', 1), e('mls', 'plan.md', 2)];
  it('filters by text and repo', () => {
    expect(filterEntries(all, 'aiacc', null).map((x) => x.name)).toEqual(['AIACC-757-notes.md']);
    expect(filterEntries(all, '', 'mls').map((x) => x.name)).toEqual(['plan.md']);
    expect(filterEntries(all, 'plan', 'ai-accelerator')).toEqual([]);
  });
  it('lists repos once, sorted', () => {
    expect(repoNames([...all, e('mls', 'x.md')])).toEqual(['ai-accelerator', 'mls']);
  });
  it('keeps one entry per path', () => {
    expect(dedupeEntries([all[0], { ...all[0], sessionId: 'other' }, all[1]])).toHaveLength(2);
  });
});

describe('olderThan', () => {
  it('picks only drafts with a known age beyond the limit', () => {
    const now = 1_000_000;
    const picked = olderThan([e('r', 'old', now - 5000), e('r', 'new', now - 10), e('r', 'unknown')], 1000, now);
    expect(picked.map((x) => x.name)).toEqual(['old']);
  });
});

describe('trashScript', () => {
  it('moves files to the trash folder, suffixing a taken name, and prints the count', () => {
    const home = mkdtempSync(join(tmpdir(), 'axn-trash-'));
    const src = mkdtempSync(join(tmpdir(), 'axn-src-'));
    writeFileSync(join(src, 'a b.md'), 'x');
    writeFileSync(join(src, 'c.md'), 'y');
    const trash = process.platform === 'darwin' ? join(home, '.Trash') : join(home, 'Trash', 'files');
    mkdirSync(trash, { recursive: true });
    writeFileSync(join(trash, 'c.md'), 'already there');
    // A PATH with only the plain tools: no trash/osascript/gio, so the test
    // never touches the real trash or Finder.
    const bin = mkdtempSync(join(tmpdir(), 'axn-bin-'));
    for (const tool of ['uname', 'mkdir', 'basename', 'mv', 'date']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(bin, tool));
    }
    const run = spawnSync('/bin/sh', ['-c', trashScript([join(src, 'a b.md'), join(src, 'c.md'), join(src, 'missing.md')])], {
      env: { PATH: bin, HOME: home, XDG_DATA_HOME: join(home) },
      encoding: 'utf8',
    });
    expect(run.stdout.trim()).toBe('2');
    expect(existsSync(join(src, 'a b.md'))).toBe(false);
    const names = readdirSync(trash);
    expect(names).toContain('a b.md');
    expect(names.filter((n) => n.startsWith('c.md'))).toHaveLength(2);
  });
});

describe('trashScript order', () => {
  it('prefers the trash CLI, then Finder, then gio, before a plain move', () => {
    const script = trashScript(['/a']);
    const at = (needle: string) => script.indexOf(needle);
    expect(at('command -v trash')).toBeGreaterThan(-1);
    expect(at('command -v trash')).toBeLessThan(at('osascript'));
    expect(at('osascript')).toBeLessThan(at('gio trash'));
    expect(at('gio trash')).toBeLessThan(at('mv --'));
  });
});

describe('relativeAgo', () => {
  it('formats minutes, hours and days; accepts ISO or epoch ms', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(relativeAgo('2026-11-23T11:59:40Z', now)).toBe('just now');
    expect(relativeAgo(now - 45 * 60_000, now)).toBe('45m ago');
    expect(relativeAgo('2026-11-23T07:00:00Z', now)).toBe('5h ago');
    expect(relativeAgo('2026-11-18T12:00:00Z', now)).toBe('5d ago');
    expect(relativeAgo('nope', now)).toBeNull();
  });
});
