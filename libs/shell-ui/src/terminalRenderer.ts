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
  const finish = (applied: TerminalRendererApplied) => {
    axnLog('debug', 'terminal-renderer', `mode=${m} applied=${applied}`);
    return { applied, dispose: noop };
  };

  if (m === 'dom') return finish('dom');

  const createCanvas = factories.canvas ?? (() => new CanvasAddon());
  const tryCanvas = (): TerminalRendererApplied => {
    try {
      load(createCanvas());
      return 'canvas';
    } catch {
      return 'dom';
    }
  };

  if (m === 'canvas') return finish(tryCanvas());
  if (m === 'auto' && liveWebglContexts >= MAX_WEBGL_CONTEXTS) {
    return finish(tryCanvas());
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
    if (m === 'auto') {
      const next = tryCanvas();
      axnLog('warn', 'terminal-renderer', `webgl context lost — fell back to ${next}`);
    }
  });
  try {
    load(webgl);
    liveWebglContexts++;
    counted = true;
    axnLog('debug', 'terminal-renderer', `mode=${m} applied=webgl`);
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
    return finish(m === 'auto' ? tryCanvas() : 'dom');
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

/**
 * OSC 10/11/12 color-report replies that xterm.js emits on the input channel
 * when a program queries the terminal colors (`ESC ] 1x ; ?`). TUIs commonly
 * ask before switching the tty to raw mode — while the tty is still in
 * cooked+echo mode the kernel echoes the reply as visible text
 * (`10;rgb:…11;rgb:…` at the prompt). Delaying a report briefly gives the
 * reader time to reach raw mode, so it is consumed as input instead of
 * echoed. Backends with `writeWhenRaw` gate the reply on the slave's real
 * termios (ECHO/ICANON cleared) — deterministic. Others fall back to a short
 * delay. Only a chunk that consists *entirely* of color reports is gated —
 * user input in the same chunk always goes straight through.
 */
export const OSC_COLOR_REPORT_RE = /^(\x1b\]1[012];[^\x07\x1b]+(?:\x07|\x1b\\))+$/;
const OSC_COLOR_REPORT_DELAY_MS = 75;

/** A hung alive probe must not freeze input — fall back to the raw gate after this. */
const OSC_REPORT_PROBE_TIMEOUT_MS = 1000;

/**
 * How long `writeWhenRaw` may hold a report inside the input queue waiting
 * for the cooked→raw flip. The real transition takes tens of ms; anything
 * past this means the asker died or reads cooked input — the reply is
 * dropped rather than echoed or typed.
 */
export const OSC_REPORT_RAW_WAIT_MS = 2000;

/**
 * Data xterm emits on the input channel *itself*, in answer to program
 * queries — not user actions: OSC replies (color reports, icon title),
 * private-CSI replies (DA `\x1b[?…c`, DECRPM `\x1b[?…y`, kitty keyboard
 * `\x1b[?…u`), CPR (`\x1b[r;cR`), window replies (`\x1b[…t`), status
 * (`\x1b[n`) and DCS replies (DECRQSS, XTGETTCAP). User keys never produce
 * `?`-CSI; public key sequences (arrows, F-keys, mouse `…M`/`m`) are kept.
 */
