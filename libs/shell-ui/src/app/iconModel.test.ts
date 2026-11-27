import { describe, it, expect, afterEach } from 'vitest';
import {
  collectIconBag,
  resolveIcon,
  pluginIconKey,
  pluginIconOverride,
  resolveProcessIcon,
  registerIconPlugin,
  resetIconPlugins,
} from './iconModel';

describe('collectIconBag', () => {
  it('merges legacy maps, customIcons wins', () => {
    const bag = collectIconBag({
      sessionIcons: { devin: 'Bot', zsh: 'Terminal' },
      pluginIcons: { docker: 'Whale' },
      customIcons: { devin: 'Sparkles', docker: 'Container' },
    });
    expect(bag.devin).toBe('Sparkles');
    expect(bag.docker).toBe('Container');
    expect(bag.zsh).toBe('Terminal');
  });

  it('handles absent maps', () => {
    expect(collectIconBag({})).toEqual({});
  });
});

describe('resolveIcon', () => {
  it('returns the configured icon or the fallback', () => {
    expect(resolveIcon({ docker: 'Container' }, 'docker', 'Puzzle')).toBe('Container');
    expect(resolveIcon({}, 'docker', 'Puzzle')).toBe('Puzzle');
  });
});

describe('resolveProcessIcon', () => {
  afterEach(() => resetIconPlugins([]));

  it('returns the fallback for no/unknown process', () => {
    expect(resolveProcessIcon(undefined, {})).toBe('SquareTerminal');
    expect(resolveProcessIcon('zsh', {})).toBe('SquareTerminal');
  });

  it('a bag entry keyed by process name wins', () => {
    expect(resolveProcessIcon('Devin', { devin: 'Sparkles' })).toBe('Sparkles');
  });

  it('falls back to the logo of a plugin claiming the process', () => {
    registerIconPlugin({ id: 'antigravity', logo: 'Bot', processPattern: /^(agy|antigravity)/i });
    expect(resolveProcessIcon('agy', {})).toBe('Bot');
  });

  it('antigravity is one entry: the `agy` key serves the process and the plugin', () => {
    registerIconPlugin({ id: 'antigravity', iconKey: 'agy', logo: 'Bot', processPattern: /^(agy|antigravity)/i });
    expect(resolveProcessIcon('agy', { agy: 'Rocket' })).toBe('Rocket');
    // an entry an earlier version left under the plugin id still applies …
    expect(resolveProcessIcon('agy', { antigravity: 'Old' })).toBe('Old');
    // … until `agy` is set, which wins
    expect(resolveProcessIcon('agy', { antigravity: 'Old', agy: 'Rocket' })).toBe('Rocket');
  });

  it('a plugin without a declared logo supplies no fallback', () => {
    registerIconPlugin({ id: 'worktrees', processPattern: /^git/ });
    expect(resolveProcessIcon('git', {})).toBe('SquareTerminal');
  });

  it('an override keyed by plugin id wins over the declared logo', () => {
    registerIconPlugin({ id: 'devin', logo: 'Bot', processPattern: /^devin/i });
    expect(resolveProcessIcon('devin', { devin: 'Sparkles' })).toBe('Sparkles');
  });

  it('an explicit process entry wins over the matched plugin logo', () => {
    registerIconPlugin({ id: 'antigravity', logo: 'Bot', processPattern: /^(agy|antigravity)/i });
    expect(resolveProcessIcon('agy', { agy: 'Rocket' })).toBe('Rocket');
    // …and a plugin-id override applies when no process entry exists.
    expect(resolveProcessIcon('agy', { antigravity: 'Rocket' })).toBe('Rocket');
  });
});

describe('pluginIconKey / pluginIconOverride', () => {
  it('uses the id unless the plugin names another key', () => {
    expect(pluginIconKey({ id: 'claude' })).toBe('claude');
    expect(pluginIconKey({ id: 'antigravity', iconKey: 'agy' })).toBe('agy');
  });

  it('reads the key, with the id as a legacy fallback only when a key is set', () => {
    expect(pluginIconOverride({ claude: 'A' }, { id: 'claude' })).toBe('A');
    expect(pluginIconOverride({ antigravity: 'Old' }, { id: 'antigravity', iconKey: 'agy' })).toBe('Old');
    expect(pluginIconOverride({ antigravity: 'Old', agy: 'New' }, { id: 'antigravity', iconKey: 'agy' })).toBe('New');
    expect(pluginIconOverride({}, { id: 'antigravity', iconKey: 'agy' })).toBeUndefined();
  });
});
