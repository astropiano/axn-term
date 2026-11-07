// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { applyTerminalRenderer, createTerminalInput, isUserInput, repaintTerminal } from './terminalRenderer';
import type { Terminal } from '@xterm/xterm';
import type { ITerminalAddon } from '@xterm/xterm';

type FakeTerm = Pick<Terminal, 'loadAddon'> &
  Partial<Pick<Terminal, 'clearTextureAtlas' | 'options' | 'refresh' | 'rows'>>;

function fakeTerm(overrides: Partial<FakeTerm> = {}): FakeTerm & { addons: ITerminalAddon[] } {
  const addons: ITerminalAddon[] = [];
  return {
    addons,
    loadAddon: (a: ITerminalAddon) => {
      addons.push(a);
      a.activate({} as Terminal);
    },
    options: {},
    ...overrides,
  };
}

function fakeAddon(onDispose?: () => void): ITerminalAddon {
  return { activate: () => {}, dispose: () => onDispose?.() };
}

function throwingAddon(): ITerminalAddon {
  return {
    activate: () => {
      throw new Error('boom');
    },
    dispose: () => {},
  };
}

describe('applyTerminalRenderer', () => {
  it('auto prefers webgl when the pool is free', () => {
    const term = fakeTerm();
    const { applied, dispose } = applyTerminalRenderer(term, 'auto', {
      webgl: () => fakeAddon() as never,
    });
    expect(applied).toBe('webgl');
    dispose();
  });

  it('never throws when the webgl addon throws in activate', () => {
    const term = fakeTerm();
    // A dead GPU/webview throws — auto must degrade, not propagate.
    expect(() =>
      applyTerminalRenderer(term, 'auto', {
        webgl: () => throwingAddon() as never,
        canvas: () => fakeAddon(),
      }),
    ).not.toThrow();
  });

  it('falls back to canvas when webgl fails under auto', () => {
    const term = fakeTerm();
    const { applied } = applyTerminalRenderer(term, 'auto', {
      webgl: () => throwingAddon() as never,
      canvas: () => fakeAddon(),
    });
    expect(applied).toBe('canvas');
  });

  it('forced webgl degrades to dom on failure', () => {
    const term = fakeTerm();
    const { applied } = applyTerminalRenderer(term, 'webgl', {
      webgl: () => throwingAddon() as never,
      canvas: () => fakeAddon(),
    });
    expect(applied).toBe('dom');
  });

  it('forced canvas degrades to dom on failure', () => {
    const term = fakeTerm();
    const { applied } = applyTerminalRenderer(term, 'canvas', {
      canvas: () => throwingAddon(),
    });
    expect(applied).toBe('dom');
  });

  it('stops offering webgl once the context pool is full', () => {
    // Saturate the pool.
    const holders = Array.from({ length: 8 }, () =>
      applyTerminalRenderer(fakeTerm(), 'auto', { webgl: () => fakeAddon() as never }),
    );
    const term = fakeTerm();
    const { applied } = applyTerminalRenderer(term, 'auto', {
      webgl: () => fakeAddon() as never,
      canvas: () => fakeAddon(),
    });
    expect(applied).toBe('canvas');
    holders.forEach((h) => h.dispose());
  });

  it('frees a pool slot on dispose', () => {
    const holders = Array.from({ length: 8 }, () =>
      applyTerminalRenderer(fakeTerm(), 'auto', { webgl: () => fakeAddon() as never }),
    );
    holders[0].dispose();
    const { applied, dispose } = applyTerminalRenderer(fakeTerm(), 'auto', {
      webgl: () => fakeAddon() as never,
    });
    expect(applied).toBe('webgl');
    holders.forEach((h) => h.dispose());
    dispose();
  });

  it('frees a pool slot on context loss', () => {
    let contextLoss: (() => void) | undefined;
    const holder = applyTerminalRenderer(fakeTerm(), 'auto', {
      webgl: () => {
        const addon = fakeAddon() as ITerminalAddon & { onContextLoss?: (cb: () => void) => void };
        addon.onContextLoss = (cb) => {
          contextLoss = cb;
        };
        return addon as never;
      },
      canvas: () => fakeAddon(),
    });
    contextLoss?.();
    const { applied, dispose } = applyTerminalRenderer(fakeTerm(), 'auto', {
      webgl: () => fakeAddon() as never,
    });
    expect(applied).toBe('webgl');
    holder.dispose();
    dispose();
  });
});

