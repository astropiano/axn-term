// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  registerTerminal,
  serializeTerminal,
  setPendingReplay,
  stashTerminalReplays,
  takePendingReplay,
  takeReloadReplay,
  unregisterTerminal,
} from './terminalRegistry';

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

it('serializes a terminal with its colors, and replays it into another one', async () => {
  const source = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  await write(source, '$ make\r\n\x1b[31mred error\x1b[0m line\r\nsecond line\r\n$ ');
  registerTerminal('s-1', source);

  const data = serializeTerminal('s-1');
  expect(data).toContain('red error');
  expect(data).toContain('second line');
  // The color survives (SGR 31, possibly combined with other attributes).
  expect(data).toMatch(/\x1b\[[0-9;]*31[0-9;]*m/);

  // What a window adopting the session does: its terminal writes the replay.
  const target = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  await write(target, data!);
  const lines = (t: Terminal) =>
    Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? '')
      .filter(Boolean);
  expect(lines(target)).toEqual(lines(source));
  expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
  expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY);

  unregisterTerminal('s-1', source);
  expect(serializeTerminal('s-1')).toBeUndefined();
  source.dispose();
  target.dispose();
});

it('hands a replay over exactly once', () => {
  setPendingReplay('tab-1', 'history');
  expect(takePendingReplay('tab-1')).toBe('history');
  expect(takePendingReplay('tab-1')).toBeUndefined();
  expect(takePendingReplay('never-set')).toBeUndefined();
});

it('stashes every live terminal and replays each exactly once', async () => {
  const a = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const b = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  await write(a, 'screen of A');
  await write(b, 'screen of B');
  registerTerminal('sess-a', a);
  registerTerminal('tab-b', b);

  stashTerminalReplays(window.sessionStorage);
  expect(takeReloadReplay('sess-a')).toContain('screen of A');
  expect(takeReloadReplay('tab-b')).toContain('screen of B');
  expect(takeReloadReplay('sess-a')).toBeUndefined();
  expect(takeReloadReplay('gone')).toBeUndefined();

  unregisterTerminal('sess-a', a);
  unregisterTerminal('tab-b', b);
  a.dispose();
  b.dispose();
});
