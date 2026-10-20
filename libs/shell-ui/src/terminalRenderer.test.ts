import { describe, it, expect, vi } from 'vitest';

// The addon UMD bundles touch `self` at import time — stub them so the module
// under test evaluates in a node env; all behavior is exercised through the
// injected factories anyway.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {}
  },
}));
vi.mock('@xterm/addon-canvas', () => ({
  CanvasAddon: class {
    activate() {}
    dispose() {}
  },
}));

import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import {
  applyTerminalRenderer,
  normalizeRendererMode,
  repaintTerminal,
  type RendererFactories,
} from './terminalRenderer';

function fakeAddon(id: string): ITerminalAddon & { id: string } {
  return { id, activate: vi.fn(), dispose: vi.fn() };
}

function fakeTerm(loadImpl?: (addon: ITerminalAddon) => void) {
  return { loadAddon: vi.fn(loadImpl) } as unknown as Pick<Terminal, 'loadAddon'>;
}

function factories(overrides: Partial<RendererFactories> = {}): RendererFactories {
  return {
    webgl: () => fakeAddon('webgl'),
    canvas: () => fakeAddon('canvas'),
    ...overrides,
  };
}

describe('normalizeRendererMode', () => {
  it('accepts the four modes, defaults everything else to auto', () => {
    expect(normalizeRendererMode('webgl')).toBe('webgl');
    expect(normalizeRendererMode('canvas')).toBe('canvas');
    expect(normalizeRendererMode('dom')).toBe('dom');
    expect(normalizeRendererMode('auto')).toBe('auto');
    expect(normalizeRendererMode(undefined)).toBe('auto');
    expect(normalizeRendererMode('gpu')).toBe('auto');
    expect(normalizeRendererMode(42)).toBe('auto');
  });
});

describe('applyTerminalRenderer', () => {
  it('dom loads nothing', () => {
    const term = fakeTerm();
    const res = applyTerminalRenderer(term, 'dom', factories());
    expect(res.applied).toBe('dom');
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('auto loads webgl', () => {
    const term = fakeTerm();
    const webgl = fakeAddon('webgl');
    const res = applyTerminalRenderer(term, 'auto', factories({ webgl: () => webgl }));
    expect(res.applied).toBe('webgl');
    expect(term.loadAddon).toHaveBeenCalledWith(webgl);
  });

  it('auto falls back to canvas when webgl fails to load', () => {
    const canvas = fakeAddon('canvas');
    const term = fakeTerm((a) => {
      if ((a as { id: string }).id === 'webgl') throw new Error('no webgl');
    });
    const res = applyTerminalRenderer(term, 'auto', factories({ canvas: () => canvas }));
    expect(res.applied).toBe('canvas');
    expect(term.loadAddon).toHaveBeenCalledWith(canvas);
  });

  it('auto lands on dom when webgl and canvas both fail', () => {
    const term = fakeTerm(() => {
      throw new Error('nope');
    });
    expect(applyTerminalRenderer(term, 'auto', factories()).applied).toBe('dom');
  });

  it('forced webgl does not fall back to canvas', () => {
    const term = fakeTerm(() => {
      throw new Error('nope');
    });
    const res = applyTerminalRenderer(term, 'webgl', factories());
    expect(res.applied).toBe('dom');
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('context loss in auto swaps webgl for canvas', () => {
    let contextLoss: (() => void) | undefined;
    const webgl = {
      ...fakeAddon('webgl'),
      onContextLoss: (cb: () => void) => {
        contextLoss = cb;
      },
    };
    const canvas = fakeAddon('canvas');
    const term = fakeTerm();
    const res = applyTerminalRenderer(
      term,
      'auto',
      factories({ webgl: () => webgl, canvas: () => canvas }),
    );
    expect(res.applied).toBe('webgl');
    contextLoss!();
    expect(webgl.dispose).toHaveBeenCalled();
    expect(term.loadAddon).toHaveBeenCalledWith(canvas);
  });

  it('context loss with a forced webgl setting stays on dom', () => {
    let contextLoss: (() => void) | undefined;
    const webgl = {
      ...fakeAddon('webgl'),
      onContextLoss: (cb: () => void) => {
        contextLoss = cb;
      },
    };
    const term = fakeTerm();
    applyTerminalRenderer(term, 'webgl', factories({ webgl: () => webgl }));
    contextLoss!();
    expect(webgl.dispose).toHaveBeenCalled();
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('dispose removes the renderer active after a context-loss fallback', () => {
    let contextLoss: (() => void) | undefined;
    const webgl = {
      ...fakeAddon('webgl'),
      onContextLoss: (cb: () => void) => {
        contextLoss = cb;
      },
    };
    const canvas = fakeAddon('canvas');
    const term = fakeTerm();
    const res = applyTerminalRenderer(
      term,
      'auto',
      factories({ webgl: () => webgl, canvas: () => canvas }),
    );
    contextLoss!();
    res.dispose();
    expect(canvas.dispose).toHaveBeenCalled();
  });
});

describe('repaintTerminal', () => {
  it('re-rasterizes glyphs before marking every row dirty', () => {
    const calls: string[] = [];
    const term = {
      rows: 24,
      clearTextureAtlas: () => calls.push('clear'),
      refresh: (start: number, end: number) => calls.push(`refresh ${start}-${end}`),
    };
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });
    try {
      repaintTerminal(term);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual(['clear', 'refresh 0-23']);
  });

  it('still refreshes a terminal without a texture atlas (DOM renderer)', () => {
    const refresh = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });
    try {
      repaintTerminal({ rows: 10, refresh });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(refresh).toHaveBeenCalledWith(0, 9);
  });
});
