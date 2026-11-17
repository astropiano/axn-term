import { describe, expect, it } from 'vitest';
import {
  TAG_PALETTE,
  addTag,
  derivedTags,
  normalizeTag,
  removeTag,
  renameTag,
  tagColor,
  tagState,
  toggleTag,
} from './taggingModel';
import { isHexColor } from './tint';

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
  it('always lands in the palette, and the palette is valid hex', () => {
    expect(TAG_PALETTE.every(isHexColor)).toBe(true);
    for (let i = 0; i < 200; i++) expect(TAG_PALETTE).toContain(tagColor(`tag-${i}`));
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
