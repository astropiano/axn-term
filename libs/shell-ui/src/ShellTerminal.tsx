import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { PathStat, SessionBackend, Unsubscribe } from '@axn-term/session-backend';
import { PathActionMenu } from './PathActionMenu';
import { placeHoverCard } from './hoverCardPlacement';
import type { ShellSession } from './types';
import { useSettings } from './SettingsProvider';
import { getXtermColors, resolveShellFont } from './themes';
import { registerTerminal, takePendingReplay, takeReloadReplay, takePtyKeepAlive, unregisterTerminal, registerTerminalElement, terminalSelection, handleClipboardWrites, registerTerminalInput, unregisterTerminalInput, type TerminalInput } from './terminalRegistry';
import { applyTerminalRenderer, createTerminalInput, isUserInput, oscReportTarget, repaintTerminal, safely } from './terminalRenderer';
import { acquirePty } from './ptyLifetime';
import { foregroundStatusPatch } from './foregroundStatus';
import {
  createLookupCache,
  createOsc8LeakGuard,
  OSC8_CLOSE,
  extractLinkTokens,
  extendWrappedUrl,
  findWrappedUrlThrough,
  URL_START_RE,
  type GetLinkLine,
  wrappedSelectionCandidates,
} from './terminalLinks';
import { agentInputPluginFor, agentInputPluginForTitle } from './app/session-plugins/agentHookBridge';
import { createHiddenCommandInput } from './app/hiddenCommands';
import { isAppNavigationShortcut, isReloadShortcut } from './app/shortcuts';
import { useShellServices } from './services';
import { axnLog } from './app/log';
import { createFlowControl } from './flowControl';

import '@xterm/xterm/css/xterm.css';

interface ShellTerminalProps {
  session: ShellSession;
  /** Environment backend — Tauri invoke/events on desktop, gateway WS online. */
  backend: SessionBackend;
  onSessionNameChange?: (sessionId: string, name: string) => void;
  onSessionOutput?: (sessionId: string, text: string) => void;
  onEditorRequest?: (sessionId: string, path: string) => void;
  onBrowserRequest?: (sessionId: string, path: string) => void;
  onPreviewRequest?: (sessionId: string, path: string) => void;
  onSessionCommand?: (
    sessionId: string,
    line: string,
  ) => string | false | undefined | Promise<string | false | undefined>;
  /**
   * Tab-completion for `axn-*` hidden commands. Given the current input line,
   * resolves the full-line candidates; the terminal applies a unique match or
   * the longest common prefix.
   */
  onCompleteInput?: (sessionId: string, line: string) => Promise<string[]>;
  updateSession?: (sessionId: string, patch: Partial<ShellSession>) => void;
  /**
   * Fired on input the user produced (keys, paste, key bar, mouse reports)
   * — never for terminal-generated query replies. Used to clear the
   * session's attention flags once the user engages with it.
   */
  onUserInput?: (sessionId: string) => void;
  isVisible?: boolean;
  onSessionReady?: (session: ShellSession) => void;
}

interface HoverCardState {
  /** Pointer position relative to the terminal — the card's anchor. */
  x: number;
  y: number;
  /** Absolute file path — or the URL itself when `isUrl` is set. */
  resolvedPath: string;
  isDir: boolean;
  isUrl?: boolean;
  copyOnly?: boolean;
}

const URL_TOKEN = /^https?:\/\/\S+$/i;
const FILE_URL_TOKEN = /^file:\/\/\S+$/i;

const HOVER_DELAY_MS = 500;
const HOVER_HIDE_MS = 250;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|][^\x07]*(?:\x07|\x1B\\)|\([A-Za-z0-9]|\)[A-Za-z0-9])/g,
    '',
  );
}