describe('repaintTerminal', () => {
  it('never throws on a torn-down terminal', () => {
    const dead = {
      refresh: () => {
        throw new Error('renderService gone');
      },
      clearTextureAtlas: () => {
        throw new Error('renderer gone');
      },
      rows: 24,
    };
    expect(() => repaintTerminal(dead as never)).not.toThrow();
    return new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
});

describe('isUserInput', () => {
  it('is true for typed input and pastes', () => {
    expect(isUserInput('x')).toBe(true);
    expect(isUserInput('ls -la\r')).toBe(true);
    expect(isUserInput('\x1b[200~pasted text\x1b[201~')).toBe(true);
  });

  it('is true for user-generated escape sequences', () => {
    expect(isUserInput('\x1b[A')).toBe(true); // arrow up
    expect(isUserInput('\x1b[<0;10;5M')).toBe(true); // mouse click
    expect(isUserInput('\x1b[1;5u')).toBe(true); // kitty key press
  });

  it('is false for terminal-generated query replies', () => {
    expect(isUserInput('\x1b]10;rgb:4f4f/6060/6666\x07')).toBe(false); // OSC color
    expect(isUserInput('\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\')).toBe(false); // ST-ended
    expect(isUserInput('\x1b[?1;2c')).toBe(false); // DA1 — devin's sentinel
    expect(isUserInput('\x1b[1;5R')).toBe(false); // CPR
    expect(isUserInput('\x1b[?1;2y')).toBe(false); // DECRPM
    expect(isUserInput('\x1b[?1u')).toBe(false); // kitty keyboard flags
    expect(isUserInput('\x1b[8;24;80t')).toBe(false); // window size reply
    expect(isUserInput('\x1b[0n')).toBe(false); // status ok
    expect(isUserInput('\x1bP$r q\x1b\\')).toBe(false); // DECRQSS
  });

  it('is false for a batch of only replies, true when mixed with input', () => {
    const replies = '\x1b]10;rgb:aaaa/bbbb/cccc\x07\x1b[?1;2c';
    expect(isUserInput(replies)).toBe(false);
    expect(isUserInput(replies + 'x')).toBe(true);
  });
});

describe('createTerminalInput', () => {
  const OSC10 = '\x1b]10;rgb:4f4f/6060/6666\x07';
  const OSC11 = '\x1b]11;rgb:fdfd/f6f6/e3e3\x07';
  const DA1 = '\x1b[?1;2c';

  it('passes normal input through synchronously', () => {
    const writes: string[] = [];
    const input = createTerminalInput((d) => writes.push(d));
    input.send('ls\r');
    input.send('\x1b[3;5R');
    expect(writes).toEqual(['ls\r', '\x1b[3;5R']);
  });

  it('defers a chunk that is only OSC color reports', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const batched = OSC10 + OSC11;
      createTerminalInput((d) => writes.push(d)).send(batched);
      expect(writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(writes).toEqual([batched]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands OSC-only chunks to writeWhenRaw when the backend supports it', () => {
    const writes: string[] = [];
    const raw: string[] = [];
    createTerminalInput(
      (d) => writes.push(d),
      (d) => {
        raw.push(d);
        return Promise.resolve(true);
      },
    ).send(OSC10);
    expect(raw).toEqual([OSC10]);
    expect(writes).toEqual([]);
  });

  it('holds a DA1 reply behind a writeWhenRaw report that is still waiting', async () => {
    const writes: string[] = [];
    const raws: ((wrote: boolean) => void)[] = [];
    const input = createTerminalInput(
      (d) => writes.push(d),
      () => new Promise<boolean>((r) => raws.push(r)),
    );
    input.send(OSC10);
    input.send(DA1);
    input.write('typed');
    expect(writes).toEqual([]);
    raws.forEach((resolve) => resolve(true));
    await vi.waitFor(() => expect(writes).toEqual([DA1, 'typed']));
  });

  it('routes a live-asker report through the raw gate, never the direct write', async () => {
    const writes: string[] = [];
    const raw: string[] = [];
    const probes: ((alive: boolean) => void)[] = [];
    const input = createTerminalInput(
      (d) => writes.push(d),
      (d) => {
        raw.push(d);
        return Promise.resolve(true);
      },
      () => new Promise<boolean>((r) => probes.push(r)),
    );
    input.send(OSC10);
    input.send(DA1);
    expect(raw).toEqual([]);
    probes.forEach((resolve) => resolve(true));
    await vi.waitFor(() => expect(raw).toEqual([OSC10]));
    // writeWhenRaw carries the report; the plain writer only sees the DA1.
    await vi.waitFor(() => expect(writes).toEqual([DA1]));
  });

  it('drops a dead-letter report without touching the raw gate', async () => {
    const writes: string[] = [];
    const raw: string[] = [];
    const input = createTerminalInput(
      (d) => writes.push(d),
      (d) => {
        raw.push(d);
        return Promise.resolve(true);
      },
      () => Promise.resolve(false),
    );
    input.send(OSC11);
    input.send('x');
    await vi.waitFor(() => expect(writes).toEqual(['x']));
    expect(raw).toEqual([]);
  });

  it('a hung probe falls through to the raw gate instead of delivering blind', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const raw: string[] = [];
      const input = createTerminalInput(
        (d) => writes.push(d),
        (d) => {
          raw.push(d);
          return Promise.resolve(true);
        },
        () => new Promise<boolean>(() => {}),
      );
      input.send(OSC11);
      input.send(DA1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(raw).toEqual([OSC11]);
      expect(writes).toEqual([DA1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not defer a report mixed with user input', () => {
    const writes: string[] = [];
    createTerminalInput((d) => writes.push(d)).send(`\x1b]10;rgb:aaaa/bbbb/cccc\x07x`);
    expect(writes).toEqual(['\x1b]10;rgb:aaaa/bbbb/cccc\x07x']);
  });

  it('normalizes ST-terminated reports to BEL', async () => {
    const writes: string[] = [];
    createTerminalInput((d) => writes.push(d), undefined, () => Promise.resolve(true)).send(
      '\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\',
    );
    await vi.waitFor(() => expect(writes).toEqual([OSC11]));
  });

  // devin queries `ESC]10;? ESC]11;? ESC[c` — the DA1 answer is its
  // sentinel: once it arrives, OSC replies are no longer expected and a
  // later one is read as typed `10;rgb:…11;rgb:…`. The report's alive
  // probe is async, so the DA1 reply must wait behind it.
  it('keeps a DA1 reply behind OSC reports whose probe is pending', async () => {
    const writes: string[] = [];
    const probes: ((alive: boolean) => void)[] = [];
    const input = createTerminalInput(
      (d) => writes.push(d),
      undefined,
      () => new Promise<boolean>((r) => probes.push(r)),
    );
    input.send(OSC10);
    input.send(OSC11);
    input.send(DA1);
    input.write('typed');
    expect(writes).toEqual([]);
    probes.forEach((resolve) => resolve(true));
    await vi.waitFor(() => expect(writes).toEqual([OSC10, OSC11, DA1, 'typed']));
  });

  it('drops dead-letter reports but still releases what queued behind them', async () => {
    const writes: string[] = [];
    const input = createTerminalInput((d) => writes.push(d), undefined, () => Promise.resolve(false));
    input.send(OSC11);
    input.send('x');
    await vi.waitFor(() => expect(writes).toEqual(['x']));
  });

  it('delivers when the probe fails or hangs (fail-open)', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const failing = createTerminalInput((d) => writes.push(d), undefined, () => Promise.reject(new Error('x')));
      failing.send(OSC10);
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual([OSC10]);
      writes.length = 0;
      const hanging = createTerminalInput((d) => writes.push(d), undefined, () => new Promise<boolean>(() => {}));
      hanging.send(OSC11);
      hanging.send(DA1);
      expect(writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(writes).toEqual([OSC11, DA1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
