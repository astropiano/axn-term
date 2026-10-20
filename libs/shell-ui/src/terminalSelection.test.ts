// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { handleClipboardWrites, parseOsc52, registerTerminalElement, terminalSelection } from './terminalRegistry';

/** Just enough xterm: a selection the test sets and a change listener. */
function fakeTerm() {
  let selection = '';
  let listener = () => {};
  const term = {
    getSelection: () => selection,
    onSelectionChange: (cb: () => void) => {
      listener = cb;
      return { dispose: () => {} };
    },
  } as unknown as Terminal;
  const select = (text: string) => {
    selection = text;
    listener();
  };
  return { term, select };
}

describe('terminalSelection', () => {
  it('keeps the user\'s selection when something else clears it', () => {
    const el = document.createElement('div');
    const { term, select } = fakeTerm();
    registerTerminalElement(el, term);
    select('a whole sentence');
    // e.g. the foreground program's input handling dropping the selection
    select('');
    el.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    expect(terminalSelection(term)).toBe('a whole sentence');
    // ⌘C is not a deselect
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));
    expect(terminalSelection(term)).toBe('a whole sentence');
  });

  it('forgets it when the user deselects: left click or typing', () => {
    const el = document.createElement('div');
    const { term, select } = fakeTerm();
    registerTerminalElement(el, term);
    select('first');
    select('');
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(terminalSelection(term)).toBe('');
    select('second');
    select('');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(terminalSelection(term)).toBe('');
  });

  it('prefers the live selection', () => {
    const el = document.createElement('div');
    const { term, select } = fakeTerm();
    registerTerminalElement(el, term);
    select('old');
    select('new');
    expect(terminalSelection(term)).toBe('new');
  });
});

describe('OSC 52 clipboard writes', () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  it('decodes a set-clipboard payload, UTF-8 included', () => {
    expect(parseOsc52(`c;${b64('Opus 5.5 · Claude Team')}`)).toBe('Opus 5.5 · Claude Team');
    expect(parseOsc52(`;${b64('no target')}`)).toBe('no target');
  });

  it('refuses reads, clears and garbage', () => {
    expect(parseOsc52('c;?')).toBeUndefined();
    expect(parseOsc52('c;')).toBeUndefined();
    expect(parseOsc52('c;***')).toBeUndefined();
    expect(parseOsc52('nosep')).toBeUndefined();
  });

  it('copies through the app clipboard and offers the text to Copy', () => {
    let handler: (data: string) => boolean = () => false;
    const { term } = fakeTerm();
    (term as unknown as { parser: unknown }).parser = {
      registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
        expect(ident).toBe(52);
        handler = cb;
        return { dispose: () => {} };
      },
    };
    const copied: string[] = [];
    registerTerminalElement(document.createElement('div'), term);
    handleClipboardWrites(term, (text) => copied.push(text));
    expect(handler(`c;${b64('selected in the TUI')}`)).toBe(true);
    expect(copied).toEqual(['selected in the TUI']);
    expect(terminalSelection(term)).toBe('selected in the TUI');
  });
});