export function ShellTerminal({
  session,
  backend,
  onSessionNameChange,
  onSessionOutput,
  onEditorRequest,
  onBrowserRequest,
  onPreviewRequest,
  onSessionCommand,
  onCompleteInput,
  updateSession,
  onUserInput,
  isVisible,
  onSessionReady,
}: ShellTerminalProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const agentInputRef = useRef(session.agentInput);
  const shellNameRef = useRef('');
  const cwdRef = useRef(session.cwd ?? '');
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isVisibleRef = useRef(isVisible);
  const onEditorRequestRef = useRef(onEditorRequest);
  onEditorRequestRef.current = onEditorRequest;
  const onBrowserRequestRef = useRef(onBrowserRequest);
  onBrowserRequestRef.current = onBrowserRequest;
  const onPreviewRequestRef = useRef(onPreviewRequest);
  onPreviewRequestRef.current = onPreviewRequest;
  const onSessionCommandRef = useRef(onSessionCommand);
  onSessionCommandRef.current = onSessionCommand;
  const onCompleteInputRef = useRef(onCompleteInput);
  onCompleteInputRef.current = onCompleteInput;
  const onSessionReadyRef = useRef(onSessionReady);
  onSessionReadyRef.current = onSessionReady;
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  const { activeTheme, settings } = useSettings();
  const { services } = useShellServices();
  // Disposes the active GPU renderer addon when the setting hot-swaps; the
  // addon itself is also disposed by term.dispose() on teardown.
  const rendererCleanupRef = useRef<(() => void) | null>(null);
  const rendererMountedRef = useRef(false);
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
  // Measured placement of the visible card — below/right of the pointer, or
  // flipped above/left when it would leave the terminal.
  const [hoverCardPos, setHoverCardPos] = useState<{ left: number; top: number } | null>(null);
  const hoverCardRef = useRef<HoverCardState | null>(null);
  const hoverCardElRef = useRef<HTMLDivElement | null>(null);
  const lastHoverPathRef = useRef<string | null>(null);
  const hoverShowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimers = () => {
    if (hoverShowTimer.current) {
      clearTimeout(hoverShowTimer.current);
      hoverShowTimer.current = null;
    }
    if (hoverHideTimer.current) {
      clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
  };

  useEffect(() => {
    clearHoverTimers();
    setHoverCard(null);
  }, [session.id]);

  useEffect(() => {
    hoverCardRef.current = hoverCard;
  }, [hoverCard]);

  const showHoverCard = (
    event: MouseEvent,
    stat: PathStat,
    isUrl = false,
    delay = HOVER_DELAY_MS,
    copyOnly = false,
  ) => {
    clearHoverTimers();
    hoverShowTimer.current = setTimeout(() => {
      const rect = terminalRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Placement relative to the card's measured size happens on render.
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setHoverCard({ x, y, resolvedPath: stat.path, isDir: stat.isDir, isUrl, copyOnly });
    }, delay);
  };

  const armHoverHide = (delay: number) => {
    if (hoverHideTimer.current) clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = setTimeout(() => {
      // Never hide while the pointer is over the card. `mouseenter` can be
      // missed entirely when the card materializes under a stationary cursor
      // (the y position is clamped near the bottom edge), and xterm re-fires
      // `leave` on every viewport re-render.
      if (hoverCardElRef.current?.matches(':hover')) return;
      setHoverCard(null);
    }, delay);
  };

  const scheduleHideHoverCard = (delay = HOVER_HIDE_MS) => {
    if (hoverShowTimer.current) {
      clearTimeout(hoverShowTimer.current);
      hoverShowTimer.current = null;
    }
    armHoverHide(delay);
  };

  const cancelHideHoverCard = () => {
    if (hoverHideTimer.current) {
      clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
  };

  useEffect(() => {
    cwdRef.current = session.cwd ?? '';
  }, [session.cwd]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  // The GPU renderer is attached only while the terminal is on screen —
  // hiding disposes it, returning the WebGL context to the pool.
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    if (isVisible && !rendererCleanupRef.current) {
      rendererCleanupRef.current = applyTerminalRenderer(
        term,
        settings.terminalRenderer,
      ).dispose;
      repaintTerminal(term);
    } else if (!isVisible) {
      if (rendererCleanupRef.current) {
        safely('renderer detach', () => rendererCleanupRef.current?.());
        rendererCleanupRef.current = null;
      }
      // Hidden viewer: release the pty stream so the authority can relax
      // the shared geometry back to the owner's size.
      backend.releasePty?.(session.mainPtyId ?? session.id);
    }
  }, [isVisible]);

  useEffect(() => {
    agentInputRef.current = session.agentInput;
  }, [session.agentInput]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const shellFont = resolveShellFont(settings);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: shellFont.size,
      fontFamily: shellFont.family,
      lineHeight: shellFont.lineHeight,
      allowProposedApi: true,
      // macOS defaults this on: a right-click would replace the selection
      // with the word under the pointer before the context menu's Copy.
      rightClickSelectsWord: false,
      theme: getXtermColors(activeTheme),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    // xterm@6 teardown race: refresh callbacks registered via
    // addRefreshCallback (Viewport._sync et al.) run inside xterm's own
    // rAF — once the renderer is torn down (WebGL context loss, fast
    // remote remount) `renderService.dimensions` dereferences the dead
    // renderer and throws an uncatchable pageerror that kills the view.
    // Wrap every registered callback so the throw is logged, not fatal.
    // The patch itself must never throw — a readonly/renamed internals
    // shape must not kill the rest of the mount.
    safely('patch refresh callbacks', () => {
      const core = (term as unknown as { _core?: { _renderService?: { addRefreshCallback?: (cb: FrameRequestCallback) => number } } })._core;
      const rs = core?._renderService;
      const orig = rs?.addRefreshCallback?.bind(rs);
      if (rs && orig) {
        rs.addRefreshCallback = (cb: FrameRequestCallback) =>
          orig((time) => {
            try {
              cb(time);
            } catch (e) {
              axnLog('warn', 'terminal', `refresh callback failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
      }
    });
    const unregisterElement = registerTerminalElement(terminalRef.current, term);
    // OSC 52: TUIs with their own mouse selection (Claude Code) copy this way
    const clipboardWrites = handleClipboardWrites(term, (text) => {
      void Promise.resolve(services.copyText(text)).catch(() => {});
    });
    registerTerminal(session.id, term);
    // A session moved in from another window, or the page reloaded with
    // live PTYs: show its restored screen first — the output listener
    // attaches later, so live output follows in order.
    const replay = takePendingReplay(session.id) ?? takeReloadReplay(session.id);
    if (replay) term.write(replay);
    // GPU renderers are demand-driven: hidden terminals keep xterm's DOM
    // renderer so a wall of mounted sessions doesn't exhaust the WebGL
    // context pool (iOS kills the whole webview past ~16 contexts).
    // Attach on the next frame: creating the WebGL context takes 100–200 ms,
    // and the PTY spawn below should not wait for it — the shell starts
    // while the GPU renderer comes up.
    let rendererFrame: number | null = null;
    if (isVisibleRef.current) {
      rendererFrame = requestAnimationFrame(() => {
        rendererFrame = null;
        if (!active || rendererCleanupRef.current || !isVisibleRef.current) return;
        rendererCleanupRef.current = applyTerminalRenderer(
          term,
          settings.terminalRenderer,
        ).dispose;
      });
    }

    // fit() reads _renderService.dimensions — undefined once the terminal
    // is disposed or before open() (remote mirrors remount fast); a throw
    // here escapes as an uncaught pageerror, so keep it inside safely.
    const safeFit = () => safely('fit', () => fit.fit());
    const proposeDims = () => {
      let d: ReturnType<FitAddon['proposeDimensions']>;
      safely('proposeDimensions', () => { d = fit.proposeDimensions(); });
      return d;
    };
    const fitWindow = () => {
      if (isVisibleRef.current) safeFit();
    };
    window.addEventListener('resize', fitWindow);

    let resizeObserver: ResizeObserver | undefined;
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => {
        if (isVisibleRef.current) safeFit();
      });
      resizeObserver.observe(terminalRef.current);
    }

    // Copy / paste support. Handled via the DOM clipboard events in the
    // capture phase so the webview's native paste (Ctrl+V, Ctrl+Shift+V,
    // Cmd+V, context menu, …) and xterm's own paste listener are both
    // preempted — handling it in a keydown handler as well would paste twice.
    const termEl = terminalRef.current;
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const selection = terminalSelection(term);
      if (!selection) return;
      // One writer per copy: the copy event's own clipboardData. Writing the
      // same text through services.copyText (desktop: the Tauri clipboard
      // plugin) as well took the pasteboard away from WebKit mid-write, and
      // AppKit crashed the app in -[NSPasteboard changeCount].
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', selection);
      } else {
        void Promise.resolve(services.copyText(selection)).catch(() => {});
      }
      term.clearSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Image clipboard content (screenshots): save it like a dropped file
      // and paste the path — the same convention agents already expect.
      const imageItem = [...(e.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith('image/'),
      );
      const imageFile = imageItem?.getAsFile();
      if (imageFile && backend.saveDroppedFile) {
        void imageFile
          .arrayBuffer()
          .then((buf) =>
            backend.saveDroppedFile!(
              sessionId,
              imageFile.name || `paste-${Date.now()}.png`,
              new Uint8Array(buf),
            ),
          )
          .then((path) => {
            if (path) term.paste(`'${path.replace(/'/g, "'\\''")}' `);
          })
          .catch(() => {});
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) {
        term.paste(text);
      } else {
        services
          .pasteText?.()
          .then((clip) => {
            if (clip) term.paste(clip);
          })
          .catch(() => {});
      }
    };
    termEl?.addEventListener('copy', onCopy, true);
    termEl?.addEventListener('paste', onPaste, true);

    let onData: { dispose: () => void } | null = null;
    let onResize: { dispose: () => void } | null = null;
    let onTitleChange: { dispose: () => void } | null = null;
    let inputHandle: TerminalInput | null = null;
    let linkProviderDisposable: { dispose: () => void } | null = null;
    let onSelectionMouseUp: ((event: MouseEvent) => void) | null = null;
    let unlisten: Unsubscribe | null = null;
    let processInterval: ReturnType<typeof setInterval> | null = null;
    let cwdInterval: ReturnType<typeof setInterval> | null = null;
    let enterPollTimeout: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    const decoder = new TextDecoder();

    const sessionId = session.id;
    // Backend PTY this view is bound to — normally the session itself, but a
    // promoted sub-shell takes over the pinned shell view while keeping its
    // own PTY id.
    const ptyId = session.mainPtyId ?? session.id;
    const flow = createFlowControl(
      () => backend.pause?.(ptyId),
      () => backend.resume?.(ptyId),
    );
    const shell = settings.defaultShell?.trim() || undefined;
    const pty = acquirePty(backend, ptyId, () => {
      const dims = isVisibleRef.current
        ? (safeFit(), proposeDims())
        : undefined;
      return backend.createSession(ptyId, {
        shell,
        cwd: session.cwd,
        cols: dims?.cols ?? term.cols,
        rows: dims?.rows ?? term.rows,
      });
    });

    (async () => {
      try {
        // Attach the title listener and shell-output listener before creating the
        // session so that early OSC title sequences (e.g. from an agent)
        // are not lost while the PTY starts up.
        onTitleChange = term.onTitleChange((title) => {
          if (title && onSessionNameChange) {
            onSessionNameChange(sessionId, title);
          }

          // Agents that set the terminal title mark the session before the
          // 1 s process poll has seen them (plugin `agentInput.title`).
          const agent = title ? agentInputPluginForTitle(title)?.id : undefined;
          if (agent && !agentInputRef.current && updateSession) {
            agentInputRef.current = agent;
            updateSession(sessionId, { agentInput: agent });
          }
        });

        // An unclosed OSC 8 hyperlink underlines every subsequent cell; the
        // guard injects a link-closer into the parser once the leak is big
        // enough to be certain it wasn't a merely long legitimate link.
        const osc8Guard = createOsc8LeakGuard(() => term.write(OSC8_CLOSE));
        unlisten = backend.onOutput(ptyId, (bytes) => {
          term.write(bytes, flow.track(bytes.length));

          const raw = decoder.decode(bytes, { stream: true });
          osc8Guard(raw);
          const text = stripAnsi(raw);
          if (text && onSessionOutput) {
            onSessionOutput(sessionId, text);
          }
        });
        if (!active) return;

        // Spawn the PTY at the terminal's real size instead of the 80x24
        // default, so full-screen programs started right away (e.g. devin)
        // already see the correct width without needing a window resize.
        // Fit first so xterm has measured the container; otherwise proposeDimensions
        // may be undefined and term.cols/rows can be 0. Skip when the
        // container is hidden (display:none — restored background sessions
        // mount that way): there is no size to measure, proposeDimensions
        // would clamp to 2 cols, and the post-spawn resize below corrects
        // the size once visible anyway.
        // `false` = attached to an already-running PTY (promoted sub-shell or
        // adopted session) — not a fresh spawn, so plugin onSessionOpen hooks
        // must not fire (they assume an empty shell and e.g. inject restore
        // commands).
        const spawned = await pty.start();
        if (!active) return;

        if (spawned) onSessionReadyRef.current?.(sessionRef.current);

        const resolvedShell = shell || (await backend.getDefaultShell?.()) || 'sh';
        if (!active) return;
        shellNameRef.current = resolvedShell.split(/[/\\]/).pop() ?? resolvedShell;

        const pollCwd = async () => {
          try {
            const cwd = (await backend.getCwd?.(ptyId)) ?? null;
            if (!active) return;
            if (cwd && cwd !== cwdRef.current) {
              cwdRef.current = cwd;
              // A cwd patch is structural — updateSession saves it eagerly.
              updateSession?.(sessionId, { cwd });
            }
          } catch {
            // ignore
          }
        };

        onResize = term.onResize(({ cols, rows }) => {
          if (isVisibleRef.current) backend.resize(ptyId, cols, rows);
        });

        // The spawn-time fit can run on a hidden (display:none) or not yet
        // laid-out container — restored background sessions mount that way —
        // and proposeDimensions then clamps to 2 cols, so the PTY was spawned
        // nearly column-less ("text staffed to the left"). Re-fit now and push
        // the live size once, so the PTY converges on the real dimensions even
        // if an early onResize event was missed before the handler bound.
        if (isVisibleRef.current) {
          safeFit();
          backend.resize(ptyId, term.cols, term.rows);
        }

        // Turn path-like tokens in the buffer into hoverable links. When the
        // mouse dwells on a resolved file, a preview card with an Edit button
        // appears; clicking the link opens the editor directly. URLs split
        // across a line break (soft wrap, or a wrapped table cell) are
        // reconstructed across the fragment rows so the full link opens.
        const getLinkLine: GetLinkLine = (index) => {
          const l = term.buffer.active.getLine(index);
          return l
            ? { text: l.translateToString(true), isWrapped: l.isWrapped }
            : undefined;
        };
        // Keyed by cwd + token; hits are kept (bounded), misses re-checked
        // after a few seconds so newly created files become links.
        const statCached = createLookupCache<PathStat>(async (key) => {
          const sep = key.indexOf('\n');
          return (await backend.statPath?.(ptyId, key.slice(0, sep), key.slice(sep + 1))) ?? null;
        });
        const statToken = (token: string): Promise<PathStat | null> =>
          statCached(`${cwdRef.current}\n${token}`);

        /** Resolve a raw token to a path stat, http(s) URL, or null. */
        const resolveToken = async (
          token: string,
        ): Promise<{ stat: PathStat; isUrl: boolean } | null> => {
          if (URL_TOKEN.test(token)) {
            return { stat: { path: token, isFile: false, isDir: false }, isUrl: true };
          }
          // file:///abs/path — stat the underlying path so it behaves
          // like any other discovered file/directory.
          let t = token;
          if (FILE_URL_TOKEN.test(t)) {
            const stripped = t.replace(/^file:\/\/[^/]*/i, '');
            try {
              t = decodeURIComponent(stripped) || stripped;
            } catch {
              t = stripped;
            }
          }
          const stat = await statToken(t);
          return stat ? { stat, isUrl: false } : null;
        };

        const linkProvider: ILinkProvider = {
          provideLinks: (bufferLineNumber, callback) => {
            const lineIndex = bufferLineNumber - 1;
            const text = getLinkLine(lineIndex)?.text ?? '';
            const candidates = extractLinkTokens(text, 32, 2);
            if (candidates.length === 0) {
              callback(undefined);
              return;
            }
            void (async () => {
              const links: ILink[] = [];
              for (const c of candidates) {
                const end = c.start + c.token.length;
                // A scheme token may continue onto the rows below; a plain
                // fragment may be the tail of a URL starting on a row above.
                const wrapped = URL_START_RE.test(c.token)
                  ? extendWrappedUrl(getLinkLine, lineIndex, c.start, end)
                  : findWrappedUrlThrough(getLinkLine, lineIndex, c.start, end);
                const resolved = await resolveToken(wrapped?.url ?? c.token);
                if (!resolved) continue;
                const { stat, isUrl } = resolved;
                const last = wrapped?.segments[wrapped.segments.length - 1];
                const link: ILink = {
                  range:
                    wrapped && last
                      ? {
                          start: {
                            x: wrapped.segments[0].start + 1,
                            y: wrapped.segments[0].line + 1,
                          },
                          end: { x: last.end, y: last.line + 1 },
                        }
                      : {
                          start: { x: c.start + 1, y: bufferLineNumber },
                          end: { x: end, y: bufferLineNumber },
                        },
                  text: wrapped?.url ?? c.token,
                  // xterm activates a link on mouse-up of any button — a
                  // right-click opening the context menu must not navigate.
                  activate: isUrl
                    ? (event: MouseEvent) => {
                        if (event.button !== 0) return;
                        services.openExternal(stat.path);
                      }
                    : // A tap/click on a file link pops the action card right
                      // away — the only way to reach it on touch, and a
                      // shortcut to Edit/Preview on desktop.
                      (event) => {
                        showHoverCard(event, stat, isUrl, 0);
                      },
                  decorations: { pointerCursor: true, underline: true },
                };
                // Files always get the preview card; a reconstructed URL gets
                // one too so the joined link can be seen and copied before
                // opening it.
                if (!isUrl || wrapped) {
                  link.hover = (event: MouseEvent) => {
                    // xterm 6 clears the hovered link and re-fires
                    // leave+hover on every viewport re-render (output,
                    // scroll) and on resize — restarting the 500ms show
                    // delay each time would starve it forever. Once the
                    // card is visible just keep it alive — retarget only to
                    // a different path, since re-showing the same card at the
                    // latest event position makes it chase the cursor (or
                    // jump under it) while the user moves to click a button.
                    // While a show is already pending, only cancel the
                    // pending hide. After a synthetic leave ate the pending
                    // show, a re-hover of the same target shows instantly.
                    if (hoverCardRef.current) {
                      cancelHideHoverCard();
                      if (hoverCardRef.current.resolvedPath !== stat.path) {
                        showHoverCard(event, stat, isUrl, 0);
                      }
                    } else if (hoverShowTimer.current) {
                      cancelHideHoverCard();
                    } else {
                      const reHover = lastHoverPathRef.current === stat.path;
                      lastHoverPathRef.current = stat.path;
                      showHoverCard(event, stat, isUrl, reHover ? 0 : undefined);
                    }
                  };
                  link.leave = () => scheduleHideHoverCard();
                }
                links.push(link);
              }
              callback(links.length > 0 ? links : undefined);
            })();
          },
        };
        linkProviderDisposable = term.registerLinkProvider(linkProvider);

        // Selected text gets the same path detection: after a mouse selection
        // ends, check whether the selection is a path/URL itself or contains
        // one, and show the action card at the cursor position right away.
        onSelectionMouseUp = (event: MouseEvent) => {
          if (event.button !== 0) return;
          const selection = term.getSelection().trim();
          if (selection.length < 2) return;
          void (async () => {
            const strip = (t: string) =>
              t
                .replace(/^[.,;:'"()[\]{}<>*]+/, '')
                .replace(/[.,;:'"()[\]{}<>*@|=]+$/, '');
            const tokens = selection.split(/\s+/).filter(Boolean);
            if (tokens.length === 1) {
              const resolved = await resolveToken(strip(tokens[0]));
              if (resolved && active) {
                showHoverCard(event, resolved.stat, resolved.isUrl, 0);
              }
            } else {
              // A selection across rows may hold a path/URL the terminal
              // wrapped (agent TUIs hard-wrap long paths onto an indented
              // continuation row): rejoin the rows and take the longest
              // candidate that resolves.
              for (const candidate of wrappedSelectionCandidates(selection)) {
                const resolved = await resolveToken(candidate);
                if (!active) return;
                if (resolved) {
                  showHoverCard(event, resolved.stat, resolved.isUrl, 0);
                  armHoverHide(4000);
                  return;
                }
              }
              if (!active) return;
              // Nothing path-like: offer a copy of the whole selected text.
              showHoverCard(
                event,
                { path: selection, isFile: false, isDir: false },
                false,
                0,
                true,
              );
            }
            // No link `leave` fires for a selection-triggered card — hide it
            // after a while unless the pointer moves onto the card (which
            // cancels the hide timer via onMouseEnter). armHoverHide, not
            // scheduleHideHoverCard: the 0ms show timer above hasn't fired
            // yet and must not be cleared.
            armHoverHide(4000);
          })();
        };
        termEl?.addEventListener('mouseup', onSelectionMouseUp);

        // One ordered writer per PTY: input after an OSC report waits until
        // the report's alive probe settles (DA1 must never overtake it).
        const ptyInput = createTerminalInput(
          (d) => backend.write(ptyId, d),
          backend.writeWhenRaw ? (d) => backend.writeWhenRaw!(ptyId, d) : undefined,
          oscReportTarget(
            backend.getForegroundProcess
              ? (id) => backend.getForegroundProcess!(id)
              : undefined,
            ptyId,
          ),
        );
        // Track the current input line so "hidden commands" (axn-edit)
        // can be intercepted before they are submitted to the shell.
        // Agent input is tracked only to notify plugins before a manual /exit.
        const hiddenInput = createHiddenCommandInput({
          write: ptyInput.write,
          mode: () => {
            const process = sessionRef.current.process;
            if (!process) return 'full';
            return agentInputPluginFor(process) ? 'agent' : 'off';
          },
          onEditorRequest: (path) => onEditorRequestRef.current?.(sessionId, path),
          onBrowserRequest: (path) => onBrowserRequestRef.current?.(sessionId, path),
          onPreviewRequest: (path) => onPreviewRequestRef.current?.(sessionId, path),
          writeDisplay: (d) => term.write(d),
          writeReport: ptyInput.send,
          onSessionCommand: (line) => onSessionCommandRef.current?.(sessionId, line),
          onCompleteInput: (line) =>
            active ? (onCompleteInputRef.current?.(sessionId, line) ?? Promise.resolve([])) : Promise.resolve([]),
        });

        // xterm.js sends a bare \r for both Enter and Shift+Enter, so the
        // shell/TUI cannot tell them apart. Intercept Shift+Enter and inject a
        // bracketed-paste wrapped newline (\x1b[200~\n\x1b[201~). Most modern
        // line editors (readline 8.1+, prompt_toolkit, Claude Code, etc.) treat
        // this as a literal newline insert instead of a submit. We suppress the
        // keydown *and* keypress/keyup paths so xterm.js never emits the bare
        // \r for Shift+Enter.
        term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          // App navigation shortcuts must bubble to ShellApp's window
          // listener instead of becoming escape sequences.
          if (isAppNavigationShortcut(event) || isReloadShortcut(event)) return false;
          const isShiftEnter =
            event.key === 'Enter' &&
            event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey;
          if (isShiftEnter) {
            if (event.type === 'keydown') {
              onUserInputRef.current?.(sessionId);
              ptyInput.write('\x1b[200~\n\x1b[201~');
            }
            return false;
          }
          return true;
        });

        // Shared input path: xterm's onData and the touch key bar both feed
        // through here so hidden-command interception and the post-Enter cwd
        // poll apply identically to injected keys.
        const sendInput = (data: string) => {
          if (isUserInput(data)) onUserInputRef.current?.(sessionId);
          if (hiddenInput(data)) return;

          ptyInput.send(data);
          // Poll cwd shortly after the user presses Enter so cd changes are
          // persisted quickly instead of waiting for the next interval.
          if (data.includes('\r') || data.includes('\n')) {
            if (enterPollTimeout) clearTimeout(enterPollTimeout);
            enterPollTimeout = setTimeout(() => {
              if (active) void pollCwd();
            }, 120);
          }
        };
        onData = term.onData(sendInput);
        inputHandle = { send: sendInput, focus: () => term.focus() };
        registerTerminalInput(sessionId, inputHandle);

        if (isVisibleRef.current) {
          safeFit();
          // onResize only fires on a size *change*; push the current size
          // unconditionally so the PTY is never left at the spawn dimensions.
          backend.resize(ptyId, term.cols, term.rows);
        }

        processInterval = setInterval(async () => {
          try {
            const process = (await backend.getForegroundProcess?.(ptyId)) ?? null;
            if (!active) return;

            const processName = process?.toLowerCase() ?? '';
            const shellName = shellNameRef.current.toLowerCase();
            const isShell = !processName || processName === shellName;
            const agent = isShell ? undefined : agentInputPluginFor(processName)?.id;

            const processDisplay = isShell ? undefined : (process ?? undefined);
            const patch = foregroundStatusPatch(sessionRef.current, processDisplay);

            if (agent !== agentInputRef.current) {
              agentInputRef.current = agent;
              patch.agentInput = agent;
            }

            if (Object.keys(patch).length > 0) {
              updateSession?.(sessionId, patch);
            }
          } catch {
            // ignore
          }
        }, 1000);

        // Poll cwd for every session — a hidden session's cwd is still needed
        // (e.g. plugins record where devin actually ran; relying on persisted
        // cwd breaks restore for non-visible sessions). Only when the backend
        // can answer cwd queries.
        if (backend.getCwd) {
          void pollCwd();
          cwdInterval = setInterval(pollCwd, 1000);
        }
        // Foreground-process polling is a desktop capability; skip when the
        // backend can't report it (e.g. the WS gateway).
        if (!backend.getForegroundProcess && processInterval) {
          clearInterval(processInterval);
          processInterval = null;
        }
      } catch (e) {
        console.error(`[shell] session "${session.name}" (${ptyId}) failed to start`, e);
        if (!active) return;
        term.writeln(`\r\nFailed to start shell session "${session.name}".`);
        term.writeln(`\r\n${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    terminal.current = term;
    fitAddon.current = fit;

    return () => {
      active = false;
      if (rendererFrame !== null) cancelAnimationFrame(rendererFrame);
      if (processInterval) clearInterval(processInterval);
      if (cwdInterval) clearInterval(cwdInterval);
      if (enterPollTimeout) clearTimeout(enterPollTimeout);
      clearHoverTimers();
      setHoverCard(null);
      // Each step is guarded: an exception escaping this cleanup would take
      // the whole app down, and must not skip the PTY release either.
      safely('link provider', () => linkProviderDisposable?.dispose());
      termEl?.removeEventListener('copy', onCopy, true);
      termEl?.removeEventListener('paste', onPaste, true);
      if (onSelectionMouseUp) termEl?.removeEventListener('mouseup', onSelectionMouseUp);
      window.removeEventListener('resize', fitWindow);
      resizeObserver?.disconnect();
      safely('resize listener', () => onResize?.dispose());
      safely('input listener', () => onData?.dispose());
      safely('title listener', () => onTitleChange?.dispose());
      safely('output listener', () => unlisten?.());
      safely('flow control', () => flow.dispose());
      // A PTY flagged keep-alive survives this unmount — it reattaches in a
      // different view (sub-shell promoted to main, demoted main re-shown as
      // a sub-shell tab).
      safely('PTY release', () => pty.release(takePtyKeepAlive(ptyId)));
      unregisterTerminal(sessionId, term);
      unregisterElement();
      safely('OSC 52 handler', () => clipboardWrites.dispose());
      // Dispose the renderer addon first: disposing an xterm with a live
      // WebGL addon can throw.
      safely('renderer', () => rendererCleanupRef.current?.());
      rendererCleanupRef.current = null;
      if (inputHandle) unregisterTerminalInput(sessionId, inputHandle);
      safely('terminal', () => term.dispose());
      terminal.current = null;
      fitAddon.current = null;
    };
  }, [
    session.id,
    session.mainPtyId,
    backend,
    services,
    settings.defaultShell,
    onSessionNameChange,
    onSessionOutput,
    updateSession,
  ]);

  useEffect(() => {
    if (!terminal.current) return;
    const shellFont = resolveShellFont(settings);
    terminal.current.options.theme = getXtermColors(activeTheme);
    terminal.current.options.fontFamily = shellFont.family;
    terminal.current.options.fontSize = shellFont.size;
    terminal.current.options.lineHeight = shellFont.lineHeight;
    if (isVisibleRef.current) fitAddon.current?.fit();
  }, [activeTheme, settings.shellFontFamily, settings.shellFontSize, settings.shellLineHeight, settings.uiZoom]);

  // Renderer changes hot-swap the addon on the live terminal — the PTY effect
  // above can't react (its teardown would kill the session). Skipped on mount:
  // the PTY effect applies the initial choice.
  useEffect(() => {
    if (!rendererMountedRef.current) {
      rendererMountedRef.current = true;
      return;
    }
    // Hidden terminals hold no GPU renderer — the visibility effect applies
    // the latest choice when the terminal comes back on screen.
    if (!isVisibleRef.current) return;
    rendererCleanupRef.current?.();
    rendererCleanupRef.current = terminal.current
      ? applyTerminalRenderer(terminal.current, settings.terminalRenderer).dispose
      : null;
  }, [settings.terminalRenderer]);

  useEffect(() => {
    if (!isVisible || !terminal.current || !fitAddon.current) return;
    fitAddon.current.fit();
    // A backend that released the stream on hide gets it back here: at an
    // unchanged size fit() fires no onResize, so nothing else would.
    if (backend.releasePty) {
      backend.resize(session.mainPtyId ?? session.id, terminal.current.cols, terminal.current.rows);
    }
    // A display:none terminal pauses xterm's renderer (IntersectionObserver),
    // and the webview can drop the accelerated canvas' backing (and WebGL's
    // glyph atlas) meanwhile — repaint from freshly rasterized glyphs.
    repaintTerminal(terminal.current);
  }, [isVisible]);

  // Place the card from its real size, before paint, and again whenever it
  // grows (the preview loads after the card opens).
  useLayoutEffect(() => {
    const el = hoverCardElRef.current;
    const container = terminalRef.current;
    if (!hoverCard || !el || !container) {
      setHoverCardPos(null);
      return;
    }
    const place = () => {
      const rect = container.getBoundingClientRect();
      setHoverCardPos(
        placeHoverCard({
          anchorX: hoverCard.x,
          anchorY: hoverCard.y,
          width: el.offsetWidth,
          height: el.offsetHeight,
          containerWidth: rect.width,
          containerHeight: rect.height,
        }),
      );
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hoverCard]);

  return (
    <div className="relative h-full w-full bg-[var(--terminal-bg)] p-1.5">
      <div ref={terminalRef} className="h-full w-full" />
      {hoverCard && (
        <div
          ref={hoverCardElRef}
          className="absolute z-50 w-96 max-w-[calc(100%-8px)] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-xl"
          style={{
            left: hoverCardPos?.left ?? hoverCard.x,
            top: hoverCardPos?.top ?? hoverCard.y,
            visibility: hoverCardPos ? 'visible' : 'hidden',
          }}
          onMouseEnter={cancelHideHoverCard}
          onMouseMove={cancelHideHoverCard}
          onMouseLeave={() => scheduleHideHoverCard()}
        >
          <PathActionMenu
            resolvedPath={hoverCard.resolvedPath}
            isDir={hoverCard.isDir}
            isUrl={hoverCard.isUrl}
            sessionId={session.id}
            copyOnly={hoverCard.copyOnly}
            onEdit={(p) => onEditorRequestRef.current?.(session.id, p)}
            onPreview={(p) => onPreviewRequestRef.current?.(session.id, p)}
            onDismiss={() => setHoverCard(null)}
          />
        </div>
      )}
    </div>
  );
}
