import { useEffect, useRef, useState } from 'react';
import type { PeerChannel } from '../platform';
import type { ShellSession, Workspace } from '../types';

/**
 * Cross-window workspace directory and session hand-over, on top of the
 * platform's `peers` channel (desktop: Tauri app-wide events). Every window
 * announces its workspaces; moving a session into another window hands the
 * session record over and waits for the target to confirm before the source
 * lets go — the PTYs stay alive throughout (output is broadcast app-wide, so
 * the target's terminal simply reattaches).
 */

export const TOPIC_WORKSPACES = 'axn:workspaces';
export const TOPIC_WORKSPACES_QUERY = 'axn:workspaces-query';
export const TOPIC_WINDOW_GONE = 'axn:window-gone';
export const TOPIC_ADOPT = 'axn:adopt-session';
export const TOPIC_ADOPT_ACK = 'axn:adopt-session-ack';

/** How long the source waits for the target window to confirm an adoption. */
export const ADOPT_TIMEOUT_MS = 3000;

export interface WorkspaceRef {
  id: string;
  name: string;
}

export interface WorkspacesAnnouncement {
  windowId: string;
  workspaces: WorkspaceRef[];
}

export interface AdoptRequest {
  to: string;
  from: string;
  requestId: string;
  workspaceId: string;
  session: ShellSession;
  /**
   * Insert before this session in the target workspace (a drop between two
   * rows); absent or null appends.
   */
  beforeSessionId?: string | null;
  /**
   * The moving session's terminal history (serialized xterm buffers keyed by
   * session id / sub-shell tab id) — the target's terminals start with it.
   */
  replay?: Record<string, string>;
}

export interface AdoptAck {
  to: string;
  requestId: string;
  ok: boolean;
  error?: string;
}

/** One pickable move target: a workspace in some window. */
export interface WorkspaceTarget {
  windowId: string;
  windowLabel: string;
  isCurrentWindow: boolean;
  workspace: WorkspaceRef;
}

export type WindowLabelKind = { kind: 'current' } | { kind: 'main' } | { kind: 'numbered'; n: number };

/** Untranslated labels — the UI passes a Lingui-backed formatter instead. */
export const defaultWindowLabel = (k: WindowLabelKind): string =>
  k.kind === 'current' ? 'This window' : k.kind === 'main' ? 'Main window' : `Window ${k.n}`;

/**
 * Human labels for window ids: the current one is "This window", `main`
 * is "Main window", the rest are numbered in id order after it.
 */
export function windowLabels(
  windowIds: string[],
  currentId: string,
  format: (k: WindowLabelKind) => string = defaultWindowLabel,
): Map<string, string> {
  const labels = new Map<string, string>();
  const others = windowIds.filter((id) => id !== 'main').sort();
  others.forEach((id, i) => labels.set(id, format({ kind: 'numbered', n: i + 2 })));
  if (windowIds.includes('main')) labels.set('main', format({ kind: 'main' }));
  labels.set(currentId, format({ kind: 'current' }));
  return labels;
}

/**
 * A window's rank in the live set — 'main' is 0, the rest follow in id
 * order. Ranks compact automatically when a lower window closes, which is
 * what drives window numbering and (for remote publishing) per-window
 * session ids: rank 0 publishes `<name>`, rank n publishes `<name>-<n+1>`.
 */
export function windowRank(windowIds: readonly string[], windowId: string): number {
  const ordered = [
    ...(windowIds.includes('main') ? ['main'] : []),
    ...windowIds.filter((id) => id !== 'main').sort(),
  ];
  const i = ordered.indexOf(windowId);
  return i === -1 ? ordered.length : i;
}

/** Per-window remote session id derived from the live-set rank. */
export function remoteSessionName(base: string, rank: number): string {
  return rank === 0 ? base : `${base}-${rank + 1}`;
}

/**
 * Live window ids (self included) — announced over the same peers topics
 * the workspace directory uses, so this stays in sync without a second
 * announcement channel.
 */
export function useWindowIds(
  peers: PeerChannel | undefined,
  windowId: string | undefined,
): string[] {
  const [live, setLive] = useState<string[]>([]);
  useEffect(() => {
    if (!peers || !windowId) return;
    setLive([windowId]);
    const unsubs = [
      peers.subscribe(TOPIC_WORKSPACES, (payload) => {
        const p = payload as WorkspacesAnnouncement;
        if (!p?.windowId) return;
        setLive((prev) => (prev.includes(p.windowId) ? prev : [...prev, p.windowId]));
      }),
      peers.subscribe(TOPIC_WINDOW_GONE, (payload) => {
        const gone = (payload as { windowId?: string })?.windowId;
        if (!gone) return;
        setLive((prev) => prev.filter((id) => id !== gone));
      }),
    ];
    // New windows announce on query — no extra heartbeat needed.
    peers.publish(TOPIC_WORKSPACES_QUERY, { from: windowId });
    return () => unsubs.forEach((u) => u());
  }, [peers, windowId]);
  return live;
}

