import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { axnLog } from './app/log';

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
// Chrome keeps ~16 live WebGL contexts and force-loses the OLDEST past
// that — with a couple of dozen mounted terminals (mirrored remote
// sessions all mount), every mount blindly claiming WebGL first creates a
// lose-and-restore churn loop (blank/dead terminals, flicker). Stop
// offering WebGL once the pool is saturated; canvas/dom is plenty fast.
const MAX_WEBGL_CONTEXTS = 8;
let liveWebglContexts = 0;

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
  if (m === 'auto' && liveWebglContexts >= MAX_WEBGL_CONTEXTS) {
    return { applied: tryCanvas(), dispose: noop };
  }

  const webgl = (factories.webgl ?? (() => new WebglAddon()))();
  let counted = false;
  const release = () => {
    if (counted) {
      counted = false;
      liveWebglContexts--;
    }
  };
  webgl.onContextLoss?.(() => {
    // The browser already killed this context — hand the slot back.
    release();
    disposeActive();
    if (m === 'auto') tryCanvas();
  });
  try {
    load(webgl);
    liveWebglContexts++;
    counted = true;
    const stopGlyphRefresh = refreshGlyphsOnFontLoad(term);
    return {
      applied: 'webgl',
      dispose: () => {
        release();
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

/**
 * Repaint a terminal that just became visible again. While display:none,
 * the webview may drop the accelerated canvas' backing — and with WebGL
 * also corrupt the glyph texture atlas, so a plain refresh() repaints
 * garbage from the stale atlas. Re-rasterize the glyphs, then mark every
 * row dirty (needed for the DOM/canvas renderers too, where nothing else
 * dirties rows when no output arrived while hidden). Deferred one frame so
 * it runs after the container is laid out again.
 */
export function repaintTerminal(term: Pick<Terminal, 'refresh' | 'rows'> & Partial<Pick<Terminal, 'clearTextureAtlas'>>): void {
  // The deferred frame can land after the view unmounted and disposed the
  // terminal — a throw there must not escape.
  const run = () =>
    safely('repaint terminal', () => {
      term.clearTextureAtlas?.();
      term.refresh(0, term.rows - 1);
    });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

/**
 * Run one teardown step, logging instead of throwing. Unmount cleanups chain
 * several disposals (renderer addons, listeners, the xterm itself); an
 * exception escaping a React effect cleanup tears down the whole app and
 * leaves an empty window, and it would also skip the remaining steps.
 */
export function safely(scope: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    axnLog('warn', 'terminal', `${scope} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