const TERMINAL_REPLY_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?[0-9;]*[a-zA-Z]|\x1b\[\d+;\d+(?:;\d+)?[Rt]|\x1b\[\d+n|\x1bP[^\x1b]*\x1b\\/g;

/**
 * True when an `onData` chunk carries user-produced input — false for
 * chunks made entirely of terminal-generated query replies. Used to tell
 * "the user did something in this session" (clears attention flags) apart
 * from the terminal answering probes on its own.
 */
export function isUserInput(data: string): boolean {
  return data.replace(TERMINAL_REPLY_RE, '') !== '';
}

export interface TerminalInput {
  /** Terminal input (xterm `onData`, key bar): OSC color reports are gated. */
  send: (data: string) => void;
  /** Raw PTY write that still queues behind a pending report. */
  write: (data: string) => void;
}

/**
 * Per-PTY input writer. OSC color reports are handled by `reportTarget`,
 * when given: it freshly resolves whether a program is still foreground —
 * a live asker gets the answer as soon as the probe returns (real terminals
 * never delay; devin's startup probe and friends poll with a deadline and a
 * late reply lands as typed `11;rgb:…` in their input), while a shell-comm
 * or missing foreground means dead letter → dropped. Without `reportTarget`
 * falls back to `writeWhenRaw` (raw-mode polling), then to a plain ~75 ms
 * delayed write.
 *
 * Everything written after a gated report waits behind it, so the PTY sees
 * input in the order xterm produced it. Askers send a DA1 query (`ESC[c`)
 * after their OSC queries as a sentinel — once its answer arrives they stop
 * waiting for color replies, so a DA1 reply overtaking a report still in
 * its async probe leaves the report to be read as typed `10;rgb:…11;rgb:…`
 * (devin, every launch). `writeWhenRaw` resolves only after the backend
 * actually wrote (or dropped) the report, so the queue still holds later
 * input — including the DA1 — behind it.
 */
export function createTerminalInput(
  write: (data: string) => void,
  writeWhenRaw?: (data: string) => Promise<boolean>,
  reportTarget?: () => Promise<boolean>,
): TerminalInput {
  const queue: (string | Promise<string | null>)[] = [];
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const item = queue.shift()!;
      const data = typeof item === 'string' ? item : await item;
      if (data !== null) safely('terminal input', () => write(data));
    }
    draining = false;
  };
  const writeOrdered = (data: string) => {
    if (queue.length === 0 && !draining) write(data);
    else queue.push(data);
  };
  const enqueue = (pending: Promise<string | null>) => {
    queue.push(pending);
    void drain();
  };
  const send = (data: string) => {
    if (!OSC_COLOR_REPORT_RE.test(data)) return writeOrdered(data);
    // Normalize every reply to BEL terminator: xterm.js reports with ST
    // (`\x1b\\`) but TUIs that query with BEL (devin, crossterm) often only
    // parse BEL-terminated replies — an ST reply is unrecognized and gets
    // rendered as typed input (`11;rgb:…` in the agent's text field).
    const report = data.replace(/\x1b\\/g, '\x07');
    if (reportTarget) {
      // A live asker gets the answer through the backend's termios gate:
      // the write lands at the cooked→raw flip (the first bytes the raw
      // reader sees, inside devin's probe window) — writing straight into
      // a still-cooked tty echoes the reply and canonical-buffers it into
      // the asker's input as typed `10;rgb:…` once it goes raw. Dead
      // letters (shell comm/no foreground) drop at the probe; a probe that
      // hangs falls through to the raw gate rather than delivering blind.
      enqueue(
        (async (): Promise<string | null> => {
          const alive = await new Promise<boolean | undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), OSC_REPORT_PROBE_TIMEOUT_MS);
            reportTarget().then(
              (a) => resolve(a),
              () => resolve(true), // a failed read is treated as alive — fail-open
            ).finally(() => clearTimeout(timer));
          });
          if (alive === false) return null;
          if (writeWhenRaw) {
            await writeWhenRaw(report).catch(() => false);
            return null; // the backend wrote it at the raw flip — or dropped it still-cooked
          }
          return report;
        })(),
      );
    } else if (writeWhenRaw) {
      // No alive probe: the termios gate alone decides, but the write must
      // still hold the queue so a DA1 reply cannot overtake it.
      enqueue(writeWhenRaw(report).then(() => null, () => null));
    } else {
      enqueue(new Promise((resolve) => setTimeout(() => resolve(report), OSC_COLOR_REPORT_DELAY_MS)));
    }
  };
  return { send, write: writeOrdered };
}

/** Foreground comms that mean "the shell itself" — not a program asking. */
const SHELL_FOREGROUND_RE = /^(ba|z|da|fi)?sh$|^fish$|^nu$|^(pwsh|powershell|cmd)(\.exe)?$/;

/**
 * `reportTarget` for `sendTerminalInput` built on the backend's fresh
 * `getForegroundProcess` — null (web) or a shell comm (desktop returns the
 * fg pgrp leader's name, e.g. `zsh`) means the shell itself is foreground,
 * so no asker remains and the report is dropped. A failed read delivers
 * (fail-open: losing a legit answer is worse than an echoed one).
 */
export function oscReportTarget(
  getForeground: ((id: string) => Promise<string | null>) | undefined,
  sessionId: string,
): (() => Promise<boolean>) | undefined {
  if (!getForeground) return undefined;
  return () =>
    getForeground(sessionId).then(
      (fg) => !!fg && !SHELL_FOREGROUND_RE.test(fg),
      () => true,
    );
}
