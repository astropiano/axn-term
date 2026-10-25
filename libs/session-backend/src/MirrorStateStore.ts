import type { RamphastosSession } from '@ramphastos/ramphastos-client';

/**
 * Structurally compatible with shell-ui's ShellStateStore — declared here
 * (not imported) because session-backend must not depend on shell-ui.
 */
export interface MirrorStateStore {
  load(windowId: string): Promise<unknown>;
  save(windowId: string, state: unknown): Promise<void>;
  delete?(windowId: string): Promise<void>;
  watch?(windowId: string, cb: () => void): () => void;
}

interface ReplicaPty {
  id: string;
  name?: string;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number | null;
  workspaceId?: string;
  sessionId?: string;
  kind?: string;
}

interface ReplicaWorkspace { id: string; name?: string }

interface LocalLayout {
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  workspaces?: { id: string; name?: string; collapsed?: boolean }[];
}

const REMOTE_WS = 'remote';

/**
 * WindowState view over a client-authoritative mirror: the session list is
 * synthesized from the replica's `ptys` collection (the authority's model),
 * while selection/workspace cosmetics are kept device-local in localStorage
 * — the remote model belongs to the authority, so this store never writes
 * sessions upstream (mutations go through backend commands).
 *
 * `watch` pushes live updates: every replica patch (bump on onChange)
 * re-derives state, so the phone sees terminals appear/close/exit as the
 * desktop changes them.
 */
export function createMirrorStateStore(connect: () => Promise<RamphastosSession>): MirrorStateStore {
  const layoutKey = (id: string | undefined) => `axn-mirror:${id ?? 'session'}`;
  // Last meta we pushed per pty — avoids re-invoking on our own echo.
  const pushed = new Map<string, string>();

  const readLayout = (key: string): LocalLayout | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as LocalLayout) : null;
    } catch {
      return null;
    }
  };

  return {
    async load(windowId) {
      const session = await connect();
      return mirrorWindowState(session, windowId, readLayout(layoutKey(session.sessionId)));
    },

    async save(_windowId, state) {
      // Only the device-local layout is persisted — workspaces/selection.
      // Session rows in `state` are the mirror's, not ours to keep.
      try {
        const s = await connect();
        const ws = state as { workspaces?: unknown[]; selectedWorkspaceId?: string; selectedSessionId?: string };
        const layout: LocalLayout = {
          selectedWorkspaceId: ws.selectedWorkspaceId,
          selectedSessionId: ws.selectedSessionId,
          workspaces: (ws.workspaces ?? []).map((w) => {
            const x = w as { id?: string; name?: string; collapsed?: boolean };
            return { id: x.id ?? '', name: x.name, collapsed: x.collapsed };
          }),
        };
        localStorage.setItem(layoutKey(s.sessionId), JSON.stringify(layout));

        // Publish workspace names upstream — shared across devices.
        const remoteWsNow = new Map((((s.vm().workspaces as ReplicaWorkspace[] | undefined) ?? []).map((w) => [w.id, w.name])));
        for (const w of layout.workspaces ?? []) {
          // 'remote' is the synthetic bucket — never a real workspace.
          if (!w.id || w.id === REMOTE_WS || remoteWsNow.get(w.id) === (w.name ?? null)) continue;
          const key = `ws:${w.id}`;
          const meta = w.name ?? '';
          if (pushed.get(key) === meta) continue;
          pushed.set(key, meta);
          void s.invoke('/vm/upsertWorkspace', [w.id, w.name ?? null])
            .catch(() => pushed.delete(key));
        }

        // Publish session-model edits upstream — the authority (desktop or
        // session host) owns name/workspaceId so every device renders the
        // same list. Never push synthetic fallbacks: the 'remote' bucket is
        // a display grouping for ungrouped ptys, and a name equal to the
        // pty id is the fallback label — writing either back would
        // overwrite real metadata from other devices (and ping-pong).
        const sessions = (state as { sessions?: { id: string; name?: string; workspaceId?: string; mainPtyId?: string }[] }).sessions ?? [];
        for (const sess of sessions) {
          const ptyId = sess.mainPtyId ?? sess.id;
          const wsId = sess.workspaceId && sess.workspaceId !== REMOTE_WS ? sess.workspaceId : null;
          const name = sess.name && sess.name !== ptyId && sess.name !== sess.id ? sess.name : null;
          const meta = JSON.stringify([sess.id, wsId, name]);
          if (pushed.get(ptyId) === meta) continue;
          pushed.set(ptyId, meta);
          void s.invoke('/vm/setPtyMeta', [ptyId, sess.id, wsId, name, null])
            .catch(() => pushed.delete(ptyId));
        }
      } catch {
        // offline/disconnected — layout loss is acceptable
      }
    },

    async delete() {
      try {
        const s = await connect();
        localStorage.removeItem(layoutKey(s.sessionId));
      } catch {
        // ignore
      }
    },

    watch(_windowId, cb) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub: (() => void) | undefined;
      void connect().then((session) => {
        unsub = session.onChange(() => {
          // Replica patches arrive per-op; coalesce bursts into one reload.
          clearTimeout(timer);
          timer = setTimeout(cb, 120);
        });
      });
      return () => {
        clearTimeout(timer);
        unsub?.();
      };
    },
  };
}