/** All move targets — this window's workspaces first, then other windows'. */
export function workspaceTargets(
  currentId: string,
  own: WorkspaceRef[],
  others: ReadonlyMap<string, WorkspaceRef[]>,
  format: (k: WindowLabelKind) => string = defaultWindowLabel,
): WorkspaceTarget[] {
  const labels = windowLabels([currentId, ...others.keys()], currentId, format);
  const targets: WorkspaceTarget[] = own.map((workspace) => ({
    windowId: currentId,
    windowLabel: labels.get(currentId)!,
    isCurrentWindow: true,
    workspace,
  }));
  const otherIds = [...others.keys()].sort((a, b) =>
    (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b, undefined, { numeric: true }),
  );
  for (const windowId of otherIds) {
    for (const workspace of others.get(windowId) ?? []) {
      targets.push({ windowId, windowLabel: labels.get(windowId) ?? windowId, isCurrentWindow: false, workspace });
    }
  }
  return targets;
}

/**
 * Keep a directory of the other windows' workspaces, and announce this
 * window's — on change, on request, and gone on unload.
 */
export function useWorkspaceDirectory(
  peers: PeerChannel | undefined,
  windowId: string | undefined,
  workspaces: Workspace[],
): ReadonlyMap<string, WorkspaceRef[]> {
  const [others, setOthers] = useState<ReadonlyMap<string, WorkspaceRef[]>>(() => new Map());
  const own = workspaces.map((w) => ({ id: w.id, name: w.name }));
  const ownKey = JSON.stringify(own);
  const ownRef = useRef(own);
  ownRef.current = own;

  useEffect(() => {
    if (!peers || !windowId) return;
    peers.publish(TOPIC_WORKSPACES, { windowId, workspaces: own } satisfies WorkspacesAnnouncement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, windowId, ownKey]);

  useEffect(() => {
    if (!peers || !windowId) return;
    const announce = () =>
      peers.publish(TOPIC_WORKSPACES, { windowId, workspaces: ownRef.current } satisfies WorkspacesAnnouncement);
    const unsubs = [
      peers.subscribe(TOPIC_WORKSPACES, (payload) => {
        const p = payload as WorkspacesAnnouncement;
        if (!p?.windowId || p.windowId === windowId || !Array.isArray(p.workspaces)) return;
        setOthers((prev) => new Map(prev).set(p.windowId, p.workspaces));
      }),
      peers.subscribe(TOPIC_WORKSPACES_QUERY, (payload) => {
        if ((payload as { from?: string })?.from !== windowId) announce();
      }),
      peers.subscribe(TOPIC_WINDOW_GONE, (payload) => {
        const gone = (payload as { windowId?: string })?.windowId;
        if (!gone) return;
        setOthers((prev) => {
          if (!prev.has(gone)) return prev;
          const next = new Map(prev);
          next.delete(gone);
          return next;
        });
      }),
    ];
    peers.publish(TOPIC_WORKSPACES_QUERY, { from: windowId });
    const leave = () => peers.publish(TOPIC_WINDOW_GONE, { windowId });
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      for (const unsub of unsubs) unsub();
    };
  }, [peers, windowId]);

  return others;
}

/**
 * Ask another window to adopt a session; resolves once it confirms, or with
 * an error after ADOPT_TIMEOUT_MS (the target closed, or never answered).
 */
export function requestAdopt(
  peers: PeerChannel,
  request: Omit<AdoptRequest, 'requestId'>,
  timeoutMs = ADOPT_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const requestId = `${request.from}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(result);
    };
    const unsub = peers.subscribe(TOPIC_ADOPT_ACK, (payload) => {
      const ack = payload as AdoptAck;
      if (ack?.to !== request.from || ack.requestId !== requestId) return;
      finish(ack.ok ? { ok: true } : { ok: false, error: ack.error ?? 'the other window refused' });
    });
    const timer = setTimeout(
      () => finish({ ok: false, error: 'the other window did not answer' }),
      timeoutMs,
    );
    peers.publish(TOPIC_ADOPT, { ...request, requestId } satisfies AdoptRequest);
  });
}
