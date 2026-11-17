// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { dropSessionBuffer, resizeSessionBuffer, serializeTerminal, trackSessionBuffer } from './terminalRegistry';

const written = (id: string, data: string) =>
  new Promise<void>((resolve) => trackSessionBuffer(id).write(data, resolve));

describe('session buffer size', () => {
  // A TUI repaint sized for 230 columns: draw a full-width rule, then step
  // back up one line, erase it and draw the prompt in its place.
  const rule = '─'.repeat(230);
  const repaint = `${rule}\r\n\x1b[1A\x1b[2K\r> prompt`;
  const leftover = '─'.repeat(80);

  it('a buffer sized to the view applies the repaint cleanly', async () => {
    trackSessionBuffer('wide');
    resizeSessionBuffer('wide', 230, 50);
    await written('wide', repaint);
    const replay = serializeTerminal('wide') ?? '';
    expect(replay).toContain('> prompt');
    expect(replay).not.toContain(leftover);
    dropSessionBuffer('wide');
  });

  it('an unsized 80-column buffer keeps rule fragments (the remount bug)', async () => {
    await written('narrow', repaint);
    expect(serializeTerminal('narrow') ?? '').toContain(leftover);
    dropSessionBuffer('narrow');
  });
});
