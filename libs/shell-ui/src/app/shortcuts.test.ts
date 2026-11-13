import { describe, expect, it } from 'vitest';
import {
  isAppChromeShortcut,
  isAppNavigationShortcut,
  isPanelToggleShortcut,
  isReloadShortcut,
  panelToggleShortcutLabel,
  railViewAriaShortcut,
  railViewShortcutIndex,
  railViewShortcutLabel,
} from './shortcuts';

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

describe('isReloadShortcut', () => {
  const key = (k: string, mods: Partial<KeyboardEvent>) =>
    ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it('matches ⌘⇧R and Ctrl+Shift+R', () => {
    expect(isReloadShortcut(key('R', { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isReloadShortcut(key('r', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('leaves the shell’s Ctrl+R and a plain ⌘R alone', () => {
    expect(isReloadShortcut(key('r', { ctrlKey: true }))).toBe(false);
    expect(isReloadShortcut(key('r', { metaKey: true }))).toBe(false);
    expect(isReloadShortcut(key('r', { metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });
});

describe('rail view shortcuts', () => {
  const MAC = true;
  const OTHER = false;

  it('maps ⌘1…⌘9 to the first nine views (macOS)', () => {
    for (let n = 1; n <= 9; n++) {
      expect(railViewShortcutIndex(key(String(n), { metaKey: true }), MAC)).toBe(n - 1);
    }
  });

  it('leaves ⌘0 / Ctrl+0 alone — the app menu uses it for Actual Size', () => {
    expect(railViewShortcutIndex(key('0', { metaKey: true }), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('0', { ctrlKey: true }), OTHER)).toBeNull();
    expect(railViewShortcutIndex({ ...key('à', { metaKey: true }), code: 'Digit0' }, MAC)).toBeNull();
  });

  it('uses Ctrl on Linux/Windows', () => {
    expect(railViewShortcutIndex(key('3', { ctrlKey: true }), OTHER)).toBe(2);
    // ⌘ / the Windows key is not the modifier there.
    expect(railViewShortcutIndex(key('3', { metaKey: true }), OTHER)).toBeNull();
  });

  it('leaves Ctrl+digit to the terminal on macOS', () => {
    expect(railViewShortcutIndex(key('3', { ctrlKey: true }), MAC)).toBeNull();
    expect(isAppChromeShortcut(key('3', { ctrlKey: true }), MAC)).toBe(false);
  });

  it('rejects extra modifiers, bare digits and other keys', () => {
    expect(railViewShortcutIndex(key('1'), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('1', { metaKey: true, shiftKey: true }), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('1', { metaKey: true, altKey: true }), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('1', { metaKey: true, ctrlKey: true }), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('a', { metaKey: true }), MAC)).toBeNull();
    expect(railViewShortcutIndex(key('ArrowLeft', { metaKey: true }), MAC)).toBeNull();
  });

  it('reads the physical key, so number rows that need Shift still work', () => {
    // AZERTY: the unshifted "1" key types "&".
    expect(railViewShortcutIndex({ ...key('&', { metaKey: true }), code: 'Digit1' }, MAC)).toBe(0);
    // Numpad: no Digit code, the key itself is the digit.
    expect(railViewShortcutIndex({ ...key('4', { metaKey: true }), code: 'Numpad4' }, MAC)).toBe(3);
  });

  it('labels the shortcut for tooltips and aria-keyshortcuts', () => {
    expect(railViewShortcutLabel(0, MAC)).toBe('⌘1');
    expect(railViewShortcutLabel(8, MAC)).toBe('⌘9');
    expect(railViewShortcutLabel(2, OTHER)).toBe('Ctrl+3');
    expect(railViewShortcutLabel(9, MAC)).toBeUndefined();
    expect(railViewShortcutLabel(-1, MAC)).toBeUndefined();
    expect(railViewAriaShortcut(0, MAC)).toBe('Meta+1');
    expect(railViewAriaShortcut(8, OTHER)).toBe('Control+9');
    expect(railViewAriaShortcut(9, MAC)).toBeUndefined();
  });
});

describe('panel toggle shortcut', () => {
  const MAC = true;
  const OTHER = false;

  it('is ⌃⌘S on macOS', () => {
    expect(isPanelToggleShortcut(key('s', { metaKey: true, ctrlKey: true }), MAC)).toBe(true);
    expect(isPanelToggleShortcut(key('S', { metaKey: true, ctrlKey: true }), MAC)).toBe(true);
    // Ctrl may turn the key into a control character — the physical key still counts.
    expect(
      isPanelToggleShortcut({ ...key('\u0013', { metaKey: true, ctrlKey: true }), code: 'KeyS' }, MAC),
    ).toBe(true);
    expect(panelToggleShortcutLabel(MAC)).toBe('⌃⌘S');
  });

  it('is Ctrl+Shift+S on Linux/Windows', () => {
    expect(isPanelToggleShortcut(key('S', { ctrlKey: true, shiftKey: true }), OTHER)).toBe(true);
    expect(panelToggleShortcutLabel(OTHER)).toBe('Ctrl+Shift+S');
  });

  it('stays clear of ⌘S, Ctrl+S (XOFF) and other combinations', () => {
    expect(isPanelToggleShortcut(key('s', { metaKey: true }), MAC)).toBe(false);
    expect(isPanelToggleShortcut(key('s', { ctrlKey: true }), MAC)).toBe(false);
    expect(isPanelToggleShortcut(key('s', { ctrlKey: true }), OTHER)).toBe(false);
    expect(isPanelToggleShortcut(key('s', { metaKey: true, ctrlKey: true, shiftKey: true }), MAC)).toBe(false);
    expect(isPanelToggleShortcut(key('s', { metaKey: true, ctrlKey: true, altKey: true }), MAC)).toBe(false);
    expect(isPanelToggleShortcut(key('d', { metaKey: true, ctrlKey: true }), MAC)).toBe(false);
    // The macOS chord means nothing elsewhere, and the other way round.
    expect(isPanelToggleShortcut(key('s', { metaKey: true, ctrlKey: true }), OTHER)).toBe(false);
    expect(isPanelToggleShortcut(key('S', { ctrlKey: true, shiftKey: true }), MAC)).toBe(false);
  });
});

describe('isAppChromeShortcut (what terminals let through)', () => {
  it('covers rail views and the panel toggle, nothing else', () => {
    expect(isAppChromeShortcut(key('2', { metaKey: true }), true)).toBe(true);
    expect(isAppChromeShortcut(key('2', { ctrlKey: true }), false)).toBe(true);
    expect(isAppChromeShortcut(key('s', { metaKey: true, ctrlKey: true }), true)).toBe(true);
    expect(isAppChromeShortcut(key('2'), true)).toBe(false);
    expect(isAppChromeShortcut(key('c', { ctrlKey: true }), false)).toBe(false);
    expect(isAppChromeShortcut(key('0', { metaKey: true }), true)).toBe(false);
  });
});
