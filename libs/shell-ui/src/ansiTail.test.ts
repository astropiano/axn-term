// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { splitAnsiTail, stripAnsi } from './ShellTerminal';

it('passes text without escapes through whole', () => {
  expect(splitAnsiTail('plain output\n')).toEqual(['plain output\n', '']);
});

it('does not treat a complete trailing sequence as a tail', () => {
  expect(splitAnsiTail('ls\x1b[0m')).toEqual(['ls\x1b[0m', '']);
  expect(splitAnsiTail('cwd\x1b]7;file://host/a\x07')).toEqual([
    'cwd\x1b]7;file://host/a\x07',
    '',
  ]);
});

it('holds back an OSC sequence cut before its terminator', () => {
  // PTY chunk ends mid-OSC-7 — without the hold-back stripAnsi leaks the
  // `7;file://…` payload as literal text into retained output.
  const [complete, tail] = splitAnsiTail('prompt$ \x1b]7;file://Alex');
  expect(complete).toBe('prompt$ ');
  expect(tail).toBe('\x1b]7;file://Alex');

  // Feeding the tail into the next chunk lets stripAnsi remove it whole.
  const next = tail + 'andersMBP2/dir\x07real output';
  const [complete2, tail2] = splitAnsiTail(next);
  expect(tail2).toBe('');
  expect(stripAnsi(complete2)).toBe('real output');
});

it('holds back an incomplete CSI sequence', () => {
  expect(splitAnsiTail('text\x1b[31')).toEqual(['text', '\x1b[31']);
  expect(splitAnsiTail('text\x1b[')).toEqual(['text', '\x1b[']);
  expect(splitAnsiTail('text\x1b')).toEqual(['text', '\x1b']);
});

it('treats a lone ESC prefix of a plain character as complete', () => {
  // \x1bc is a complete two-char sequence — stripAnsi already handles it.
  expect(splitAnsiTail('x\x1bc')).toEqual(['x\x1bc', '']);
});

it('flushes tails that outgrow the cap as garbage', () => {
  const huge = 'x\x1b]' + 'a'.repeat(5000);
  const [complete, tail] = splitAnsiTail(huge);
  expect(tail).toBe('');
  expect(complete).toBe(huge);
});
