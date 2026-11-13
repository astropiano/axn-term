// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isRenameShortcut, isTextEntryTarget } from './shortcuts';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('isRenameShortcut', () => {
  it('matches a bare F2 only', () => {
    expect(isRenameShortcut(key('F2'))).toBe(true);
    expect(isRenameShortcut(key('F2', { metaKey: true }))).toBe(false);
    expect(isRenameShortcut(key('F2', { shiftKey: true }))).toBe(false);
    expect(isRenameShortcut(key('F3'))).toBe(false);
  });
});

describe('isTextEntryTarget', () => {
  it('treats text fields and terminals as text entry', () => {
    const input = document.createElement('input');
    const term = document.createElement('div');
    term.className = 'xterm';
    const helper = document.createElement('textarea');
    term.appendChild(helper);
    const button = document.createElement('button');
    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(helper)).toBe(true);
    expect(isTextEntryTarget(term)).toBe(true);
    expect(isTextEntryTarget(button)).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
