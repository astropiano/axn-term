// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { applyTerminalRenderer, repaintTerminal } from './terminalRenderer';
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
