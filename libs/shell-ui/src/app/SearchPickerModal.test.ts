import { describe, it, expect } from 'vitest';
import { filterPickerItems, type PickerItem } from './SearchPickerModal';

const items: PickerItem[] = [
  { key: 'a', label: 'ast-analyze', detail: 'Pre-planning analysis', group: 'claude' },
  { key: 'b', label: 'reviewer', detail: 'claude · opus' },
  { key: 'c', label: 'docs', group: 'Window 2' },
];

describe('filterPickerItems', () => {
  it('matches label, detail and group case-insensitively', () => {
    expect(filterPickerItems(items, 'ANALY').map((i) => i.key)).toEqual(['a']);
    expect(filterPickerItems(items, 'opus').map((i) => i.key)).toEqual(['b']);
    expect(filterPickerItems(items, 'window 2').map((i) => i.key)).toEqual(['c']);
  });

  it('returns everything for a blank query', () => {
    expect(filterPickerItems(items, '  ')).toHaveLength(3);
  });
});
