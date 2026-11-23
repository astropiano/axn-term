import { describe, expect, it } from 'vitest';
import {
  addTag,
  derivedTags,
  normalizeTag,
  removeTag,
  renameTag,
  tagColor,
  tagColorOverrides,
  setTagColor,
  clearTagColor,
  parseHexColor,
  tagState,
  toggleTag,
} from './taggingModel';
import { TAG_SLOTS } from '../../themes';

describe('normalizeTag', () => {
  it('trims and rejects blank', () => {
    expect(normalizeTag('  Foo ')).toBe('Foo');
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('')).toBeNull();
  });
});

describe('tagColor', () => {
  it('is stable and case/space-insensitive', () => {
    expect(tagColor('Foo')).toBe(tagColor(' foo '));
    expect(tagColor('foo')).toBe(tagColor('foo'));
  });
  it('without a configured colour, always lands on a theme slot (so it follows the theme)', () => {
    for (let i = 0; i < 200; i++) expect(TAG_SLOTS).toContain(tagColor(`tag-${i}`));
  });
  it('spreads different names over more than one colour', () => {
    expect(new Set(Array.from({ length: 50 }, (_, i) => tagColor(`t${i}`))).size).toBeGreaterThan(1);
  });
});

describe('add / remove / rename', () => {
  it('adds a trimmed tag once, case-insensitively, ignoring blank', () => {
    expect(addTag(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addTag(['Foo'], 'foo')).toEqual(['Foo']);
    expect(addTag(['a'], '  ')).toEqual(['a']);
  });
  it('removes case-insensitively', () => {
    expect(removeTag(['Foo', 'b'], 'foo')).toEqual(['b']);
  });
  it('renames in place, ignoring blank targets and merging into an existing tag', () => {
    expect(renameTag(['a', 'b'], 'a', ' c ')).toEqual(['c', 'b']);
    expect(renameTag(['a', 'b'], 'a', ' ')).toEqual(['a', 'b']);
    expect(renameTag(['a', 'B'], 'a', 'b')).toEqual(['B']);
  });
});

describe('tagState / toggleTag', () => {
  const targets = [['x', 'y'], ['x'], []];
  it('is none / some / all', () => {
    expect(tagState(targets, 'z')).toBe('none');
    expect(tagState(targets, 'X')).toBe('some');
    expect(tagState([['x'], ['X']], 'x')).toBe('all');
    expect(tagState([], 'x')).toBe('none');
  });
  it('adds to all on none/some, removes from all on all', () => {
    expect(toggleTag(targets, 'x')).toEqual([['x', 'y'], ['x'], ['x']]);
    expect(toggleTag([['x'], ['x']], 'x')).toEqual([[], []]);
    expect(toggleTag([['a']], 'x')).toEqual([['a', 'x']]);
  });
});

describe('derivedTags', () => {
  it('is the case-insensitive union, first spelling wins, sorted', () => {
    expect(derivedTags([['beta', 'Alpha'], ['ALPHA', 'gamma'], []])).toEqual(['Alpha', 'beta', 'gamma']);
  });
  it('drops a tag once no carrier has it', () => {
    expect(derivedTags([['a'], ['b']])).toEqual(['a', 'b']);
    expect(derivedTags([['a'], []])).toEqual(['a']);
  });
});

describe('tag colour overrides', () => {
  it('an override wins over the hash, case-insensitively', () => {
    expect(tagColor('Foo', { foo: '#123456' })).toBe('#123456');
    expect(tagColor('bar', { foo: '#123456' })).toBe(tagColor('bar'));
  });

  it('reads only valid hex entries from the plugin settings section', () => {
    expect(tagColorOverrides({ colors: { Foo: '#123456', slot: 'blue', bad: 'nope', Url: 'url(x)', ' ': '#fff' } })).toEqual({
      foo: '#123456',
      slot: 'blue',
    });
    expect(tagColorOverrides(undefined)).toEqual({});
    expect(tagColorOverrides({ colors: ['#fff'] })).toEqual({});
  });

  it('sets and clears by normalised name and rejects invalid input', () => {
    const set = setTagColor({}, ' Foo ', '#abcdef');
    expect(set).toEqual({ foo: '#abcdef' });
    expect(setTagColor(set, 'x', 'nope')).toBe(set);
    expect(setTagColor(set, 'X', 'violet')).toEqual({ foo: '#abcdef', x: 'violet' });
    expect(setTagColor(set, '  ', '#fff')).toBe(set);
    expect(clearTagColor(set, 'FOO')).toEqual({});
  });
});

describe('parseHexColor', () => {
  it.each([
    ['#ABC', '#abc'],
    ['abc', '#abc'],
    ['  #12AB34 ', '#12ab34'],
    ['12ab34cc', '#12ab34cc'],
  ])('accepts %s', (raw, out) => expect(parseHexColor(raw)).toBe(out));
  it.each(['', '#', 'red', '#12', '##abc', '#ggg', 'rgb(1,2,3)'])('rejects %s', (raw) =>
    expect(parseHexColor(raw)).toBeNull(),
  );
});
