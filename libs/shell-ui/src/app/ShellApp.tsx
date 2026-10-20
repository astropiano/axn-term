import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '../ContextMenu';
import { Trans } from '@lingui/react/macro';
import { ErrorBoundary } from './ErrorBoundary';
import { dump } from 'js-yaml';
import { Menu, X, Settings, SquareTerminal, Terminal, FileText, Folder, Pencil, BrushCleaning, Eye, MoveRight, AlertOctagon, AlertTriangle, GitBranch, Copy } from 'lucide-react';
import { ShellTerminal } from '../ShellTerminal';
import {
  SessionBackendProvider,
  ShellPlatformProvider,
  ShellServicesProvider,
  bindShellServices,
} from '../services';
import type { FileReader, SessionBackend, ShellServices } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import { isMac, registerShellPlatform } from '../platform';
import { resolveFilePreviewPlugin } from './preview-plugins/plugin';
import { RestoringOverlay } from './RestoringOverlay';
import { TooltipHost } from './Tooltip';
import {
  clearSessionRestoring,
  setSessionRestoring,
  useRestoring,
} from './restoring';
import { SessionPanel } from './SessionPanel';
import { SettingsModal } from './SettingsModal';
import { EditorView } from './EditorView';
import { useEditorClose } from './useEditorClose';
import { BrowserView } from './BrowserView';
import { SubShellView } from './SubShellView';
import { PreviewView } from './PreviewView';
import { GitInspectView } from './GitInspectView';
import { backendFileService, expandPathArg, resolvePath } from './fileService';
import { useShellSessions, MAX_OUTPUT_LENGTH } from './useShellSessions';
import { useAgentTasks } from './useAgentTasks';
import { MemoryStatsProvider } from './useMemoryStats';
import {
  getSessionViewPlugins,
  createWaitForSessionOutput,
  isPluginEnabled,
  pluginCommands,
} from './session-plugins';
import { useSettings, CONFIG_ATTENTION_SOURCE } from '../SettingsProvider';
import { getScreenLines, keepPtyAlive, takePtyKeepAlive, terminalAt } from '../terminalRegistry';
import { MoveToWorkspaceModal } from './MoveToWorkspaceModal';
import { runSubShellClosers } from './subShellAgents';
import { PickerHost } from './pickerHost';
import {
  requestAdopt,
  TOPIC_ADOPT,
  TOPIC_ADOPT_ACK,
  useWorkspaceDirectory,
  type AdoptAck,
  type AdoptRequest,
  type WorkspaceTarget,
} from './windowPeers';
import { defaultTabLabel, planSubShellPromote, planTurnIntoWorkspace } from './subshellPromote';
import {
  PluginSettingsProvider,
  PLUGINS_ATTENTION_SOURCE,
  usePluginSettings,
} from './PluginSettingsProvider';
import { normalizePluginSettings, pluginSettingsToYaml } from './pluginSettings';
import { axnLog } from './log';
import { bindAppRuntime } from './appRuntime';
import { bindGitBackend } from './gitClient';
import { AttentionDot } from './AttentionDot';
import { AttentionModal } from './AttentionModal';
import { Banner, sessionBanners } from './Banner';
import { parseSessionSummary, runCommandChain } from './hiddenCommands';
import { isAppNavigationShortcut, isReloadShortcut } from './shortcuts';
import { AppContextMenu, appMenuTarget, type AppMenuTarget } from './AppContextMenu';
import { sessionAttention, setAppAttention, summarizeAttention, useAppAttention, noteSessionSelected } from './attention';
import type { RailFlag } from './attention';
import { RAIL_ORDER_KEY, orderRailPlugins, railDropIndexAt, railOrderAfterDrop, storedRailOrder } from './railOrder';
import { ptyIdOf } from '../types';
import { controlReply, sessionForPty } from './controlCommands';
import type { AgentCli, EditorTab, RepoInfo, SessionAttention, SessionBanner, ShellSession, WindowState } from '../types';
import type { AppSettings } from '../themes';
import type { RepoMenuContext, SessionViewPlugin } from './session-plugins/plugin';
import {
  dispatchSessionCommand,
  registerSessionCommandDispatch,
} from './session-plugins/plugin';
import { pushSandboxViewData, sandboxRuntime, syncSandboxes } from './session-plugins/sandbox';
import {
  dropHookSpec,
  dropHookRuntime,
  syncHookSpecPlugins,
  maybeWireHookSpec,
  releaseHookSpec,
} from './session-plugins/agentHookBridge';

const SMALL_SCREEN_QUERY = '(max-width: 639px)';

const AXN_BUILTIN_COMMANDS = [
  'axn-edit',
  'axn-browse',
  'axn-preview',
  'axn-sh',
  'axn-rename',
  'axn-install',
  'axn-session',
  'axn-session-mv',
  'axn-session-up',
  'axn-session-down',
  'axn-session-summary',
  'axn-workspace-up',
  'axn-workspace-down',
  'axn-focus',
];

/** Hidden commands that take an argument (get a trailing space on complete). */
const AXN_ARG_COMMANDS = new Set([
  'axn-edit',
  'axn-browse',
  'axn-preview',
  'axn-sh',
  'axn-rename',
  'axn-install',
  'axn-session',
  'axn-session-mv',
  'axn-session-summary',
  'axn-focus',
]);

const AXN_BUILTIN_RE =
  /^\s*(axn-session(?:-mv|-up|-down)?|axn-workspace-up|axn-workspace-down|axn-focus)(?:\s+(.*?))?\s*$/;

