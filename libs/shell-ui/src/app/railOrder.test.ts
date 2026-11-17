import { describe, expect, it } from 'vitest';
import {
  RAIL_ORDER_KEY,
  orderRailPlugins,
  railOrderAfterDrop,
  storedRailOrder, railDropIndexAt, railViewAfterShortcut, railViewIds, viewKey, parseViewKey, orderRailSlots } from './railOrder';

const plugins = (...ids: string[]) => ids.map((id) => ({ id }));
const data = (order: unknown) => ({ [RAIL_ORDER_KEY]: { order } });

describe('storedRailOrder', () => {
  it('returns [] for missing or malformed data and drops non-strings', () => {
    expect(storedRailOrder({})).toEqual([]);
    expect(storedRailOrder(data('nope'))).toEqual([]);
    expect(storedRailOrder(data(['a', 7, 'b', null]))).toEqual(['a', 'b']);
  });
});

describe('orderRailPlugins', () => {
  it('keeps registration order when nothing is stored', () => {
    expect(orderRailPlugins(plugins('a', 'b', 'c'), {}).map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('orders by stored rank and appends unknown ids in registration order', () => {
    expect(
      orderRailPlugins(plugins('a', 'b', 'c', 'd'), data(['d', 'b'])).map((p) => p.id),
    ).toEqual(['d', 'b', 'a', 'c']);
  });
  it('ignores stored ids that are not rendered', () => {
    expect(
      orderRailPlugins(plugins('a', 'b'), data(['x', 'b', 'a'])).map((p) => p.id),
    ).toEqual(['b', 'a']);
  });
});

describe('railOrderAfterDrop', () => {
  it('inserts before the target index', () => {
    expect(railOrderAfterDrop(['a', 'b', 'c'], [], 'c', 0)).toEqual(['c', 'a', 'b']);
  });
  it('appends at dropIndex = length', () => {
    expect(railOrderAfterDrop(['a', 'b', 'c'], [], 'a', 3)).toEqual(['b', 'c', 'a']);
  });
  it('adjusts the index when moving downward', () => {
    expect(railOrderAfterDrop(['a', 'b', 'c'], [], 'a', 2)).toEqual(['b', 'a', 'c']);
  });
  it('clamps out-of-range indices', () => {
    expect(railOrderAfterDrop(['a', 'b'], [], 'b', -5)).toEqual(['b', 'a']);
    expect(railOrderAfterDrop(['a', 'b'], [], 'a', 99)).toEqual(['b', 'a']);
  });
  it('keeps stored ids that are not currently rendered at the tail', () => {
    expect(railOrderAfterDrop(['a', 'b'], ['x', 'b', 'a'], 'a', 0)).toEqual([
      'a',
      'b',
      'x',
    ]);
  });
  it('returns the stored order untouched for an unknown dragId', () => {
    expect(railOrderAfterDrop(['a', 'b'], ['x'], 'nope', 0)).toEqual(['x']);
  });
});

describe('railDropIndexAt', () => {
  // Three 28px icons stacked 12px apart.
  const rects = [
    { top: 100, height: 28 },
    { top: 140, height: 28 },
    { top: 180, height: 28 },
  ];

  it('inserts before the first item whose midpoint is below the pointer', () => {
    expect(railDropIndexAt(90, rects)).toBe(0);
    expect(railDropIndexAt(113, rects)).toBe(0);
    expect(railDropIndexAt(120, rects)).toBe(1);
    expect(railDropIndexAt(160, rects)).toBe(2);
  });

  it('appends below the last item', () => {
    expect(railDropIndexAt(200, rects)).toBe(3);
    expect(railDropIndexAt(900, rects)).toBe(3);
  });

  it('skips items that are not mounted', () => {
    expect(railDropIndexAt(150, [undefined, { top: 140, height: 28 }])).toBe(1);
  });
});

describe('railViewIds', () => {
  const slot = (id: string, hasView = true, visible = true) => ({ id, hasView, visible });

  it('keeps the display order of the slots that open a view', () => {
    expect(railViewIds([slot('agents'), slot('glab-mr'), slot('servdemo-board')])).toEqual([
      'agents',
      'glab-mr',
      'servdemo-board',
    ]);
  });

  it('skips indicator-only slots and slots that render nothing', () => {
    expect(
      railViewIds([
        slot('glab-mr'),
        slot('ram', false), // an indicator, not a view
        slot('gh-pr', true, false), // gh not installed: no rail item
        slot('docker'),
      ]),
    ).toEqual(['glab-mr', 'docker']);
    expect(railViewIds([])).toEqual([]);
  });
});

describe('railViewAfterShortcut', () => {
  const views = ['glab-mr', 'docker', 'servdemo-board'];

  it('opens the view at the pressed position', () => {
    expect(railViewAfterShortcut(views, 0, null)).toBe('glab-mr');
    expect(railViewAfterShortcut(views, 2, 'glab-mr')).toBe('servdemo-board');
  });

  it('returns to the session when that view is already active', () => {
    expect(railViewAfterShortcut(views, 1, 'docker')).toBeNull();
  });

  it('does nothing past the last view', () => {
    expect(railViewAfterShortcut(views, 3, null)).toBeUndefined();
    expect(railViewAfterShortcut(views, 9, 'docker')).toBeUndefined();
    expect(railViewAfterShortcut([], 0, null)).toBeUndefined();
  });
});

describe('view keys', () => {
  it('formats and parses plugin and entry keys', () => {
    expect(viewKey('docker')).toBe('docker');
    expect(viewKey('external-views', 'abc')).toBe('external-views/abc');
    expect(parseViewKey('external-views/abc')).toEqual({ pluginId: 'external-views', entryId: 'abc' });
    expect(parseViewKey('docker')).toEqual({ pluginId: 'docker' });
  });
});

describe('orderRailSlots', () => {
  const slot = (key: string, entry = false) => ({ key, entry });
  const keys = (slots: { key: string }[]) => slots.map((s) => s.key);

  it('puts unranked entries after every unranked plugin, so existing numbers never shift', () => {
    const input = [slot('jira'), slot('ev/e1', true), slot('ev/e2', true), slot('docker'), slot('sandboxed')];
    expect(keys(orderRailSlots(input, {}))).toEqual(['jira', 'docker', 'sandboxed', 'ev/e1', 'ev/e2']);
  });
  it('keeps a partial saved order first, then plugins, then entries', () => {
    const input = [slot('jira'), slot('ev/e1', true), slot('docker')];
    expect(keys(orderRailSlots(input, data(['jira'])))).toEqual(['jira', 'docker', 'ev/e1']);
  });
  it('honours a saved rank for an entry', () => {
    const input = [slot('jira'), slot('ev/e1', true), slot('docker')];
    expect(keys(orderRailSlots(input, data(['ev/e1', 'jira', 'docker'])))).toEqual(['ev/e1', 'jira', 'docker']);
  });
});

describe('railOrderAfterDrop with transient keys', () => {
  it('never persists transient (runtime) keys', () => {
    expect(railOrderAfterDrop(['a', 'b', 'ev/rt'], [], 'b', 0, new Set(['ev/rt']))).toEqual(['b', 'a']);
  });
  it('drops a transient key already in the stored order', () => {
    expect(railOrderAfterDrop(['a', 'b'], ['ev/rt', 'a', 'b'], 'b', 0, new Set(['ev/rt']))).toEqual(['b', 'a']);
  });
});
