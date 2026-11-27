import { useSyncExternalStore } from 'react';

/**
 * In-memory store for "restoring" overlays — a plugin that intends to drive
 * a session restore (e.g. devin re-injecting `devin -r <name>` on session
 * open) declares it via `pendingRestore`, and the terminal is covered by a
 * blocking overlay until the plugin calls `ctx.setRestoring(null)` or the
 * user dismisses it. Transient by design: never persisted, so a stale flag
 * cannot survive a restart.
 *
 * Keyed sessionId -> pluginId -> display label, so plugins flag
 * independently — like attention flags.
 */
let restoring: Record<string, Record<string, string>> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Raise (label) or clear (null) a plugin's restore overlay on a session. */
export function setSessionRestoring(
  sessionId: string,
  pluginId: string,
  label: string | null,
): void {
  const current = restoring[sessionId]?.[pluginId];
  if (label ? current === label : current === undefined) return;
  const next = { ...restoring };
  const entries = { ...(next[sessionId] ?? {}) };
  if (label) entries[pluginId] = label;
  else delete entries[pluginId];
  if (Object.keys(entries).length > 0) next[sessionId] = entries;
  else delete next[sessionId];
  restoring = next;
  emit();
}

/** Drop every plugin's overlay on a session (× dismiss / session closed). */
export function clearSessionRestoring(sessionId: string): void {
  if (!restoring[sessionId]) return;
  const next = { ...restoring };
  delete next[sessionId];
  restoring = next;
  emit();
}

/** Whether any plugin has a restore overlay raised on the session right now. */
export function isSessionRestoring(sessionId: string): boolean {
  return restoring[sessionId] !== undefined;
}

const EMPTY: Record<string, string> = {};

/** The restore labels currently raised on a session (pluginId -> label). */
export function useSessionRestoring(sessionId: string): Record<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => restoring[sessionId] ?? EMPTY,
  );
}

/** All raised restore overlays — sessionId -> pluginId -> label. */
export function useRestoring(): Record<string, Record<string, string>> {
  return useSyncExternalStore(subscribe, () => restoring);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
