import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { ShellStateStore } from '../platform';
import { clearSessionRestoring } from './restoring';
import type { PluginTabSet, ShellSession, WindowState, Workspace } from '../types';

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const MAX_OUTPUT_LENGTH = 200_000;

// Session fields that change with terminal output and must NOT trigger an
// eager save — they stay on the interval flush. Everything else (tabs, cwd,
// names, workspaceId) is structural and persists immediately.
const RUNTIME_SESSION_PATCH_KEYS = new Set<keyof ShellSession>([
  'status',
  'tasks',
  'progress',
  'output',
  'agentInput',
  'process',
  'repo',
  'pluginState',
]);

function createDefaultWorkspace(): Workspace {
  return {
    id: generateId(),
    name: 'workspace-1',
    collapsed: false,
  };
}

function createDefaultSession(workspaceId: string, index = 1): ShellSession {
  return {
    id: generateId(),
    workspaceId,
    name: `session-${index}`,
    topic: 'New session',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
  };
}

function isWindowState(value: unknown): value is WindowState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as WindowState).id === 'string' &&
    Array.isArray((value as WindowState).workspaces) &&
    Array.isArray((value as WindowState).sessions)
  );
}

async function loadWindowState(store: ShellStateStore, windowId: string): Promise<WindowState | null> {
  try {
    const value = await store.load(windowId);
    if (value && isWindowState(value)) {
      return value;
    }
  } catch (e) {
    console.error('Failed to load window state:', e);
  }
  return null;
}

async function writeWindowState(store: ShellStateStore, windowId: string, state: WindowState): Promise<void> {
  await store.save(windowId, state);
}

