import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useSessionBackend, useShellServices } from '../services';
import { backendFileService } from './fileService';
import { createTabHookWatcher } from './subShellHooks';
import { useSettings } from '../SettingsProvider';
import { getXtermColors, resolveShellFont } from '../themes';
import {
  getScreenLines,
  handleClipboardWrites,
  registerTerminal,
  takePendingReplay,
  registerTerminalElement,
  takePtyKeepAlive,
  unregisterTerminal,
  registerTerminalInput,
  unregisterTerminalInput,
} from '../terminalRegistry';
import { tabTaskPatch } from './subShellTasks';
import { agentInputPluginFor } from './session-plugins/agentHookBridge';
import { createHiddenCommandInput } from './hiddenCommands';
import { createOsc8LeakGuard, OSC8_CLOSE } from '../terminalLinks';
import { applyTerminalRenderer, repaintTerminal, safely } from '../terminalRenderer';
import { acquirePty } from '../ptyLifetime';
import {
  agentOfProcess,
  captureAgentResume,
  registerSubShellCloser,
  subShellSpawnCommand,
  withLoginShell,
} from './subShellAgents';
import { talkResumeCommand } from './gitReview';
import { isAppNavigationShortcut, isReloadShortcut } from './shortcuts';
import type { EditorTab, ShellSession } from '../types';
import { createFlowControl } from '../flowControl';

/**
 * A sub-shell sub-view: a child PTY of the session spawned via
 * `create_subshell` — `sh -c <command>` for one-shot commands, or the default
 * shell when `tab.command` is unset. Runs in the session's live cwd. After the
 * child exits the tab holds its output: Enter re-runs, Esc closes the tab.
 */
