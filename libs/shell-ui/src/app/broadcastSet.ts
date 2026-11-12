/**
 * The per-window broadcast set: session ids that receive `axn-broadcast`
 * fan-out lines. Runtime state only — a window reload starts empty, the
 * way session selection and marks behave elsewhere.
 */
import { useSyncExternalStore } from 'react';

const set = new Set<string>();
const listeners = new Set<() => void>();
let cachedList: string[] = [];

const notify = () => {
  cachedList = [...set];
  for (const l of listeners) l();
};

export const broadcastSet = {
  mark: (id: string) => {
    if (!set.has(id)) {
      set.add(id);
      notify();
    }
  },
  unmark: (id: string) => {
    if (set.delete(id)) notify();
  },
  clear: () => {
    if (set.size) {
      set.clear();
      notify();
    }
  },
  has: (id: string) => set.has(id),
  /** Replaces the whole set — the session multiselect IS the broadcast target. */
  replaceAll: (ids: string[]) => {
    const next = new Set(ids);
    if (next.size === set.size && [...next].every((i) => set.has(i))) return;
    set.clear();
    for (const id of next) set.add(id);
    notify();
  },
  list: () => [...set],
  size: () => set.size,
};

/** Prunes ids of sessions that no longer exist (closed sessions stay silent). */
export function pruneBroadcastSet(existingIds: ReadonlySet<string>): void {
  let changed = false;
  for (const id of set) {
    if (!existingIds.has(id)) {
      set.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Reactive `is marked` for badges — re-renders when the set changes. */
export function useBroadcastMarked(sessionId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => set.has(sessionId),
  );
}

/** Reactive marked-id list (stable reference per version). */
export function useBroadcastSet(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cachedList,
  );
}
