import { describe, it, expect, afterEach } from 'vitest';
import {
  collectIconBag,
  resolveIcon,
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
