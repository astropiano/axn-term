import { describe, expect, it } from 'vitest';
import { cwdLabel, panelSessionVisible, sessionMetaLine } from './SessionPanel';

describe('cwdLabel', () => {
  it('collapses the home directory', () => {
    expect(cwdLabel('/Users/me/dev/axn-term')).toBe('~/dev/axn-term');
    expect(cwdLabel('/home/me')).toBe('~');
    expect(cwdLabel('/Users/me/')).toBe('~');
  });

  it('keeps the last two segments of deep paths', () => {
    expect(cwdLabel('/Users/me/dev/axn-term/libs/shell-ui')).toBe('…/libs/shell-ui');
    expect(cwdLabel('/var/log/nginx/sites/a')).toBe('…/sites/a');
  });

  it('leaves short absolute paths alone', () => {
    expect(cwdLabel('/etc')).toBe('/etc');
    expect(cwdLabel('/')).toBe('/');
    expect(cwdLabel(undefined)).toBeNull();
    expect(cwdLabel('')).toBeNull();
  });
});

describe('sessionMetaLine', () => {
  it('shows where a session runs when its name does not say so', () => {
    expect(sessionMetaLine({ name: 'me@MacBook-Pro', cwd: '/Users/me/dev/axn-term' })).toBe('~/dev/axn-term');
  });

  it('stays empty when the name already contains the folder', () => {
    expect(sessionMetaLine({ name: 'axn-term · devin', cwd: '/Users/me/dev/axn-term' })).toBeNull();
    expect(sessionMetaLine({ name: 'AXN-TERM build', cwd: '/Users/me/dev/axn-term' })).toBeNull();
  });

  it('stays empty without a cwd or in the home directory', () => {
    expect(sessionMetaLine({ name: 'shell' })).toBeNull();
    expect(sessionMetaLine({ name: 'shell', cwd: '/Users/me' })).toBeNull();
  });

  it('prefers the reason a session needs attention (first line only)', () => {
    expect(
      sessionMetaLine(
        { name: 'me@host', cwd: '/Users/me/dev/axn-term' },
        'claude: wants to edit styles.css\ndocker: disk 91%',
      ),
    ).toBe('claude: wants to edit styles.css');
  });
});

describe('panelSessionVisible (panel filters)', () => {
  const build = { id: 's1', name: 'axn-term · build' };
  const agent = { id: 's2', name: 'Claude · redesign' };

  it('shows everything without a filter', () => {
    expect(panelSessionVisible(build, { query: '', attentionIds: null })).toBe(true);
  });

  it('applies the text filter to the name', () => {
    expect(panelSessionVisible(build, { query: 'build', attentionIds: null })).toBe(true);
    expect(panelSessionVisible(agent, { query: 'build', attentionIds: null })).toBe(false);
    expect(panelSessionVisible(agent, { query: 'claude', attentionIds: null })).toBe(true);
  });

  it('"waiting" keeps only the sessions that need attention', () => {
    const waiting = new Set(['s2']);
    expect(panelSessionVisible(agent, { query: '', attentionIds: waiting })).toBe(true);
    expect(panelSessionVisible(build, { query: '', attentionIds: waiting })).toBe(false);
  });

  it('combines both filters', () => {
    const waiting = new Set(['s1', 's2']);
    expect(panelSessionVisible(agent, { query: 'redesign', attentionIds: waiting })).toBe(true);
    expect(panelSessionVisible(build, { query: 'redesign', attentionIds: waiting })).toBe(false);
  });
});