export function SubShellView({
  session,
  tab,
  isVisible,
  onClose,
  onRename,
  onUpdateTab,
  onEditorRequest,
  onBrowserRequest,
  onPreviewRequest,
  onSessionCommand,
  onCompleteInput,
}: {
  session: ShellSession;
  tab: EditorTab;
  isVisible: boolean;
  onClose: () => void;
  /** Rename this tab (`axn-rename`); empty label resets to the default. */
  onRename?: (label: string) => void;
  /** Persist a patch onto this tab (agent tabs store their resumeCommand). */
  onUpdateTab?: (patch: Partial<EditorTab>) => void;
  onEditorRequest?: (sessionId: string, path: string, ptyId?: string) => void;
  onBrowserRequest?: (sessionId: string, path: string, ptyId?: string) => void;
  onPreviewRequest?: (sessionId: string, path: string, ptyId?: string) => void;
  onSessionCommand?: (
    sessionId: string,
    line: string,
    ptyId?: string,
  ) => string | false | undefined | Promise<string | false | undefined>;
  onCompleteInput?: (sessionId: string, line: string, ptyId?: string) => Promise<string[]>;
}) {
  const backend = useSessionBackend();
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const exitedRef = useRef(false);
  const spawnRef = useRef<() => void>(() => {});
  // Foreground process of this sub-shell's PTY — gates axn-* interception.
  const foregroundRef = useRef<string | null>(null);
  // Agent conversations in this tab (see subShellAgents.ts): the output tail
  // the exit hint is parsed from, a waiter the close-time capture resolves,
  // and whether the app's close is stopping the agent (that exit must not
  // count as the user leaving it).
  const agentTailRef = useRef('');
  const hintWaiterRef = useRef<(() => void) | null>(null);
  const closingRef = useRef(false);
  const shellNameRef = useRef('');
  const isVisibleRef = useRef(isVisible);
  const onCloseRef = useRef(onClose);
  const onRenameRef = useRef(onRename);
  const onUpdateTabRef = useRef(onUpdateTab);
  const sessionRef = useRef(session);
  const tabRef = useRef(tab);
  const onEditorRequestRef = useRef(onEditorRequest);
  const onBrowserRequestRef = useRef(onBrowserRequest);
  const onPreviewRequestRef = useRef(onPreviewRequest);
  const onSessionCommandRef = useRef(onSessionCommand);
  const onCompleteInputRef = useRef(onCompleteInput);
  isVisibleRef.current = isVisible;
  onCloseRef.current = onClose;
  onRenameRef.current = onRename;
  onUpdateTabRef.current = onUpdateTab;
  sessionRef.current = session;
  tabRef.current = tab;
  onEditorRequestRef.current = onEditorRequest;
  onBrowserRequestRef.current = onBrowserRequest;
  onPreviewRequestRef.current = onPreviewRequest;
  onSessionCommandRef.current = onSessionCommand;
  onCompleteInputRef.current = onCompleteInput;
  const { activeTheme, settings } = useSettings();
  const { services } = useShellServices();
  const notifyRef = useRef(services.notify);
  notifyRef.current = services.notify;
  // Disposes the active GPU renderer addon when the setting hot-swaps.
  const rendererCleanupRef = useRef<(() => void) | null>(null);
  const rendererMountedRef = useRef(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    const shellFont = resolveShellFont(settings);
    const t = new Terminal({
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
    t.loadAddon(fit);
    t.open(terminalRef.current);
    const unregisterElement = registerTerminalElement(terminalRef.current, t);
    // OSC 52: TUIs with their own mouse selection (Claude Code) copy this way
    const clipboardWrites = handleClipboardWrites(t, (text) => {
      void Promise.resolve(services.copyText(text)).catch(() => {});
    });
    // keyed by the tab id: screen scans (subShellTasks.ts) read this PTY's view
    registerTerminal(tab.id, t);
    // A tab moved in with its session from another window: history first.
    const replay = takePendingReplay(tab.id);
    if (replay) t.write(replay);
    // App navigation shortcuts must bubble to ShellApp's window listener
    // instead of becoming escape sequences.
    t.attachCustomKeyEventHandler(
      (event) => !isAppNavigationShortcut(event) && !isReloadShortcut(event),
    );
    term.current = t;
    fitAddon.current = fit;
    // GPU renderers are demand-driven (see ShellTerminal) — a hidden tab
    // keeps the DOM renderer instead of holding a WebGL context.
    if (isVisibleRef.current) {
      rendererCleanupRef.current = applyTerminalRenderer(
        t,
        settings.terminalRenderer,
      ).dispose;
    }

    const fitWindow = () => {
      if (isVisibleRef.current) fit.fit();
    };
    window.addEventListener('resize', fitWindow);

    let resizeObserver: ResizeObserver | undefined;
    const termEl = terminalRef.current;
    if ('ResizeObserver' in window && termEl) {
      resizeObserver = new ResizeObserver(fitWindow);
      resizeObserver.observe(termEl);
    }

    let active = true;
    const pty = acquirePty(backend, tab.id, () => {
      const current = tabRef.current;
      return backend.createSubshell?.(current.id, {
        // Parent resolves the cwd — the session's current main PTY, which may
        // be a promoted sub-shell.
        parentId: sessionRef.current.mainPtyId ?? sessionRef.current.id,
        // Agent tabs resume their conversation once the tab has run; the
        // seed `command` only ever runs on the very first spawn.
        command: subShellSpawnCommand(current),
        cwd: current.cwd ?? undefined,
        cols: t.cols,
        rows: t.rows,
      }) ?? Promise.resolve(false);
    });
    const spawn = (initial = false) => {
      exitedRef.current = false;
      (initial ? pty.start() : pty.restart()).then(() => {
        if (!active) return;
        // The seed ran at least once — store the fallback resume line so a
        // respawn (restart, Enter re-run) continues the agent conversation
        // even when no session name was captured.
        const spawned = tabRef.current;
        if (spawned.agent && !spawned.resumeCommand) {
          onUpdateTabRef.current?.({ resumeCommand: talkResumeCommand(spawned.agent) });
        }
        // The pre-spawn fit can run before the just-unhidden container is
        // laid out; push the live size once more so the PTY never stays at
        // the clamped 2 cols.
        if (exitedRef.current) return;
        if (isVisibleRef.current) fit.fit();
        backend.resize(tab.id, t.cols, t.rows);
      }).catch((e) => {
        if (!active) return;
        exitedRef.current = true;
        t.writeln(`\r\nFailed to start sub-shell: ${String(e)}`);
      });
    };
    spawnRef.current = () => spawn(true);

    // Same hidden-command interception as the main terminal: axn-rename is
    // handled locally (it renames this tab, never the session); all other
    // axn-* commands delegate to the session-level dispatch. Interception is
    // gated on the sub-shell's own foreground process so input typed into a
    // running program (vim, devin, …) is never stolen.
    const hiddenInput = createHiddenCommandInput({
      write: (d) => backend.write(tab.id, d),
      mode: () => {
        const fg = foregroundRef.current;
        if (!fg) return 'full';
        return agentInputPluginFor(fg) ? 'agent' : 'off';
      },
      onLocalCommand: (line) => {
        const m = /^\s*axn-rename(?:\s+(.*?))?\s*$/.exec(line);
        if (!m) return false;
        // Clear the typed line and rename the tab instead of executing
        // anything in the sub-shell.
        backend.write(tab.id, '\x15');
        onRenameRef.current?.(m[1]?.trim().replace(/^["']+|["']+$/g, '') ?? '');
        return true;
      },
      onEditorRequest: (path) =>
        onEditorRequestRef.current?.(sessionRef.current.id, path, tab.id),
      onBrowserRequest: (path) =>
        onBrowserRequestRef.current?.(sessionRef.current.id, path, tab.id),
      onPreviewRequest: (path) =>
        onPreviewRequestRef.current?.(sessionRef.current.id, path, tab.id),
      onSessionCommand: (line) => {
        // `/exit` inside a sub-shell must not reach session-level dispatch:
        // the devin plugin's exit capture is bound to the session's main PTY
        // and would clear the session's remembered name while never seeing
        // this tab's resume line (plugin onOutput gets main-PTY output only).
        if (line.trim() === '/exit') return undefined;
        return onSessionCommandRef.current?.(sessionRef.current.id, line, tab.id);
      },
      onCompleteInput: (line) =>
        onCompleteInputRef.current?.(sessionRef.current.id, line, tab.id) ??
        Promise.resolve([]),
    });
    // Shared input path — the touch key bar sends through this too, so
    // hidden commands, exit-state re-run (Enter) and Esc-to-close all behave
    // exactly like typed input.
    const sendInput = (data: string) => {
      if (!exitedRef.current) {
        if (hiddenInput(data)) return;
        backend.write(tab.id, data);
        return;
      }
      if (data === '\r') {
        t.reset();
        spawn();
      } else if (data === '\x1b') {
        onCloseRef.current?.();
      }
    };
    const onData = t.onData(sendInput);
    const inputHandle = { send: sendInput, focus: () => t.focus() };
    registerTerminalInput(tab.id, inputHandle);

    const onResize = t.onResize(({ cols, rows }) => {
      backend.resize(tab.id, cols, rows);
    });

    // Poll the sub-shell's foreground process — hidden commands are only
    // intercepted at a bare shell prompt (same rule as the main terminal).
    let fgPoll: ReturnType<typeof setInterval> | null = null;
    // Hook status of an agent running in this tab (subShellHooks.ts). A
    // previous run's non-final status/flag is stale by now.
    if (tabRef.current.hookAttention || (tabRef.current.hookStatus ?? 'completed') !== 'completed') {
      onUpdateTabRef.current?.({ hookStatus: undefined, hookAttention: null });
    }
    const hookWatcher = createTabHookWatcher({
      tabId: tab.id,
      read: (path) => backendFileService(backend, tab.id).readFile(path),
      stateDir: async () =>
        (await backend.exec?.(tab.id, 'printf %s "${AXN_TERM_STATE_DIR:-$HOME/.axn-term}"'))?.trim() || undefined,
      getTab: () => tabRef.current,
      update: (patch) => {
        const looking = isVisibleRef.current && document.hasFocus();
        // a "needs input" warning while the user watches this tab says nothing new
        if (patch.hookAttention?.level === 'warning' && looking) delete patch.hookAttention;
        if (Object.keys(patch).length === 0) return;
        onUpdateTabRef.current?.(patch);
        if (patch.hookAttention && !looking) {
          const label = tabRef.current.label ?? 'sub-shell';
          notifyRef.current?.(`${sessionRef.current.name} · ${label}`, patch.hookAttention.message);
        }
      },
    });
    if (backend.getForegroundProcess) {
      void backend
        .getDefaultShell?.()
        .then((s) => {
          shellNameRef.current = (s.split(/[/\\]/).pop() ?? s).toLowerCase();
        })
        .catch(() => {});
      fgPoll = setInterval(() => {
        void backend
          .getForegroundProcess?.(tab.id)
          .then((p) => {
            const name = p?.toLowerCase() ?? '';
            const isShell = !name || name === shellNameRef.current;
            foregroundRef.current = isShell ? null : p;
            // Track the agent running in this tab: a fresh start forgets the
            // id of an earlier run; an exit the app did not drive means the
            // user left the agent — nothing to resume next time.
            const agent = agentOfProcess(foregroundRef.current);
            const current = tabRef.current;
            if (agent && current.agentActive !== agent) {
              agentTailRef.current = '';
              onUpdateTabRef.current?.({ agentActive: agent, agentResume: undefined });
            } else if (!agent && current.agentActive && !closingRef.current) {
              onUpdateTabRef.current?.({ agentActive: undefined });
            }
            void hookWatcher.tick(foregroundRef.current);
            const tasks = tabTaskPatch(tabRef.current, foregroundRef.current, () =>
              getScreenLines(tab.id),
            );
            if (tasks) onUpdateTabRef.current?.(tasks);
          })
          .catch(() => {});
      }, 1000);
    }

    // An unclosed OSC 8 hyperlink underlines every subsequent cell; the
    // guard injects a link-closer into the parser once the leak is big
    // enough to be certain it wasn't a merely long legitimate link.
    const outputDecoder = new TextDecoder();
    const osc8Guard = createOsc8LeakGuard(() => t.write(OSC8_CLOSE));
    const flow = createFlowControl(
      () => backend.pause?.(tab.id),
      () => backend.resume?.(tab.id),
    );
    const unlistenOut = backend.onOutput(tab.id, (data) => {
      t.write(data, flow.track(data.length));
      const text = outputDecoder.decode(data, { stream: true });
      osc8Guard(text);
      // Capture the agent's exit hint (exact conversation id/name): a talk
      // tab stores it as its resumeCommand, a plain tab as agentResume.
      const current = tabRef.current;
      const agent =
        current.agent === 'claude' || current.agent === 'devin'
          ? current.agent
          : current.agentActive ?? agentOfProcess(foregroundRef.current);
      if (!agent) return;
      agentTailRef.current = (agentTailRef.current + text).slice(-16_384);
      const resume = captureAgentResume(agent, agentTailRef.current);
      if (!resume) return;
      if (current.agent === agent) {
        const resumeCommand = withLoginShell(resume);
        if (current.resumeCommand !== resumeCommand) onUpdateTabRef.current?.({ resumeCommand });
      } else if (current.agentResume !== resume) {
        onUpdateTabRef.current?.({ agentResume: resume });
      }
      hintWaiterRef.current?.();
    });
    // On app close, stop a running agent gracefully so it prints its resume
    // hint — the same Ctrl-C pairs the claude/devin plugins send to the main
    // shell — and keep agentActive so the next start resumes it.
    const unregisterCloser = registerSubShellCloser(tab.id, async () => {
      if (!agentOfProcess(foregroundRef.current)) return;
      closingRef.current = true;
      const hint = new Promise<void>((resolve) => {
        hintWaiterRef.current = resolve;
      });
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let round = 0; round < 2; round++) {
        await backend.write(tab.id, '\x03');
        await pause(250);
        await backend.write(tab.id, '\x03');
        if ((await Promise.race([hint.then(() => true), pause(1_500).then(() => false)])) === true) break;
      }
      await Promise.race([hint, pause(2_000)]);
      hintWaiterRef.current = null;
    });
    const unlistenExit = backend.onSubshellExit?.((ptyId, exitCode) => {
      if (ptyId !== tab.id) return;
      exitedRef.current = true;
      t.writeln(
        `\r\n\x1b[2m[process exited${exitCode != null ? ` (${exitCode})` : ''} — Enter to re-run, Esc to close]\x1b[0m`,
      );
    });

    // A StrictMode replay retains the lazy-start flag, so the replacement
    // view must attach its completion handler to the shared pending spawn.
    if (spawnedRef.current) spawn(true);

    return () => {
      active = false;
      // Each step is guarded: closing a tab must never take the app down, and
      // one failing disposal must not skip the rest (the PTY release above all).
      safely('sub-shell output listener', () => unlistenOut?.());
      safely('sub-shell flow control', () => flow.dispose());
      safely('sub-shell agent closer', () => unregisterCloser());
      unregisterElement();
      safely('OSC 52 handler', () => clipboardWrites.dispose());
      unregisterTerminal(tab.id, t);
      safely('sub-shell exit listener', () => unlistenExit?.());
      if (fgPoll) clearInterval(fgPoll);
      safely('sub-shell input listener', () => onData.dispose());
      safely('sub-shell resize listener', () => onResize.dispose());
      window.removeEventListener('resize', fitWindow);
      resizeObserver?.disconnect();
      // Keep-alive PTYs survive the unmount: a promoted sub-shell becomes the
      // session's main view, a demoted main re-shows here, and "turn into
      // workspace" tabs reattach as standalone sessions.
      safely('sub-shell PTY release', () => pty.release(takePtyKeepAlive(tab.id)));
      // Dispose the renderer addon first: disposing an xterm with a live
      // WebGL addon can throw.
      safely('sub-shell renderer', () => rendererCleanupRef.current?.());
      rendererCleanupRef.current = null;
      unregisterTerminalInput(tab.id, inputHandle);
      safely('sub-shell terminal', () => t.dispose());
      term.current = null;
      fitAddon.current = null;
    };
  }, [tab.id, session.id, tab.command]);

  useEffect(() => {
    if (!term.current) return;
    const shellFont = resolveShellFont(settings);
    term.current.options.theme = getXtermColors(activeTheme);
    term.current.options.fontFamily = shellFont.family;
    term.current.options.fontSize = shellFont.size;
    term.current.options.lineHeight = shellFont.lineHeight;
    if (isVisibleRef.current) fitAddon.current?.fit();
  }, [activeTheme, settings.shellFontFamily, settings.shellFontSize, settings.shellLineHeight, settings.uiZoom]);

  // Renderer changes hot-swap the addon on the live terminal — recreating the
  // PTY would kill the sub-shell. Skipped on mount; the PTY effect applies
  // the initial choice.
  useEffect(() => {
    if (!rendererMountedRef.current) {
      rendererMountedRef.current = true;
      return;
    }
    if (!isVisibleRef.current) return;
    rendererCleanupRef.current?.();
    rendererCleanupRef.current = term.current
      ? applyTerminalRenderer(term.current, settings.terminalRenderer).dispose
      : null;
  }, [settings.terminalRenderer]);

  // Attach the GPU renderer only while visible — hiding disposes it and
  // returns the WebGL context to the pool (see ShellTerminal).
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (isVisible && !rendererCleanupRef.current) {
      rendererCleanupRef.current = applyTerminalRenderer(
        t,
        settings.terminalRenderer,
      ).dispose;
      repaintTerminal(t);
    } else if (!isVisible && rendererCleanupRef.current) {
      safely('renderer detach', () => rendererCleanupRef.current?.());
      rendererCleanupRef.current = null;
    }
  }, [isVisible]);

  // Spawn lazily on first activation so restored tabs don't all fork at once.
  useEffect(() => {
    if (!isVisible || spawnedRef.current) return;
    spawnedRef.current = true;
    fitAddon.current?.fit();
    spawnRef.current();
  }, [isVisible]);

  // Looking at the tab acknowledges its agent's "needs input" warning; a
  // critical flag (pending permission) waits for the agent's next event.
  useEffect(() => {
    if (isVisible && tab.hookAttention?.level === 'warning') onUpdateTab?.({ hookAttention: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible || !term.current) return;
    fitAddon.current?.fit();
    // Same as ShellTerminal: the webview may drop the accelerated canvas'
    // backing (and WebGL's glyph atlas) while display:none — repaint.
    repaintTerminal(term.current);
  }, [isVisible]);

  return (
    <div className="relative h-full w-full bg-[var(--terminal-bg)] p-1.5">
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}
