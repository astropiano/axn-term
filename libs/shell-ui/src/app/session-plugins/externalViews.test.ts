import { beforeEach, describe, expect, it } from 'vitest';
import { externalViewsPlugin, normalizeViews, resolveEntryUrl } from './externalViews';
import { openView, resetViewHostForTests } from '../viewHost';

beforeEach(() => resetViewHostForTests());

describe('normalizeViews', () => {
  it('keeps a valid entry untouched', () => {
    const entry = { id: 'mr', title: 'MRs', url: 'http://127.0.0.1:37778/d/mr/', logo: 'GitMerge' };
    expect(normalizeViews({ views: [entry] })).toEqual({ views: [entry], dropped: [] });
  });
  it('regenerates missing, duplicate and slash-containing ids', () => {
    const { views } = normalizeViews({
      views: [
        { title: 'A', url: 'https://a.example' },
        { id: 'x', title: 'B', url: 'https://b.example' },
        { id: 'x', title: 'C', url: 'https://c.example' },
        { id: 'a/b', title: 'D', url: 'https://d.example' },
      ],
    });
    const ids = views.map((v) => v.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids[1]).toBe('x');
    for (const id of ids) expect(id).not.toContain('/');
  });
  it('drops entries without a usable URL and reports them', () => {
    const { views, dropped } = normalizeViews({
      views: [
        { id: 'js', title: 'JS', url: 'javascript:alert(1)' },
        { id: 'data', title: 'Data', url: 'data:text/html,x' },
        { id: 'rel', title: 'Rel', url: '/d/mr/' },
        { id: 'blank', title: 'Blank', url: '' },
      ],
    });
    expect(views).toEqual([]);
    expect(dropped).toEqual(['JS', 'Data', 'Rel', 'Blank']);
  });
  it('keeps a urlCommand entry without a url', () => {
    const { views } = normalizeViews({ views: [{ id: 'mr', title: 'MRs', urlCommand: 'launchpad url mr' }] });
    expect(views).toEqual([{ id: 'mr', title: 'MRs', urlCommand: 'launchpad url mr' }]);
  });
  it('tolerates a malformed section', () => {
    expect(normalizeViews(undefined)).toEqual({ views: [], dropped: [] });
    expect(normalizeViews({ views: 'nope' })).toEqual({ views: [], dropped: [] });
    expect(normalizeViews({ views: [null, 7, 'x'] }).views).toEqual([]);
  });
});

describe('railEntries', () => {
  it('lists settings entries, then runtime views flagged runtime', () => {
    openView({ url: 'http://127.0.0.1:1/x', title: 'Pushed' });
    const entries = externalViewsPlugin.railEntries!({
      pluginSettings: { views: [{ id: 'mr', title: 'MRs', url: 'https://a.example' }] },
    });
    expect(entries.map((e) => [e.title, e.runtime === true])).toEqual([
      ['MRs', false],
      ['Pushed', true],
    ]);
  });
});

describe('resolveEntryUrl', () => {
  it('uses the url when set', async () => {
    await expect(resolveEntryUrl({ id: 'a', title: 'A', url: 'https://a.example' }, undefined)).resolves.toBe(
      'https://a.example',
    );
  });
  it('runs urlCommand and accepts only an http(s) answer', async () => {
    const entry = { id: 'a', title: 'A', urlCommand: 'launchpad url mr' };
    await expect(resolveEntryUrl(entry, async () => '  http://127.0.0.1:37778/t/tok/d/mr/\n')).resolves.toBe(
      'http://127.0.0.1:37778/t/tok/d/mr/',
    );
    await expect(resolveEntryUrl(entry, async () => 'javascript:alert(1)')).rejects.toThrow();
  });
  it('fails a urlCommand entry where commands cannot run', async () => {
    await expect(resolveEntryUrl({ id: 'a', title: 'A', urlCommand: 'x' }, undefined)).rejects.toThrow();
  });
});
