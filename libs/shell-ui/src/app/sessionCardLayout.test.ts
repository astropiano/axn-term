import { describe, expect, it } from 'vitest';
import {
  CORE_FIELDS,
  DEFAULT_SESSION_CARD,
  parseCardLayout,
  resolveCardLayout,
  type FieldMeta,
  type ResolvedCardLayout,
} from './sessionCardLayout';

const fields: FieldMeta[] = [
  ...CORE_FIELDS,
  { id: 'git-status.branch', label: 'Git branch', kind: 'inline', zone: 'title' },
  { id: 'jira.tickets', label: 'Jira tickets', kind: 'inline', zone: 'always' },
  { id: 'git-status.repo', label: 'Git repository', kind: 'block', zone: 'selected' },
  { id: 'tagging.tags', label: 'Tags', kind: 'inline', zone: 'title' },
];

const flat = (l: ResolvedCardLayout) => [...l.title, ...l.always.flat(), ...l.selected.flat()];

describe('resolveCardLayout without a layout', () => {
  it('shows the shipped default card for the fields that are available', () => {
    expect(resolveCardLayout(undefined, fields)).toEqual({
      title: ['core.name', 'git-status.branch', 'core.status'],
      always: [['core.summary']],
      selected: [['core.process'], ['git-status.repo'], ['core.tasks'], ['core.progress']],
    });
  });

  it('does not show plugin fields the default does not name (tags, Jira tickets)', () => {
    const shown = flat(resolveCardLayout(undefined, fields));
    expect(shown).not.toContain('tagging.tags');
    expect(shown).not.toContain('jira.tickets');
    expect(flat(DEFAULT_SESSION_CARD)).not.toContain('tagging.tags');
    expect(flat(DEFAULT_SESSION_CARD)).not.toContain('jira.tickets');
  });

  it("drops a disabled plugin's fields even where the layout names them", () => {
    const withoutGit = fields.filter((f) => !f.id.startsWith('git-status.'));
    expect(flat(resolveCardLayout(undefined, withoutGit))).not.toContain('git-status.branch');
    expect(flat(resolveCardLayout({ title: ['core.name', 'git-status.branch'] }, withoutGit))).not.toContain(
      'git-status.branch',
    );
  });
});

describe('resolveCardLayout with a layout', () => {
  it('a configured zone replaces its default; other zones keep the default', () => {
    const r = resolveCardLayout({ always: [['core.summary', 'git-status.branch'], ['jira.tickets']] }, fields);
    // branch moved out of the default title row into the configured always row
    expect(r.title).toEqual(['core.name', 'core.status']);
    expect(r.always).toEqual([['core.summary', 'git-status.branch'], ['jira.tickets']]);
    expect(r.selected).toContainEqual(['git-status.repo']);
  });

  it('shows a plugin field only where placed; unplaced built-ins still fall back to their zone', () => {
    const r = resolveCardLayout(
      { selected: [['jira.tickets'], ['nope.gone']], hidden: ['core.progress'] },
      fields,
    );
    expect(r.selected).toEqual([['jira.tickets'], ['core.process'], ['core.tasks']]);
    // git-status.repo is named only by the replaced default selected zone
    expect(flat(r)).not.toContain('git-status.repo');
  });

  it('hides a field even when a zone names it', () => {
    const r = resolveCardLayout({ title: ['core.name', 'tagging.tags'], hidden: ['tagging.tags'] }, fields);
    expect(flat(r)).not.toContain('tagging.tags');
  });

  it('keeps blocks out of the title row and the name always in it', () => {
    const r = resolveCardLayout({ title: ['git-status.repo', 'core.status'], hidden: ['core.name'] }, fields);
    expect(r.title).toEqual(['core.name', 'core.status']);
    expect(r.selected).toContainEqual(['git-status.repo']);
  });

  it('places each field once', () => {
    const r = resolveCardLayout({ title: ['core.name', 'core.name'], always: [['jira.tickets', 'jira.tickets']] }, fields);
    expect(r.title.filter((id) => id === 'core.name')).toHaveLength(1);
    expect(r.always[0]).toEqual(['jira.tickets']);
  });
});

describe('parseCardLayout', () => {
  it('accepts rows, flat lists and drops junk', () => {
    expect(parseCardLayout({ title: ['core.name', 3], always: ['core.summary', ['a', 'b'], []], hidden: 'x' })).toEqual({
      title: ['core.name'],
      always: [['core.summary'], ['a', 'b']],
      hidden: [],
    });
    expect(parseCardLayout('nope')).toBeUndefined();
  });
});
