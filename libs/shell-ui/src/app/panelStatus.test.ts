import { afterEach, describe, expect, it } from 'vitest';
import {
  PANEL_UI_KEY,
  currentPanelStatus,
  splitPanelStatus,
  publishPanelStatus,
  resetPanelStatus,
  statusLevelColor,
  storedExpandedGroups,
  storedSystemExpanded,
  toggleExpandedGroup,
  worstStatusLevel,
  type StatusGroup,
} from './panelStatus';

const group = (title: string, ...levels: (0 | 1 | 2 | 3)[]): StatusGroup => ({
  title,
  meters: levels.map((level, i) => ({ label: `m${i}`, value: `${i}`, level })),
});

afterEach(() => resetPanelStatus());

describe('panel status slot', () => {
  it('lists published groups in the order their sources first appeared', () => {
    publishPanelStatus('ram', group('Memory', 0));
    publishPanelStatus('docker', group('Docker VM', 1));
    publishPanelStatus('ram', group('Memory', 2)); // update keeps the slot
    expect(currentPanelStatus().map((p) => p.source)).toEqual(['ram', 'docker']);
    expect(currentPanelStatus()[0].group.meters[0].level).toBe(2);
  });

  it('sorts by the groups\' order before publish order', () => {
    publishPanelStatus('docker', { ...group('Docker VM', 0), order: 10 });
    publishPanelStatus('ram', group('Memory', 0)); // order 0, published later
    publishPanelStatus('other', { ...group('Other', 0), order: 10 });
    expect(currentPanelStatus().map((p) => p.source)).toEqual(['ram', 'docker', 'other']);
  });

  it('withdraws a source with null or an empty group', () => {
    publishPanelStatus('ram', group('Memory', 0));
    publishPanelStatus('docker', group('Docker VM', 0));
    publishPanelStatus('ram', null);
    expect(currentPanelStatus().map((p) => p.source)).toEqual(['docker']);
    publishPanelStatus('docker', { title: 'Docker VM', meters: [] });
    expect(currentPanelStatus()).toEqual([]);
  });

  it('keeps the same snapshot when nothing changed', () => {
    publishPanelStatus('ram', group('Memory', 1));
    const before = currentPanelStatus();
    publishPanelStatus('ram', group('Memory', 1));
    publishPanelStatus('gone', null);
    expect(currentPanelStatus()).toBe(before);
  });

  it('reports the worst level and its colour', () => {
    expect(worstStatusLevel([])).toBe(0);
    publishPanelStatus('ram', group('Memory', 0, 1));
    publishPanelStatus('docker', group('Docker VM', 3, 0));
    expect(worstStatusLevel(currentPanelStatus())).toBe(3);
    expect(statusLevelColor(0)).toBe('var(--green)');
    expect(statusLevelColor(3)).toBe('var(--red)');
  });

  it('splits tools (rail order) from the machine-level groups of System', () => {
    publishPanelStatus('docker', group('Docker', 0));
    publishPanelStatus('agents', group('Agents', 0));
    publishPanelStatus('ram', { ...group('Memory', 0), system: true });
    publishPanelStatus('external', group('External', 0)); // a tool without a rail slot
    publishPanelStatus('glab-mr', group('Merge requests', 0));
    const rail = ['glab-mr', 'gh-pr', 'docker', 'agents'];
    const split = splitPanelStatus(currentPanelStatus(), rail);
    // Docker keeps an accordion of its own (its VM numbers are not "System").
    expect(split.tools.map((p) => p.source)).toEqual(['glab-mr', 'docker', 'agents', 'external']);
    expect(split.system.map((p) => p.source)).toEqual(['ram']);
    // Without a rail order the published order stays.
    expect(splitPanelStatus(currentPanelStatus(), []).tools.map((p) => p.source)).toEqual([
      'docker',
      'agents',
      'external',
      'glab-mr',
    ]);
  });

  it('has no System accordion content without machine-level groups', () => {
    publishPanelStatus('docker', group('Docker', 0));
    expect(splitPanelStatus(currentPanelStatus(), ['docker'])).toEqual({
      tools: currentPanelStatus(),
      system: [],
    });
  });

  it('keeps System open by default and remembers closing it', () => {
    expect(storedSystemExpanded({})).toBe(true);
    expect(storedSystemExpanded({ [PANEL_UI_KEY]: null })).toBe(true);
    expect(storedSystemExpanded({ [PANEL_UI_KEY]: { systemExpanded: true } })).toBe(true);
    expect(storedSystemExpanded({ [PANEL_UI_KEY]: { systemExpanded: false } })).toBe(false);
  });

  it('remembers which tool accordions are expanded — none by default', () => {
    expect(storedExpandedGroups({})).toEqual([]);
    expect(storedExpandedGroups({ [PANEL_UI_KEY]: { expandedGroups: ['docker', 7, 'ram'] } })).toEqual([
      'docker',
      'ram',
    ]);
    expect(storedExpandedGroups({ [PANEL_UI_KEY]: { expandedGroups: 'docker' } })).toEqual([]);
    expect(toggleExpandedGroup(['docker'], 'ram')).toEqual(['docker', 'ram']);
    expect(toggleExpandedGroup(['docker', 'ram'], 'docker')).toEqual(['ram']);
  });
});

import { resolveStatusDisplay } from './panelStatus';

describe('resolveStatusDisplay', () => {
  it('honours an explicit panel or rail, with or without a detailed rail item', () => {
    expect(resolveStatusDisplay('rail', false, false)).toBe('rail');
    expect(resolveStatusDisplay('Rail', true, false)).toBe('rail');
    expect(resolveStatusDisplay('panel', true, true)).toBe('panel');
  });

  it('auto: the rail only for detailed items on touch devices', () => {
    expect(resolveStatusDisplay(undefined, true, true)).toBe('rail');
    expect(resolveStatusDisplay('auto', true, false)).toBe('panel');
    expect(resolveStatusDisplay(undefined, false, true)).toBe('panel');
    expect(resolveStatusDisplay('nonsense', false, false)).toBe('panel');
  });
});