function mirrorWindowState(
  session: RamphastosSession,
  windowId: string,
  layout: LocalLayout | null,
): Record<string, unknown> {
  const vm = session.vm();
  const ptys = ((vm.ptys as ReplicaPty[] | undefined) ?? []).filter((p) => p?.id);
  const mains = ptys.filter((p) => p.kind !== 'subshell');
  const subs = ptys.filter((p) => p.kind === 'subshell');

  // Workspace grouping comes from the published workspaceId; entries
  // without one (remote-spawned, detached) land in a "Remote" bucket.
  const wsIds = new Map<string, string>();
  for (const p of mains) {
    const ws = p.workspaceId ?? REMOTE_WS;
    if (!wsIds.has(ws)) wsIds.set(ws, ws);
  }
  if (wsIds.size === 0) wsIds.set(REMOTE_WS, REMOTE_WS);
  const localWs = new Map((layout?.workspaces ?? []).map((w) => [w.id, w]));
  // Server-published workspace names win — a rename on any device lands here.
  const remoteWs = new Map(
    (((vm.workspaces as ReplicaWorkspace[] | undefined) ?? []).map((w) => [w.id, w.name])),
  );
  const workspaces = [...wsIds.keys()].map((id) => ({
    id,
    name: remoteWs.get(id) ?? localWs.get(id)?.name ?? (id === REMOTE_WS ? 'Remote' : id),
    collapsed: localWs.get(id)?.collapsed,
  }));

  const sessions = mains.map((p) => {
    const sessionId = p.sessionId ?? p.id;
    return {
      id: sessionId,
      // The desktop's session id is the PTY id unless a promoted sub-shell
      // took over — mainPtyId keeps PTY-bound ops aimed at the right id.
      mainPtyId: p.id === sessionId ? undefined : p.id,
      workspaceId: p.workspaceId ?? REMOTE_WS,
      name: p.name ?? p.id,
      topic: '',
      summary: '',
      tasks: [],
      progress: 0,
      output: '',
      cwd: p.cwd,
      status: p.status === 'exited' ? ('completed' as const) : ('idle' as const),
      editors: subs
        .filter((t) => (t.sessionId ?? t.workspaceId) === sessionId)
        .map((t) => ({
          id: t.id,
          path: t.id,
          kind: 'shell' as const,
          command: t.command,
          cwd: t.cwd,
          label: t.name,
        })),
    };
  });

  return {
    id: windowId,
    workspaces,
    sessions,
    selectedWorkspaceId: layout?.selectedWorkspaceId,
    selectedSessionId: layout?.selectedSessionId,
    // Surface the authority's identity for the UI (window title / banner).
    remoteDevice: vm.device,
    remoteHostname: vm.hostname,
  };
}
