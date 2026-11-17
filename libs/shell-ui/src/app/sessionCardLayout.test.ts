import { describe, expect, it } from 'vitest';
import { CORE_FIELDS, defaultCardLayout, parseCardLayout, resolveCardLayout, type FieldMeta } from './sessionCardLayout';

const fields: FieldMeta[] = [
  ...CORE_FIELDS,
  { id: 'git-status.branch', label: 'Git branch', kind: 'inline', zone: 'title' },
  { id: 'jira.tickets', label: 'Jira tickets', kind: 'inline', zone: 'always' },
  { id: 'git-status.repo', label: 'Git repository', kind: 'block', zone: 'selected' },
  { id: 'odd.block', label: 'Block wanting the title', kind: 'block', zone: 'title' },
];

describe('defaultCardLayout', () => {
  it("reproduces today's card", () => {
    expect(defaultCardLayout(fields)).toEqual({
      title: ['core.name', 'git-status.branch', 'core.status'],
      always: [['core.summary'], ['jira.tickets']],
      selected: [['core.process'], ['git-status.repo'], ['odd.block'], ['core.tasks'], ['core.progress']],
    });
  });
});

describe('resolveCardLayout', () => {
  it('without a layout is the default', () => {
    expect(resolveCardLayout(undefined, fields)).toEqual(defaultCardLayout(fields));
  });

  it('a configured zone replaces its default; unplaced fields fall back to theirs', () => {
    const r = resolveCardLayout({ always: [['core.summary', 'git-status.branch']] }, fields);
    // branch moved out of the title row into the always row…
    expect(r.title).toEqual(['core.name', 'core.status']);
    expect(r.always).toEqual([['core.summary', 'git-status.branch'], ['jira.tickets']]);
  });

  it("moves a field to the selected card, hides others, skips unknown ids", () => {
    const r = resolveCardLayout(
      { selected: [['jira.tickets'], ['nope.gone']], hidden: ['git-status.repo', 'core.progress'] },
      fields,
    );
    expect(r.always).toEqual([['core.summary']]);
    expect(r.selected).toEqual([
      ['jira.tickets'],
      // unplaced fields append to their default zone in field order
      ['core.process'],
      ['core.tasks'],
      ['odd.block'],
    ]);
  });

  it('keeps blocks out of the title row and the name always in it', () => {
    const r = resolveCardLayout({ title: ['git-status.repo', 'core.status'], hidden: ['core.name'] }, fields);
    // an unplaced title badge goes before core.status
    expect(r.title).toEqual(['core.name', 'git-status.branch', 'core.status']);
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

describe('optIn fields', () => {
  const fields: FieldMeta[] = [
    ...CORE_FIELDS,
    { id: 'a.chip', label: 'Chip', kind: 'inline', zone: 'title', optIn: true },
    { id: 'b.row', label: 'Row', kind: 'inline', zone: 'always' },
  ];
  const flat = (l: ReturnType<typeof resolveCardLayout>) => [...l.title, ...l.always.flat(), ...l.selected.flat()];

  it('are absent unless placed, while other plugin fields keep their default', () => {
    expect(flat(resolveCardLayout(undefined, fields))).not.toContain('a.chip');
    expect(flat(resolveCardLayout(undefined, fields))).toContain('b.row');
    expect(flat(defaultCardLayout(fields))).not.toContain('a.chip');
  });

  it('appear where the layout places them', () => {
    expect(resolveCardLayout({ title: ['core.name', 'a.chip'] }, fields).title).toContain('a.chip');
  });
});
