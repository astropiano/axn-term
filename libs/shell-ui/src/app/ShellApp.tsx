import { createTargetHost, registerTargetHost } from './textTargets';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { ErrorBoundary } from './ErrorBoundary';
import { dump } from 'js-yaml';
import { PanelLeft, X, Settings, FileText, Folder, Eye } from 'lucide-react';
import { ShellTerminal, splitAnsiTail, stripAnsi } from '../ShellTerminal';
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
import { PluginIcon, SessionPanel } from './SessionPanel';
import { SettingsModal } from './SettingsModal';
import { EditorView, GitInspectView, IdeView, preloadMonacoViews } from './lazyViews';
import { useEditorClose } from './useEditorClose';
import { BrowserView } from './BrowserView';
import { SubShellView } from './SubShellView';
import { PreviewView } from './PreviewView';
import { backendFileService, resolvePath } from './fileService';
import { useShellSessions, MAX_OUTPUT_LENGTH } from './useShellSessions';
import { useAgentTasks } from './useAgentTasks';
import { MemoryStatsProvider } from './useMemoryStats';
import {
  getSessionViewPlugins,
  createPluginApi,
  isPluginEnabled,
} from './session-plugins';
import { useSettings, CONFIG_ATTENTION_SOURCE } from '../SettingsProvider';
import { dropSessionBuffer, keepPtyAlive, serializeTerminal, sessionBufferIds, setPendingReplay, stashTerminalReplays, takePtyKeepAlive, terminalAt, terminalIdOf, trackSessionBuffer } from '../terminalRegistry';
import { acquirePty, syncRetainedPtys } from '../ptyLifetime';
import { foregroundStatusPatch } from '../foregroundStatus';
import { agentInputPluginFor } from './session-plugins/agentHookBridge';
import { safely } from '../terminalRenderer';
import { createFileDrop } from './fileDrop';
import { MoveToWorkspaceModal } from './MoveToWorkspaceModal';
import { runSubShellClosers } from './subShellAgents';
import { PickerHost } from './pickerHost';
import { TagHost } from './tagHost';
import {
  requestAdopt,
  TOPIC_ADOPT,
  TOPIC_ADOPT_ACK,
  TOPIC_WINDOW_GONE,
  useWorkspaceDirectory,
  type AdoptAck,
  type AdoptRequest,
  type WorkspaceTarget,
} from './windowPeers';
import {
  FOREIGN_DRAG_LINGER_MS,
  TEAR_OFF_ADOPT_TIMEOUT_MS,
  TEAR_OFF_CLAIM_GRACE_MS,
  TOPIC_SESSION_DRAG,
  TOPIC_SESSION_DRAG_END,
  TOPIC_SESSION_DROP,
  TOPIC_WINDOW_READY,
  WINDOW_READY_REPEAT_MS,
  openTearOffWindow,
  type SessionDrag,
  type SessionDragEnd,
  type SessionDrop,
  type TearOffPlacement,
  type WindowReady,
} from './sessionTearOff';
import { planSubShellPromote, planTurnIntoWorkspace } from './subshellPromote';
import {
  PluginSettingsProvider,
  PLUGINS_ATTENTION_SOURCE,
  usePluginSettings,
} from './PluginSettingsProvider';
import { normalizePluginSettings, pluginSettingsToYaml } from './pluginSettings';
import { axnLog } from './log';
import { IconBagContext, collectIconBag, ICONS_PLUGIN_DATA_KEY, ICONS_SHARED_KEY, type IconBag } from './iconModel';
import { bindAppRuntime } from './appRuntime';
import { setRepoDirProviders } from './repoDirectory';
import { bindGitBackend } from './gitClient';
import { AttentionModal } from './AttentionModal';
import { Banner, sessionBanners } from './Banner';
import {
  isAppNavigationShortcut,
  isPanelToggleShortcut,
  isReloadShortcut,
  panelToggleShortcutLabel,
  railViewAriaShortcut,
  railViewShortcutIndex,
  railViewShortcutLabel,
} from './shortcuts';
import { AppContextMenu, appMenuTarget, type AppMenuTarget } from './AppContextMenu';
import { sessionAttention, setAppAttention, summarizeAttention, useAppAttention, noteSessionSelected } from './attention';
import type { RailFlag } from './attention';
import {
  RAIL_ORDER_KEY,
  orderRailSlots,
  parseViewKey,
  viewKey,
  railDropIndexAt,
  railOrderAfterDrop,
  railViewAfterShortcut,
  railViewIds,
  storedRailOrder,
} from './railOrder';
import { ptyIdOf } from '../types';
import { CloseConfirmModal } from './CloseConfirmModal';
import { TabContextMenu } from './TabContextMenu';
import { useSessionCommands } from './useSessionCommands';
import { SessionTabStrip } from './SessionTabStrip';
import { tabStripTabClasses } from './tabStyles';
import { TabStrip } from './TabStrip';
import { browserTabPatch, ideTabPatch, resolveSessionPath } from './shellCommandSupport';
import { BroadcastDeck } from './BroadcastDeck';
import { broadcastSet, useBroadcastSet } from './broadcastSet';
import { installDropGuard } from './dropGuard';
import type { AgentCli, EditorTab, SessionAttention, ShellSession, WindowState } from '../types';
import type { AppSettings } from '../themes';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { pushSandboxViewData, sandboxRuntime, syncSandboxes } from './session-plugins/sandbox';
import {
  dropHookSpec,
  dropHookRuntime,
  syncHookSpecPlugins,
  maybeWireHookSpec,
  releaseHookSpec,
} from './session-plugins/agentHookBridge';
import { terminalInput } from '../terminalRegistry';
import { focusView } from './viewFocus';
import { RailItem, RailShortcutContext } from './RailItem';
import { nextKeptViews } from './keptViews';
import { publishActiveView, registerViewHost, setFrameOriginAllower, useRuntimeViews } from './viewHost';
import type { RailEntry } from './session-plugins/plugin';
import { ghostButtonClass } from './chromeStyles';
import { MobileKeyBar } from './MobileKeyBar';
import { LONG_PRESS_MS } from '../useContextMenuTrigger';
import { useCoarsePointer, useVisualViewportSize } from '../useMediaQuery';
import { resolveStatusDisplay, type StatusDisplay } from './panelStatus';

const SMALL_SCREEN_QUERY = '(max-width: 639px)';
/** How often batched terminal output reaches session state and plugins. */
const OUTPUT_FLUSH_INTERVAL_MS = 50;



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

/** One rail item: a plugin's own (`key` = plugin id) or one of its `railEntries`. */
interface RailSlot {
  key: string;
  plugin: SessionViewPlugin;
  entry?: RailEntry;
}