export function useShellSessions(windowId: string, stateStore: ShellStateStore) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [pluginTabs, setPluginTabs] = useState<Record<string, PluginTabSet>>({});
  const [pluginData, setPluginData] = useState<Record<string, unknown>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Set when the backend loaded state.json.bak because state.json failed. */
  const [stateNotice, setStateNotice] = useState<string | null>(null);

  const workspacesRef = useRef(workspaces);
  const sessionsRef = useRef(sessions);
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const pluginTabsRef = useRef(pluginTabs);
  const pluginDataRef = useRef(pluginData);
  const windowIdRef = useRef(windowId);
  const stateStoreRef = useRef(stateStore);
  stateStoreRef.current = stateStore;
  const dirtyRef = useRef(false);
  // Bumped on every change; a save only clears dirtyRef when no change
  // landed while it was in flight.
  const dirtyGenRef = useRef(0);
  const saveChainRef = useRef(Promise.resolve());

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    dirtyGenRef.current += 1;
  }, []);

  useEffect(() => {
    windowIdRef.current = windowId;
  }, [windowId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    pluginTabsRef.current = pluginTabs;
  }, [pluginTabs]);

  useEffect(() => {
    pluginDataRef.current = pluginData;
  }, [pluginData]);

  // Mark dirty whenever persisted data changes.
  useEffect(() => {
    if (loaded) {
      markDirty();
    }
  }, [workspaces, sessions, selectedWorkspaceId, selectedSessionId, pluginTabs, pluginData, loaded, markDirty]);

  const setSessionsWithRef = useCallback(
    (updater: (prev: ShellSession[]) => ShellSession[]) => {
      setSessions((prev) => {
        const next = updater(prev);
        sessionsRef.current = next;
        markDirty();
        return next;
      });
    },
    [setSessions, markDirty],
  );

  const setWorkspacesWithRef = useCallback(
    (updater: (prev: Workspace[]) => Workspace[]) => {
      setWorkspaces((prev) => {
        const next = updater(prev);
        workspacesRef.current = next;
        markDirty();
        return next;
      });
    },
    [setWorkspaces, markDirty],
  );

  const setSelectedWorkspaceIdWithRef = useCallback(
    (id: string) => {
      setSelectedWorkspaceId(id);
      selectedWorkspaceIdRef.current = id;
      markDirty();
    },
    [setSelectedWorkspaceId, markDirty],
  );

  const setSelectedSessionIdWithRef = useCallback(
    (id: string) => {
      setSelectedSessionId(id);
      selectedSessionIdRef.current = id;
      markDirty();
    },
    [setSelectedSessionId, markDirty],
  );

  const setPluginTabsWithRef = useCallback(
    (updater: (prev: Record<string, PluginTabSet>) => Record<string, PluginTabSet>) => {
      setPluginTabs((prev) => {
        const next = updater(prev);
        pluginTabsRef.current = next;
        markDirty();
        return next;
      });
    },
    [setPluginTabs, markDirty],
  );

  const setPluginDataWithRef = useCallback(
    (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      setPluginData((prev) => {
        const next = updater(prev);
        pluginDataRef.current = next;
        markDirty();
        return next;
      });
    },
    [setPluginData, markDirty],
  );

  // Saves are serialized through saveChainRef: structural mutations call
  // saveNow eagerly and several may fire back-to-back (e.g. a session-exited
  // burst), but state.json.tmp + rename must never be written concurrently.
  const saveNow = useCallback(async () => {
    const run = saveChainRef.current.then(async () => {
      const gen = dirtyGenRef.current;
      const state: WindowState = {
        id: windowIdRef.current,
        workspaces: workspacesRef.current,
        sessions: sessionsRef.current,
        selectedWorkspaceId: selectedWorkspaceIdRef.current,
        selectedSessionId: selectedSessionIdRef.current,
        pluginTabs: pluginTabsRef.current,
        pluginData: pluginDataRef.current,
      };
      try {
        await writeWindowState(stateStoreRef.current, windowIdRef.current, state);
        if (dirtyGenRef.current === gen) dirtyRef.current = false;
      } catch (e) {
        console.error('Failed to save window state:', e);
        dirtyRef.current = true;
        throw e;
      }
    });
    saveChainRef.current = run.catch(() => {});
    return run;
  }, []);

  // Flush state to disk every couple of seconds while the app is running.
  useEffect(() => {
    if (!loaded) return;
    const interval = setInterval(() => {
      if (dirtyRef.current) {
        saveNow().catch(() => {});
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [loaded, saveNow]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;

    loadWindowState(stateStore, windowId)
      .then((saved) => {
        if (cancelled) return;
        const initial: WindowState = saved ?? {
          id: windowId,
          workspaces: [createDefaultWorkspace()],
          sessions: [],
        };
        const defaultWorkspace = initial.workspaces[0] ?? createDefaultWorkspace();
        let workspaceSessions = initial.sessions.filter((s) => s.workspaceId === defaultWorkspace.id);
        if (workspaceSessions.length === 0) {
          workspaceSessions = [createDefaultSession(defaultWorkspace.id)];
        }
        const allSessions = [
          ...workspaceSessions,
          ...initial.sessions.filter((s) => s.workspaceId !== defaultWorkspace.id),
        ].map((s) => ({
          // Runtime-only fields must not survive a restart — no process is
          // running in a freshly spawned session, so a persisted 100% progress
          // bar or "running" status would be stale.
          ...s,
          process: undefined,
          status: 'idle' as const,
          progress: 0,
          tasks: [],
          agentInput: undefined,
        }));

        if (saved?.restoredFromBackup) {
          setStateNotice(
            `Session state was restored from a backup — the previous save failed${
              saved.failedStateFile ? ` (${saved.failedStateFile} kept for diagnosis)` : ''
            }.`,
          );
        }

        const fallbackWorkspace = defaultWorkspace.id;
        const fallbackSession = workspaceSessions[0].id;
        const selectedSessionId =
          saved?.selectedSessionId && allSessions.some((s) => s.id === saved.selectedSessionId)
            ? saved.selectedSessionId
            : fallbackSession;
        const selectedWorkspaceId =
          allSessions.find((s) => s.id === selectedSessionId)?.workspaceId ??
          (saved?.selectedWorkspaceId && initial.workspaces.some((w) => w.id === saved.selectedWorkspaceId)
            ? saved.selectedWorkspaceId
            : fallbackWorkspace);

        setWorkspacesWithRef(() => [defaultWorkspace, ...initial.workspaces.slice(1)]);
        setSessionsWithRef(() => allSessions);
        setPluginTabsWithRef(() => initial.pluginTabs ?? {});
        setPluginDataWithRef(() => initial.pluginData ?? {});
        setSelectedWorkspaceIdWithRef(selectedWorkspaceId);
        setSelectedSessionIdWithRef(selectedSessionId);
        setLoaded(true);

        if (!saved) {
          saveNow().catch(() => {});
        }
      })
      .catch(() => {
        if (cancelled) return;
        const workspace = createDefaultWorkspace();
        const session = createDefaultSession(workspace.id);
        setWorkspacesWithRef(() => [workspace]);
        setSessionsWithRef(() => [session]);
        setSelectedWorkspaceIdWithRef(workspace.id);
        setSelectedSessionIdWithRef(session.id);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [windowId, saveNow, setSessionsWithRef, setWorkspacesWithRef, setPluginTabsWithRef, setPluginDataWithRef, setSelectedSessionIdWithRef, setSelectedWorkspaceIdWithRef]);

  // Stores that mirror a remote model push changes through watch — reload
  // and merge upstream sessions/workspaces, keeping local selection when
  // it still exists (plugin state stays local: the mirror doesn't carry it).
  useEffect(() => {
    if (!loaded || !stateStore.watch) return;
    return stateStore.watch(windowId, () => {
      void loadWindowState(stateStoreRef.current, windowIdRef.current).then((fresh) => {
        if (!fresh) return;
        setWorkspacesWithRef(() => fresh.workspaces);
        setSessionsWithRef(() => fresh.sessions);
        if (!fresh.sessions.some((s) => s.id === selectedSessionIdRef.current)) {
          setSelectedSessionIdWithRef(fresh.sessions[0]?.id ?? '');
        }
        if (!fresh.workspaces.some((w) => w.id === selectedWorkspaceIdRef.current)) {
          setSelectedWorkspaceIdWithRef(
            fresh.sessions.find((s) => s.id === selectedSessionIdRef.current)?.workspaceId ??
              fresh.workspaces[0]?.id ??
              '',
          );
        }
      });
    });
  }, [loaded, stateStore, windowId, setWorkspacesWithRef, setSessionsWithRef, setSelectedSessionIdWithRef, setSelectedWorkspaceIdWithRef]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0],
    [workspaces, selectedWorkspaceId],
  );

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? sessions[0],
    [sessions, selectedSessionId],
  );

  const addWorkspace = useCallback(
    (name?: string): string => {
      const id = generateId();
      setWorkspacesWithRef((prev) => {
        const names = new Set(prev.map((w) => w.name));
        // addWorkspace is also wired directly to onClick handlers, where the
        // argument is the MouseEvent — only a real string counts as a name.
        let workspaceName = typeof name === 'string' ? name.trim() : '';
        if (!workspaceName) {
          let index = 1;
          while (names.has(`workspace-${index}`)) {
            index++;
          }
          workspaceName = `workspace-${index}`;
        }
        const workspace: Workspace = { id, name: workspaceName, collapsed: false };
        return [...prev, workspace];
      });
      saveNow().catch(() => {});
      return id;
    },
    [setWorkspacesWithRef, saveNow],
  );

  const renameWorkspace = useCallback(
    (workspaceId: string, name: string) => {
      setWorkspacesWithRef((prev) => {
        const trimmed = name.trim();
        if (!trimmed) {
          const names = new Set(prev.map((w) => w.name));
          let index = 1;
          while (names.has(`workspace-${index}`)) {
            index++;
          }
          return prev.map((w) => (w.id === workspaceId ? { ...w, name: `workspace-${index}` } : w));
        }
        return prev.map((w) => (w.id === workspaceId ? { ...w, name: trimmed } : w));
      });
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, saveNow],
  );

  const deleteWorkspace = useCallback(
    (workspaceId: string) => {
      setWorkspacesWithRef((prev) => {
        if (prev.length <= 1) return prev;
        const fallback = prev.find((w) => w.id !== workspaceId)?.id ?? prev[0].id;
        setSessionsWithRef((sessionsPrev) =>
          sessionsPrev.map((s) => (s.workspaceId === workspaceId ? { ...s, workspaceId: fallback } : s)),
        );
        if (selectedWorkspaceIdRef.current === workspaceId) {
          setSelectedWorkspaceIdWithRef(fallback);
        }
        return prev.filter((w) => w.id !== workspaceId);
      });
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, setSessionsWithRef, setSelectedWorkspaceIdWithRef, saveNow],
  );

  const toggleWorkspaceCollapsed = useCallback(
    (workspaceId: string) => {
      setWorkspacesWithRef((prev) =>
        prev.map((w) => (w.id === workspaceId ? { ...w, collapsed: !w.collapsed } : w)),
      );
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, saveNow],
  );

  const updateWorkspace = useCallback(
    (workspaceId: string, patch: Partial<Workspace>) => {
      setWorkspacesWithRef((prev) =>
        prev.map((w) => (w.id === workspaceId ? { ...w, ...patch } : w)),
      );
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, saveNow],
  );

  const moveSessionToWorkspace = useCallback(
    (sessionId: string, workspaceId: string, beforeSessionId?: string | null) => {
      setSessionsWithRef((prev) => {
        const moving = prev.find((s) => s.id === sessionId);
        if (!moving || moving.id === beforeSessionId) return prev;
        const moved = { ...moving, workspaceId };
        const without = prev.filter((s) => s.id !== sessionId);
        let insertAt: number;
        if (beforeSessionId) {
          insertAt = without.findIndex((s) => s.id === beforeSessionId);
          if (insertAt === -1) insertAt = without.length;
        } else {
          // Append after the last session that belongs to the workspace.
          insertAt = without.length;
          for (let i = without.length - 1; i >= 0; i--) {
            if (without[i].workspaceId === workspaceId) {
              insertAt = i + 1;
              break;
            }
          }
        }
        return [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
      });
      setSelectedWorkspaceIdWithRef(workspaceId);
      saveNow().catch(() => {});
    },
    [setSessionsWithRef, setSelectedWorkspaceIdWithRef, saveNow],
  );

  const moveWorkspace = useCallback(
    (workspaceId: string, delta: -1 | 1) => {
      setWorkspacesWithRef((prev) => {
        const index = prev.findIndex((w) => w.id === workspaceId);
        const target = index + delta;
        if (index === -1 || target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, saveNow],
  );

  // Drag-and-drop reorder: inserts the workspace so it lands at `targetIndex`
  // in the list *after* removal (index i = before the i-th remaining entry,
  // length = end). No-op when the workspace is missing or stays in place.
  const reorderWorkspace = useCallback(
    (workspaceId: string, targetIndex: number) => {
      setWorkspacesWithRef((prev) => {
        const from = prev.findIndex((w) => w.id === workspaceId);
        if (from === -1) return prev;
        const next = [...prev];
        const [ws] = next.splice(from, 1);
        const to = Math.max(
          0,
          Math.min(targetIndex > from ? targetIndex - 1 : targetIndex, next.length),
        );
        if (to === from) return prev;
        next.splice(to, 0, ws);
        return next;
      });
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, saveNow],
  );

  const addSession = useCallback(
    (workspaceId?: string, cwd?: string, name?: string) => {
      // Only ids that exist right now — a stale/unknown id would create a
      // session no workspace lists (invisible, yet selected), which surfaces
      // as "click → nothing happened" (MR review hit this).
      const known = (id?: string) =>
        workspacesRef.current.some((w) => w.id === id);
      const targetWorkspaceId = [
        workspaceId,
        selectedWorkspaceIdRef.current,
        workspacesRef.current[0]?.id,
      ].find(known);
      if (!targetWorkspaceId) return;
      const session = createDefaultSession(targetWorkspaceId);
      session.name = name?.trim() || `session-${sessionsRef.current.length + 1}`;
      if (cwd) session.cwd = cwd;
      setSessionsWithRef((prev) => [...prev, session]);
      setSelectedWorkspaceIdWithRef(targetWorkspaceId);
      setSelectedSessionIdWithRef(session.id);
      saveNow().catch(() => {});
    },
    [setSessionsWithRef, setSelectedWorkspaceIdWithRef, setSelectedSessionIdWithRef, saveNow],
  );

  // Adopt a session object as-is — used when a sub-shell PTY is detached into
  // its own session ("turn into workspace") and when another window hands a
  // whole session over (its tabs, plugin state and scrollback ride along):
  // the id is the live PTY's backend session id, so the mounting
  // ShellTerminal reattaches instead of spawning.
  const adoptSession = useCallback(
    (workspaceId: string, init: { id: string; name: string; cwd?: string } & Partial<ShellSession>) => {
      const session: ShellSession = { ...createDefaultSession(workspaceId), ...init, workspaceId };
      setSessionsWithRef((prev) => [...prev, session]);
    },
    [setSessionsWithRef],
  );

  const selectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionIdWithRef(sessionId);
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (session) {
        setSelectedWorkspaceIdWithRef(session.workspaceId);
      }
    },
    [setSelectedSessionIdWithRef, setSelectedWorkspaceIdWithRef],
  );

  const orderedSessions = useMemo(
    () => workspaces.flatMap((w) => sessions.filter((s) => s.workspaceId === w.id)),
    [workspaces, sessions],
  );

  const selectNextSession = useCallback(() => {
    if (orderedSessions.length === 0) return;
    const idx = orderedSessions.findIndex((s) => s.id === selectedSessionIdRef.current);
    const next = orderedSessions[(idx + 1) % orderedSessions.length];
    selectSession(next.id);
  }, [orderedSessions, selectSession]);

  const selectPrevSession = useCallback(() => {
    if (orderedSessions.length === 0) return;
    const idx = orderedSessions.findIndex((s) => s.id === selectedSessionIdRef.current);
    const next =
      idx <= 0 ? orderedSessions[orderedSessions.length - 1] : orderedSessions[idx - 1];
    selectSession(next.id);
  }, [orderedSessions, selectSession]);

  const selectNextWorkspace = useCallback(() => {
    if (workspaces.length === 0) return;
    const idx = workspaces.findIndex((w) => w.id === selectedWorkspaceIdRef.current);
    const next = workspaces[(idx + 1) % workspaces.length];
    const nextSession = orderedSessions.find((s) => s.workspaceId === next.id);
    setSelectedWorkspaceIdWithRef(next.id);
    if (nextSession) setSelectedSessionIdWithRef(nextSession.id);
  }, [workspaces, orderedSessions, setSelectedWorkspaceIdWithRef, setSelectedSessionIdWithRef]);

  const selectPrevWorkspace = useCallback(() => {
    if (workspaces.length === 0) return;
    const idx = workspaces.findIndex((w) => w.id === selectedWorkspaceIdRef.current);
    const next = workspaces[idx <= 0 ? workspaces.length - 1 : idx - 1];
    const nextSession = orderedSessions.find((s) => s.workspaceId === next.id);
    setSelectedWorkspaceIdWithRef(next.id);
    if (nextSession) setSelectedSessionIdWithRef(nextSession.id);
  }, [workspaces, orderedSessions, setSelectedWorkspaceIdWithRef, setSelectedSessionIdWithRef]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceIdWithRef(workspaceId);
    },
    [setSelectedWorkspaceIdWithRef],
  );

  const renameSession = useCallback(
    (sessionId: string, name: string) => {
      const trimmed = name.trim();
      setSessionsWithRef((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          // An empty name clears the custom override and falls back to the
          // name last reported by the process (e.g. a devin session title).
          if (!trimmed) {
            return { ...s, customName: undefined, name: s.autoName ?? s.name };
          }
          return { ...s, name: trimmed, customName: trimmed };
        }),
      );
      saveNow().catch(() => {});
    },
    [setSessionsWithRef, saveNow],
  );

  /**
   * Applies a process-reported name (OSC title). The override wins: while a
   * customName is set the display name stays untouched, but autoName is always
   * kept current so clearing the custom name restores the latest process name.
   */
  const applySessionAutoName = useCallback(
    (sessionId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setSessionsWithRef((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, autoName: trimmed, name: s.customName ?? trimmed }
            : s,
        ),
      );
    },
    [setSessionsWithRef],
  );

  const duplicateSession = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const copy: ShellSession = {
        ...session,
        id: generateId(),
        // The copy spawns its own PTY — mainPtyId only makes sense while it
        // points at a live backend session this session owns.
        mainPtyId: undefined,
        name: `${session.name} (copy)`,
        customName: session.customName ? `${session.customName} (copy)` : undefined,
        output: '',
        tasks: [],
        progress: 0,
        status: 'idle',
        process: undefined,
        agentInput: undefined,
        pluginState: {},
        editors: [],
        activeTab: 'shell',
      };
      setSessionsWithRef((prev) => {
        const idx = prev.findIndex((s) => s.id === sessionId);
        if (idx === -1) return [...prev, copy];
        return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
      });
      setSelectedWorkspaceIdWithRef(copy.workspaceId);
      setSelectedSessionIdWithRef(copy.id);
      saveNow().catch(() => {});
    },
    [setSessionsWithRef, setSelectedWorkspaceIdWithRef, setSelectedSessionIdWithRef, saveNow],
  );

  const updateSession = useCallback(
    (sessionId: string, patch: Partial<ShellSession>) => {
      setSessionsWithRef((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)));
      // Runtime churn (status/progress/tasks per output chunk) stays on the
      // interval flush; structural patches (tabs, cwd, names) persist now.
      if (
        Object.keys(patch).some(
          (key) => !RUNTIME_SESSION_PATCH_KEYS.has(key as keyof ShellSession),
        )
      ) {
        saveNow().catch(() => {});
      }
    },
    [setSessionsWithRef, saveNow],
  );

  /** Merge a patch into a plugin's hosted tab set (window-level state). */
  const updatePluginTabs = useCallback(
    (pluginId: string, patch: Partial<PluginTabSet>) => {
      setPluginTabsWithRef((prev) => {
        const current = prev[pluginId] ?? { editors: [] };
        return { ...prev, [pluginId]: { ...current, ...patch } };
      });
      saveNow().catch(() => {});
    },
    [setPluginTabsWithRef, saveNow],
  );

  /**
   * Merge a patch into a plugin's app-level persisted data — the plugin-view
   * counterpart of `mergePluginState`.
   */
  const mergePluginData = useCallback(
    (key: string, patch: Record<string, unknown>) => {
      setPluginDataWithRef((prev) => ({
        ...prev,
        [key]: {
          ...((prev[key] ?? {}) as Record<string, unknown>),
          ...patch,
        },
      }));
      saveNow().catch(() => {});
    },
    [setPluginDataWithRef, saveNow],
  );

  /**
   * Merge a per-plugin state patch into the *latest* session state inside the
   * state updater. Building the merged pluginState from a captured snapshot
   * (as a plain updateSession patch would) lets a stale update resurrect old
   * fields — e.g. a tasks update written on an older snapshot reintroducing an
   * outdated devinSessionName.
   */
  const mergePluginState = useCallback(
    (sessionId: string, stateKey: string, patch: Record<string, unknown>) => {
      setSessionsWithRef((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const pluginState = { ...(s.pluginState ?? {}) } as Record<string, unknown>;
          const current = (pluginState[stateKey] ?? {}) as Record<string, unknown>;
          pluginState[stateKey] = { ...current, ...patch };
          return { ...s, pluginState };
        }),
      );
    },
    [setSessionsWithRef],
  );

  const appendSessionOutput = useCallback(
    (sessionId: string, text: string) => {
      if (!text) return;
      setSessionsWithRef((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const combined = s.output + text;
          const output =
            combined.length > MAX_OUTPUT_LENGTH ? combined.slice(-MAX_OUTPUT_LENGTH) : combined;
          return { ...s, output };
        }),
      );
    },
    [setSessionsWithRef],
  );

  const closeSession = useCallback(
    (sessionId: string) => {
      clearSessionRestoring(sessionId);
      setSessionsWithRef((prev) => {
        const next = prev.filter((s) => s.id !== sessionId);
        if (selectedSessionIdRef.current === sessionId) {
          const fallback =
            next.find((s) => s.workspaceId === selectedWorkspaceIdRef.current)?.id ?? next[0]?.id;
          if (fallback) setSelectedSessionIdWithRef(fallback);
        }
        return next;
      });
      saveNow().catch(() => {});
    },
    [setSessionsWithRef, setSelectedSessionIdWithRef, saveNow],
  );

  const importWindowState = useCallback(
    (state: Partial<WindowState>) => {
      const importedWorkspaces =
        state.workspaces && state.workspaces.length > 0
          ? state.workspaces
          : [createDefaultWorkspace()];
      const defaultWorkspace = importedWorkspaces[0];
      const importedSessions = state.sessions && state.sessions.length > 0
        ? state.sessions
        : [createDefaultSession(defaultWorkspace.id)];
      const sanitized = importedSessions.map((s) => ({
        ...s,
        process: undefined,
        status: 'idle' as const,
        progress: 0,
        tasks: [],
        agentInput: undefined,
      }));
      const fallbackSession = sanitized[0].id;
      const selectedSessionId =
        state.selectedSessionId && sanitized.some((s) => s.id === state.selectedSessionId)
          ? state.selectedSessionId
          : fallbackSession;
      const fallbackWorkspace = defaultWorkspace.id;
      const selectedWorkspaceId =
        sanitized.find((s) => s.id === selectedSessionId)?.workspaceId ??
        (state.selectedWorkspaceId &&
        importedWorkspaces.some((w) => w.id === state.selectedWorkspaceId)
          ? state.selectedWorkspaceId
          : fallbackWorkspace);

      setWorkspacesWithRef(() => importedWorkspaces);
      setSessionsWithRef(() => sanitized);
      setPluginTabsWithRef(() => state.pluginTabs ?? {});
      setPluginDataWithRef(() => state.pluginData ?? {});
      setSelectedWorkspaceIdWithRef(selectedWorkspaceId);
      setSelectedSessionIdWithRef(selectedSessionId);
      saveNow().catch(() => {});
    },
    [setWorkspacesWithRef, setSessionsWithRef, setPluginTabsWithRef, setPluginDataWithRef, setSelectedWorkspaceIdWithRef, setSelectedSessionIdWithRef, saveNow],
  );

  return {
    workspaces,
    sessions,
    selectedWorkspaceId,
    selectedSessionId,
    selectedWorkspace,
    selectedSession,
    hoveredId,
    setHoveredId,
    setSelectedSessionId: selectSession,
    setSelectedWorkspaceId: selectWorkspace,
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
    closeSession,
    loaded,
    saveNow,
    importWindowState,
    stateNotice,
    dismissStateNotice: () => setStateNotice(null),
  };
}
