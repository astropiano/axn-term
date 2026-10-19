import { useSyncExternalStore } from 'react';
import type { AttentionLevel, SessionAttention, ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';

/**
 * Read the attention flags currently raised on a session. Flags live in the
 * plugin's pluginState under the reserved key `attention`, written via
 * `ctx.setAttention(...)`.
 */
export function sessionAttention(
  session: ShellSession,
  plugins: readonly SessionViewPlugin[],
): Record<string, SessionAttention> {
  const out: Record<string, SessionAttention> = {};
  for (const plugin of plugins) {
    const key = plugin.stateKey ?? plugin.id;
    const state = session.pluginState?.[key] as
      | { attention?: SessionAttention | null }
      | undefined;
    const attention = state?.attention;
    if (attention && typeof attention === 'object') out[plugin.id] = attention;
  }
  return out;
}

export interface AttentionSummary {
  level: AttentionLevel;
  /** One "source: message" line per raised flag, for tooltips. */
  title: string;
}

/** A single raised attention flag in the rail indicator's detail list. */
export interface RailFlag {
  /** Display key — `<session> · <plugin>` or the app-level source name. */
  source: string;
  attention: SessionAttention;
  /** Set when the flag belongs to a session — enables navigate-on-click. */
  sessionId?: string;
  /** App-level action — clicking the flag runs this (e.g. open Settings). */
  onClick?: () => void;
}

/**
 * Reduce a set of attention flags to the worst level plus a tooltip text.
 * Returns null when no flags are raised.
 */
export function summarizeAttention(
  record: Record<string, SessionAttention>,
): AttentionSummary | null {
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  const level: AttentionLevel = entries.some(([, a]) => a.level === 'critical' || !a.level)
    ? 'critical'
    : 'warning';
  const title = entries
    .map(([source, a]) => (a.message ? `${source}: ${a.message}` : source))
    .join('\n');
  return { level, title };
}

// ---------------------------------------------------------------------------
// Session-selection tracking (runtime only, not persisted): lets attention
// raisers require "output after the user last viewed the session" — e.g.
// devin's idle flag should only count silence that follows activity the user
// actually watched.
// ---------------------------------------------------------------------------

const lastSelectedAt = new Map<string, number>();

/** Records the moment a session became the selected one. */
export function noteSessionSelected(sessionId: string): void {
  lastSelectedAt.set(sessionId, Date.now());
}

/** Timestamp of the session's most recent selection — 0 when never selected. */
export function sessionLastSelectedAt(sessionId: string): number {
  return lastSelectedAt.get(sessionId) ?? 0;
}

// ---------------------------------------------------------------------------
// App-level attention: flags not bound to a session (e.g. the RAM plugin
// flagging system memory pressure from renderRail). Kept in a tiny external
// store — app-level flags are transient and intentionally not persisted.
// ---------------------------------------------------------------------------

let appAttention: Record<string, SessionAttention> = {};
const listeners = new Set<() => void>();

export function setAppAttention(source: string, attention: SessionAttention | null): void {
  const current = appAttention[source];
  if (JSON.stringify(current ?? null) === JSON.stringify(attention ?? null)) return;
  const next = { ...appAttention };
  if (attention) next[source] = attention;
  else delete next[source];
  appAttention = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppAttention(): Record<string, SessionAttention> {
  return useSyncExternalStore(subscribe, () => appAttention);
}
