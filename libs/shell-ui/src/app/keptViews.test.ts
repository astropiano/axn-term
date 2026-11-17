import { describe, expect, it } from 'vitest';
import { nextKeptViews } from './keptViews';

const keepEv = (key: string) => key.startsWith('ev/');
const all = () => true;

describe('nextKeptViews', () => {
  it('adds a keepable view once, on activation', () => {
    expect(nextKeptViews([], 'ev/a', keepEv, all)).toEqual(['ev/a']);
    expect(nextKeptViews(['ev/a'], 'ev/a', keepEv, all)).toEqual(['ev/a']);
    expect(nextKeptViews(['ev/a'], 'ev/b', keepEv, all)).toEqual(['ev/a', 'ev/b']);
  });
  it('never keeps a view whose plugin did not opt in', () => {
    expect(nextKeptViews([], 'docker', keepEv, all)).toEqual([]);
  });
  it('keeps hidden views when the session or another view shows', () => {
    expect(nextKeptViews(['ev/a'], null, keepEv, all)).toEqual(['ev/a']);
    expect(nextKeptViews(['ev/a'], 'docker', keepEv, all)).toEqual(['ev/a']);
  });
  it('drops views that are no longer valid (entry removed, plugin disabled)', () => {
    expect(nextKeptViews(['ev/a', 'ev/b'], null, keepEv, (k) => k !== 'ev/a')).toEqual(['ev/b']);
  });
  it('returns the same array when nothing changed', () => {
    const prev = ['ev/a'];
    expect(nextKeptViews(prev, 'ev/a', keepEv, all)).toBe(prev);
  });
});
