// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { appMenuTarget } from './AppContextMenu';

describe('appMenuTarget', () => {
  const term = { getSelection: () => 'a whole sentence' } as unknown as Terminal;

  it('prefers the terminal under the pointer and captures its selection right away', () => {
    const inner = document.createElement('span');
    expect(appMenuTarget(inner, () => term)).toEqual({
      kind: 'terminal',
      term,
      selection: 'a whole sentence',
    });
  });

  it('recognises text fields', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(appMenuTarget(input, () => undefined)).toEqual({ kind: 'editable', el: input });
    const area = document.createElement('textarea');
    expect(appMenuTarget(area, () => undefined).kind).toBe('editable');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(appMenuTarget(box, () => undefined).kind).toBe('other');
  });

  it('falls back to the page selection elsewhere', () => {
    expect(appMenuTarget(document.body, () => undefined)).toEqual({ kind: 'other', selection: '' });
  });
});