export function ShellApp({ backend, services, platform, fileReader, tasksWsUrl }: ShellAppProps) {
  useEffect(() => {
    // Load Monaco in the background once startup has settled, so it never
    // competes with the first terminals but the first editor still opens fast.
    const timer = setTimeout(() => {
      const ric = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      if (ric) ric(preloadMonacoViews);
      else preloadMonacoViews();
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
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
  // Set when another window opened this one to tear a session off into it.
  const bootIntent = platform.window?.bootIntent ?? null;

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
    updateSessionWith,
    mergePluginState,
    pluginTabs,
    pluginData,
    updatePluginTabs,
    mergePluginData,
    appendSessionOutput,
    loaded,
    startedEmpty,
    closeSession,
    saveNow,
    importWindowState,
    stateNotice,
    dismissStateNotice,
  } = useShellSessions(windowId, platform.stateStore, {
    startEmpty:
      bootIntent?.kind === 'tear-off' ? { workspaceName: bootIntent.workspaceName } : undefined,
  });
  const { settings, updateSettings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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
  // A plugin declaring `railEntries` contributes one slot per entry (view
  // key `pluginId/entryId`); runtime views re-evaluate them.
  const runtimeViewList = useRuntimeViews();
  const slotsOf = useCallback(
    (plugin: SessionViewPlugin): RailSlot[] => {
      if (!plugin.railEntries) {
        return plugin.renderRail ? [{ key: plugin.id, plugin }] : [];
      }
      const settings = pluginSettings[(plugin.settingsKey ?? plugin.id) as keyof typeof pluginSettings];
      try {
        return plugin.railEntries({ pluginSettings: settings })
          .filter((entry) => !entry.id.includes('/'))
          .map((entry) => ({ key: viewKey(plugin.id, entry.id), plugin, entry }));
      } catch (e) {
        console.warn(`[plugin:${plugin.id}] railEntries failed:`, e);
        return [];
      }
    },
    // runtimeViewList: railEntries reads the runtime views
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginSettings, runtimeViewList],
  );
  const railPlugins = useMemo(
    () => orderRailSlots(enabledPlugins.filter((p) => !p.pinned).flatMap(slotsOf), pluginData),
    [enabledPlugins, pluginData, slotsOf],
  );

  // Pinned rail plugins always render first and are not draggable.
  const pinnedRailPlugins = useMemo(
    () => enabledPlugins.filter((p) => p.pinned).flatMap(slotsOf),
    [enabledPlugins, slotsOf],
  );

  const dropRailPlugin = useCallback(
    (dragId: string, dropIndex: number) => {
      const order = railOrderAfterDrop(
        railPlugins.map((slot) => slot.key),
        storedRailOrder(pluginData),
        dragId,
        dropIndex,
        new Set(railPlugins.filter((slot) => slot.entry?.runtime).map((slot) => slot.key)),
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

  // The rail's views in display order — what ⌘1…⌘9 (Ctrl elsewhere)
  // count. Read from the rendered rail: a plugin may render no item at all
  // (a forge whose CLI is missing, remote access turned off), and such a
  // slot must not take a number. Slots are marked `data-rail-view` when the
  // plugin has a view; the observer keeps the list current when a plugin's
  // item appears or disappears on its own.
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const [visibleRailViews, setVisibleRailViews] = useState<string[]>([]);
  const visibleRailViewsRef = useRef(visibleRailViews);
  visibleRailViewsRef.current = visibleRailViews;
  useLayoutEffect(() => {
    if (!railEl) return;
    const read = () => {
      const ids = railViewIds(
        Array.from(railEl.querySelectorAll<HTMLElement>('[data-rail-slot]')).map((el) => ({
          id: el.dataset.railSlot ?? '',
          hasView: el.dataset.railView !== undefined,
          visible: el.childElementCount > 0,
        })),
      );
      setVisibleRailViews((prev) =>
        prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
      );
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(railEl, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [railEl, railPlugins, pinnedRailPlugins]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌃⌘S (Ctrl+Shift+S elsewhere): show/hide the session panel.
      if (isPanelToggleShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        setSidebarOpen((v) => !v);
        return;
      }
      const index = railViewShortcutIndex(event, isMac);
      if (index === null) return;
      const next = railViewAfterShortcut(
        visibleRailViewsRef.current,
        index,
        activePluginViewRef.current,
      );
      // No view at that position: leave the key alone.
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setActivePluginView(next);
    };
    // Capture phase, like the reload shortcut: editors and inputs must not
    // swallow it. Terminals let it through (see isRailViewShortcut).
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /** Tooltip / aria shortcut of a rail slot, when it is one of the first ten views. */
  const railShortcutOf = useCallback(
    (pluginId: string) => {
      const label = railViewShortcutLabel(visibleRailViews.indexOf(pluginId), isMac);
      return label
        ? { label, aria: railViewAriaShortcut(visibleRailViews.indexOf(pluginId), isMac) }
        : undefined;
    },
    [visibleRailViews],
  );
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
          railPlugins.map((slot) => railItemRefs.current.get(slot.key)?.getBoundingClientRect()),
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
  // Touch-primary devices get the mobile affordances: the key bar under the
  // terminal, and a root sized to the visual viewport so the on-screen
  // keyboard shrinks the app instead of covering it.
  const coarsePointer = useCoarsePointer();
  const viewportSize = useVisualViewportSize(coarsePointer);
  // Where each plugin's status shows (`statusDisplay`, resolveStatusDisplay):
  // plugins with a heavier rail form (renderRailDetail) get it instead of
  // their plain icon when the setting resolves to the rail — explicitly, or
  // by default on coarse pointers where the panel status stack costs the
  // most space. A plugin without one shows just its plain icon in `rail`
  // mode. Either way its panel accordion is dropped.
  const statusDisplays = useMemo(() => {
    const out = new Map<string, StatusDisplay>();
    for (const p of enabledPlugins) {
      const section = pluginSettings[(p.settingsKey ?? p.id) as keyof typeof pluginSettings] as
        | { statusDisplay?: unknown }
        | undefined;
      out.set(p.id, resolveStatusDisplay(section?.statusDisplay, !!p.renderRailDetail, coarsePointer));
    }
    return out;
  }, [enabledPlugins, pluginSettings, coarsePointer]);
  const railDetailIds = useMemo(
    () =>
      new Set(
        enabledPlugins
          .filter((p) => p.renderRailDetail && statusDisplays.get(p.id) === 'rail')
          .map((p) => p.id),
      ),
    [enabledPlugins, statusDisplays],
  );
  const hiddenStatusIds = useMemo(
    () => [...statusDisplays].filter(([, d]) => d === 'rail').map(([id]) => id),
    [statusDisplays],
  );
  // Long-press on a session/plugin tab opens the same menu as right-click.
  const tabLongPress = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    fired: boolean;
    origin: { x: number; y: number };
    el: HTMLElement | null;
  }>({ timer: null, fired: false, origin: { x: 0, y: 0 }, el: null });
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  // Progress through the plugin onClose hooks (plus sub-shell closers and the
  // final save) while the "collecting session state" modal is up.
  const [closingProgress, setClosingProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const taskState = useAgentTasks(
    selectedSession?.id ?? null,
    updateSession,
    Boolean(selectedSession?.agentInput),
    tasksWsUrl,
  );
  const closingRef = useRef(false);
  // Set when the backend reports OS session teardown (SIGTERM/SIGHUP):
  // collect state and close instead of asking for confirmation.
  const shutdownRequestedRef = useRef(false);
  const sessionsRef = useRef(sessions);
  /** Resolved login-shell basenames per session for the foreground poll. */
  const sessionShellNamesRef = useRef(new Map<string, string>());
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
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  selectedWorkspaceIdRef.current = selectedWorkspaceId;
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
  // plugins (e.g. RAM pressure). The session panel's toolbar shows them — an
  // "N waiting" filter for session flags, a warning button for the rest that
  // opens a modal listing every raised flag — and, while the panel is
  // closed, the panel toggle carries their count.
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
      const prefix =
        tab.kind === 'browser'
          ? 'br'
          : tab.kind === 'preview'
            ? 'pv'
            : tab.kind === 'git'
              ? 'git'
              : 'ed';
      const newId = `${prefix}-${crypto.randomUUID()}`;
      updateSessionWith(sessionId, (session) => {
        const resolved = resolvePath(session.cwd, tab.path);
        const editors = session.editors ?? [];
        const existing = editors.find(
          (e) => e.path === resolved && (e.kind ?? 'editor') === tab.kind,
        );
        const id = existing?.id ?? newId;
        return {
          // A base change on an existing git tab retargets its compare section.
          editors: existing
            ? editors.map((e) =>
                e.id === existing.id && e.base !== tab.base ? { ...e, base: tab.base } : e,
              )
            : [...editors, { id, path: resolved, kind: tab.kind, base: tab.base }],
          activeTab: id,
        };
      });
    },
    [updateSessionWith],
  );

  // Open a sub-shell tab for a session: `sh -c <command>` for a one-shot
  // command, or an interactive shell when `command` is unset. `cwd` pins the
  // working directory; otherwise the session's live cwd is used. `agent`
  // marks the tab as hosting an agent conversation (git "talk" tabs) — its
  // re-spawns resume the agent session instead of re-running `command`.
  const openSubShell = useCallback(
    (sessionId: string, command?: string, cwd?: string, label?: string, agent?: AgentCli) => {
      if (!sessionsRef.current.some((s) => s.id === sessionId)) return undefined;
      const id = `sh-${crypto.randomUUID()}`;
      updateSessionWith(sessionId, (session) => ({
        editors: [
          ...(session.editors ?? []),
          { id, path: '', kind: 'shell', command, cwd, label, agent },
        ],
        activeTab: id,
      }));
      return id;
    },
    [updateSessionWith]
  );

  // Opening a session — plugin api, `axn-session`, the panel's New button —
  // selects it and dismisses a covering plugin view so the user lands on it.
  // `background` (`axn-session --background`, plugin openSession) does
  // neither — the session spawns without taking focus.
  const openSession = useCallback(
    (workspaceId?: string, cwd?: string, name?: string, background?: boolean) => {
      if (!background) setActivePluginView(null);
      const id = addSession(workspaceId, cwd, name, background);
      // Opening a session navigates to it — like a panel click it becomes
      // the only selection, otherwise a live broadcast set would leave it
      // stranded beneath the broadcast view.
      if (id && !background) broadcastSet.replaceAll([id]);
      return id;
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

  // OS-notify a raised flag once per content, only for sessions the user
  // isn't looking at (different session selected, or window unfocused).
  const notifyAttention = useCallback(
    (session: ShellSession, stateKey: string, attention: SessionAttention | null) => {
      const notifyKey = `${session.id}:${stateKey}`;
      if (!attention) {
        notifiedAttentionRef.current.delete(notifyKey);
        return;
      }
      const signature = `${attention.level ?? ''}:${attention.message}`;
      if (notifiedAttentionRef.current.get(notifyKey) === signature) return;
      notifiedAttentionRef.current.set(notifyKey, signature);
      if (session.id !== selectedSessionIdRef.current || !document.hasFocus()) {
        services.notify?.(session.name, attention.message);
      }
    },
    [services],
  );

  const pendingOutputRef = useRef(new Map<string, string>());
  const outputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSessionOutputRef = useRef<() => void>(() => {});
  /** Live session including output still waiting for the next batch flush. */
  const liveSessionWithPending = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    const pending = pendingOutputRef.current.get(sessionId);
    if (!session || !pending) return session;
    const combined = (session.output ?? '') + pending;
    return {
      ...session,
      output: combined.length > MAX_OUTPUT_LENGTH ? combined.slice(-MAX_OUTPUT_LENGTH) : combined,
    };
  }, []);

  const buildPluginApi = useCallback(
    (session: ShellSession, plugin: SessionViewPlugin) =>
      createPluginApi(session, plugin, {
        backend,
        updateSession,
        mergePluginState,
        pluginSettings: pluginSettingsRef.current,
        plugins: getSessionViewPlugins(),
        openBrowser: (sessionId, path) => {
          const latest = sessionsRef.current.find((s) => s.id === sessionId) ?? session;
          updateSession(sessionId, browserTabPatch(latest, path));
        },
        openTab: openSessionTab,
        openSubShell,
        openSession,
        getWorkspaces: () => workspacesRef.current,
        pluginData: pluginDataRef.current,
        mergePluginData,
        getLiveSession: liveSessionWithPending,
        getSessionCount: () => sessionsRef.current.length,
        onAttention: notifyAttention,
      }),
    [updateSession, mergePluginState, mergePluginData, openSessionTab, openSubShell, openSession, notifyAttention, liveSessionWithPending],
  );

  // A rail plugin's rendered item: the heavier `renderRailDetail` when the
  // plugin opted in and the user placed its status in the rail, else the
  // plain `renderRail` icon. Same ctx either way.
  const railNode = useCallback(
    (plugin: SessionViewPlugin) => {
      const render =
        (railDetailIds.has(plugin.id) ? plugin.renderRailDetail : undefined) ?? plugin.renderRail;
      const settingsKey = plugin.settingsKey ?? plugin.id;
      return render?.({
        backend,
        pluginSettings: pluginSettings[settingsKey as keyof typeof pluginSettings],
        setAppAttention: (attention) => setAppAttention(plugin.id, attention),
        viewActive: activePluginView === plugin.id,
        toggleView: () =>
          setActivePluginView((v) => (plugin.renderView ? (v === plugin.id ? null : plugin.id) : v)),
        appState: pluginData[settingsKey],
        updateAppState: (patch) => mergePluginData(settingsKey, patch),
        sessions,
        sessionApi: (sessionId) => {
          const s = sessionsRef.current.find((x) => x.id === sessionId);
          return s ? buildPluginApi(s, plugin) : undefined;
        },
      });
    },
    [
      backend,
      pluginSettings,
      pluginData,
      sessions,
      activePluginView,
      railDetailIds,
      mergePluginData,
      buildPluginApi,
    ],
  );

  // An entry slot is drawn by the host: the plugin only names its entries.
  const railSlotNode = useCallback(
    (slot: RailSlot) =>
      slot.entry ? (
        <RailItem
          title={slot.entry.title}
          active={activePluginView === slot.key}
          onClick={() => setActivePluginView((v) => (v === slot.key ? null : slot.key))}
        >
          <PluginIcon
            plugin={{ id: slot.key, logo: slot.entry.logo ?? slot.plugin.logo ?? 'Globe' }}
            className="h-[18px] w-[18px]"
          />
        </RailItem>
      ) : (
        railNode(slot.plugin)
      ),
    [activePluginView, railNode],
  );

  // Enabled plugins declaring `repoDirs` feed local repo discovery
  // (repoDirectory.ts) — the forge plugins add them to their repo-roots scan.
  useEffect(() => {
    setRepoDirProviders(
      enabledPlugins.flatMap((p) => (p.repoDirs ? [{ id: p.id, repoDirs: p.repoDirs }] : [])),
    );
  }, [enabledPlugins]);

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

  // Text targets (ticket keys, tracker links …): the terminal link provider
  // and chips ask this host for the enabled plugins' readers and actions.
  useEffect(
    () =>
      registerTargetHost(
        createTargetHost({
          plugins: () => enabledPluginsRef.current,
          settings: () => pluginSettingsRef.current,
          sessions: () => sessionsRef.current,
          selectedSessionId: () => selectedSessionIdRef.current ?? undefined,
          buildApi: buildPluginApi,
          selectSession: (sessionId) => selectSessionRef.current?.(sessionId),
        }),
      ),
    [buildPluginApi],
  );

  useEffect(() => {
    syncSandboxes(
      getSessionViewPlugins(),
      new Set(enabledPlugins.map((p) => p.id)),
    );
    pushSandboxViewData();
  }, [enabledPlugins, sessions, pluginData]);

  // Terminal output reaches session state and plugin onOutput in batches:
  // per-chunk updates re-rendered the whole app thousands of times a second
  // during bursts (`cat` of a big file, build logs). The terminal itself
  // writes every chunk immediately; only the text copy for plugins waits.
  const flushSessionOutput = useCallback(() => {
    if (outputFlushTimerRef.current !== null) {
      clearTimeout(outputFlushTimerRef.current);
      outputFlushTimerRef.current = null;
    }
    const pending = pendingOutputRef.current;
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    for (const [sessionId, text] of batch) {
      appendSessionOutput(sessionId, text);
      const originalSession = sessionsRef.current.find((s) => s.id === sessionId);
      if (!originalSession) continue;
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
    }
  }, [appendSessionOutput, buildPluginApi]);
  flushSessionOutputRef.current = flushSessionOutput;

  const handleSessionOutput = useCallback((sessionId: string, text: string) => {
    if (!text) return;
    const pending = pendingOutputRef.current;
    const combined = (pending.get(sessionId) ?? '') + text;
    pending.set(
      sessionId,
      combined.length > MAX_OUTPUT_LENGTH ? combined.slice(-MAX_OUTPUT_LENGTH) : combined,
    );
    if (outputFlushTimerRef.current === null) {
      outputFlushTimerRef.current = setTimeout(
        () => flushSessionOutputRef.current(),
        OUTPUT_FLUSH_INTERVAL_MS,
      );
    }
  }, []);

  // Session PTYs are owned by session state, not by mounted views —
  // plugin-style: only the selected session mounts a view. Output
  // retention and plugin onOutput hooks therefore subscribe here, at
  // session level, so background sessions keep retaining output and
  // feeding plugins; and every session + sub-shell PTY is retained for as
  // long as its session exists, so a view unmount never kills a process.
  const sessionPtyKey = sessions
    .map(
      (s) =>
        `${s.id}=${ptyIdOf(s)}:${(s.editors ?? [])
          .filter((t) => t.kind === 'shell')
          .map((t) => t.id)
          .join(',')}`,
    )
    .join('\u0000');
  useEffect(() => {
    const retained: string[] = [];
    const offs: (() => void)[] = [];
    const live = new Set<string>();
    for (const pair of sessionPtyKey.split('\u0000')) {
      if (!pair) continue;
      const [sessionId, rest] = pair.split('=');
      const [ptyId, tabIds = ''] = rest.split(':');
      retained.push(ptyId, ...tabIds.split(',').filter(Boolean));
      live.add(sessionId);
      // The headless buffer keeps the session's screen current while no
      // view is mounted — plugins read it via getScreenLines, a remount
      // serializes it for the repaint.
      const buffer = trackSessionBuffer(sessionId);
      const decoder = new TextDecoder();
      // PTY chunks split escape sequences mid-way — hold back a trailing
      // incomplete sequence so stripAnsi never leaks `7;file://` /
      // `2;ls` fragments into retained output and plugin hooks.
      let pending = '';
      offs.push(
        backend.onOutput(ptyId, (bytes) => {
          buffer.write(bytes);
          const [complete, tail] = splitAnsiTail(
            pending + decoder.decode(bytes, { stream: true }),
          );
          pending = tail;
          const text = stripAnsi(complete);
          if (text) handleSessionOutput(sessionId, text);
        }),
      );

      // cwd + foreground-process polling used to ride each session's
      // hidden view — sessions own it now (background sessions must still
      // track agent exits and where devin actually ran for restore).
      const timers: ReturnType<typeof setInterval>[] = [];
      if (backend.getCwd) {
        // In-flight guard: a host slow to answer must not get a new
        // request stacked on every tick.
        let cwdBusy = false;
        const pollCwd = async () => {
          if (cwdBusy) return;
          cwdBusy = true;
          try {
            const cwd = (await backend.getCwd!(ptyId)) ?? null;
            const current = sessionsRef.current.find((s) => s.id === sessionId);
            // A cwd patch is structural — updateSession saves it eagerly.
            if (current && cwd && cwd !== current.cwd) updateSession(sessionId, { cwd });
          } catch {
            // ignore
          } finally {
            cwdBusy = false;
          }
        };
        void pollCwd();
        timers.push(setInterval(pollCwd, 1000));
      }
      if (backend.getForegroundProcess) {
        let processBusy = false;
        const pollProcess = async () => {
          if (processBusy) return;
          processBusy = true;
          try {
            const process = (await backend.getForegroundProcess!(ptyId)) ?? null;
            const session = sessionsRef.current.find((s) => s.id === sessionId);
            if (!session) return;
            const processName = process?.toLowerCase() ?? '';
            if (!sessionShellNamesRef.current.has(sessionId)) {
              const resolved =
                settings.defaultShell?.trim() || (await backend.getDefaultShell?.()) || 'sh';
              sessionShellNamesRef.current.set(
                sessionId,
                resolved.split(/[/\\]/).pop()!.toLowerCase(),
              );
            }
            const isShell =
              !processName || processName === sessionShellNamesRef.current.get(sessionId);
            const agent = isShell ? undefined : agentInputPluginFor(processName)?.id;
            const processDisplay = isShell ? undefined : (process ?? undefined);
            const patch = foregroundStatusPatch(session, processDisplay);
            if (agent !== session.agentInput) patch.agentInput = agent;
            if (Object.keys(patch).length > 0) updateSession(sessionId, patch);
          } catch {
            // ignore
          } finally {
            processBusy = false;
          }
        };
        void pollProcess();
        timers.push(setInterval(pollProcess, 1000));
      }
      offs.push(() => timers.forEach((t) => clearInterval(t)));
    }
    for (const id of sessionBufferIds()) {
      if (!live.has(id)) dropSessionBuffer(id);
    }
    syncRetainedPtys(retained);
    return () => {
      for (const off of offs) safely('session output listener', off);
    };
  }, [backend, sessionPtyKey, handleSessionOutput]);

  useEffect(
    () => () => {
      if (outputFlushTimerRef.current !== null) clearTimeout(outputFlushTimerRef.current);
    },
    [],
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
    async (sessionId: string, target: WorkspaceTarget, beforeSessionId?: string | null) => {
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
      // Carry the terminals' history along: the PTYs stay put and only send
      // new output, so the target window would otherwise start blank.
      const replay: Record<string, string> = {};
      for (const id of [session.id, ...(session.editors ?? []).filter((e) => e.kind === 'shell').map((e) => e.id)]) {
        const data = serializeTerminal(id);
        if (data) replay[id] = data;
      }
      const result = await requestAdopt(peers, {
        to: target.windowId,
        from: windowId,
        workspaceId: target.workspace.id,
        session: { ...session, workspaceId: target.workspace.id },
        beforeSessionId: beforeSessionId ?? null,
        replay,
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
      closeSession(sessionId, 'moved to other window');
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
      for (const [id, data] of Object.entries(req.replay ?? {})) {
        if (typeof data === 'string') setPendingReplay(id, data);
      }
      adoptSession(req.workspaceId, req.session);
      // A drop between two rows: place it there (moveSessionToWorkspace
      // also saves). Otherwise it appends.
      if (req.beforeSessionId) {
        moveSessionToWorkspace(req.session.id, req.workspaceId, req.beforeSessionId);
      }
      setSelectedSessionId(req.session.id);
      saveNow().catch(() => {});
      ack(true);
      // The user just sent a session here — show it.
      platform.window?.focus?.();
    });
  }, [platform.peers, windowId, adoptSession, moveSessionToWorkspace, setSelectedSessionId, saveNow]);

  const pickMoveTarget = useCallback(
    (sessionId: string, target: WorkspaceTarget) => {
      setMoveDialogSessionId(null);
      if (target.isCurrentWindow) moveSessionToWorkspace(sessionId, target.workspace.id);
      else void moveSessionToWindow(sessionId, target);
    },
    [moveSessionToWorkspace, moveSessionToWindow],
  );

  // ---- Session tear-off, Chrome-tab style (see sessionTearOff.ts): drag a
  // session row out of the window and it opens in a window of its own; drag
  // it onto another window and it moves there. Every hand-over is the adopt
  // request above, so PTYs, tabs, plugin state and scrollback ride along.
  const canTearOff = Boolean(platform.peers && platform.window?.createWindow);
  // Sessions with a hand-over in flight — a drag can trigger both a tear-off
  // and a drop claim; whichever starts first wins.
  const inFlightMovesRef = useRef(new Set<string>());
  // Tear-offs waiting out TEAR_OFF_CLAIM_GRACE_MS for a drop claim.
  const pendingTearOffsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** Open a window for `sessionId` and hand the session over; resolves an error message or null. */
  const tearOffSession = useCallback(
    async (sessionId: string, placement?: TearOffPlacement): Promise<string | null> => {
      const peers = platform.peers;
      const createWindow = platform.window?.createWindow;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return 'no such session';
      if (!peers || !createWindow) return 'new windows are not available here';
      if (sessionsRef.current.length <= 1) return 'this is the only session in its window';
      if (inFlightMovesRef.current.has(sessionId)) return null;
      inFlightMovesRef.current.add(sessionId);
      try {
        const opened = await openTearOffWindow(peers, createWindow, {
          from: windowId,
          workspaceName: workspacesRef.current.find((w) => w.id === session.workspaceId)?.name,
          placement,
        });
        if (!opened.ok) {
          const message = `Could not move '${session.name}' to a new window: ${opened.error}`;
          setMoveError(message);
          return message;
        }
        await moveSessionToWindow(sessionId, {
          windowId: opened.ready.windowId,
          windowLabel: 'a new window',
          isCurrentWindow: false,
          workspace: opened.ready.workspace,
        });
        return null;
      } finally {
        inFlightMovesRef.current.delete(sessionId);
      }
    },
    [platform.peers, platform.window, windowId, moveSessionToWindow],
  );

  // Drag source: announce the drag so other windows accept the drop; a drag
  // that ends outside every window becomes a tear-off.
  const handleSessionDragStart = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      platform.peers?.publish(TOPIC_SESSION_DRAG, {
        from: windowId,
        sessionId,
        name: session.name,
      } satisfies SessionDrag);
    },
    [platform.peers, windowId],
  );

  const handleSessionDragEnd = useCallback(
    (sessionId: string, end: { dropEffect: string; outside: boolean; placement: TearOffPlacement }) => {
      platform.peers?.publish(TOPIC_SESSION_DRAG_END, { from: windowId, sessionId } satisfies SessionDragEnd);
      if (!canTearOff || end.dropEffect !== 'none' || !end.outside) return;
      // Nothing took the drop and it landed outside this window. Give a
      // window's drop claim (sent from its own drop handler) a moment to
      // overtake this dragend before opening a new window.
      clearTimeout(pendingTearOffsRef.current.get(sessionId));
      pendingTearOffsRef.current.set(
        sessionId,
        setTimeout(() => {
          pendingTearOffsRef.current.delete(sessionId);
          void tearOffSession(sessionId, end.placement);
        }, TEAR_OFF_CLAIM_GRACE_MS),
      );
    },
    [platform.peers, windowId, canTearOff, tearOffSession],
  );

  // Drag source: another window took our dragged session — hand it over.
  useEffect(() => {
    const peers = platform.peers;
    if (!peers) return;
    return peers.subscribe(TOPIC_SESSION_DROP, (payload) => {
      const drop = payload as SessionDrop;
      if (drop?.to !== windowId || !drop.windowId || drop.windowId === windowId) return;
      if (!drop.sessionId || typeof drop.workspace?.id !== 'string') return;
      const pending = pendingTearOffsRef.current.get(drop.sessionId);
      if (pending) {
        clearTimeout(pending);
        pendingTearOffsRef.current.delete(drop.sessionId);
      }
      if (inFlightMovesRef.current.has(drop.sessionId)) return;
      if (!sessionsRef.current.some((s) => s.id === drop.sessionId)) return;
      inFlightMovesRef.current.add(drop.sessionId);
      void moveSessionToWindow(
        drop.sessionId,
        {
          windowId: drop.windowId,
          windowLabel: 'the other window',
          isCurrentWindow: false,
          workspace: drop.workspace,
        },
        drop.beforeSessionId,
      ).finally(() => inFlightMovesRef.current.delete(drop.sessionId));
    });
  }, [platform.peers, windowId, moveSessionToWindow]);

  useEffect(() => {
    const pending = pendingTearOffsRef.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // Drop target: while another window drags a session, accept it. The ref
  // lingers briefly after the drag's end — the source's dragend can overtake
  // this window's own drop event.
  const [foreignDrag, setForeignDrag] = useState<SessionDrag | null>(null);
  const foreignDragRef = useRef<SessionDrag | null>(null);
  useEffect(() => {
    const peers = platform.peers;
    if (!peers) return;
    let linger: ReturnType<typeof setTimeout> | undefined;
    const forget = () => {
      clearTimeout(linger);
      foreignDragRef.current = null;
      setForeignDrag(null);
    };
    const unsubs = [
      peers.subscribe(TOPIC_SESSION_DRAG, (payload) => {
        const drag = payload as SessionDrag;
        if (!drag?.sessionId || !drag.from || drag.from === windowId) return;
        clearTimeout(linger);
        foreignDragRef.current = drag;
        setForeignDrag(drag);
      }),
      peers.subscribe(TOPIC_SESSION_DRAG_END, (payload) => {
        const end = payload as SessionDragEnd;
        const drag = foreignDragRef.current;
        if (!drag || end?.from !== drag.from || end.sessionId !== drag.sessionId) return;
        setForeignDrag(null);
        clearTimeout(linger);
        linger = setTimeout(() => {
          foreignDragRef.current = null;
        }, FOREIGN_DRAG_LINGER_MS);
      }),
      peers.subscribe(TOPIC_WINDOW_GONE, (payload) => {
        if ((payload as { windowId?: string })?.windowId === foreignDragRef.current?.from) forget();
      }),
    ];
    return () => {
      clearTimeout(linger);
      for (const unsub of unsubs) unsub();
    };
  }, [platform.peers, windowId]);

  /** Claim the foreign session dragged onto this window; true when claimed. */
  const claimForeignDrop = useCallback(
    (workspaceId: string, beforeSessionId: string | null): boolean => {
      const drag = foreignDragRef.current;
      const peers = platform.peers;
      const workspace = workspacesRef.current.find((w) => w.id === workspaceId);
      if (!drag || !peers || !workspace) return false;
      foreignDragRef.current = null;
      setForeignDrag(null);
      peers.publish(TOPIC_SESSION_DROP, {
        to: drag.from,
        sessionId: drag.sessionId,
        windowId,
        workspace: { id: workspace.id, name: workspace.name },
        beforeSessionId,
      } satisfies SessionDrop);
      return true;
    },
    [platform.peers, windowId],
  );

  // Dropped files/URLs/text from outside must never navigate the webview —
  // only x-axn drags and drags that started inside this window reach drop
  // targets (see dropGuard.ts). Foreign drops on a terminal paste their
  // paths at the prompt (fileDrop.ts).
  useEffect(() => {
    const save = backend.saveDroppedFile?.bind(backend);
    const fileDrop = createFileDrop({
      terminalAt,
      localPaths: backend.localFiles === true,
      onNativeDrop: services.onFileDrop?.bind(services),
      saveFile: save
        ? (term, name, bytes) => {
            const id = terminalIdOf(term);
            if (!id) return Promise.reject(new Error('terminal has no session'));
            return save(id, name, bytes);
          }
        : undefined,
    });
    const uninstall = installDropGuard(window, fileDrop);
    return () => {
      uninstall();
      fileDrop.dispose();
    };
  }, [backend, services]);

  // The whole window is a drop target for a foreign session: drops the
  // session panel did not place (it preventDefaults its own) land in the
  // selected workspace.
  useEffect(() => {
    if (!platform.peers) return;
    const onDragOver = (e: DragEvent) => {
      if (!foreignDragRef.current) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    };
    const onDrop = (e: DragEvent) => {
      if (!foreignDragRef.current || e.defaultPrevented) return;
      e.preventDefault();
      claimForeignDrop(selectedWorkspaceIdRef.current || workspacesRef.current[0]?.id || '', null);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [platform.peers, claimForeignDrop]);

  // Tear-off target: a window opened for a tear-off boots empty, announces
  // itself until the source hands the session over, and gives up (closing
  // again, being empty) after TEAR_OFF_ADOPT_TIMEOUT_MS.
  const [awaitingAdoption, setAwaitingAdoption] = useState(() => bootIntent?.kind === 'tear-off');
  useEffect(() => {
    if (!loaded || !awaitingAdoption) return;
    const peers = platform.peers;
    const workspace = workspacesRef.current[0];
    if (!startedEmpty || !peers || !bootIntent || !workspace || sessionsRef.current.length > 0) {
      setAwaitingAdoption(false);
      return;
    }
    const announce = () =>
      peers.publish(TOPIC_WINDOW_READY, {
        windowId,
        requestId: bootIntent.requestId,
        workspace: { id: workspace.id, name: workspace.name },
      } satisfies WindowReady);
    announce();
    const repeat = setInterval(announce, WINDOW_READY_REPEAT_MS);
    const giveUp = setTimeout(() => setAwaitingAdoption(false), TEAR_OFF_ADOPT_TIMEOUT_MS);
    return () => {
      clearInterval(repeat);
      clearTimeout(giveUp);
    };
  }, [loaded, awaitingAdoption, startedEmpty, platform.peers, bootIntent, windowId]);
  useEffect(() => {
    if (awaitingAdoption && sessions.length > 0) setAwaitingAdoption(false);
  }, [awaitingAdoption, sessions.length]);

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
  const broadcastIds = useBroadcastSet();
  // 'go to session': focus a session and make it the only selection — the
  // tile button and `axn-session select` share this.
  const goToSession = useCallback(
    (id: string) => {
      broadcastSet.replaceAll([id]);
      selectSessionRef.current?.(id);
      activateSessionTab(id, 'shell');
    },
    [activateSessionTab],
  );
  const { handleSessionCommand, handleCompleteInput } = useSessionCommands({
    backend,
    platform,
    sessionsRef,
    workspacesRef,
    enabledPluginsRef,
    buildPluginApi,
    selectedSessionId: () => selectedSessionRef.current?.id,
    allowExternalCommands: () => settingsRef.current.allowExternalCommands === true,
    pluginSettingsOf: (plugin) =>
      pluginSettingsRef.current[(plugin.settingsKey ?? plugin.id) as keyof typeof pluginSettings],
    openSession,
    openSubShell,
    addWorkspace,
    moveSessionToWorkspace,
    moveWorkspace,
    activateSessionTab,
    renameSession,
    updateSession,
    pathDeps,
    tearOffSession: canTearOff ? tearOffSession : undefined,
    selectSession: goToSession,
  });

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

  // Sessions spawn eagerly at session level — plugin-style views only
  // attach to an already-running PTY, so background sessions (restored
  // agents, devin -r) keep running with no view mounted. A mounted view's
  // own acquire can still claim the spawn first (child effects run before
  // this parent effect); whichever claims it fires handleSessionReady once
  // via the notified flag.
  useEffect(() => {
    const handles = sessionPtyKey
      .split('\u0000')
      .filter(Boolean)
      .map((pair) => {
        const [sessionId, rest] = pair.split('=');
        const [ptyId] = rest.split(':');
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        if (!session) return undefined;
        const handle = acquirePty(backend, ptyId, () =>
          backend.createSession(ptyId, {
            shell: settings.defaultShell?.trim() || undefined,
            cwd: session.cwd,
            // No view exists to fit — the backend default size; a mounted
            // view's post-spawn resize corrects it once it attaches.
            cols: 80,
            rows: 24,
          }),
        );
        void handle.start().then((spawned: boolean) => {
          if (spawned) handleSessionReady(session);
        });
        return handle;
      });
    return () => handles.forEach((h) => h?.release());
  }, [backend, sessionPtyKey, handleSessionReady, settings.defaultShell]);

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
  // Bigger uiZoom needs more room: the cap scales with it.
  const MAX_SIDEBAR_WIDTH = Math.round(448 * ((settings.uiZoom ?? 100) / 100));

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

  // destroy() runs no React teardown, so nothing releases the PTY leases —
  // a window's sessions must be killed here or they orphan in the backend
  // and keep running until the process exits (and longer, when a
  // settings/dev window keeps it alive). Closing a session's main PTY takes
  // its sub-shell tree with it; explicit shell-tab closes cover a tab whose
  // parent link moved elsewhere. Only call after any state save — the
  // resulting session-exited events are ignored while closing.
  const killWindowSessions = useCallback(() => {
    for (const session of sessionsRef.current) {
      backend.close(ptyIdOf(session));
      for (const tab of session.editors ?? []) {
        if (tab.kind === 'shell' && tab.id !== ptyIdOf(session)) backend.close(tab.id);
      }
    }
  }, [backend]);

  const closeNow = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    axnLog('info', 'shell', `closeNow (sessions=${sessionsRef.current.length}, shutdown=${shutdownRequestedRef.current})`);
    flushSessionOutputRef.current();
    const win = platform.window;

    try {
      // Let plugins gracefully terminate their sessions (e.g. send /exit to devin)
      // and capture any state they emit before the PTY is destroyed. While that
      // runs, show a modal so the user knows the close is in progress — but only
      // when there is actually a plugin collecting session state.
      const onClosePlugins = enabledPluginsRef.current.filter((p) => p.onClose);
      const collectState =
        sessionsRef.current.length > 0 && onClosePlugins.length > 0;
      if (collectState) {
        setClosing(true);
        // One step per session×plugin onClose, plus the sub-shell closers and
        // the state save at the end, so the bar only fills when really done.
        setClosingProgress({
          done: 0,
          total: sessionsRef.current.length * onClosePlugins.length + 2,
        });
      }
      const tickClosingProgress = () =>
        setClosingProgress((p) =>
          p ? { ...p, done: Math.min(p.done + 1, p.total) } : p,
        );
      await Promise.all(sessionsRef.current.map(async (session) => {
        for (const plugin of enabledPluginsRef.current) {
          const ctx = buildPluginApi(session, plugin);
          if (plugin.hookSpec) dropHookSpec(plugin, ctx);
          if (!plugin.onClose) continue;
          try {
            await plugin.onClose(ctx);
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] onClose failed for session ${session.id}:`, e);
          } finally {
            tickClosingProgress();
          }
        }
      }));
      // Sub-shell tabs running an agent: stop them gracefully too, so their
      // exit hints (exact conversation ids) land before the state is saved.
      await runSubShellClosers();
      tickClosingProgress();

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
      tickClosingProgress();
    } catch (e) {
      console.error('Failed to flush state before close:', e);
    } finally {
      // Saved sessions restore with fresh PTYs — the live ones die with the
      // window regardless of whether the process exits behind it.
      killWindowSessions();
      await win?.destroy().catch(() => {});
    }
  }, [saveNow, updateSession, buildPluginApi, platform, killWindowSessions]);

  const removeAndClose = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    axnLog('info', 'shell', 'removeAndClose');
    try {
      killWindowSessions();
      await (platform.window?.deleteState?.() ?? platform.stateStore.delete?.(windowId));
    } catch (e) {
      console.error('failed to delete window state:', e);
    } finally {
      await platform.window?.destroy().catch(() => {});
    }
  }, [windowId, platform, killWindowSessions]);

  // "Close all windows & save": broadcast close-now so every window runs
  // its own collect+save+destroy path (the emit reaches this window too),
  // then run ours — closingRef makes the duplicate a no-op. Same path the
  // remote-control server's POST /close drives; once the last window is
  // gone, ExitRequested lets the process exit.
  const closeAllWindows = useCallback(() => {
    platform.peers?.publish('close-now', {});
    void closeNow();
  }, [platform, closeNow]);

  useEffect(() => {
    let closing = false;
    const unlisten = platform.window?.onCloseRequested?.(async () => {
      axnLog('info', 'shell', `onCloseRequested (sessions=${sessionsRef.current.length}, shutdown=${shutdownRequestedRef.current}, closing=${closingRef.current || closing})`);
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
      flushSessionOutputRef.current();
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
      // PTY lifetime is session-owned — a view unmount never kills a
      // process, so the close is explicit here: main shell plus every
      // sub-shell tab.
      backend.close(ptyIdOf(session));
      for (const tab of session.editors ?? []) {
        if (tab.kind === 'shell' && tab.id !== ptyIdOf(session)) backend.close(tab.id);
      }
      closeSession(sessionId, 'user close');
    },
    [buildPluginApi, closeSession, backend],
  );

  useEffect(() => {
    const unlisten = backend.onSessionExit?.((ptyId) => {
      // Closing runs its own session kills — an exit while tearing down is
      // expected and must not mutate state or re-trigger a save.
      if (closingRef.current) return;
      // Plugins must see the session's last output before it closes.
      flushSessionOutputRef.current();
      // The payload is a PTY id — a promoted sub-shell PTY maps back to its
      // owning session via mainPtyId.
      const session = sessionsRef.current.find(
        (s) => s.id === ptyId || ptyIdOf(s) === ptyId,
      );
      axnLog('info', 'shell', `session-exit pty ${ptyId} → session ${session?.id ?? 'none'}`);
      if (session) closeSession(session.id, 'pty exited');
    });
    return () => unlisten?.();
  }, [closeSession, backend]);

  // Route sub-shell exits to the owning session's plugins — the payload is
  // the tab's PTY id, which equals the editors[] tab id (SubShellView spawns
  // the PTY under it). dev-workflow uses this to record check results for
  // `run-in: sub-shell` command actions.
  useEffect(() => {
    const unlisten = backend.onSubshellExit?.((ptyId, exitCode) => {
      if (closingRef.current) return;
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
    // A tear-off window is empty until its session arrives.
    if (awaitingAdoption) return;

    // A secondary window emptied while others remain (its sessions were
    // dragged or moved elsewhere — typically a torn-off window whose session
    // went back) has nothing to restore: drop its saved state instead of
    // reopening it empty at the next launch. The main window, the last
    // window, and windows holding per-window data (bookmarks, rail order,
    // hosted tabs) keep their state as before.
    const holdsWindowData =
      Object.keys(pluginDataRef.current).length > 0 || Object.keys(pluginTabsRef.current).length > 0;
    if (windowId !== 'main' && otherWindowWorkspaces.size > 0 && !holdsWindowData) {
      void removeAndClose();
      return;
    }
    axnLog('info', 'shell', `autoCloseWhenEmpty → window.close() (window=${windowId})`);
    platform.window?.close?.();
  }, [loaded, sessions.length, platform, awaitingAdoption, otherWindowWorkspaces, removeAndClose, windowId]);

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
    // Snapshot every live terminal's screen for the reloaded page — the PTYs
    // survive, so each reattaching view restores its scrollback (see
    // stashTerminalReplays).
    stashTerminalReplays();
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
    const onMenuReload = () => void reloadWindow();
    window.addEventListener('axn:menu-reload', onMenuReload);
    return () => window.removeEventListener('axn:menu-reload', onMenuReload);
  }, [reloadWindow]);

  // Preferences… from the app menu (⌘, / Ctrl+,) opens and closes the same
  // settings dialog as the gear at the bottom of the rail. The desktop host
  // forwards the menu event to the one window that should react.
  useEffect(() => {
    const onMenuSettings = () => setSettingsOpen((open) => !open);
    window.addEventListener('axn:menu-settings', onMenuSettings);
    return () => window.removeEventListener('axn:menu-settings', onMenuSettings);
  }, []);

  // Keyboard navigation hands focus to the destination view: the flag is
  // armed in the keydown handler, the every-render effect below applies it
  // once the selection commit has mounted the visible view.
  const focusAfterNavRef = useRef(false);
  const focusActiveSessionView = useCallback((session: ShellSession) => {
    const activeTab = session.activeTab ?? 'shell';
    // Registration ids: the main shell registers under the session id (its
    // PTY may be a promoted sub-shell's — mainPtyId — while the input
    // handle stays keyed by session), sub-shells and view focusers under
    // the tab id.
    const viewId = activeTab === 'shell' ? session.id : activeTab;
    const input = terminalInput(viewId);
    if (input) {
      input.focus();
      return true;
    }
    return focusView(viewId);
  }, []);

  useEffect(() => {
    if (!focusAfterNavRef.current) return;
    focusAfterNavRef.current = false;
    const session = selectedSessionRef.current;
    if (!session) return;
    // The destination view may still be mounting — a terminal registers
    // its input only after the PTY attach — so retry briefly instead of
    // giving up on the first empty lookup.
    let tries = 0;
    const attempt = () => {
      if (focusActiveSessionView(session)) return;
      if (++tries < 40) setTimeout(attempt, 50);
    };
    attempt();
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isAppNavigationShortcut(event)) return;

      if (event.shiftKey) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActivePluginView(null);
          focusAfterNavRef.current = true;
          selectNextWorkspace();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActivePluginView(null);
          focusAfterNavRef.current = true;
          selectPrevWorkspace();
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActivePluginView(null);
        focusAfterNavRef.current = true;
        selectNextSession();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActivePluginView(null);
        focusAfterNavRef.current = true;
        selectPrevSession();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        focusAfterNavRef.current = true;
        selectAdjacentTab(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusAfterNavRef.current = true;
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
      // Sub-shell tab flags live on the editor objects, not in pluginState.
      if ((session.editors ?? []).some((t) => t.hookAttention)) {
        updateSession(sessionId, {
          editors: (session.editors ?? []).map((t) =>
            t.hookAttention ? { ...t, hookAttention: null } : t,
          ),
        });
      }
    },
    [mergePluginState, updateSession],
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

  // Long-press on a tab opens the same menu as right-click — the primary
  // context-menu path on touch devices (tabs aren't draggable there anyway).
  // Delegated at the strip level: `data-tab-id` (plus `data-session-id` or
  // `data-plugin-id`) on each row identifies the target.
  const handleTabStripTouchStart = useCallback((e: React.TouchEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
    const touch = e.touches[0];
    const lp = tabLongPress.current;
    if (lp.timer) clearTimeout(lp.timer);
    lp.el = el;
    lp.fired = false;
    if (!el || !touch) return;
    lp.origin = { x: touch.clientX, y: touch.clientY };
    lp.timer = setTimeout(() => {
      lp.fired = true;
      const { sessionId, tabId, pluginId } = el.dataset;
      if (pluginId) {
        const tab = pluginTabsRef.current[pluginId]?.editors.find((t) => t.id === tabId);
        if (tab) setTabMenu({ pluginId, tab, x: lp.origin.x, y: lp.origin.y });
      } else {
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        const tab = session && (session.editors ?? []).find((t) => t.id === tabId);
        if (session && tab) setTabMenu({ session, tab, x: lp.origin.x, y: lp.origin.y });
      }
    }, LONG_PRESS_MS);
  }, []);
  const handleTabStripTouchMove = useCallback((e: React.TouchEvent) => {
    const lp = tabLongPress.current;
    if (!lp.timer) return;
    const touch = e.touches[0];
    if (
      Math.abs((touch?.clientX ?? 0) - lp.origin.x) > 10 ||
      Math.abs((touch?.clientY ?? 0) - lp.origin.y) > 10
    ) {
      clearTimeout(lp.timer);
      lp.timer = null;
    }
  }, []);
  const handleTabStripTouchEnd = useCallback(() => {
    const lp = tabLongPress.current;
    if (lp.timer) clearTimeout(lp.timer);
    lp.timer = null;
  }, []);
  // The tap that ends a fired long-press must not also activate the tab.
  const handleTabStripClickCapture = useCallback((e: React.MouseEvent) => {
    if (!tabLongPress.current.fired) return;
    tabLongPress.current.fired = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

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
          agentInput: undefined,
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
        const newId = `ed-${crypto.randomUUID()}`;
        updateSessionWith(sessionId, (latest) => {
          const editors = latest.editors ?? [];
          const existing = editors.find(
            (e) => e.path === resolved && (e.kind ?? 'editor') === 'editor',
          );
          const id = existing?.id ?? newId;
          return {
            editors: existing ? editors : [...editors, { id, path: resolved, kind: 'editor' }],
            activeTab: id,
          };
        });
      });
    },
    [updateSessionWith]
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
        const newId = `pv-${crypto.randomUUID()}`;
        updateSessionWith(sessionId, (latest) => {
          const editors = latest.editors ?? [];
          const existing = editors.find((e) => e.path === resolved && e.kind === 'preview');
          const id = existing?.id ?? newId;
          return {
            editors: existing ? editors : [...editors, { id, path: resolved, kind: 'preview' }],
            activeTab: id,
          };
        });
      });
    },
    [updateSessionWith]
  );

  const openBrowser = useCallback(
    (sessionId: string, path: string, ptyId?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      void resolveSessionPath(backend, () => platform.homeDir(), session, path, ptyId).then((resolved) => {
        updateSessionWith(sessionId, (latest) => browserTabPatch(latest, resolved));
      });
    },
    [updateSessionWith]
  );

  const openIde = useCallback(
    (sessionId: string, path: string, ptyId?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      void resolveSessionPath(backend, () => platform.homeDir(), session, path, ptyId).then((resolved) => {
        const latest = sessionsRef.current.find((s) => s.id === sessionId);
        if (latest) updateSession(sessionId, ideTabPatch(latest, resolved));
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
        if (!sessionsRef.current.some((s) => s.id === session.id)) return;
        if (tab.kind === 'shell') backend.close(tabId);
        updateSessionWith(session.id, (latest) => ({
          editors: (latest.editors ?? []).filter((e) => e.id !== tabId),
          activeTab: (latest.activeTab ?? 'shell') === tabId ? 'shell' : latest.activeTab,
        }));
      });
    },
    [updateSessionWith, requestEditorClose]
  );

  // Patch fields on an editor tab — SubShellView uses it to persist an
  // agent tab's resumeCommand once the tab has run / a session name was
  // captured.
  const updateEditorTab = useCallback(
    (sessionId: string, tabId: string, patch: Partial<EditorTab>) => {
      updateSessionWith(sessionId, (session) => ({
        editors: (session.editors ?? []).map((e) =>
          e.id === tabId ? { ...e, ...patch } : e
        ),
      }));
    },
    [updateSessionWith]
  );

  const renameTab = useCallback(
    (sessionId: string, tabId: string, label: string) => {
      const trimmed = label.trim();
      updateSessionWith(sessionId, (session) => ({
        // An empty label clears the override → default label (command/dir).
        editors: (session.editors ?? []).map((e) =>
          e.id === tabId ? { ...e, label: trimmed || undefined } : e
        ),
      }));
    },
    [updateSessionWith]
  );

  const reorderTab = useCallback(
    (session: ShellSession, dragId: string, targetId: string) => {
      updateSessionWith(session.id, (latest) => {
        const editors = [...(latest.editors ?? [])];
        const from = editors.findIndex((e) => e.id === dragId);
        const to = editors.findIndex((e) => e.id === targetId);
        if (from === -1 || to === -1 || from === to) return null;
        const [moved] = editors.splice(from, 1);
        editors.splice(to, 0, moved);
        return { editors };
      });
    },
    [updateSessionWith]
  );

  const setEditorDirty = useCallback(
    (sessionId: string, editorId: string, dirty: boolean) => {
      updateSessionWith(sessionId, (session) => ({
        editors: (session.editors ?? []).map((e) =>
          e.id === editorId ? { ...e, dirty } : e
        ),
      }));
    },
    [updateSessionWith]
  );

  // --- Plugin-hosted tabs (plugins declaring `hostsTabs`) -------------------

  // Open (or focus) a tab inside a plugin's view — e.g. the awesome list
  // opening a browse/edit tab for a bookmarked path.
  const openPluginTab = useCallback(
    (pluginId: string, tab: { path: string; kind: 'editor' | 'browser' | 'preview' }) => {
      const prefix = tab.kind === 'browser' ? 'br' : tab.kind === 'preview' ? 'pv' : 'ed';
      const newId = `${prefix}-${crypto.randomUUID()}`;
      updatePluginTabs(pluginId, (set) => {
        const existing = set.editors.find(
          (e) => e.path === tab.path && (e.kind ?? 'editor') === tab.kind,
        );
        const id = existing?.id ?? newId;
        return {
          editors: existing
            ? set.editors
            : [...set.editors, { id, path: tab.path, kind: tab.kind }],
          activeTab: id,
        };
      });
    },
    [updatePluginTabs]
  );

  const closePluginTab = useCallback(
    (pluginId: string, tabId: string) => {
      const tab = pluginTabsRef.current[pluginId]?.editors.find((e) => e.id === tabId);
      if (!tab) return;
      requestEditorClose(tab, () => {
        if (!pluginTabsRef.current[pluginId]) return;
        updatePluginTabs(pluginId, (set) => ({
          editors: set.editors.filter((e) => e.id !== tabId),
          activeTab: (set.activeTab ?? 'view') === tabId ? 'view' : set.activeTab,
        }));
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
      updateSessionWith(session.id, (latest) => {
        const patch: Partial<ShellSession> = {
          editors: (latest.editors ?? []).filter((e) => e.id !== tabId),
        };
        if ((latest.activeTab ?? 'shell') === tabId) patch.activeTab = 'shell';
        return patch;
      });
      updatePluginTabs(pluginId, (set) => ({
        editors: [...set.editors, tab],
        activeTab: tab.id,
      }));
    },
    [updateSessionWith, updatePluginTabs]
  );

  // Send a plugin-hosted tab back to a session; selecting the session closes
  // the plugin view so the moved tab is immediately visible.
  const moveTabToSession = useCallback(
    (pluginId: string, tabId: string, sessionId: string) => {
      const set = pluginTabsRef.current[pluginId];
      const tab = set?.editors.find((e) => e.id === tabId);
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!set || !tab || !session) return;
      updatePluginTabs(pluginId, (latest) => ({
        editors: latest.editors.filter((e) => e.id !== tabId),
        activeTab: (latest.activeTab ?? 'view') === tabId ? 'view' : latest.activeTab,
      }));
      updateSessionWith(sessionId, (latest) => ({
        editors: [...(latest.editors ?? []), tab],
        activeTab: tab.id,
      }));
      setActivePluginView(null);
      setSelectedSessionId(sessionId);
    },
    [updatePluginTabs, updateSessionWith, setSelectedSessionId]
  );

  const setPluginEditorDirty = useCallback(
    (pluginId: string, tabId: string, dirty: boolean) => {
      if (!pluginTabsRef.current[pluginId]) return;
      updatePluginTabs(pluginId, (set) => ({
        editors: set.editors.map((e) => (e.id === tabId ? { ...e, dirty } : e)),
      }));
    },
    [updatePluginTabs]
  );

  const runningCount = sessions.filter(
    (s) => s.status === 'running' || !!s.process
  ).length;

  // The plugin whose full-area view is active (dropped when the plugin has no
  // renderView or is disabled while active → falls back to the session view).
  const resolveView = useCallback(
    (key: string): { plugin: SessionViewPlugin; entry?: RailEntry } | undefined => {
      const { pluginId, entryId } = parseViewKey(key);
      const plugin = enabledPlugins.find((p) => p.id === pluginId && p.renderView);
      if (!plugin) return undefined;
      if (entryId === undefined) return plugin.railEntries ? undefined : { plugin };
      const entry = slotsOf(plugin).find((slot) => slot.key === key)?.entry;
      return entry ? { plugin, entry } : undefined;
    },
    [enabledPlugins, slotsOf],
  );
  const activeResolved = activePluginView ? resolveView(activePluginView) : undefined;
  const viewPlugin = activeResolved?.plugin;
  const effectiveViewKey = activeResolved ? activePluginView : null;

  // Views of plugins declaring `keepViewMounted` stay mounted once opened.
  const [keptViews, setKeptViews] = useState<string[]>([]);
  useEffect(() => {
    setKeptViews((prev) =>
      nextKeptViews(
        prev,
        effectiveViewKey,
        (key) => resolveView(key)?.plugin.keepViewMounted === true,
        (key) => resolveView(key)?.plugin.keepViewMounted === true,
      ),
    );
  }, [effectiveViewKey, resolveView]);

  // openView/selectView/activeView (viewHost) act on this window. Validation
  // reads live entries: a runtime view opened a moment ago is not rendered yet.
  useEffect(
    () =>
      registerViewHost({
        select: (key) => {
          if (key !== null && !resolveLiveView(key)) return false;
          setActivePluginView(key);
          return true;
        },
        describe: (key) => {
          const found = resolveLiveView(key);
          if (!found) return null;
          const { pluginId, entryId } = parseViewKey(key);
          return {
            pluginId,
            entryId,
            title: found.entry?.title ?? found.plugin.title,
            runtime: found.entry?.runtime === true,
          };
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  function resolveLiveView(key: string) {
    const { pluginId, entryId } = parseViewKey(key);
    const plugin = enabledPluginsRef.current.find((p) => p.id === pluginId && p.renderView);
    if (!plugin) return undefined;
    if (entryId === undefined) return plugin.railEntries ? undefined : { plugin };
    const settings = pluginSettingsRef.current[(plugin.settingsKey ?? plugin.id) as keyof typeof pluginSettings];
    const entry = plugin.railEntries?.({ pluginSettings: settings }).find((e) => e.id === entryId);
    return entry ? { plugin, entry } : undefined;
  }
  useEffect(() => publishActiveView(effectiveViewKey), [effectiveViewKey]);
  useEffect(() => {
    const allow = platform.allowFrameOrigin?.bind(platform);
    setFrameOriginAllower(allow ?? null);
    return () => setFrameOriginAllower(null);
  }, [platform]);

  // The PTY the touch key bar targets: the session's live main PTY on the
  // shell tab, the tab's own PTY on sub-shell tabs — nothing on non-terminal
  // tabs (editors/browsers have their own input) or plugin views.
  const keybarPtyId = (() => {
    if (!selectedSession || viewPlugin) return null;
    const activeTab = selectedSession.activeTab ?? 'shell';
    if (activeTab === 'shell') return ptyIdOf(selectedSession);
    const tab = (selectedSession.editors ?? []).find((e) => e.id === activeTab);
    return tab?.kind === 'shell' ? tab.id : null;
  })();

  // Effective icon bag: local settings overlaid by the synced `app:icons`
  // entry — the authority's bag wins per key on every device.
  const iconBag = useMemo<IconBag>(
    () => ({
      ...collectIconBag(settings),
      ...((pluginData[ICONS_PLUGIN_DATA_KEY] ?? {}) as IconBag),
    }),
    [settings, pluginData],
  );
  // Publish the effective bag whenever it changes — desktop authority
  // patches replicas, a remote viewer's write rides /vm/setPluginState
  // upstream and the authority applies it into its own settings.
  const iconBagJson = JSON.stringify(iconBag);
  const lastPublishedIcons = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Not before load: pluginData is still empty, the bag would be local-only.
    if (!loaded || iconBagJson === lastPublishedIcons.current) return;
    lastPublishedIcons.current = iconBagJson;
    platform.publishSharedState?.(ICONS_SHARED_KEY, iconBagJson);
  }, [loaded, iconBagJson, platform]);

  // uiZoom scales the chrome; insets that must match the unscaled window
  // (the macOS traffic lights) are computed against it.
  const uiScale = settings.uiZoom && settings.uiZoom > 0 ? settings.uiZoom / 100 : 1;
  // Flags that belong to no session — the panel shows them as a warning
  // button next to its "N waiting" filter.
  const appFlags = railFlags.filter((f) => !f.sessionId);
  const appFlagSummary = summarizeAttention(
    Object.fromEntries(appFlags.map((f) => [f.source, f.attention])),
  );
  // The session panel toggle (see where it is placed below). While the
  // panel is closed it shows how many attention flags are raised.
  const panelToggle = (
    <button
      type="button"
      onClick={() => setSidebarOpen((v) => !v)}
      data-tip={`${sidebarOpen ? 'Hide sessions' : 'Show sessions'}\n${panelToggleShortcutLabel(isMac)}`}
      aria-label={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
      aria-expanded={sidebarOpen}
      aria-keyshortcuts={isMac ? 'Control+Meta+S' : 'Control+Shift+S'}
      className={`relative ${ghostButtonClass}`}
    >
      <PanelLeft className="h-4 w-4" />
      {!sidebarOpen && railAttention && (
        <span
          className={`pointer-events-none absolute -right-1 -top-1 min-w-4 select-none rounded-full px-1 text-center text-[10px] font-semibold leading-4 tabular-nums shadow-[0_0_0_2px_var(--chrome)] ${
            railAttention.level === 'critical'
              ? 'bg-[var(--attention)] text-white'
              : 'bg-[var(--orange)] text-[var(--text-inverted)]'
          }`}
        >
          {railFlags.length}
        </span>
      )}
    </button>
  );

  if (!loaded || !selectedSession) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--chrome)] text-[var(--text-secondary)]">
        <span className="text-[13px]">Loading sessions…</span>
      </div>
    );
  }

  /** The real view component for one editor tab — shared between the main
   * area and broadcast tiles, so a tile mounts the actual view. */
  const renderEditorView = (session: ShellSession, ed: EditorTab, visible: boolean) => (
                    ed.kind === 'browser' ? (
                      <BrowserView
                        path={ed.path}
                        cwd={session.cwd}
                        sessionId={session.id}
                        isVisible={visible}
                        focusId={ed.id}
                        onOpenFile={(path) => openEditor(session.id, path)}
                        onPreviewFile={(path) => openPreview(session.id, path)}
                        onIdeRequest={(dirPath) => openIde(session.id, dirPath)}
                      />
                    ) : ed.kind === 'preview' ? (
                      <PreviewView
                        path={ed.path}
                        cwd={session.cwd}
                        sessionId={session.id}
                        isVisible={visible}
                        focusId={ed.id}
                      />
                    ) : ed.kind === 'shell' ? (
                      <SubShellView
                        session={session}
                        tab={ed}
                        isVisible={visible}
                        onClose={() => closeTab(session, ed.id)}
                        onRename={(label) => renameTab(session.id, ed.id, label)}
                        onUpdateTab={(patch) => updateEditorTab(session.id, ed.id, patch)}
                        onEditorRequest={openEditor}
                        onBrowserRequest={openBrowser}
                        onPreviewRequest={openPreview}
                        onIdeRequest={openIde}
                        onSessionCommand={handleSessionCommand}
                        onCompleteInput={handleCompleteInput}
                        onUserInput={clearSessionAttention}
                      />
                    ) : ed.kind === 'ide' ? (
                      <IdeView
                        ref={(handle) => registerEditor(ed.id, handle)}
                        path={ed.path}
                        cwd={session.cwd}
                        sessionId={session.id}
                        isVisible={visible}
                        focusId={ed.id}
                        fileService={backendFileService(backend, session.id)}
                        onDirtyChange={(dirty) => setEditorDirty(session.id, ed.id, dirty)}
                      />
                    ) : ed.kind === 'git' ? (
                      <GitInspectView
                        session={session}
                        tab={ed}
                        isVisible={visible}
                        focusId={ed.id}
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
                        isVisible={visible}
                        focusId={ed.id}
                        fileService={backendFileService(backend, session.id)}
                        onDirtyChange={(dirty) => setEditorDirty(session.id, ed.id, dirty)}
                      />
                    )
  );

  /** Broadcast tile body: the session's REAL current view — main shell or
   * whatever editor tab is active — mounted here (the below view for a
   * broadcast session is suppressed, so this is its single mount). */
  const renderSessionTileView = (session: ShellSession) => {
    const active = session.activeTab ?? 'shell';
    if (active === 'shell') {
      return (
        <ShellTerminal
          session={session}
          backend={backend}
          onSessionNameChange={applySessionAutoName}
          onEditorRequest={openEditor}
          onBrowserRequest={openBrowser}
          onPreviewRequest={openPreview}
          onIdeRequest={openIde}
          onSessionCommand={handleSessionCommand}
          onCompleteInput={handleCompleteInput}
          updateSession={updateSession}
          onUserInput={clearSessionAttention}
          isVisible={true}
          onSessionReady={handleSessionReady}
        />
      );
    }
    const ed = session.editors?.find((e) => e.id === active);
    if (!ed) return null;
    return renderEditorView(session, ed, true);
  };

  return (
    <IconBagContext.Provider value={iconBag}>
    <ShellServicesProvider services={mergedServices} fileReader={fileReader}>
    <MemoryStatsProvider active={enabledPlugins.some((p) => p.needsMemoryStats)}>
    <div
      className="relative flex h-screen w-full overflow-hidden bg-[var(--chrome)]"
      style={{
        // On touch devices track the visual viewport so the on-screen
        // keyboard shrinks/translates the app instead of covering it
        // (100dvh is the no-keyboard value; h-screen covers old engines).
        height: viewportSize ? `${viewportSize.height}px` : '100dvh',
        transform:
          viewportSize && viewportSize.offsetTop > 0
            ? `translateY(${viewportSize.offsetTop}px)`
            : undefined,
        padding:
          'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
        // Room the session panel's toolbar row leaves for the panel toggle
        // that floats in the title-bar row — macOS only; elsewhere the
        // toggle sits in the rail and the row needs no extra space.
        ['--panel-toggle-w' as string]: isMac ? '2rem' : '0px',
      }}
    >
      {/* Headless status sources: plugins whose meters show in the session
          panel's status stack publish them from here — mounted for as
          long as the plugin is enabled, also while the panel is hidden. */}
      {enabledPlugins.map((plugin) =>
        plugin.panelStatus ? (
          <Fragment key={plugin.id}>
            {plugin.panelStatus({
              backend,
              pluginSettings: pluginSettings[(plugin.settingsKey ?? plugin.id) as keyof typeof pluginSettings],
              setAppAttention: (attention) => setAppAttention(plugin.id, attention),
              sessions,
            })}
          </Fragment>
        ) : null,
      )}

      {/* Session panel toggle — in the title-bar row, right of the macOS
          traffic lights, like the sidebar button of Finder or Xcode. It
          floats above the panel's toolbar row (which leaves room for it,
          --panel-toggle-w) and, with the panel closed, above the strip the
          content pane leaves for the traffic lights. Without that strip
          (no overlay title bar — Linux/Windows — or fullscreen) the copy
          at the top of the rail takes over. While the panel is closed it
          carries the number of raised attention flags. */}
      <div
        className="axn-titlebar-only absolute z-[45]"
        style={{
          left: `calc(var(--rail-w) * ${uiScale} + var(--titlebar-overhang) + ${8 * uiScale}px)`,
          top: `${6 * uiScale}px`,
        }}
      >
        <div style={{ zoom: uiScale === 1 ? undefined : uiScale }}>{panelToggle}</div>
      </div>

      {/* Left rail — always visible, tools only: one item per plugin view,
          Settings set apart at the bottom. With the macOS overlay title bar
          the traffic lights sit above its first item (--titlebar-h,
          counter-scaled because the rail is zoomed and the lights are not).
          Slots carry data-rail-slot / data-rail-view so the ⌘1…⌘9 numbering
          can follow what is actually shown. */}
      <div
        ref={setRailEl}
        className="flex w-[var(--rail-w)] shrink-0 flex-col items-center gap-1 bg-[var(--chrome)] pb-2.5"
        style={{
          zoom: uiScale === 1 ? undefined : uiScale,
          paddingTop: `calc(var(--titlebar-h) / ${uiScale} + 4px)`,
        }}
        data-tauri-drag-region
      >
        <div className="axn-no-titlebar-only mb-1 flex flex-col items-center gap-1.5">
          {panelToggle}
          <div className="h-px w-5 bg-[var(--hairline)]" />
        </div>
        {pinnedRailPlugins.map((slot) => (
          <div
            key={slot.key}
            data-rail-slot={slot.key}
            data-rail-view={slot.plugin.renderView ? '' : undefined}
            className="flex flex-col items-center empty:hidden"
          >
            <RailShortcutContext.Provider value={railShortcutOf(slot.key)}>
            {railSlotNode(slot)}
            </RailShortcutContext.Provider>
          </div>
        ))}
        {railPlugins.map((slot, i) => {
          const plugin = slot.plugin;
          return (
            <div
              key={slot.key}
              ref={(el) => {
                if (el) railItemRefs.current.set(slot.key, el);
                else railItemRefs.current.delete(slot.key);
              }}
              data-rail-slot={slot.key}
              data-rail-view={plugin.renderView ? '' : undefined}
              data-tip={`${slot.entry?.title ?? plugin.title} (drag to reorder)`}
              data-tip-side="right"
              onPointerDown={(e) => startRailDrag(e, slot.key)}
              onClickCapture={(e) => {
                if (!suppressRailClick.current) return;
                suppressRailClick.current = false;
                e.preventDefault();
                e.stopPropagation();
              }}
              onDragStart={(e) => e.preventDefault()}
              className={`flex touch-none select-none flex-col items-center empty:hidden${railDragId ? ' cursor-grabbing' : ''}${
                railDragId === slot.key ? ' opacity-40' : ''
              }${
                railDropIndex === i && railDragId !== slot.key
                  ? ' shadow-[inset_0_2px_0_var(--accent)]'
                  : ''
              }${
                railDropIndex === railPlugins.length &&
                i === railPlugins.length - 1 &&
                railDragId !== slot.key
                  ? ' shadow-[inset_0_-2px_0_var(--accent)]'
                  : ''
              }`}
            >
              <RailShortcutContext.Provider value={railShortcutOf(slot.key)}>
              {railSlotNode(slot)}
              </RailShortcutContext.Provider>
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
        {/* Settings is not a tool — a hairline sets it apart from them. */}
        <div className="mb-0.5 h-px w-5 shrink-0 bg-[var(--hairline)]" />
        <RailItem
          title="Settings"
          onClick={() => setSettingsOpen((v) => !v)}
          active={settingsOpen}
        >
          <Settings />
        </RailItem>
      </div>

      {/* Session panel: overlay drawer on small screens, inline column on sm+ */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/20 sm:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <div
            className="absolute bottom-0 left-[var(--rail-w)] top-0 z-40 min-w-[12rem] max-w-[85vw] shadow-lg sm:static sm:z-auto sm:shadow-none"
            style={{ width: sidebarWidth }}
          >
            <div className="relative h-full w-full">
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
                onOpenIde={openIde}
                onOpenTab={openSessionTab}
                pluginData={pluginData}
                mergePluginData={mergePluginData}
                onOpenSubShell={openSubShell}
                onTurnIntoWorkspace={turnIntoWorkspace}
                onMoveToNewWindow={
                  canTearOff ? (id) => void tearOffSession(id) : undefined
                }
                onSessionDragStart={handleSessionDragStart}
                onSessionDragEnd={handleSessionDragEnd}
                foreignDrag={foreignDrag}
                onForeignDrop={claimForeignDrop}
                hiddenStatusSources={hiddenStatusIds}
                onOpenPluginView={setActivePluginView}
                appAttention={
                  appFlagSummary
                    ? { count: appFlags.length, level: appFlagSummary.level, title: appFlagSummary.title }
                    : null
                }
                onShowAttention={() => setAttentionOpen(true)}
              />
              <div
                onMouseDown={startSidebarResize}
                className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize select-none transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]"
              />
            </div>
          </div>
        </>
      )}

      {/* Content pane — an inset card on the chrome. With the session panel
          hidden, the macOS traffic lights have no toolbar row to sit in, so
          the pane starts below them (the gap is a window drag region). */}
      <div
        className="flex min-w-0 flex-1 flex-col sm:pb-2 sm:pr-2 sm:pt-2 sm:data-[sidebar=closed]:pt-[max(0.5rem,var(--titlebar-h))]"
        data-sidebar={sidebarOpen ? 'open' : 'closed'}
        data-tauri-drag-region
      >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg)] sm:rounded-[var(--radius-lg)] sm:shadow-[0_0_0_1px_var(--hairline)]">
        {stateNotice && (
          <Banner level="warning" message={stateNotice} onDismiss={dismissStateNotice} />
        )}
        {moveError && (
          <Banner level="error" message={moveError} onDismiss={() => setMoveError(null)} />
        )}
        {/* Broadcast split above the shell area — fan-out input on top,
            the selected sessions' real views as view-only columns. When the
            focused session is itself a target the below area would only show
            a placeholder, so the deck fills the space instead. The session
            area stays mounted underneath either way — hidden while the deck
            fills, otherwise sharing the column — so non-target sessions
            keep their live terminals instead of unmounting. */}
        {broadcastIds.length > 1 && broadcastSet.has(selectedSessionId) && (
          <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--border)]">
            <BroadcastDeck
              backend={backend}
              sessions={sessionsRef.current}
              renderView={renderSessionTileView}
              onFocusSession={goToSession}
            />
          </div>
        )}
        <div
          className={
            broadcastIds.length > 1 && broadcastSet.has(selectedSessionId)
              ? 'hidden'
              : 'flex min-h-0 flex-1 flex-col'
          }
        >
        {broadcastIds.length > 1 && !broadcastSet.has(selectedSessionId) && (
          <div className="flex max-h-[50%] min-h-[160px] shrink-0 flex-col border-b border-[var(--border)]">
            <BroadcastDeck
              backend={backend}
              sessions={sessionsRef.current}
              renderView={renderSessionTileView}
              onFocusSession={goToSession}
            />
          </div>
        )}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {sessions.filter((s) => s.id === selectedSessionId).map((session) => {
          // Plugin-style mounting: only the selected session has a view.
          // Other sessions keep running — their PTYs are session-owned and
          // their output retention is subscribed at session level — and
          // repaint from a serialized screen stash on remount.
          const isVisible = !viewPlugin;
          const editors = session.editors ?? [];
          const activeTab = session.activeTab ?? 'shell';
          return (
            <div
              key={session.id}
              className={isVisible ? 'flex h-full w-full flex-col' : 'hidden'}
            >
              {/* A broadcast-selected session's real view is mounted in its
                  deck tile — mounting a second copy here would put two
                  xterms on one PTY. The row itself stays so the session
                  remounts in place when it leaves the set. */}
              {broadcastIds.length > 1 && broadcastSet.has(session.id) ? null : (
              <>
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
                <div
                  className="contents"
                  onTouchStart={handleTabStripTouchStart}
         
         onTouchMove={handleTabStripTouchMove}
         
         onTouchEnd={handleTabStripTouchEnd}
         
         onTouchCancel={handleTabStripTouchEnd}
         onClickCapture={handleTabStripClickCapture}
                >
                  <SessionTabStrip
                  editors={editors}
                  activeTab={activeTab}
                  onSelect={(tabId) => updateSession(session.id, { activeTab: tabId })}
                  onTabMenu={(tab, x, y) => setTabMenu({ session, tab, x, y })}
                  onReorder={(dragId, targetId) => reorderTab(session, dragId, targetId)}
                  onCloseTab={(tabId) => closeTab(session, tabId)}
                />
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
                    onEditorRequest={openEditor}
                    onBrowserRequest={openBrowser}
                    onPreviewRequest={openPreview}
                    onIdeRequest={openIde}
                    onSessionCommand={handleSessionCommand}
                    onCompleteInput={handleCompleteInput}
                    updateSession={updateSession}
                    onUserInput={clearSessionAttention}
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
                    style={ed.kind === 'shell' ? undefined : { zoom: settings.uiZoom ? settings.uiZoom / 100 : undefined }}
                  >
                    {/* A crashing tab view replaces only itself. */}
                    <ErrorBoundary
                      scope={`${ed.kind} tab — ${ed.label || ed.path || ed.id}`}
                      extraAction={{
                        label: <Trans>Close tab</Trans>,
                        onClick: () => closeTab(session, ed.id),
                      }}
                    >
                    {renderEditorView(session, ed, isVisible && activeTab === ed.id)}
                    </ErrorBoundary>
                  </div>
                ))}
              </div>
              </>
              )}
            </div>
          );
        })}
        {keptViews.map((key) => {
          const found = resolveView(key);
          if (!found?.plugin.renderView) return null;
          const plugin = found.plugin;
          const settingsKey = plugin.settingsKey ?? plugin.id;
          const active = key === effectiveViewKey;
          return (
            <div
              key={key}
              className={`absolute inset-0 flex flex-col overflow-hidden${active ? '' : ' invisible pointer-events-none'}`}
              inert={!active}
              aria-hidden={!active}
            >
              {plugin.renderView!({
                pluginSettings: pluginSettings[settingsKey as keyof typeof pluginSettings],
                entryId: found.entry?.id,
                active,
                close: () => setActivePluginView(null),
                appState: pluginData[settingsKey],
                updateAppState: (patch) => mergePluginData(settingsKey, patch),
                sessions,
                workspaces,
                selectedSessionId,
                selectSession: handleSelectSession,
                sessionApi: (sessionId) => {
                  const s = sessionsRef.current.find((x) => x.id === sessionId);
                  return s ? buildPluginApi(s, plugin) : undefined;
                },
              })}
            </div>
          );
        })}
        {viewPlugin?.renderView && !viewPlugin.keepViewMounted && (() => {
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
                <TabStrip
                  activeTab={viewTab}
                  onTouchStart={handleTabStripTouchStart}
                  onTouchMove={handleTabStripTouchMove}
                  onTouchEnd={handleTabStripTouchEnd}
                  onTouchCancel={handleTabStripTouchEnd}
                  onClickCapture={handleTabStripClickCapture}
                >
                  <button
                    type="button"
                    data-tab-id="view"
                    onClick={() => updatePluginTabs(viewPlugin.id, { activeTab: 'view' })}
                    data-tip={viewPlugin.title}
                    className={`relative flex shrink-0 items-center gap-1.5 px-2.5 text-xs transition-colors duration-[var(--dur-1)] ${tabStripTabClasses(
                      viewTab === 'view',
                    )}`}
                  >
                    {viewPlugin.title}
                  </button>
                  {hostedTabs.map((ed) => (
                    <div
                      key={ed.id}
                      data-plugin-id={viewPlugin.id}
                      data-tab-id={ed.id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTabMenu({
                          pluginId: viewPlugin.id,
                          tab: ed,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }}
                      className={`relative flex shrink-0 items-center pl-2.5 pr-1 text-xs transition-colors duration-[var(--dur-1)] ${tabStripTabClasses(
                        viewTab === ed.id,
                      )}`}
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
                        className="ml-1 flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </TabStrip>
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
                    entryId: activeResolved?.entry?.id,
                    active: true,
                    close: () => setActivePluginView(null),
                    appState: pluginData[viewKey],
                    updateAppState: (patch) => mergePluginData(viewKey, patch),
                    openTab: viewPlugin.hostsTabs
                      ? (tab) => openPluginTab(viewPlugin.id, tab)
                      : undefined,
                    sessions,
                    workspaces,
                    selectedSessionId,
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
                        focusId={ed.id}
                        onOpenFile={(path) =>
                          openPluginTab(viewPlugin.id, { path, kind: 'editor' })
                        }
                        onPreviewFile={(path) =>
                          openPluginTab(viewPlugin.id, { path, kind: 'preview' })
                        }
                      />
                    ) : ed.kind === 'preview' ? (
                      <PreviewView path={ed.path} isVisible={viewTab === ed.id} focusId={ed.id} />
                    ) : (
                      <EditorView
                        ref={(handle) => registerEditor(ed.id, handle)}
                        path={ed.path}
                        isVisible={viewTab === ed.id}
                        focusId={ed.id}
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
        {/* Touch key bar — coarse-pointer devices only, and only while a
            terminal tab (main shell or sub-shell) is active. */}
        {coarsePointer && keybarPtyId && (
          <MobileKeyBar target={() => terminalInput(keybarPtyId)} />
        )}
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
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sessions={sessions}
        workspaces={workspaces}
      />
      <PickerHost />
      <TagHost />
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
          onAction={(flag, actionId) => {
            // `goto-session:<id>` is handled by the app; `<plugin>:<act>`
            // routes to that plugin's onAttentionAction with the ctx bound
            // to the flag's session.
            if (actionId.startsWith('goto-session:')) {
              const sessionId = actionId.slice('goto-session:'.length);
              const target = sessionsRef.current.find((s) => s.id === sessionId);
              if (target) setSelectedWorkspaceId(target.workspaceId);
              handleSelectSession(sessionId);
              return;
            }
            const sep = actionId.indexOf(':');
            const targetPlugin = enabledPluginsRef.current.find(
              (p) => p.id === (sep === -1 ? flag.pluginId : actionId.slice(0, sep)),
            );
            const session = flag.sessionId
              ? sessionsRef.current.find((s) => s.id === flag.sessionId)
              : undefined;
            if (!targetPlugin?.onAttentionAction || !session) return;
            targetPlugin.onAttentionAction(
              buildPluginApi(session, targetPlugin),
              sep === -1 ? actionId : actionId.slice(sep + 1),
              flag.attention,
            );
          }}
        />
      )}
      {closing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="w-80 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]">
            <h2 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">
              Closing…
            </h2>
            <p className="text-[13px] text-[var(--text-secondary)]">
              Collecting session state from plugins before closing.
            </p>
            {closingProgress && (
              <div className="mt-3 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-[var(--bg)]">
                  <div
                    className="h-full bg-[var(--accent)] transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((closingProgress.done / closingProgress.total) * 100))}%`,
                    }}
                  />
                </div>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {Math.min(100, Math.round((closingProgress.done / closingProgress.total) * 100))}%
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {closeConfirmOpen && (
        <CloseConfirmModal
          sessionCount={sessions.length}
          runningCount={runningCount}
          otherWindowCount={otherWindowWorkspaces.size}
          onCancel={() => setCloseConfirmOpen(false)}
          onCloseThisWindow={() => {
            setCloseConfirmOpen(false);
            void removeAndClose();
          }}
          onConfirm={() => {
            setCloseConfirmOpen(false);
            closeAllWindows();
          }}
        />
      )}
      {editorCloseDialog}
      <TooltipHost />
    </div>
    </MemoryStatsProvider>
    </ShellServicesProvider>
    </IconBagContext.Provider>
  );
}

