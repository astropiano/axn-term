import { describe, expect, it } from 'vitest';
import { isAppNavigationShortcut } from './shortcuts';

const key = (k: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('isAppNavigationShortcut', () => {
  it('matches Ctrl/Cmd+Alt+arrows (sessions, tabs)', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(isAppNavigationShortcut(key(k, { ctrlKey: true, altKey: true }))).toBe(true);
      expect(isAppNavigationShortcut(key(k, { metaKey: true, altKey: true }))).toBe(true);
    }
  });

  it('matches Ctrl/Cmd+Alt+Shift+Up/Down (workspaces) only', () => {
    const mods = { ctrlKey: true, altKey: true, shiftKey: true };
    expect(isAppNavigationShortcut(key('ArrowUp', mods))).toBe(true);
    expect(isAppNavigationShortcut(key('ArrowDown', mods))).toBe(true);
    expect(isAppNavigationShortcut(key('ArrowLeft', mods))).toBe(false);
  });

  it('leaves shell Alt/Ctrl combos to the terminal', () => {
    expect(isAppNavigationShortcut(key('ArrowLeft', { altKey: true }))).toBe(false);
    expect(isAppNavigationShortcut(key('ArrowLeft', { ctrlKey: true }))).toBe(false);
    expect(isAppNavigationShortcut(key('b', { altKey: true }))).toBe(false);
    expect(isAppNavigationShortcut(key('b', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isAppNavigationShortcut(key('ArrowUp'))).toBe(false);
  });
});
