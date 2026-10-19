import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';

/** `terminalRenderer` config values. */
export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas' | 'dom';
/** The renderer that ended up active. */
export type TerminalRendererApplied = 'webgl' | 'canvas' | 'dom';

export function normalizeRendererMode(value: unknown): TerminalRendererMode {
  return value === 'webgl' || value === 'canvas' || value === 'dom' ? value : 'auto';
}

type ContextLossAddon = ITerminalAddon & { onContextLoss?: (cb: () => void) => void };

export interface RendererFactories {
  webgl?: () => ContextLossAddon;
  canvas?: () => ITerminalAddon;
}

/**
 * Load the cell renderer per the `terminalRenderer` setting. Call after
 * `term.open()`; the returned cleanup disposes whichever renderer ended up
 * active (renderer addons can also be hot-swapped — dispose the old handle
 * first, or just let `term.dispose()` cover it).
 *
 * - `dom`: nothing loaded (xterm's built-in DOM renderer).
 * - `canvas`/`webgl`: forced — load failure falls back to DOM only.
 * - `auto`: WebGL → canvas → DOM; a WebGL context loss also degrades to canvas.
 *
 * Returns the renderer that was applied.
 */
export function applyTerminalRenderer(
  term: Pick<Terminal, 'loadAddon'> & Partial<Pick<Terminal, 'clearTextureAtlas' | 'options'>>,
  mode?: string,
  factories: RendererFactories = {},
): { applied: TerminalRendererApplied; dispose: () => void } {
  const m = normalizeRendererMode(mode);
  let active: ITerminalAddon | null = null;
  const load = (addon: ITerminalAddon): void => {
    term.loadAddon(addon);
    active = addon;
  };
  const disposeActive = () => {
    try {
      active?.dispose();
    } catch {
      // already disposed (e.g. term.dispose() ran first)
    }
    active = null;
  };
  const noop = () => disposeActive();

  if (m === 'dom') return { applied: 'dom', dispose: noop };

  const createCanvas = factories.canvas ?? (() => new CanvasAddon());
  const tryCanvas = (): TerminalRendererApplied => {
    try {
      load(createCanvas());
      return 'canvas';
    } catch {
      return 'dom';
    }
  };

  if (m === 'canvas') return { applied: tryCanvas(), dispose: noop };

  const webgl = (factories.webgl ?? (() => new WebglAddon()))();
  webgl.onContextLoss?.(() => {
    disposeActive();
    if (m === 'auto') tryCanvas();
  });
  try {
    load(webgl);
    const stopGlyphRefresh = refreshGlyphsOnFontLoad(term);
    return {
      applied: 'webgl',
      dispose: () => {
        stopGlyphRefresh();
        disposeActive();
      },
    };
  } catch {
    return { applied: m === 'auto' ? tryCanvas() : 'dom', dispose: noop };
  }
}

/**
 * The WebGL renderer rasterizes each glyph into its texture atlas the first
 * time it is drawn and reuses it after that. A glyph first drawn while the
 * shell font (or one of its bold/italic faces) was still loading keeps the
 * fallback font's shape and baseline for good — letters end up shifted
 * against their neighbours. Re-rasterize once the font faces are loaded,
 * and again whenever the document finishes loading more fonts.
 */
function refreshGlyphsOnFontLoad(
  term: Partial<Pick<Terminal, 'clearTextureAtlas' | 'options'>>,
): () => void {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts || !term.clearTextureAtlas) return () => {};
  let disposed = false;
  const clear = () => {
    if (!disposed) term.clearTextureAtlas?.();
  };
  const family = term.options?.fontFamily;
  const size = term.options?.fontSize ?? 14;
  if (family) {
    void Promise.all(
      ['', 'bold ', 'italic ', 'italic bold '].map((style) =>
        fonts.load(`${style}${size}px ${family}`).catch(() => []),
      ),
    ).then(clear);
  }
  fonts.addEventListener('loadingdone', clear);
  return () => {
    disposed = true;
    fonts.removeEventListener('loadingdone', clear);
  };
}
