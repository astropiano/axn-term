import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isPluginEnabled,
  pluginDependencies,
  satisfiesVersion,
} from './plugin';
import type { SessionViewPlugin } from './plugin';
import type { PluginSettings } from '../pluginSettings';

function plugin(partial: Partial<SessionViewPlugin>): SessionViewPlugin {
  return { id: 'p', title: 'p', ...partial };
}

describe('compareVersions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });
  it('treats missing segments as 0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
  });
});

describe('satisfiesVersion', () => {
  it('matches exact, comparators and caret', () => {
    expect(satisfiesVersion('0.1.0', '0.1.0')).toBe(true);
    expect(satisfiesVersion('0.1.1', '0.1.0')).toBe(false);
    expect(satisfiesVersion('0.2.0', '>=0.1.0')).toBe(true);
    expect(satisfiesVersion('0.0.9', '>=0.1.0')).toBe(false);
    expect(satisfiesVersion('0.2.0', '>0.1.0')).toBe(true);
    expect(satisfiesVersion('0.1.0', '>0.1.0')).toBe(false);
    expect(satisfiesVersion('0.0.9', '<0.1.0')).toBe(true);
    expect(satisfiesVersion('0.1.0', '<=0.1.0')).toBe(true);
    expect(satisfiesVersion('0.5.0', '^0.1.0')).toBe(true);
    expect(satisfiesVersion('1.0.0', '^0.1.0')).toBe(false);
    expect(satisfiesVersion('0.0.9', '^0.1.0')).toBe(false);
  });
});

describe('isPluginEnabled with dependsOn', () => {
  const gitStatus = plugin({ id: 'git-status', version: '0.1.0' });
  const gitInspect = plugin({
    id: 'git-inspect',
    version: '0.1.0',
    dependsOn: [{ id: 'git-status', version: '>=0.1.0' }],
  });
  const all = [gitStatus, gitInspect];
  const settings: PluginSettings = {};

  it('is enabled when the dependency is present, enabled and matching', () => {
    expect(isPluginEnabled(gitInspect, settings, all)).toBe(true);
  });

  it('is disabled when the dependency plugin is missing', () => {
    expect(isPluginEnabled(gitInspect, settings, [gitInspect])).toBe(false);
  });

  it('is disabled when the dependency is disabled', () => {
    const s: PluginSettings = { 'git-status': { enabled: false } };
    expect(isPluginEnabled(gitInspect, s, all)).toBe(false);
    expect(isPluginEnabled(gitStatus, s, all)).toBe(false);
  });

  it('is disabled when the dependency version is too old', () => {
    const old = plugin({ id: 'git-status', version: '0.0.5' });
    expect(isPluginEnabled(gitInspect, settings, [old, gitInspect])).toBe(false);
  });

  it('is enabled when the dependency version is newer', () => {
    const newer = plugin({ id: 'git-status', version: '0.9.0' });
    expect(isPluginEnabled(gitInspect, settings, [newer, gitInspect])).toBe(true);
  });

  it('dependency chains and cycles resolve to disabled', () => {
    const a = plugin({ id: 'a', dependsOn: [{ id: 'b' }] });
    const b = plugin({ id: 'b', dependsOn: [{ id: 'c' }] });
    const list = [a, b];
    expect(isPluginEnabled(a, {}, list)).toBe(false);
    const c = plugin({ id: 'c' });
    expect(isPluginEnabled(a, {}, [a, b, c])).toBe(true);
    const cyclic = plugin({ id: 'x', dependsOn: [{ id: 'x' }] });
    expect(isPluginEnabled(cyclic, {}, [cyclic])).toBe(false);
  });

  it('matches dependencies by settingsKey too', () => {
    const keyed = plugin({ id: 'gs', settingsKey: 'git-status', version: '0.1.0' });
    expect(isPluginEnabled(gitInspect, settings, [keyed, gitInspect])).toBe(true);
  });

  it('pluginDependencies reports met/unmet', () => {
    const deps = pluginDependencies(gitInspect, settings, all);
    expect(deps).toEqual([{ dep: { id: 'git-status', version: '>=0.1.0' }, met: true }]);
    const s: PluginSettings = { 'git-status': { enabled: false } };
    expect(pluginDependencies(gitInspect, s, all)[0].met).toBe(false);
  });
});