/** Filesystem completion for a path argument token; returns full lines. */
async function completePathArg(
  deps: {
    listDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>;
    homeDir: () => Promise<string>;
  },
  cwd: string | undefined,
  linePrefix: string,
  token: string,
  includeFiles: boolean,
): Promise<string[]> {
  const unquoted = token.replace(/^["']/, '');
  const sep = unquoted.lastIndexOf('/');
  const dirPart = sep === -1 ? '' : unquoted.slice(0, sep + 1);
  const base = sep === -1 ? unquoted : unquoted.slice(sep + 1);

  let absDir: string;
  if (dirPart.startsWith('/')) {
    absDir = dirPart;
  } else if (dirPart === '~' || dirPart.startsWith('~/')) {
    const home = await deps.homeDir().catch(() => '');
    if (!home) return [];
    absDir = home.replace(/\/$/, '') + dirPart.slice(1);
  } else if (dirPart === '') {
    absDir = cwd ?? '/';
  } else {
    absDir = `${(cwd ?? '/').replace(/\/$/, '')}/${dirPart}`;
  }

  try {
    const list = await deps.listDir(absDir);
    return list
      .filter(
        (e) => e.name.startsWith(base) && e.name !== base && (includeFiles || e.isDirectory),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      )
      .slice(0, 50)
      .map((e) => `${linePrefix}${dirPart}${e.name}${e.isDirectory ? '/' : ''}`);
  } catch {
    return [];
  }
}

async function resolveSessionPath(
  backend: SessionBackend,
  homeDir: () => Promise<string>,
  session: ShellSession,
  path: string,
  ptyId?: string,
): Promise<string> {
  // Typed arguments get the same unquote + `~` handling as completion.
  const home = path.trim().replace(/^["']/, '').startsWith('~')
    ? await homeDir().catch(() => undefined)
    : undefined;
  const liveCwd =
    (await backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ?? session.cwd;
  return resolvePath(liveCwd, expandPathArg(path, home));
}

function browserTabPatch(session: ShellSession, path: string): Partial<ShellSession> {
  const editors = session.editors ?? [];
  const existing = editors.find((e) => e.path === path && e.kind === 'browser');
  const id = existing?.id ?? `br-${crypto.randomUUID()}`;
  return {
    editors: existing ? editors : [...editors, { id, path, kind: 'browser' }],
    activeTab: id,
  };
}

interface CloseConfirmModalProps {
  sessionCount: number;
  runningCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function CloseConfirmModal({ sessionCount, runningCount, onCancel, onConfirm }: CloseConfirmModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-80 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          Close window?
        </h2>
        <p className="mb-1 text-xs text-[var(--text-primary)]">
          {sessionCount} open session{sessionCount === 1 ? '' : 's'}
        </p>
        <p className="mb-3 text-xs text-[var(--text-secondary)]">
          {runningCount > 0
            ? `${runningCount} ${runningCount === 1 ? 'session has' : 'sessions have'} a running process`
            : 'All sessions are idle'}
        </p>
        {runningCount > 0 && (
          <p className="mb-3 text-xs text-[var(--orange)]">
            Running processes will be terminated.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-[var(--red)] px-3 py-1.5 text-xs text-[var(--text-inverted)] hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ShellAppProps {
  backend: SessionBackend;
  /** Environment services (clipboard/open/reveal) for the bound platform. */
  services: ShellServices;
  platform: ShellPlatform;
  /**
   * File access for hover-card previews and editors; called with the owning
   * session id (remote backends route per-session). Desktop ignores the id.
   */
  fileReader: (sessionId?: string) => FileReader | undefined;
  /**
   * /tasks stream endpoint, resolved per connect (e.g. token-bearing web
   * URL). Absent → no tasks stream.
   */
  tasksWsUrl?: () => string | null | Promise<string | null>;
}

export function ShellApp({ backend, services, platform, fileReader, tasksWsUrl }: ShellAppProps) {
  useEffect(() => {
    registerShellPlatform(platform);
    bindShellServices(services);
    bindGitBackend(backend);
    bindAppRuntime({
      exec: (command, cwd) => {
        const sid = resolveAnySessionId();
        if (!sid || !backend.exec) return Promise.reject(new Error('no live session'));
        return backend.exec(sid, command, cwd);
      },
      statPath: (path, cwd) => {
        const sid = resolveAnySessionId();
        if (!sid || !backend.statPath) return Promise.resolve(null);
        return backend.statPath(sid, cwd ?? '/', path);
      },
      resolveSessionId: resolveAnySessionId,
    });
  }, [backend, platform, services]);

  return (
    <ShellPlatformProvider platform={platform}>
     <SessionBackendProvider backend={backend}>
      <PluginSettingsProvider store={platform.pluginSettingsStore}>
        {/* Last resort: an uncaught error must not leave an empty window. */}
        <ErrorBoundary kind="app" scope="axn-term">
          <ShellAppInner
            backend={backend}
            services={services}
            platform={platform}
            fileReader={fileReader}
            tasksWsUrl={tasksWsUrl}
          />
        </ErrorBoundary>
      </PluginSettingsProvider>
     </SessionBackendProvider>
    </ShellPlatformProvider>
  );
}

/** Any live session id — set by the inner component once sessions load. */
let liveSessionResolver: (() => string | null) | null = null;
function resolveAnySessionId(): string | null {
  return liveSessionResolver?.() ?? null;
}

function ShellAppInner({ backend, services, platform, fileReader, tasksWsUrl }: ShellAppProps) {
  const windowId = platform.window?.id ?? 'main';

  const {
    workspaces,
    sessions,
    selectedWorkspaceId,
    selectedSessionId,
    selectedSession,
    setSelectedSessionId,
    setSelectedWorkspaceId,
    selectNextSession,
    selectPrevSession,
    selectNextWorkspace,
    selectPrevWorkspace,
    addWorkspace,
    renameWorkspace,
    deleteWorkspace,
    toggleWorkspaceCollapsed,
    updateWorkspace,
    moveWorkspace,
    reorderWorkspace,
    moveSessionToWorkspace,
    addSession,
    adoptSession,
    renameSession,
    applySessionAutoName,
    duplicateSession,
    updateSession,
    mergePluginState,
    pluginTabs,
    pluginData,
    updatePluginTabs,
    mergePluginData,
    appendSessionOutput,
    loaded,
    closeSession,
    saveNow,
    importWindowState,
    stateNotice,
    dismissStateNotice,
  } = useShellSessions(windowId, platform.stateStore);
  const { settings, updateSettings } = useSettings();
  const pathDeps = useMemo(
    () => ({
      listDir: (dir: string) =>
        backend.listDir?.(resolveAnySessionId() ?? '', dir) ?? Promise.resolve([]),
      homeDir: () => platform.homeDir(),
    }),
    [backend, platform],
  );
  const { pluginSettings, setPluginSettings, loaded: pluginSettingsLoaded } = usePluginSettings();
  // Read via refs inside callbacks so their identity stays stable across
  // settings changes — a changing identity re-runs ShellTerminal's PTY
  // effect, whose teardown closes the PTY (every session dies and the
  // window auto-closes).
  const pluginSettingsRef = useRef(pluginSettings);
  pluginSettingsRef.current = pluginSettings;
  const mergedServices = useMemo<ShellServices>(
    () => ({
      ...services,
      hasFilePreview: (path) =>
        resolveFilePreviewPlugin(path, pluginSettingsRef.current) != null,
    }),
    [services],
  );
  // Bumped after external .mjs plugins are registered so plugin consumers re-render.
  const [pluginsVersion, setPluginsVersion] = useState(0);
  const [tabDragId, setTabDragId] = useState<string | null>(null);
  const [tabDropId, setTabDropId] = useState<string | null>(null);
  const [railDragId, setRailDragId] = useState<string | null>(null);
  const [railDropIndex, setRailDropIndex] = useState<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    /** Set when the tab lives on a session; unset for plugin-hosted tabs. */
    session?: ShellSession;
    /** Set when the tab is hosted by a plugin view (`pluginTabs` key). */
    pluginId?: string;
    tab: EditorTab;
    x: number;
    y: number;
  } | null>(null);
  // When set, the named plugin's renderView fills the main area and no
  // session is selected in the panel (activated from the plugin's rail view).
  const [activePluginView, setActivePluginView] = useState<string | null>(null);

  useEffect(() => {
    if (!pluginSettingsLoaded) return;
    let cancelled = false;
    Promise.resolve(platform.loadExternalPlugins?.() ?? 0).then((count) => {
      if (!cancelled && count > 0) setPluginsVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pluginSettingsLoaded]);

  // Plugins currently driving a session restore — sessions whose terminal
  // is covered by the blocking RestoringOverlay (sessionId -> labels).
  const restoring = useRestoring();
  const restoringLabels = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [sessionId, plugins] of Object.entries(restoring)) {
      out[sessionId] = Object.values(plugins);
    }
    return out;
  }, [restoring]);

  // Only plugins the user enabled (with met dependencies) run hooks or
  // render into the session view.
  const enabledPlugins = useMemo(
    () => {
      const all = getSessionViewPlugins();
      return all.filter((p) => isPluginEnabled(p, pluginSettings, all));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginSettings, pluginsVersion],
  );

  // Rail plugins render in a user-chosen order persisted under a reserved
  // pluginData key — the stored list is a preference over ids, so newly
  // enabled rail plugins append at the end and disabled ones keep their
  // slot for when they return.
  const railPlugins = useMemo(
    () => orderRailPlugins(enabledPlugins.filter((p) => p.renderRail && !p.pinned), pluginData),
    [enabledPlugins, pluginData],
  );

  // Pinned rail plugins always render first and are not draggable.
  const pinnedRailPlugins = useMemo(
    () => enabledPlugins.filter((p) => p.renderRail && p.pinned),
    [enabledPlugins],
  );

  const dropRailPlugin = useCallback(
    (dragId: string, dropIndex: number) => {
      const order = railOrderAfterDrop(
        railPlugins.map((p) => p.id),
        storedRailOrder(pluginData),
        dragId,
        dropIndex,
      );
      mergePluginData(RAIL_ORDER_KEY, { order });
    },
    [railPlugins, pluginData, mergePluginData],
  );

  // Rail reordering is pointer-driven, not HTML5 drag-and-drop: rail views
  // are <button>s, and WebKit (macOS) starts no drag from a button press —
  // it only showed a "+" copy cursor and never moved anything. Press, move
  // 4px to start, release to drop; Esc cancels. The click that follows a
  // drag is swallowed so dropping does not also toggle the plugin.
  const railItemRefs = useRef(new Map<string, HTMLDivElement>());
  const suppressRailClick = useRef(false);
  const startRailDrag = useCallback(
    (e: React.PointerEvent, pluginId: string) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const dropIndexAt = (y: number) =>
        railDropIndexAt(
          y,
          railPlugins.map((p) => railItemRefs.current.get(p.id)?.getBoundingClientRect()),
        );
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', key, true);
        setRailDragId(null);
        setRailDropIndex(null);
      };
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          dragging = true;
          setRailDragId(pluginId);
        }
        setRailDropIndex(dropIndexAt(ev.clientY));
      };
      const up = (ev: PointerEvent) => {
        end();
        if (!dragging) return;
        suppressRailClick.current = true;
        // No click may follow (released outside the item) — don't let the
        // flag swallow the next real click.
        setTimeout(() => {
          suppressRailClick.current = false;
        }, 0);
        dropRailPlugin(pluginId, dropIndexAt(ev.clientY));
      };
      const cancel = () => end();
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !dragging) return;
        ev.preventDefault();
        dragging = false;
        end();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', key, true);
    },
    [railPlugins, dropRailPlugin],
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || !window.matchMedia(SMALL_SCREEN_QUERY).matches
  );
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const taskState = useAgentTasks(
    selectedSession?.id ?? null,
    updateSession,
    Boolean(selectedSession?.devinActive),
    tasksWsUrl,
  );
  const closingRef = useRef(false);
  // Set when the backend reports OS session teardown (SIGTERM/SIGHUP):
  // collect state and close instead of asking for confirmation.
  const shutdownRequestedRef = useRef(false);
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    liveSessionResolver = () => sessionsRef.current[0]?.id ?? null;
    return () => {
      liveSessionResolver = null;
    };
  }, []);
  const workspacesRef = useRef(workspaces);
  const selectedSessionRef = useRef(selectedSession);
  const pluginTabsRef = useRef(pluginTabs);
  const pluginDataRef = useRef(pluginData);
  const activePluginViewRef = useRef(activePluginView);
  // handleSelectSession is declared further down; sandboxRuntime delegates
  // through this ref so the wiring effect can run earlier.
  const selectSessionRef = useRef<((id: string) => void) | null>(null);
  // Same stability pattern as pluginSettingsRef above — buildPluginApi reads
  // enabled plugins through a ref so the callback identity never changes.
  const enabledPluginsRef = useRef(enabledPlugins);
  // Attention flags already surfaced as an OS notification — plugins re-raise
  // the same flag repeatedly; keyed `${sessionId}:${pluginId}` → flag content.
  const notifiedAttentionRef = useRef(new Map<string, string>());
  const selectedSessionIdRef = useRef(selectedSessionId);
  sessionsRef.current = sessions;
  selectedSessionIdRef.current = selectedSessionId;
  workspacesRef.current = workspaces;
  selectedSessionRef.current = selectedSession;
  pluginTabsRef.current = pluginTabs;
  pluginDataRef.current = pluginData;
  activePluginViewRef.current = activePluginView;
  pluginSettingsRef.current = pluginSettings;
  enabledPluginsRef.current = enabledPlugins;

  // App-level "needs attention": any session flag plus global flags raised by
  // rail plugins (e.g. RAM pressure). Shown as a pulsing icon in the rail;
  // clicking it opens a modal listing every raised flag.
  const appAttention = useAppAttention();
  const railFlags = useMemo<RailFlag[]>(() => {
    const flags: RailFlag[] = Object.entries(appAttention).map(([source, attention]) => ({
      source,
      attention,
      onClick:
        source === CONFIG_ATTENTION_SOURCE || source === PLUGINS_ATTENTION_SOURCE
          ? () => setSettingsOpen(true)
          : undefined,
    }));
    for (const session of sessions) {
      for (const [pluginId, attention] of Object.entries(
        sessionAttention(session, enabledPlugins),
      )) {
        flags.push({
          source: `${session.name} · ${pluginId}`,
          attention,
          sessionId: session.id,
        });
      }
    }
    return flags;
  }, [appAttention, sessions, enabledPlugins]);
  const railAttention = useMemo(
    () =>
      summarizeAttention(Object.fromEntries(railFlags.map((f) => [f.source, f.attention]))),
    [railFlags],
  );
  const [attentionOpen, setAttentionOpen] = useState(false);
  useEffect(() => {
    if (!railAttention) setAttentionOpen(false);
  }, [railAttention]);

  // Generic session sub-view opener used by the plugin `openTab` API:
  // editor/browser/preview/git tabs deduplicate by kind+path.
  const openSessionTab = useCallback(
    (
      sessionId: string,
      tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git'; base?: string },
    ) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const resolved = resolvePath(session.cwd, tab.path);
      const editors = session.editors ?? [];
      const existing = editors.find(
        (e) => e.path === resolved && (e.kind ?? 'editor') === tab.kind,
      );
      const prefix =
        tab.kind === 'browser'
          ? 'br'
          : tab.kind === 'preview'
            ? 'pv'
            : tab.kind === 'git'
              ? 'git'
              : 'ed';
      const id = existing?.id ?? `${prefix}-${crypto.randomUUID()}`;
      updateSession(sessionId, {
        // A base change on an existing git tab retargets its compare section.
        editors: existing
          ? editors.map((e) =>
              e.id === existing.id && e.base !== tab.base ? { ...e, base: tab.base } : e,
            )
          : [...editors, { id, path: resolved, kind: tab.kind, base: tab.base }],
        activeTab: id,
      });
    },
    [updateSession],
  );

  // Open a sub-shell tab for a session: `sh -c <command>` for a one-shot
  // command, or an interactive shell when `command` is unset. `cwd` pins the
  // working directory; otherwise the session's live cwd is used. `agent`
  // marks the tab as hosting an agent conversation (git "talk" tabs) — its
  // re-spawns resume the agent session instead of re-running `command`.
  const openSubShell = useCallback(
    (sessionId: string, command?: string, cwd?: string, label?: string, agent?: AgentCli) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return undefined;
      const id = `sh-${crypto.randomUUID()}`;
      updateSession(sessionId, {
        editors: [
          ...(session.editors ?? []),
          { id, path: '', kind: 'shell', command, cwd, label, agent },
        ],
        activeTab: id,
      });
      return id;
    },
    [updateSession]
  );

  // Opening a session — plugin api, `axn-session`, the panel's New button —
  // selects it and dismisses a covering plugin view so the user lands on it.
  const openSession = useCallback(
    (workspaceId?: string, cwd?: string, name?: string) => {
      setActivePluginView(null);
      addSession(workspaceId, cwd, name);
    },
    [addSession],
  );

  // Activate one of a session's tabs ('shell' = the main terminal) and bring
  // the session forward like a panel click — selects it, dismisses a
  // covering plugin view, clears attention. `axn-focus` and the plugin
  // `activateTab` api route through this.
  const activateSessionTab = useCallback(
    (sessionId: string, tabId: string) => {
      setActivePluginView(null);
      selectSessionRef.current?.(sessionId);
      updateSession(sessionId, { activeTab: tabId });
    },
    [updateSession],
  );

  const buildPluginApi = useCallback(
    (session: ShellSession, plugin: SessionViewPlugin) => {
      const stateKey = plugin.stateKey ?? plugin.id;
      const settingsKey = plugin.settingsKey ?? plugin.id;
      const currentState = (session.pluginState ?? {}) as Record<string, unknown>;
      // PTY-bound ops target the session's current main PTY, which differs
      // from session.id after a sub-shell was promoted.
      const ptyId = ptyIdOf(session);
      return {
        session,
        updateSession,
        writeToSession: async (data: string) => {
          await backend.write(ptyId, data);
        },
        updatePluginState: (patch: unknown) => {
          // Merge against the latest session state inside the updater — using
          // the captured `currentState` here would let a stale snapshot
          // resurrect old fields (e.g. an outdated devinSessionName).
          mergePluginState(session.id, stateKey, patch as Record<string, unknown>);
        },
        getSession: () =>
          sessionsRef.current.find((s) => s.id === session.id) ?? session,
        getSessionCount: () => sessionsRef.current.length,
        pluginState: currentState[stateKey],
        pluginSettings: pluginSettingsRef.current[settingsKey as keyof typeof pluginSettings],
        exec: (command: string, cwd?: string) => {
          if (!backend.exec) return Promise.reject(new Error('exec is not available on this backend'));
          return backend.exec(ptyId, command, cwd ?? session.cwd);
        },
        waitForSessionOutput: createWaitForSessionOutput(backend, ptyId),
        getCwd: () => backend.getCwd?.(ptyId).catch(() => null) ?? Promise.resolve(null),
        getTty: () => backend.getTty?.(ptyId).catch(() => null) ?? Promise.resolve(null),
        openBrowser: (path: string) => {
          const latest =
            sessionsRef.current.find((s) => s.id === session.id) ?? session;
          updateSession(session.id, browserTabPatch(latest, path));
        },
        openTab: (tab: {
          path: string;
          kind: 'editor' | 'browser' | 'preview' | 'git';
          base?: string;
        }) => openSessionTab(session.id, tab),
        openSubShell: (command?: string, cwd?: string, label?: string, agent?: AgentCli) =>
          openSubShell(session.id, command, cwd, label, agent),
        openSession: (cwd?: string, name?: string, workspaceId?: string) =>
          openSession(workspaceId ?? session.workspaceId, cwd, name),
        runCommand: (line: string) =>
          dispatchSessionCommand(session.id, line, ptyId),
        activateTab: (tabId: string) =>
          dispatchSessionCommand(session.id, `axn-focus ${tabId}`, ptyId).then(
            (r) => r === false,
          ),
        getWorkspace: () =>
          workspacesRef.current.find((w) => w.id === session.workspaceId),
        getWorkspaces: () => workspacesRef.current,
        readFile: (path: string, cwd?: string) =>
          backendFileService(backend, ptyId).readFile(path, cwd ?? session.cwd),
        writeFile: (path: string, contents: string, cwd?: string) =>
          backendFileService(backend, ptyId).writeFile(path, cwd ?? session.cwd, contents),
        statPath: (path: string, cwd?: string) =>
          backend.statPath?.(ptyId, cwd ?? session.cwd ?? '/', path).catch(() => null) ??
          Promise.resolve(null),
        mkdir: (path: string, cwd?: string) =>
          backend.mkdir?.(ptyId, resolvePath(cwd ?? session.cwd, path)).then(() => true, () => false) ??
          Promise.resolve(false),
        repoMenuItems: (repo: RepoInfo) => {
          const menuCtx: RepoMenuContext = {
            session,
            updateSession,
            writeToSession: async (data: string) => {
              await backend.write(ptyId, data);
            },
            exec: (command: string, cwd?: string) => {
              if (!backend.exec) return Promise.reject(new Error('exec is not available on this backend'));
              return backend.exec(ptyId, command, cwd ?? session.cwd);
            },
            getCwd: () => backend.getCwd?.(ptyId).catch(() => null) ?? Promise.resolve(null),
            openBrowser: (path: string) => {
              const latest =
                sessionsRef.current.find((s) => s.id === session.id) ?? session;
              updateSession(session.id, browserTabPatch(latest, path));
            },
            openTab: (tab) => openSessionTab(session.id, tab),
            openSubShell: (command, cwd, label, agent) =>
              openSubShell(session.id, command, cwd, label, agent),
          };
          return enabledPluginsRef.current
            .filter((p) => p.repoMenuItems)
            .flatMap((p) => p.repoMenuItems!(menuCtx, repo));
        },
        isProgressHandled: () =>
          enabledPluginsRef.current.some(
            (p) =>
              p.id !== plugin.id &&
              p.handlesProgress &&
              p.processPattern?.test(
                // Read the live process — hooks may fire on a timer long after
                // the ctx snapshot was built (e.g. progress debounce scans).
                (sessionsRef.current.find((s) => s.id === session.id) ?? session)
                  .process ?? '',
              ) === true,
          ),
        getScreenLines: () => getScreenLines(session.id),
        setAttention: (attention: SessionAttention | null) => {
          mergePluginState(session.id, stateKey, { attention: attention ?? null });
          const notifyKey = `${session.id}:${stateKey}`;
          if (!attention) {
            notifiedAttentionRef.current.delete(notifyKey);
            return;
          }
          // OS-notify once per flag content, only for sessions the user isn't
          // looking at (different session selected, or window unfocused).
          const signature = `${attention.level ?? ''}:${attention.message}`;
          if (notifiedAttentionRef.current.get(notifyKey) === signature) return;
          notifiedAttentionRef.current.set(notifyKey, signature);
          if (session.id !== selectedSessionIdRef.current || !document.hasFocus()) {
            services.notify?.(session.name, attention.message);
          }
        },
        setBanner: (banner: SessionBanner | null) => {
          mergePluginState(session.id, stateKey, { banner: banner ?? null });
        },
        setRestoring: (label: string | null) =>
          setSessionRestoring(session.id, plugin.id, label),
        appState: pluginDataRef.current[settingsKey],
        updateAppState: (patch: Record<string, unknown>) =>
          mergePluginData(settingsKey, patch),
      };
    },
    [updateSession, mergePluginState, mergePluginData, openSessionTab, openSubShell, openSession],
  );

  const previousHookPluginsRef = useRef<SessionViewPlugin[]>([]);
  useEffect(() => {
    if (!pluginSettingsLoaded) return;
    syncHookSpecPlugins(previousHookPluginsRef.current, enabledPlugins, (plugin) =>
      sessionsRef.current.map((session) => buildPluginApi(session, plugin)),
    );
    previousHookPluginsRef.current = enabledPlugins;
  }, [enabledPlugins, pluginSettingsLoaded, buildPluginApi]);

  useEffect(() => () => {
    for (const plugin of previousHookPluginsRef.current) {
      if (!plugin.hookSpec) continue;
      for (const session of sessionsRef.current) {
        dropHookRuntime(plugin.hookSpec, session.id);
      }
    }
    previousHookPluginsRef.current = [];
  }, []);

  // Sandboxed external plugins (iframe + postMessage contract): give the
  // bridge live app-state access and boot/tear down plugin sandboxes with
  // the enabled set.
  useEffect(() => {
    sandboxRuntime.getSessions = () => sessionsRef.current;
    sandboxRuntime.buildApi = (plugin, sessionId) => {
      const s = sessionsRef.current.find((x) => x.id === sessionId);
      return s ? buildPluginApi(s, plugin) : undefined;
    };
    sandboxRuntime.mergePluginData = mergePluginData;
    sandboxRuntime.getPluginData = (key) => pluginDataRef.current[key];
    sandboxRuntime.getPluginSettings = (key) => pluginSettingsRef.current[key];
    sandboxRuntime.selectSession = (sessionId) =>
      selectSessionRef.current?.(sessionId);
  }, [buildPluginApi, mergePluginData]);

  useEffect(() => {
    syncSandboxes(
      getSessionViewPlugins(),
      new Set(enabledPlugins.map((p) => p.id)),
    );
    pushSandboxViewData();
  }, [enabledPlugins, sessions, pluginData]);

  const handleSessionOutput = useCallback(
    (sessionId: string, text: string) => {
      appendSessionOutput(sessionId, text);
      const originalSession = sessionsRef.current.find((s) => s.id === sessionId);
      if (!originalSession || !text) return;
      const combined = (originalSession.output ?? '') + text;
      const output =
        combined.length > MAX_OUTPUT_LENGTH ? combined.slice(-MAX_OUTPUT_LENGTH) : combined;
      const session = { ...originalSession, output };
      for (const plugin of enabledPluginsRef.current) {
        const ctx = buildPluginApi(session, plugin);
        plugin.onOutput?.(ctx, text);
        // Declarative agent-hook bridging — spec-only plugins (external
        // .mjs) get the full bridge with no lifecycle code of their own.
        if (plugin.hookSpec) maybeWireHookSpec(plugin, ctx);
      }
    },
    [appendSessionOutput, buildPluginApi],
  );

  // Promote a sub-shell tab to the session's main shell: the tab's PTY takes
  // over the pinned "shell" view (session.mainPtyId) and the old main PTY
  // continues as a sub-shell tab in its place. Both backend PTYs stay alive —
  // only the parent links and the tab bindings change.
  const promoteSubShell = useCallback(
    (sessionId: string, tabId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const plan = planSubShellPromote(session, tabId);
      if (!plan) return;
      // The promoted tab's SubShellView unmounts and the pinned ShellTerminal
      // re-binds to the new PTY — neither unmount may kill its backend
      // process.
      for (const ptyId of plan.keepAlive) keepPtyAlive(ptyId);
      // The promoted PTY becomes the session's root (its exit emits
      // session-exited again); the demoted main shell is re-parented to it so
      // it exits via subshell-exited like any sub-shell tab.
      for (const [subshellId, parentId] of plan.reparent) {
        backend.setSubshellParent?.(subshellId, parentId);
      }
      updateSession(sessionId, plan.patch);
    },
    [updateSession]
  );

  // Convert a session with sub-shells into a workspace: the session moves to
  // a new workspace named after it (kept first) and every sub-shell tab
  // becomes a standalone session that reattaches to its existing PTY.
  const turnIntoWorkspace = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const plan = planTurnIntoWorkspace(session);
      if (!plan) return;
      const workspaceId = addWorkspace(plan.workspaceName);
      moveSessionToWorkspace(sessionId, workspaceId);
      for (const adopted of plan.sessions) {
        // Detach the PTY from the session before removing the tab — the
        // unmounting SubShellView must not kill it, and its exit is reported
        // as session-exited for the adopted session.
        keepPtyAlive(adopted.id);
        backend.setSubshellParent?.(adopted.id, null);
        adoptSession(workspaceId, adopted);
      }
      updateSession(sessionId, plan.patch);
      setSelectedSessionId(sessionId);
    },
    [
      addWorkspace,
      moveSessionToWorkspace,
      adoptSession,
      updateSession,
      setSelectedSessionId,
    ]
  );

  // ---- "Move to workspace…": a searchable picker over every window's
  // workspaces. Same window → plain move; another window → hand the session
  // over through the peer channel. Its PTYs stay alive throughout (output is
  // broadcast to every window, so the target's terminals reattach); the
  // source only lets go once the target confirmed the adoption.
  const otherWindowWorkspaces = useWorkspaceDirectory(platform.peers, windowId, workspaces);
  const [moveDialogSessionId, setMoveDialogSessionId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const moveSessionToWindow = useCallback(
    async (sessionId: string, target: WorkspaceTarget) => {
      const peers = platform.peers;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!peers || !session) return;
      // The main shell plus every sub-shell tab — none may die when this
      // window's views unmount.
      const ptyIds = [
        ptyIdOf(session),
        ...(session.editors ?? []).filter((e) => e.kind === 'shell').map((e) => e.id),
      ];
      for (const id of ptyIds) keepPtyAlive(id);
      const result = await requestAdopt(peers, {
        to: target.windowId,
        from: windowId,
        workspaceId: target.workspace.id,
        session: { ...session, workspaceId: target.workspace.id },
      });
      if (!result.ok) {
        for (const id of ptyIds) takePtyKeepAlive(id);
        setMoveError(
          `Could not move '${session.name}' to ${target.windowLabel} / ${target.workspace.name}: ${result.error}`,
        );
        return;
      }
      // Hand-over confirmed: drop this window's per-session runtime state
      // (hook polling), then let the session go without killing anything.
      for (const plugin of enabledPluginsRef.current) {
        if (plugin.hookSpec) dropHookSpec(plugin, buildPluginApi(session, plugin));
      }
      closeSession(sessionId);
    },
    [platform.peers, windowId, closeSession, buildPluginApi],
  );

  // Adopt sessions handed over by another window.
  useEffect(() => {
    const peers = platform.peers;
    if (!peers) return;
    return peers.subscribe(TOPIC_ADOPT, (payload) => {
      const req = payload as AdoptRequest;
      if (req?.to !== windowId || !req.session?.id) return;
      const ack = (ok: boolean, error?: string) =>
        peers.publish(TOPIC_ADOPT_ACK, {
          to: req.from,
          requestId: req.requestId,
          ok,
          error,
        } satisfies AdoptAck);
      if (!workspacesRef.current.some((w) => w.id === req.workspaceId)) {
        ack(false, 'the workspace no longer exists');
        return;
      }
      if (sessionsRef.current.some((s) => s.id === req.session.id)) {
        ack(false, 'the session is already in that window');
        return;
      }
      adoptSession(req.workspaceId, req.session);
      setSelectedSessionId(req.session.id);
      saveNow().catch(() => {});
      ack(true);
    });
  }, [platform.peers, windowId, adoptSession, setSelectedSessionId, saveNow]);

  const pickMoveTarget = useCallback(
    (sessionId: string, target: WorkspaceTarget) => {
      setMoveDialogSessionId(null);
      if (target.isCurrentWindow) moveSessionToWorkspace(sessionId, target.workspace.id);
      else void moveSessionToWindow(sessionId, target);
    },
    [moveSessionToWorkspace, moveSessionToWindow],
  );

  // Cycle the selected session's tabs: 'shell' first, then sub-view tabs in
  // order. Same modifier family as session/workspace switching. While a
  // tab-hosting plugin view is active it cycles that view's tabs instead
  // ('view' — the plugin's own renderView — pinned first).
  const selectAdjacentTab = useCallback(
    (direction: number) => {
      const viewId = activePluginViewRef.current;
      if (viewId) {
        const plugin = getSessionViewPlugins().find((p) => p.id === viewId);
        const set = pluginTabsRef.current[viewId];
        if (plugin?.hostsTabs && set) {
          const tabIds = ['view', ...set.editors.map((e) => e.id)];
          const idx = Math.max(0, tabIds.indexOf(set.activeTab ?? 'view'));
          const next = tabIds[(idx + direction + tabIds.length) % tabIds.length];
          updatePluginTabs(viewId, { activeTab: next });
        }
        return;
      }
      const session = selectedSessionRef.current;
      if (!session) return;
      const tabIds = ['shell', ...(session.editors ?? []).map((e) => e.id)];
      if (tabIds.length < 2) return;
      const idx = Math.max(0, tabIds.indexOf(session.activeTab ?? 'shell'));
      const next = tabIds[(idx + direction + tabIds.length) % tabIds.length];
      updateSession(session.id, { activeTab: next });
    },
    [updateSession, updatePluginTabs]
  );

  // Built-in hidden commands (axn-session*, axn-workspace-*). Resolves
  // asynchronously; `false` swallows the line, a string replaces it (used to
  // echo errors back into the shell).
  const runBuiltinCommand = useCallback(
    async (
      sessionId: string,
      line: string,
      ptyId?: string,
    ): Promise<string | false | undefined> => {
      const m = AXN_BUILTIN_RE.exec(line);
      if (!m) return undefined;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return false;
      const [, cmd, argRaw] = m;
      const arg = argRaw?.replace(/^["']+|["']+$/g, '');
      // Resolve paths/cwd against the PTY the command was typed into — a
      // sub-shell's cwd can differ from the session's stored cwd.
      const targetPty = ptyId ?? ptyIdOf(session);

      const wsSessions = sessionsRef.current.filter(
        (s) => s.workspaceId === session.workspaceId,
      );
      const idx = wsSessions.findIndex((s) => s.id === sessionId);

      switch (cmd) {
        case 'axn-session': {
          const liveCwd =
            (await backend.getCwd?.(targetPty).catch(() => null)) ?? session.cwd;
          if (!arg || arg === '.') {
            openSession(session.workspaceId, liveCwd ?? undefined);
            return false;
          }
          const stat =
            (await backend.statPath?.(targetPty, liveCwd ?? '/', arg).catch(() => null)) ??
            null;
          if (stat?.isDir) {
            openSession(session.workspaceId, stat.path);
            return false;
          }
          return `echo ${JSON.stringify(`axn-session: not a directory: ${arg}`)}`;
        }
        case 'axn-session-mv': {
          if (!arg) return 'echo "usage: axn-session-mv <workspace>"';
          const existing = workspacesRef.current.find(
            (w) => w.name.toLowerCase() === arg.toLowerCase(),
          );
          moveSessionToWorkspace(sessionId, existing?.id ?? addWorkspace(arg));
          return false;
        }
        case 'axn-session-up': {
          const prev = wsSessions[idx - 1];
          if (idx > 0 && prev) {
            moveSessionToWorkspace(sessionId, session.workspaceId, prev.id);
          }
          return false;
        }
        case 'axn-session-down': {
          const next = wsSessions[idx + 1];
          if (!next) return false;
          const afterNext = wsSessions[idx + 2];
          moveSessionToWorkspace(sessionId, session.workspaceId, afterNext?.id ?? null);
          return false;
        }
        case 'axn-workspace-up':
          moveWorkspace(session.workspaceId, -1);
          return false;
        case 'axn-workspace-down':
          moveWorkspace(session.workspaceId, 1);
          return false;
        case 'axn-focus': {
          // Bring a session view to the front: `shell` (default) the main
          // terminal, else a sub-view tab by 1-based index, kind, id (prefix)
          // or label/path-basename text.
          const target = arg?.trim();
          if (!target || target === 'shell') {
            activateSessionTab(sessionId, 'shell');
            return false;
          }
          const editors = session.editors ?? [];
          const lower = target.toLowerCase();
          const hit =
            (/^\d+$/.test(target) ? editors[parseInt(target, 10) - 1] : undefined) ??
            editors.find((e) => e.id === target || e.id.startsWith(target)) ??
            editors.find((e) => (e.kind ?? 'editor') === lower) ??
            editors.find((e) =>
              (e.label ?? e.path.split('/').pop() ?? '').toLowerCase().includes(lower),
            );
          if (!hit) {
            return `echo ${JSON.stringify(`axn-focus: no such tab: ${target}`)}`;
          }
          activateSessionTab(sessionId, hit.id);
          return false;
        }
      }
      return undefined;
    },
    [openSession, addWorkspace, moveSessionToWorkspace, moveWorkspace, activateSessionTab],
  );

  // Give plugins a chance to intercept submitted input lines ("hidden
  // commands" like axn-devin-resume) before they reach the shell. Built-in
  // axn-session*/axn-workspace-* commands are handled first.
  const handleSessionCommand = useCallback(
    (
      sessionId: string,
      line: string,
      ptyId?: string,
    ): string | false | undefined | Promise<string | false | undefined> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return undefined;
      const renameMatch = /^\s*axn-rename(?:\s+(.*?))?\s*$/.exec(line);
      if (renameMatch) {
        // `axn-rename` (no arg) clears the override → process-reported name.
        renameSession(
          sessionId,
          renameMatch[1]?.trim().replace(/^["']+|["']+$/g, '') ?? '',
        );
        return false;
      }
      const summary = parseSessionSummary(line);
      if (summary !== undefined) {
        // `axn-session-summary` (no arg) clears the summary — same convention
        // as `axn-rename`.
        updateSession(sessionId, { summary });
        return false;
      }
      const shMatch = /^\s*axn-sh(?:\s+(.*?))?\s*$/.exec(line);
      if (shMatch) {
        return (async (): Promise<string | false | undefined> => {
          const arg = shMatch[1]?.trim().replace(/^["']+|["']+$/g, '');
          const targetPty = ptyId ?? ptyIdOf(session);
          if (arg) {
            // A single argument that resolves to a directory opens an
            // interactive sub-shell there (`axn-sh .`, `axn-sh src`); anything
            // else is a `sh -c` one-shot command.
            const liveCwd =
              (await backend.getCwd?.(targetPty).catch(() => null)) ?? session.cwd;
            const stat =
              (await backend.statPath?.(targetPty, liveCwd ?? '/', arg).catch(() => null)) ??
              null;
            if (stat?.isDir) {
              openSubShell(sessionId, undefined, stat.path);
              return false;
            }
          }
          openSubShell(sessionId, arg || undefined);
          return false;
        })();
      }
      const installMatch = /^\s*axn-install(?:\s+(.*?))?\s*$/.exec(line);
      if (installMatch) {
        // Swap for `axn-term install …` and let it run visibly in the shell.
        // Resolve the running binary so the command also works in dev builds
        // where `axn-term` is not on PATH.
        return (async (): Promise<string | false | undefined> => {
          const exe = (await platform.exePath?.().catch(() => undefined)) ?? 'axn-term';
          const args = installMatch[1]?.trim();
          return `${JSON.stringify(exe)} install${args ? ` ${args}` : ''}`;
        })();
      }
      if (
        /^\s*(axn-session(?:-mv|-up|-down)?|axn-workspace-up|axn-workspace-down)(?:\s|$)/.test(
          line,
        )
      ) {
        return runBuiltinCommand(sessionId, line, ptyId);
      }
      // Plugin-declared commands (e.g. axn-devin-resume): the first word of
      // the line selects the owning plugin's command; `run` decides the
      // outcome (a string replaces the line, `false` swallows it, undefined
      // passes it through to the shell).
      const word = /^\s*(\S+)/.exec(line)?.[1];
      if (word) {
        for (const plugin of enabledPluginsRef.current) {
          const declared = pluginCommands(plugin).find((c) => c.name === word && c.run);
          if (!declared?.run) continue;
          const arg = line.trim().slice(word.length).trim() || undefined;
          try {
            // `void` collapses to `undefined` at runtime: pass-through.
            return declared.run(buildPluginApi(session, plugin), arg, line.trim()) as
              | string
              | false
              | undefined
              | Promise<string | false | undefined>;
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] command ${word} failed:`, e);
            return `echo ${JSON.stringify(`${word}: command failed`)}`;
          }
        }
        if (word.startsWith('axn-')) {
          axnLog(
            'warn',
            'shell',
            `no plugin claimed '${word}' — enabled: ${enabledPluginsRef.current.map((p) => p.id).join(',')}`,
          );
        }
      }
      return runCommandChain(
        enabledPluginsRef.current.filter((p) => p.onCommand),
        (plugin) => plugin.onCommand?.(buildPluginApi(session, plugin), line),
        (plugin, e) => console.warn(`[plugin:${plugin.id}] onCommand failed:`, e),
      );
    },
    [buildPluginApi, openSubShell, renameSession, runBuiltinCommand, updateSession],
  );

  // `PluginApi.runCommand` — every built api (SessionPanel call sites don't
  // see this callback) dispatches through the module-level holder.
  useEffect(
    () => registerSessionCommandDispatch(handleSessionCommand),
    [handleSessionCommand],
  );

  // Remote-control command lines (desktop: POST /sessions/<id>/command → the
  // 'remote-command' event) run through the same hidden/plugin dispatch as a
  // typed line — a replacement string is written to the PTY, `false`
  // swallows, `undefined` passes the line through.
  useEffect(() => {
    const unlisten = platform.onRemoteCommand?.(({ sessionId, line }) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const ptyId = ptyIdOf(session);
      void Promise.resolve(handleSessionCommand(sessionId, line, ptyId)).then(
        (resolved) => {
          if (resolved === false) return;
          void backend.write(ptyId, `${typeof resolved === 'string' ? resolved : line}\r`);
        },
      );
    });
    return () => unlisten?.();
  }, [platform, handleSessionCommand]);

  // `axn-term session …` from a program inside one of our terminals (control
  // socket): the line runs through the same dispatch, for the PTY it came
  // from — never typed into it (an agent owns the foreground).
  useEffect(() => {
    const unlisten = platform.onControlCommand?.(async ({ ptyId, line }) => {
      const session = sessionForPty(sessionsRef.current, ptyId);
      if (!session) return null;
      try {
        return controlReply(line, await handleSessionCommand(session.id, line, ptyId));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
    return () => unlisten?.();
  }, [platform, handleSessionCommand]);

  // Tab-completion for axn-* hidden commands: completes the command word, a
  // workspace name for axn-session-mv, or a filesystem path for axn-edit /
  // axn-browse / axn-session. Returns full replacement lines.
  const handleCompleteInput = useCallback(
    async (sessionId: string, line: string, ptyId?: string): Promise<string[]> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return [];
      const declared = enabledPluginsRef.current.flatMap((p) =>
        pluginCommands(p).map((cmd) => ({ plugin: p, cmd })),
      );
      const commands = [...AXN_BUILTIN_COMMANDS, ...declared.map((d) => d.cmd.name)];
      const argCommands = new Set([
        ...AXN_ARG_COMMANDS,
        ...declared.filter((d) => d.cmd.takesArg).map((d) => d.cmd.name),
      ]);
      const m = /^(\s*)(\S*)(?:\s+(.*))?$/.exec(line);
      if (!m) return [];
      const [, leading, word, rest] = m;

      if (rest === undefined) {
        if (!word.startsWith('axn-')) return [];
        const candidates = commands
          .filter((c) => c.startsWith(word) && c !== word)
          .map((c) => `${leading}${c}${argCommands.has(c) ? ' ' : ''}`);
        if (argCommands.has(word)) candidates.unshift(`${leading}${word} `);
        return candidates;
      }

      const completeWorkspaceArg = () => {
        const prefix = rest.replace(/^["']/, '');
        return workspacesRef.current
          .map((w) => w.name)
          .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
          .map((n) => `${leading}${word} ${n.includes(' ') ? `"${n}"` : n}`);
      };

      if (word === 'axn-session-mv') {
        return completeWorkspaceArg();
      }
      if (
        word === 'axn-browse' ||
        word === 'axn-edit' ||
        word === 'axn-preview' ||
        word === 'axn-session' ||
        word === 'axn-sh'
      ) {
        // Complete against the originating PTY's live cwd (a sub-shell's cwd
        // can differ from the session's stored cwd).
        const liveCwd =
          (await backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ??
          session.cwd;
        return completePathArg(
          pathDeps,
          liveCwd,
          `${leading}${word} `,
          rest,
          word === 'axn-edit' || word === 'axn-preview',
        );
      }
      const declaredCmd = declared.find((d) => d.cmd.name === word);
      if (declaredCmd?.cmd.completeArg) {
        try {
          const candidates = await declaredCmd.cmd.completeArg(
            buildPluginApi(session, declaredCmd.plugin),
            rest,
          );
          return candidates.map((a) => `${leading}${word} ${a}`);
        } catch (e) {
          console.warn(`[plugin:${declaredCmd.plugin.id}] completion for ${word} failed:`, e);
          return [];
        }
      }
      const argCompletion = declaredCmd?.cmd.argCompletion;
      if (argCompletion === 'workspace') return completeWorkspaceArg();
      if (argCompletion) {
        const liveCwd =
          (await backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ??
          session.cwd;
        return completePathArg(pathDeps, liveCwd, `${leading}${word} `, rest, argCompletion === 'file');
      }
      return [];
    },
    [buildPluginApi],
  );

  // Sessions whose PTY just spawned, waiting for plugin settings to load
  // before their onSessionOpen hooks may run.
  const pendingReadySessionsRef = useRef<ShellSession[]>([]);

  const flushPendingSessionOpen = useCallback(() => {
    if (!pluginSettingsLoaded) return;
    const pending = pendingReadySessionsRef.current;
    pendingReadySessionsRef.current = [];
    for (const session of pending) {
      for (const plugin of enabledPluginsRef.current) {
        const ctx = buildPluginApi(session, plugin);
        // Fresh PTY → forget hook-bridge state so the next agent start
        // re-resolves its tty, and drop a stale flag.
        if (plugin.hookSpec) dropHookSpec(plugin, ctx);
        // Let plugins declare a pending restore before onSessionOpen injects
        // anything — the overlay goes up while the shell is still settling,
        // so user input cannot race the restore command. Unconditional set
        // also clears a stale overlay when the session re-opens but the
        // plugin no longer intends to restore it.
        try {
          const label = plugin.pendingRestore?.(ctx);
          setSessionRestoring(session.id, plugin.id, label ?? null);
        } catch (e) {
          console.warn(`[plugin:${plugin.id}] pendingRestore failed:`, e);
        }
        try {
          plugin.onSessionOpen?.(ctx);
        } catch (e) {
          console.warn(`[plugin:${plugin.id}] onSessionOpen failed:`, e);
        }
      }
    }
  }, [pluginSettingsLoaded, buildPluginApi]);

  const handleSessionReady = useCallback(
    (session: ShellSession) => {
      pendingReadySessionsRef.current.push(session);
      flushPendingSessionOpen();
    },
    [flushPendingSessionOpen],
  );

  // Fire plugin.onProcessEnd when a session's foreground process stops matching
  // the plugin's processPattern (e.g. devin exits and the shell takes over).
  const prevProcessRef = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    const prev = prevProcessRef.current;
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const prevProc = prev.get(session.id);
      const currProc = session.process;
      prev.set(session.id, currProc);
      if (prevProc === currProc) continue;
      for (const plugin of enabledPluginsRef.current) {
        const pattern = plugin.processPattern;
        if (!pattern || (!plugin.onProcessEnd && !plugin.hookSpec)) continue;
        const wasRunning = prevProc !== undefined && pattern.test(prevProc);
        const isRunning = currProc !== undefined && pattern.test(currProc);
        if (!wasRunning && isRunning) {
          const ctx = buildPluginApi(session, plugin);
          // The initial output can precede foreground-process detection.
          // Start polling even if the agent is now quietly waiting for input.
          plugin.onOutput?.(ctx, '');
          if (plugin.hookSpec) maybeWireHookSpec(plugin, ctx);
        }
        if (wasRunning && !isRunning) {
          const ctx = buildPluginApi(session, plugin);
          // Release the hook bridge first — poll stops, flag clears.
          if (plugin.hookSpec) releaseHookSpec(plugin, ctx);
          try {
            plugin.onProcessEnd?.(ctx);
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] onProcessEnd failed:`, e);
          }
          // Spec-only plugins get the default terminal badge: 'completed'
          // persists as the done signal, anything else falls back to idle.
          if (plugin.hookSpec && !plugin.onProcessEnd) {
            const status = session.status ?? 'idle';
            if (status !== 'completed' && status !== 'idle') {
              ctx.updateSession(session.id, { status: 'idle' });
            }
          }
        }
      }
    }
    // Drop entries for sessions that no longer exist.
    for (const id of [...prev.keys()]) {
      if (!seen.has(id)) prev.delete(id);
    }
  }, [sessions, buildPluginApi]);

  useEffect(() => {
    flushPendingSessionOpen();
  }, [flushPendingSessionOpen]);

  const MIN_SIDEBAR_WIDTH = 192;
  const MAX_SIDEBAR_WIDTH = 448;

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (event: MouseEvent) => {
        const next = startWidth + (event.clientX - startX);
        setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, next)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth],
  );

  const closeNow = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const win = platform.window;

    try {
      // Let plugins gracefully terminate their sessions (e.g. send /exit to devin)
      // and capture any state they emit before the PTY is destroyed. While that
      // runs, show a modal so the user knows the close is in progress — but only
      // when there is actually a plugin collecting session state.
      const collectState =
        sessionsRef.current.length > 0 && enabledPluginsRef.current.some((p) => p.onClose);
      if (collectState) setClosing(true);
      await Promise.all(sessionsRef.current.map(async (session) => {
        for (const plugin of enabledPluginsRef.current) {
          const ctx = buildPluginApi(session, plugin);
          if (plugin.hookSpec) dropHookSpec(plugin, ctx);
          if (!plugin.onClose) continue;
          try {
            await plugin.onClose(ctx);
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] onClose failed for session ${session.id}:`, e);
          }
        }
      }));
      // Sub-shell tabs running an agent: stop them gracefully too, so their
      // exit hints (exact conversation ids) land before the state is saved.
      await runSubShellClosers();

      // Grab the latest cwd for the active session before the PTY goes away.
      const current = selectedSessionRef.current;
      if (current?.id) {
        try {
          const cwd = await backend.getCwd?.(ptyIdOf(current));
          if (cwd && cwd !== current.cwd) {
            updateSession(current.id, { cwd });
          }
        } catch {}
      }

      await saveNow();
    } catch (e) {
      console.error('Failed to flush state before close:', e);
    } finally {
      await win?.destroy().catch(() => {});
    }
  }, [saveNow, updateSession, buildPluginApi, platform]);

  const removeAndClose = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      await (platform.window?.deleteState?.() ?? platform.stateStore.delete?.(windowId));
    } catch (e) {
      console.error('failed to delete window state:', e);
    } finally {
      await platform.window?.destroy().catch(() => {});
    }
  }, [windowId, platform]);

  useEffect(() => {
    let closing = false;
    const unlisten = platform.window?.onCloseRequested?.(async () => {
      if (closingRef.current || closing) return;
      closing = true;
      try {
        if (shutdownRequestedRef.current) {
          await closeNow();
          return;
        }

        if (sessionsRef.current.length === 0) {
          await closeNow();
          return;
        }
        setCloseConfirmOpen(true);
      } finally {
        closing = false;
      }
    });
    return () => unlisten?.();
  }, [closeNow, platform]);

  // Session context-menu close: let plugins gracefully terminate first
  // (devin's onClose interrupts the agent and captures the resume hint)
  // before the session/PTY is torn down — same order as window close.
  const closeSessionGracefully = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      await Promise.all(
        enabledPluginsRef.current.map(async (plugin) => {
          if (!plugin.onClose) return;
          try {
            await plugin.onClose(buildPluginApi(session, plugin));
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] onClose failed for session ${sessionId}:`, e);
          }
        }),
      );
      closeSession(sessionId);
    },
    [buildPluginApi, closeSession],
  );

  useEffect(() => {
    const unlisten = backend.onSessionExit?.((ptyId) => {
      // The payload is a PTY id — a promoted sub-shell PTY maps back to its
      // owning session via mainPtyId.
      const session = sessionsRef.current.find(
        (s) => s.id === ptyId || ptyIdOf(s) === ptyId,
      );
      if (session) closeSession(session.id);
    });
    return () => unlisten?.();
  }, [closeSession, backend]);

  // Route sub-shell exits to the owning session's plugins — the payload is
  // the tab's PTY id, which equals the editors[] tab id (SubShellView spawns
  // the PTY under it). dev-workflow uses this to record check results for
  // `run-in: sub-shell` command actions.
  useEffect(() => {
    const unlisten = backend.onSubshellExit?.((ptyId, exitCode) => {
      const session = sessionsRef.current.find((s) =>
        (s.editors ?? []).some((e) => e.id === ptyId && e.kind === 'shell'),
      );
      if (!session) return;
      for (const plugin of enabledPluginsRef.current) {
        try {
          plugin.onSubShellExit?.(buildPluginApi(session, plugin), ptyId, exitCode);
        } catch (e) {
          console.warn(`[plugin:${plugin.id}] onSubShellExit failed:`, e);
        }
      }
    });
    return () => unlisten?.();
  }, [backend, buildPluginApi]);

  useEffect(() => {
    const unlisten = platform.window?.onCloseNow?.(() => {
      void closeNow();
    });
    return () => unlisten?.();
  }, [closeNow, platform]);

  // The backend emits os-shutdown when the OS terminates the process
  // (SIGTERM/SIGHUP — logout, restart, shutdown). Skip the confirmation
  // modal and run the normal collect-and-close path.
  useEffect(() => {
    const unlisten = platform.window?.onOsShutdown?.(() => {
      shutdownRequestedRef.current = true;
      void closeNow();
    });
    return () => unlisten?.();
  }, [closeNow, platform]);

  useEffect(() => {
    const unlisten = platform.window?.onCloseWindow?.((targetWindowId) => {
      if (targetWindowId === windowId) {
        void removeAndClose();
      }
    });
    return () => unlisten?.();
  }, [windowId, removeAndClose, platform]);

  useEffect(() => {
    if (!platform.autoCloseWhenEmpty) return;
    if (!loaded || sessions.length > 0 || closingRef.current) return;

    platform.window?.close?.();
  }, [loaded, sessions.length, platform]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        platform.window?.createWindow?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---- App-wide right-click menu + window reload. The native webview menu
  // never shows: any right-click no view handled itself (they all
  // preventDefault) opens AppContextMenu — copy/paste for terminals and text
  // fields, plus "Reload window" (also ⌘⇧R / Ctrl+Shift+R). A reload saves
  // first; it runs no React cleanup, so the backend PTYs stay alive and the
  // reloaded window reattaches to them.
  const [appMenu, setAppMenu] = useState<{ x: number; y: number; target: AppMenuTarget } | null>(
    null,
  );
  const reloadWindow = useCallback(async () => {
    await saveNow().catch(() => {});
    window.location.reload();
  }, [saveNow]);
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      setAppMenu({
        x: event.clientX,
        y: event.clientY,
        target: appMenuTarget(event.target, terminalAt),
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isReloadShortcut(event)) return;
      event.preventDefault();
      void reloadWindow();
    };
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [reloadWindow]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isAppNavigationShortcut(event)) return;

      if (event.shiftKey) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActivePluginView(null);
          selectNextWorkspace();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActivePluginView(null);
          selectPrevWorkspace();
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActivePluginView(null);
        selectNextSession();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActivePluginView(null);
        selectPrevSession();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectAdjacentTab(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectAdjacentTab(1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectNextSession, selectPrevSession, selectNextWorkspace, selectPrevWorkspace, selectAdjacentTab]);

  // Selecting (or re-selecting) a session acknowledges its "needs attention"
  // flags. Plugins raise them again only after new output — e.g. the devin
  // idle flag re-arms on output and fires once the screen is quiet again.
  const clearSessionAttention = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const flags = sessionAttention(session, enabledPluginsRef.current);
      for (const plugin of enabledPluginsRef.current) {
        if (!flags[plugin.id]) continue;
        mergePluginState(sessionId, plugin.stateKey ?? plugin.id, {
          attention: null,
        });
      }
    },
    [mergePluginState],
  );

  // Covers keyboard navigation and programmatic selection changes; clicks on
  // the already-selected session are handled in handleSelectSession below.
  useEffect(() => {
    if (selectedSessionId) {
      noteSessionSelected(selectedSessionId);
      clearSessionAttention(selectedSessionId);
    }
  }, [selectedSessionId, clearSessionAttention]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActivePluginView(null);
      noteSessionSelected(id);
      clearSessionAttention(id);
      setSelectedSessionId(id);
      if (typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_QUERY).matches) {
        setSidebarOpen(false);
      }
    },
    [setSelectedSessionId, clearSessionAttention]
  );
  selectSessionRef.current = handleSelectSession;

  const handleSaveWorkspaces = useCallback(async () => {
    const snapshot = {
      version: 1,
      windowState: {
        id: windowId,
        workspaces,
        sessions: sessions.map((s) => ({
          ...s,
          process: undefined,
          status: 'idle' as const,
          progress: 0,
          tasks: [],
          devinActive: false,
        })),
        selectedWorkspaceId,
        selectedSessionId,
      } as WindowState,
      settings,
      pluginSettings,
    };
    const content = JSON.stringify(snapshot, null, 2);
    try {
      await platform.workspaceSetStorage.save(content, 'axn-term-state.json');
      axnLog('info', 'workspace-set', 'saved workspace set');
    } catch (err) {
      axnLog('error', 'workspace-set', `failed to save workspace set: ${String(err)}`);
    }
  }, [windowId, workspaces, sessions, selectedWorkspaceId, selectedSessionId, settings, pluginSettings]);

  const handleLoadWorkspaces = useCallback(async () => {
    try {
      const content = await platform.workspaceSetStorage.load();
      if (!content) return;
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid snapshot format');
      }
      const snapshot = parsed as Record<string, unknown>;
      if (snapshot.windowState && typeof snapshot.windowState === 'object' && !Array.isArray(snapshot.windowState)) {
        importWindowState(snapshot.windowState as Partial<WindowState>);
      } else {
        throw new Error('Snapshot missing windowState');
      }
      if (snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings)) {
        updateSettings(snapshot.settings as Partial<AppSettings>);
      }
      if (
        snapshot.pluginSettings &&
        typeof snapshot.pluginSettings === 'object' &&
        !Array.isArray(snapshot.pluginSettings)
      ) {
        const normalized = normalizePluginSettings(snapshot.pluginSettings);
        const yaml = dump(pluginSettingsToYaml(normalized), { sortKeys: true });
        platform.pluginSettingsStore.write(yaml).catch((err) =>
          axnLog('error', 'workspace-set', `failed to write plugins: ${String(err)}`),
        );
        setPluginSettings(normalized);
      }
      axnLog('info', 'workspace-set', 'loaded workspace set');
    } catch (err) {
      axnLog('error', 'workspace-set', `failed to load workspace set: ${String(err)}`);
    }
  }, [importWindowState, updateSettings, setPluginSettings]);

  const openEditor = useCallback(
    (sessionId: string, path: string, ptyId?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      // Resolve against the originating PTY's live cwd — a sub-shell's cwd can
      // differ from the session's stored cwd (`axn-sh src`).
      void resolveSessionPath(backend, () => platform.homeDir(), session, path, ptyId).then(async (resolved) => {
        // `axn-edit new.md` on a missing file touches it first so the editor
        // opens an empty buffer instead of an ENOENT error.
        const targetPty = ptyId ?? ptyIdOf(session);
        if (backend.statPath && backend.writeFile) {
          const stat = await backend.statPath(targetPty, '/', resolved).catch(() => null);
          if (!stat) await backend.writeFile(targetPty, resolved, '').catch(() => {});
        }
        const latest = sessionsRef.current.find((s) => s.id === sessionId);
        if (!latest) return;
        const editors = latest.editors ?? [];
        const existing = editors.find(
          (e) => e.path === resolved && (e.kind ?? 'editor') === 'editor',
        );
        const id = existing?.id ?? `ed-${crypto.randomUUID()}`;
        updateSession(sessionId, {
          editors: existing ? editors : [...editors, { id, path: resolved, kind: 'editor' }],
          activeTab: id,
        });
      });
    },
    [updateSession]
  );

  // Read-only preview tab rendered by the matching preview plugin
  // (image/markdown/asciidoc/mermaid/…, text fallback for the rest).
  const openPreview = useCallback(
    (sessionId: string, path: string, ptyId?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      // Resolve relative paths now so `axn-preview x.png` and a hover-card
      // Preview (which passes the absolute path) share one tab.
      void resolveSessionPath(backend, () => platform.homeDir(), session, path, ptyId).then((resolved) => {
        const latest = sessionsRef.current.find((s) => s.id === sessionId);
        if (!latest) return;
        const editors = latest.editors ?? [];
        const existing = editors.find((e) => e.path === resolved && e.kind === 'preview');
        const id = existing?.id ?? `pv-${crypto.randomUUID()}`;
        updateSession(sessionId, {
          editors: existing ? editors : [...editors, { id, path: resolved, kind: 'preview' }],
          activeTab: id,
        });
      });
    },
    [updateSession]
  );

  const openBrowser = useCallback(
    (sessionId: string, path: string, ptyId?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      void resolveSessionPath(backend, () => platform.homeDir(), session, path, ptyId).then((resolved) => {
        const latest = sessionsRef.current.find((s) => s.id === sessionId);
        if (latest) updateSession(sessionId, browserTabPatch(latest, resolved));
      });
    },
    [updateSession]
  );

  const { registerEditor, requestClose: requestEditorClose, dialog: editorCloseDialog } = useEditorClose();
  const closeTab = useCallback(
    (session: ShellSession, tabId: string) => {
      const current = sessionsRef.current.find((s) => s.id === session.id);
      const tab = current?.editors?.find((e) => e.id === tabId);
      if (!tab) return;
      requestEditorClose(tab, () => {
        const latest = sessionsRef.current.find((s) => s.id === session.id);
        if (!latest) return;
        if (tab.kind === 'shell') backend.close(tabId);
        const editors = (latest.editors ?? []).filter((e) => e.id !== tabId);
        updateSession(latest.id, {
          editors,
          activeTab: (latest.activeTab ?? 'shell') === tabId ? 'shell' : latest.activeTab,
        });
      });
    },
    [updateSession, requestEditorClose]
  );

  // Patch fields on an editor tab — SubShellView uses it to persist an
  // agent tab's resumeCommand once the tab has run / a session name was
  // captured.
  const updateEditorTab = useCallback(
    (sessionId: string, tabId: string, patch: Partial<EditorTab>) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      updateSession(sessionId, {
        editors: (session.editors ?? []).map((e) =>
          e.id === tabId ? { ...e, ...patch } : e
        ),
      });
    },
    [updateSession]
  );

  const renameTab = useCallback(
    (sessionId: string, tabId: string, label: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const trimmed = label.trim();
      updateSession(sessionId, {
        // An empty label clears the override → default label (command/dir).
        editors: (session.editors ?? []).map((e) =>
          e.id === tabId ? { ...e, label: trimmed || undefined } : e
        ),
      });
    },
    [updateSession]
  );

  const reorderTab = useCallback(
    (session: ShellSession, dragId: string, targetId: string) => {
      const editors = [...(session.editors ?? [])];
      const from = editors.findIndex((e) => e.id === dragId);
      const to = editors.findIndex((e) => e.id === targetId);
      if (from === -1 || to === -1 || from === to) return;
      const [moved] = editors.splice(from, 1);
      editors.splice(to, 0, moved);
      updateSession(session.id, { editors });
    },
    [updateSession]
  );

  const setEditorDirty = useCallback(
    (sessionId: string, editorId: string, dirty: boolean) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      updateSession(sessionId, {
        editors: (session.editors ?? []).map((e) =>
          e.id === editorId ? { ...e, dirty } : e
        ),
      });
    },
    [updateSession]
  );

  // --- Plugin-hosted tabs (plugins declaring `hostsTabs`) -------------------

  // Open (or focus) a tab inside a plugin's view — e.g. the awesome list
  // opening a browse/edit tab for a bookmarked path.
  const openPluginTab = useCallback(
    (pluginId: string, tab: { path: string; kind: 'editor' | 'browser' | 'preview' }) => {
      const set = pluginTabsRef.current[pluginId] ?? { editors: [] };
      const existing = set.editors.find(
        (e) => e.path === tab.path && (e.kind ?? 'editor') === tab.kind,
      );
      const prefix = tab.kind === 'browser' ? 'br' : tab.kind === 'preview' ? 'pv' : 'ed';
      const id = existing?.id ?? `${prefix}-${crypto.randomUUID()}`;
      updatePluginTabs(pluginId, {
        editors: existing
          ? set.editors
          : [...set.editors, { id, path: tab.path, kind: tab.kind }],
        activeTab: id,
      });
    },
    [updatePluginTabs]
  );

  const closePluginTab = useCallback(
    (pluginId: string, tabId: string) => {
      const tab = pluginTabsRef.current[pluginId]?.editors.find((e) => e.id === tabId);
      if (!tab) return;
      requestEditorClose(tab, () => {
        const set = pluginTabsRef.current[pluginId];
        if (!set) return;
        updatePluginTabs(pluginId, {
          editors: set.editors.filter((e) => e.id !== tabId),
          activeTab: (set.activeTab ?? 'view') === tabId ? 'view' : set.activeTab,
        });
      });
    },
    [updatePluginTabs, requestEditorClose]
  );

  // Detach a session sub-view tab into a hosting plugin view. Sub-shell tabs
  // are excluded — their PTY is bound to the owning session; git inspect
  // tabs are session-bound too (plugin views cannot render them).
  const moveTabToPlugin = useCallback(
    (session: ShellSession, tabId: string, pluginId: string) => {
      const tab = (session.editors ?? []).find((e) => e.id === tabId);
      if (!tab || tab.kind === 'shell' || tab.kind === 'git') return;
      const patch: Partial<ShellSession> = {
        editors: (session.editors ?? []).filter((e) => e.id !== tabId),
      };
      if ((session.activeTab ?? 'shell') === tabId) patch.activeTab = 'shell';
      updateSession(session.id, patch);
      const set = pluginTabsRef.current[pluginId] ?? { editors: [] };
      updatePluginTabs(pluginId, {
        editors: [...set.editors, tab],
        activeTab: tab.id,
      });
    },
    [updateSession, updatePluginTabs]
  );

  // Send a plugin-hosted tab back to a session; selecting the session closes
  // the plugin view so the moved tab is immediately visible.
  const moveTabToSession = useCallback(
    (pluginId: string, tabId: string, sessionId: string) => {
      const set = pluginTabsRef.current[pluginId];
      const tab = set?.editors.find((e) => e.id === tabId);
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!set || !tab || !session) return;
      updatePluginTabs(pluginId, {
        editors: set.editors.filter((e) => e.id !== tabId),
        activeTab: (set.activeTab ?? 'view') === tabId ? 'view' : set.activeTab,
      });
      updateSession(sessionId, {
        editors: [...(session.editors ?? []), tab],
        activeTab: tab.id,
      });
      setActivePluginView(null);
      setSelectedSessionId(sessionId);
    },
    [updatePluginTabs, updateSession, setSelectedSessionId]
  );

  const setPluginEditorDirty = useCallback(
    (pluginId: string, tabId: string, dirty: boolean) => {
      const set = pluginTabsRef.current[pluginId];
      if (!set) return;
      updatePluginTabs(pluginId, {
        editors: set.editors.map((e) => (e.id === tabId ? { ...e, dirty } : e)),
      });
    },
    [updatePluginTabs]
  );

  const runningCount = sessions.filter(
    (s) => s.status === 'running' || !!s.process
  ).length;

  // The plugin whose full-area view is active (dropped when the plugin has no
  // renderView or is disabled while active → falls back to the session view).
  const viewPlugin = activePluginView
    ? enabledPlugins.find((p) => p.id === activePluginView && p.renderView)
    : undefined;

  if (!loaded || !selectedSession) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--bg)] text-[var(--text-primary)]">
        <span className="font-mono text-sm">loading sessions...</span>
      </div>
    );
  }

  return (
    <ShellServicesProvider services={mergedServices} fileReader={fileReader}>
    <MemoryStatsProvider active={enabledPlugins.some((p) => p.needsMemoryStats)}>
    <div className="relative flex h-screen w-full overflow-hidden bg-[var(--bg)]">
      {/* Slim left rail — always visible, holds the hamburger + settings. */}
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--bg-secondary)] py-2">
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          data-tip={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          aria-label={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
        >
          <Menu className="h-4 w-4" />
        </button>
        {/* Active/total session counter — a permanent rail slot so plugin
            views below never shift when an attention flag appears. With
            flags raised it doubles as the attention button (pulsing dot +
            level icon above the counter, click opens the modal). */}
        <button
          type="button"
          onClick={railAttention ? () => setAttentionOpen(true) : undefined}
          data-tip={
            (railAttention ? `${railAttention.title}\n—\n` : '') +
            `${sessions.length} session${sessions.length === 1 ? '' : 's'}, ${runningCount} with a running process`
          }
          className={`relative mt-2 flex h-8 w-7 flex-col items-center justify-center gap-px ${
            railAttention ? 'cursor-pointer' : 'cursor-default'
          }`}
        >
          {railAttention && (
            <AttentionDot
              level={railAttention.level}
              className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2"
            />
          )}
          {railAttention &&
            (railAttention.level === 'critical' ? (
              <AlertOctagon className="relative h-3 w-3 text-[var(--red)]" />
            ) : (
              <AlertTriangle className="relative h-3 w-3 text-[var(--orange)]" />
            ))}
          <span className="relative select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]">
            {runningCount}/{sessions.length}
          </span>
        </button>
        {pinnedRailPlugins.map((plugin) => (
          <div key={plugin.id} className="mt-3">
            {plugin.renderRail!({
              backend,
              pluginSettings: pluginSettings[(plugin.settingsKey ?? plugin.id) as keyof typeof pluginSettings],
              setAppAttention: (attention) => setAppAttention(plugin.id, attention),
              viewActive: activePluginView === plugin.id,
              toggleView: () =>
                setActivePluginView((v) =>
                  plugin.renderView ? (v === plugin.id ? null : plugin.id) : v,
                ),
              appState: pluginData[plugin.settingsKey ?? plugin.id],
              updateAppState: (patch) => mergePluginData(plugin.settingsKey ?? plugin.id, patch),
              sessions,
            })}
          </div>
        ))}
        {railPlugins.map((plugin, i) => {
          const settingsKey = plugin.settingsKey ?? plugin.id;
          return (
            <div
              key={plugin.id}
              ref={(el) => {
                if (el) railItemRefs.current.set(plugin.id, el);
                else railItemRefs.current.delete(plugin.id);
              }}
              data-tip={`${plugin.title} (drag to reorder)`}
              onPointerDown={(e) => startRailDrag(e, plugin.id)}
              onClickCapture={(e) => {
                if (!suppressRailClick.current) return;
                suppressRailClick.current = false;
                e.preventDefault();
                e.stopPropagation();
              }}
              onDragStart={(e) => e.preventDefault()}
              className={`mt-3 touch-none select-none${railDragId ? ' cursor-grabbing' : ''}${
                railDragId === plugin.id ? ' opacity-40' : ''
              }${
                railDropIndex === i && railDragId !== plugin.id
                  ? ' shadow-[inset_0_2px_0_var(--accent)]'
                  : ''
              }${
                railDropIndex === railPlugins.length &&
                i === railPlugins.length - 1 &&
                railDragId !== plugin.id
                  ? ' shadow-[inset_0_-2px_0_var(--accent)]'
                  : ''
              }`}
            >
              {plugin.renderRail!({
                backend,
                pluginSettings: pluginSettings[settingsKey as keyof typeof pluginSettings],
                setAppAttention: (attention) => setAppAttention(plugin.id, attention),
                viewActive: activePluginView === plugin.id,
                toggleView: () =>
                  setActivePluginView((v) =>
                    plugin.renderView ? (v === plugin.id ? null : plugin.id) : v,
                  ),
                appState: pluginData[settingsKey],
                updateAppState: (patch) => mergePluginData(settingsKey, patch),
                sessions,
              })}
            </div>
          );
        })}
        {/* Drop target for "append at end" — dragging over the empty rail
            space or the last icon's lower half lands there. */}
        <div
          className={`flex-1${
            railDropIndex === railPlugins.length && railPlugins.length > 0
              ? ' min-h-4'
              : ''
          }`}
        />
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          data-tip="Settings"
          aria-label="Settings"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Session panel: overlay drawer on small screens, inline column on sm+ */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/20 sm:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <div
            className="absolute bottom-0 left-10 top-0 z-40 min-w-[12rem] max-w-[85vw] shadow-lg sm:static sm:z-auto sm:max-w-[28rem] sm:shadow-none"
            style={{ width: sidebarWidth }}
          >
            <div
              className="relative h-full w-full"
              style={{
                fontFamily: settings.panelFontFamily?.trim() || undefined,
                // Panel text is ~12px-based; scale the whole pane proportionally.
                zoom: settings.panelFontSize
                  ? settings.panelFontSize / 12
                  : undefined,
              }}
            >
              <SessionPanel
                workspaces={workspaces}
                sessions={sessions}
                // An active plugin view deselects every session in the panel.
                selectedSessionId={viewPlugin ? '' : selectedSessionId}
                taskState={taskState}
                onSelectWorkspace={setSelectedWorkspaceId}
                onSelectSession={handleSelectSession}
                onAddWorkspace={() => addWorkspace()}
                onSaveWorkspaceSet={handleSaveWorkspaces}
                onLoadWorkspaceSet={handleLoadWorkspaces}
                onRenameWorkspace={renameWorkspace}
                onDeleteWorkspace={deleteWorkspace}
                onToggleWorkspace={toggleWorkspaceCollapsed}
                updateWorkspace={updateWorkspace}
                onAddSession={openSession}
                onMoveSession={moveSessionToWorkspace}
                onRequestMoveSession={setMoveDialogSessionId}
                onReorderWorkspace={reorderWorkspace}
                onMoveWorkspace={moveWorkspace}
                onRenameSession={renameSession}
                onDuplicateSession={duplicateSession}
                onCloseSession={(id) => void closeSessionGracefully(id)}
                updateSession={updateSession}
                mergePluginState={mergePluginState}
                plugins={enabledPlugins}
                onOpenBrowser={openBrowser}
                onOpenTab={openSessionTab}
                pluginData={pluginData}
                mergePluginData={mergePluginData}
                onOpenSubShell={openSubShell}
                onTurnIntoWorkspace={turnIntoWorkspace}
              />
              <div
                onMouseDown={startSidebarResize}
                className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize select-none hover:bg-[var(--surface-hover)]"
              />
            </div>
          </div>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {stateNotice && (
          <Banner level="warning" message={stateNotice} onDismiss={dismissStateNotice} />
        )}
        {moveError && (
          <Banner level="error" message={moveError} onDismiss={() => setMoveError(null)} />
        )}
        <div className="flex min-h-0 flex-1 overflow-hidden">
        {sessions.map((session) => {
          const isVisible = session.id === selectedSessionId && !viewPlugin;
          const editors = session.editors ?? [];
          const activeTab = session.activeTab ?? 'shell';
          return (
            <div
              key={session.id}
              className={isVisible ? 'flex h-full w-full flex-col' : 'hidden'}
            >
              {sessionBanners(session, enabledPlugins).map(({ plugin, stateKey, banner }) => (
                <Banner
                  key={stateKey}
                  level={banner.level}
                  message={banner.message}
                  actions={banner.actions}
                  trailingActions={banner.trailingActions}
                  onAction={
                    plugin.onBannerAction
                      ? (actionId) =>
                          plugin.onBannerAction!(
                            buildPluginApi(session, plugin),
                            actionId,
                          )
                      : undefined
                  }
                  onDismiss={
                    banner.dismissible === false
                      ? undefined
                      : () =>
                          mergePluginState(session.id, stateKey, { banner: null })
                  }
                />
              ))}
              {editors.length > 0 && (
                <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
                  <button
                    type="button"
                    onClick={() => updateSession(session.id, { activeTab: 'shell' })}
                    data-tip="Shell"
                    className={`flex h-6 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] transition ${
                      activeTab === 'shell'
                        ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <SquareTerminal className="h-3.5 w-3.5" />
                    shell
                  </button>
                  {editors.map((ed) => (
                    <div
                      key={ed.id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTabMenu({ session, tab: ed, x: e.clientX, y: e.clientY });
                      }}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-axn-tab', ed.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setTabDragId(ed.id);
                      }}
                      onDragEnd={() => {
                        setTabDragId(null);
                        setTabDropId(null);
                      }}
                      onDragOver={(e) => {
                        if (!tabDragId || tabDragId === ed.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setTabDropId(ed.id);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (tabDragId && tabDragId !== ed.id) {
                          reorderTab(session, tabDragId, ed.id);
                        }
                        setTabDragId(null);
                        setTabDropId(null);
                      }}
                      className={`flex h-6 shrink-0 items-center rounded pl-2 pr-1 text-[11px] transition ${
                        activeTab === ed.id
                          ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                      }${tabDragId === ed.id ? ' opacity-40' : ''}${
                        tabDropId === ed.id && tabDragId !== ed.id
                          ? ' shadow-[inset_2px_0_0_var(--accent)]'
                          : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => updateSession(session.id, { activeTab: ed.id })}
                        data-tip={
                          ed.kind === 'shell'
                            ? (ed.label ?? defaultTabLabel(ed))
                            : ed.path
                        }
                        className="flex items-center gap-1.5"
                      >
                        {ed.kind === 'browser' ? (
                          <Folder className="h-3.5 w-3.5" />
                        ) : ed.kind === 'shell' ? (
                          <Terminal className="h-3.5 w-3.5" />
                        ) : ed.kind === 'preview' ? (
                          <Eye className="h-3.5 w-3.5" />
                        ) : ed.kind === 'git' ? (
                          <GitBranch className="h-3.5 w-3.5" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        <span className="max-w-40 truncate">
                          {ed.kind === 'shell'
                            ? (ed.label ?? defaultTabLabel(ed))
                            : ed.path.split('/').pop() || ed.path}
                        </span>
                        {ed.dirty && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--orange)]" />
                        )}
                        {ed.kind === 'shell' && ed.hookStatus && ed.hookStatus !== 'idle' && (
                          <span
                            data-tip={ed.hookAttention?.message ?? ed.hookStatus}
                            className={`h-1.5 w-1.5 rounded-full ${
                              ed.hookStatus === 'blocked'
                                ? 'animate-pulse bg-[var(--red)]'
                                : ed.hookStatus === 'running'
                                  ? 'bg-[var(--blue)]'
                                  : 'bg-[var(--green)]'
                            }`}
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => closeTab(session, ed.id)}
                        data-tip="Close tab"
                        aria-label="Close tab"
                        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--red)]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <div
                  className={
                    activeTab === 'shell' ? 'relative h-full w-full' : 'hidden'
                  }
                >
                  <ShellTerminal
                    session={session}
                    backend={backend}
                    onSessionNameChange={applySessionAutoName}
                    onSessionOutput={handleSessionOutput}
                    onEditorRequest={openEditor}
                    onBrowserRequest={openBrowser}
                    onPreviewRequest={openPreview}
                    onSessionCommand={handleSessionCommand}
                    onCompleteInput={handleCompleteInput}
                    updateSession={updateSession}
                    isVisible={isVisible && activeTab === 'shell'}
                    onSessionReady={handleSessionReady}
                  />
                  {(restoringLabels[session.id]?.length ?? 0) > 0 && (
                    <RestoringOverlay
                      labels={restoringLabels[session.id]}
                      onDismiss={() => clearSessionRestoring(session.id)}
                    />
                  )}
                </div>
                {editors.map((ed) => (
                  <div
                    key={ed.id}
                    className={activeTab === ed.id ? 'h-full w-full' : 'hidden'}
                  >
                    {/* A crashing tab view replaces only itself. */}
                    <ErrorBoundary
                      scope={`${ed.kind} tab — ${ed.label || ed.path || ed.id}`}
                      extraAction={{
                        label: <Trans>Close tab</Trans>,
                        onClick: () => closeTab(session, ed.id),
                      }}
                    >
                    {ed.kind === 'browser' ? (
                      <BrowserView
                        path={ed.path}
                        cwd={session.cwd}
                        sessionId={session.id}
                        isVisible={isVisible && activeTab === ed.id}
                        onOpenFile={(path) => openEditor(session.id, path)}
                        onPreviewFile={(path) => openPreview(session.id, path)}
                      />
                    ) : ed.kind === 'preview' ? (
                      <PreviewView
                        path={ed.path}
                        cwd={session.cwd}
                        sessionId={session.id}
                        isVisible={isVisible && activeTab === ed.id}
                      />
                    ) : ed.kind === 'shell' ? (
                      <SubShellView
                        session={session}
                        tab={ed}
                        isVisible={isVisible && activeTab === ed.id}
                        onClose={() => closeTab(session, ed.id)}
                        onRename={(label) => renameTab(session.id, ed.id, label)}
                        onUpdateTab={(patch) => updateEditorTab(session.id, ed.id, patch)}
                        onEditorRequest={openEditor}
                        onBrowserRequest={openBrowser}
                        onPreviewRequest={openPreview}
                        onSessionCommand={handleSessionCommand}
                        onCompleteInput={handleCompleteInput}
                      />
                    ) : ed.kind === 'git' ? (
                      <GitInspectView
                        session={session}
                        tab={ed}
                        isVisible={isVisible && activeTab === ed.id}
                        onOpenFile={(path) => openEditor(session.id, path)}
                        onOpenSubShell={(command, cwd, label, agent) =>
                          openSubShell(session.id, command, cwd, label, agent)
                        }
                      />
                    ) : (
                      <EditorView
                        ref={(handle) => registerEditor(ed.id, handle)}
                        path={ed.path}
                        cwd={session.cwd}
                        isVisible={isVisible && activeTab === ed.id}
                        fileService={backendFileService(backend, session.id)}
                        onDirtyChange={(dirty) => setEditorDirty(session.id, ed.id, dirty)}
                      />
                    )}
                    </ErrorBoundary>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {viewPlugin?.renderView && (() => {
          const viewKey = viewPlugin.settingsKey ?? viewPlugin.id;
          // Plugins declaring hostsTabs get a tab strip: their own view is
          // pinned leftmost as 'view', hosted tabs follow.
          const tabSet = viewPlugin.hostsTabs
            ? (pluginTabs[viewPlugin.id] ?? { editors: [] })
            : undefined;
          const hostedTabs = tabSet?.editors ?? [];
          const viewTab = tabSet?.activeTab ?? 'view';
          return (
            <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
              {tabSet && (
                <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
                  <button
                    type="button"
                    onClick={() => updatePluginTabs(viewPlugin.id, { activeTab: 'view' })}
                    data-tip={viewPlugin.title}
                    className={`flex h-6 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] transition ${
                      viewTab === 'view'
                        ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {viewPlugin.title}
                  </button>
                  {hostedTabs.map((ed) => (
                    <div
                      key={ed.id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTabMenu({
                          pluginId: viewPlugin.id,
                          tab: ed,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }}
                      className={`flex h-6 shrink-0 items-center rounded pl-2 pr-1 text-[11px] transition ${
                        viewTab === ed.id
                          ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => updatePluginTabs(viewPlugin.id, { activeTab: ed.id })}
                        data-tip={ed.path}
                        className="flex items-center gap-1.5"
                      >
                        {ed.kind === 'browser' ? (
                          <Folder className="h-3.5 w-3.5" />
                        ) : ed.kind === 'preview' ? (
                          <Eye className="h-3.5 w-3.5" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        <span className="max-w-40 truncate">
                          {ed.path.split('/').pop() || ed.path}
                        </span>
                        {ed.dirty && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--orange)]" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => closePluginTab(viewPlugin.id, ed.id)}
                        data-tip="Close tab"
                        aria-label="Close tab"
                        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--red)]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <div
                  className={
                    !tabSet || viewTab === 'view' ? 'h-full w-full' : 'hidden'
                  }
                >
                  {viewPlugin.renderView({
                    pluginSettings:
                      pluginSettings[viewKey as keyof typeof pluginSettings],
                    close: () => setActivePluginView(null),
                    appState: pluginData[viewKey],
                    updateAppState: (patch) => mergePluginData(viewKey, patch),
                    openTab: viewPlugin.hostsTabs
                      ? (tab) => openPluginTab(viewPlugin.id, tab)
                      : undefined,
                    sessions,
                    workspaces,
                    selectSession: handleSelectSession,
                    sessionApi: (sessionId) => {
                      const s = sessionsRef.current.find((x) => x.id === sessionId);
                      return s ? buildPluginApi(s, viewPlugin) : undefined;
                    },
                  })}
                </div>
                {hostedTabs.map((ed) => (
                  <div
                    key={ed.id}
                    className={viewTab === ed.id ? 'h-full w-full' : 'hidden'}
                  >
                    {ed.kind === 'browser' ? (
                      <BrowserView
                        path={ed.path}
                        isVisible={viewTab === ed.id}
                        onOpenFile={(path) =>
                          openPluginTab(viewPlugin.id, { path, kind: 'editor' })
                        }
                        onPreviewFile={(path) =>
                          openPluginTab(viewPlugin.id, { path, kind: 'preview' })
                        }
                      />
                    ) : ed.kind === 'preview' ? (
                      <PreviewView path={ed.path} isVisible={viewTab === ed.id} />
                    ) : (
                      <EditorView
                        ref={(handle) => registerEditor(ed.id, handle)}
                        path={ed.path}
                        isVisible={viewTab === ed.id}
                        fileService={backendFileService(backend, resolveAnySessionId() ?? '')}
                        onDirtyChange={(dirty) =>
                          setPluginEditorDirty(viewPlugin.id, ed.id, dirty)
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        </div>
      </div>

      {tabMenu && (
        <TabContextMenu
          tab={tabMenu.tab}
          position={{ x: tabMenu.x, y: tabMenu.y }}
          onClose={() => setTabMenu(null)}
          onRename={
            tabMenu.session && tabMenu.tab.kind === 'shell'
              ? (label) => renameTab(tabMenu.session!.id, tabMenu.tab.id, label)
              : undefined
          }
          onMakeMain={
            tabMenu.session && tabMenu.tab.kind === 'shell'
              ? () => promoteSubShell(tabMenu.session!.id, tabMenu.tab.id)
              : undefined
          }
          onCopyPath={
            tabMenu.session && tabMenu.tab.kind === 'shell' && backend.getCwd
              ? () => {
                  const tab = tabMenu.tab;
                  const fallback = tab.cwd ?? tabMenu.session?.cwd;
                  void (async () => {
                    // The tab shell's live cwd (its own PTY), even while a
                    // program runs in it; the recorded cwd is the fallback.
                    const cwd = (await backend.getCwd?.(tab.id).catch(() => null)) ?? fallback;
                    if (cwd) await services.copyText(cwd);
                  })();
                }
              : undefined
          }
          onCloseTab={() =>
            tabMenu.session
              ? closeTab(tabMenu.session, tabMenu.tab.id)
              : tabMenu.pluginId
                ? closePluginTab(tabMenu.pluginId, tabMenu.tab.id)
                : undefined
          }
          moveTargets={
            tabMenu.session
              ? // Sub-shell and git inspect tabs stay bound to their session.
                tabMenu.tab.kind === 'shell' || tabMenu.tab.kind === 'git'
                ? []
                : enabledPlugins
                    .filter((p) => p.hostsTabs && p.renderView)
                    .map((p) => ({ id: p.id, label: p.title }))
              : sessions.map((s) => ({ id: s.id, label: s.name }))
          }
          onMoveTo={(targetId) =>
            tabMenu.session
              ? moveTabToPlugin(tabMenu.session, tabMenu.tab.id, targetId)
              : tabMenu.pluginId
                ? moveTabToSession(tabMenu.pluginId, tabMenu.tab.id, targetId)
                : undefined
          }
        />
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <PickerHost />
      {appMenu && (
        <AppContextMenu
          x={appMenu.x}
          y={appMenu.y}
          target={appMenu.target}
          services={services}
          reloadShortcut={isMac ? '⌘⇧R' : 'Ctrl+Shift+R'}
          onReload={() => void reloadWindow()}
          onClose={() => setAppMenu(null)}
        />
      )}
      {(() => {
        const moving = sessions.find((s) => s.id === moveDialogSessionId);
        return moving ? (
          <MoveToWorkspaceModal
            sessionName={moving.name}
            currentWorkspaceId={moving.workspaceId}
            windowId={windowId}
            ownWorkspaces={workspaces}
            otherWindows={otherWindowWorkspaces}
            onPick={(target) => pickMoveTarget(moving.id, target)}
            onCreate={(name) => {
              setMoveDialogSessionId(null);
              moveSessionToWorkspace(moving.id, addWorkspace(name));
            }}
            onClose={() => setMoveDialogSessionId(null)}
          />
        ) : null;
      })()}
      {attentionOpen && railAttention && (
        <AttentionModal
          flags={railFlags}
          onClose={() => setAttentionOpen(false)}
          onNavigate={(sessionId) => {
            const target = sessionsRef.current.find((s) => s.id === sessionId);
            if (target) setSelectedWorkspaceId(target.workspaceId);
            handleSelectSession(sessionId);
            setAttentionOpen(false);
          }}
        />
      )}
      {closing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="w-80 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-primary)]">
              Closing…
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Collecting session state from plugins before closing.
            </p>
          </div>
        </div>
      )}
      {closeConfirmOpen && (
        <CloseConfirmModal
          sessionCount={sessions.length}
          runningCount={runningCount}
          onCancel={() => setCloseConfirmOpen(false)}
          onConfirm={() => {
            setCloseConfirmOpen(false);
            void closeNow();
          }}
        />
      )}
      {editorCloseDialog}
      <TooltipHost />
    </div>
    </MemoryStatsProvider>
    </ShellServicesProvider>
  );
}

/**
 * Right-click menu for tabs: rename (inline input, sub-shell tabs only),
 * "Move to" targets (sessions ↔ tab-hosting plugin views), and close.
 */
function TabContextMenu({
  tab,
  position,
  onClose,
  onRename,
  onMakeMain,
  onCopyPath,
  onCloseTab,
  moveTargets,
  onMoveTo,
}: {
  tab: EditorTab;
  position: { x: number; y: number };
  onClose: () => void;
  /** Only provided for sub-shell tabs — they are the renamable kind. */
  onRename?: (label: string) => void;
  /** Only provided for sub-shell tabs — promotes the tab to the main shell. */
  onMakeMain?: () => void;
  /** Only provided for sub-shell tabs — copies the tab shell's live cwd. */
  onCopyPath?: () => void;
  onCloseTab: () => void;
  /** "Move to" targets — plugin views for session tabs, sessions for hosted tabs. */
  moveTargets?: { id: string; label: string }[];
  onMoveTo?: (targetId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(tab.label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);


  const tabLabel =
    tab.kind === 'shell'
      ? (tab.label ?? defaultTabLabel(tab))
      : tab.path.split('/').pop() || tab.path;

  const commitRename = () => {
    const trimmed = name.trim();
    // Non-empty sets the tab label; empty clears it → default label.
    if (trimmed ? trimmed !== tab.label : tab.label) onRename?.(trimmed);
    onClose();
  };

  const resetLabel = () => {
    onRename?.('');
    onClose();
  };

  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]';

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      className="rounded-lg bg-[var(--surface)] p-1 shadow-2xl"
    >
      <div className="flex items-center gap-1 pr-1">
        {renaming && onRename ? (
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder={defaultTabLabel(tab)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(tab.label ?? '');
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none"
          />
        ) : (
          <div
            className="min-w-0 flex-1 truncate px-2 py-1 text-[10px] text-[var(--text-secondary)]"
            data-tip={tab.kind === 'shell' ? tabLabel : tab.path}
          >
            {tabLabel}
          </div>
        )}
        {onRename && tab.label && (
          <button
            type="button"
            data-tip="Reset to default name"
            aria-label="Reset to default name"
            onClick={resetLabel}
            className="shrink-0 rounded p-1 text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <BrushCleaning className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="my-1 h-px bg-[var(--border)]" />
      {!renaming && onRename && (
        <button type="button" onClick={() => setRenaming(true)} className={itemClass}>
          <Pencil className="h-3.5 w-3.5 shrink-0" />
          Rename…
        </button>
      )}
      {onMakeMain && (
        <button
          type="button"
          onClick={() => {
            onMakeMain();
            onClose();
          }}
          className={itemClass}
        >
          <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
          Make main shell
        </button>
      )}
      {onCopyPath && (
        <button
          type="button"
          onClick={() => {
            onCopyPath();
            onClose();
          }}
          className={itemClass}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" />
          Copy path
        </button>
      )}
      {moveTargets && moveTargets.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]">
            Move to
          </div>
          {moveTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => {
                onMoveTo?.(target.id);
                onClose();
              }}
              className={itemClass}
            >
              <MoveRight className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{target.label}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--border)]" />
        </>
      )}
      <button
        type="button"
        onClick={() => {
          onCloseTab();
          onClose();
        }}
        className={itemClass}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        Close tab
      </button>
    </ContextMenu>
  );
}
