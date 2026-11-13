import { useEffect, useSyncExternalStore } from 'react';
import type { PluginSettings } from '../pluginSettings';

/**
 * Ticket sources — the listing counterpart of card enrichers: a plugin that
 * knows a tracker (the jira plugin) registers a source that turns a query
 * (JQL for Jira) into tickets. dev-workflow uses it for the backlog — the
 * tickets of a linked workflow that no session works on yet — without
 * importing the tracker.
 */

export interface Ticket {
  key: string;
  summary: string;
  status: string;
  /** `new` | `indeterminate` | `done` (Jira's status categories). */
  statusCategory: string;
  url: string;
  assignee?: string;
  type?: string;
  /** Chip color the source picked for the status (named or hex, see `CardChip.color`). */
  color?: string;
}

export interface TicketSource {
  id: string;
  enabled(settings: PluginSettings): boolean;
  search(query: string, settings: PluginSettings): Promise<Ticket[]>;
  /** Settings fingerprint; a list fetched under another one is refetched. */
  settingsKey?: (settings: PluginSettings) => string;
}

const sources = new Map<string, TicketSource>();

/** Module-level registration; a duplicate id replaces the earlier one. */
export function registerTicketSource(source: TicketSource): void {
  sources.set(source.id, source);
}

export function ticketSource(id: string): TicketSource | undefined {
  return sources.get(id);
}

// ---------------------------------------------------------------------------
// Polled cache, shared across views
// ---------------------------------------------------------------------------

export const TICKET_REFRESH_MS = 2 * 60_000;

export interface TicketList {
  tickets: Ticket[];
  /** Last fetch time; 0 = never. */
  at: number;
  loading: boolean;
  error?: string;
  /** `settingsKey` the list was fetched under. */
  sk?: string;
}

const EMPTY: TicketList = { tickets: [], at: 0, loading: false };
const lists = new Map<string, TicketList>();
const listeners = new Set<() => void>();
let version = 0;

const listKey = (sourceId: string, query: string) => `${sourceId}\u0000${query}`;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetch unless fresh or in flight (`force` ignores freshness). */
export function refreshTickets(
  sourceId: string,
  query: string,
  settings: PluginSettings,
  force = false,
): void {
  const source = sources.get(sourceId);
  if (!source || !source.enabled(settings)) return;
  const key = listKey(sourceId, query);
  const prev = lists.get(key) ?? EMPTY;
  const sk = source.settingsKey?.(settings) ?? '';
  const fresh = Date.now() - prev.at < TICKET_REFRESH_MS && prev.sk === sk;
  if (prev.loading || (!force && fresh)) return;
  lists.set(key, { ...prev, loading: true });
  notify();
  source
    .search(query, settings)
    .then((tickets) => lists.set(key, { tickets, at: Date.now(), loading: false, sk }))
    .catch((e: unknown) =>
      lists.set(key, {
        ...prev,
        at: Date.now(),
        loading: false,
        sk,
        error: String(e instanceof Error ? e.message : e).slice(0, 300),
      }),
    )
    .finally(notify);
}

export interface TicketRequest {
  sourceId: string;
  query: string;
}

/**
 * Ticket lists for several (source, query) pairs — one hook call per view,
 * results keyed `${sourceId}\0${query}` (see `ticketListKey`). Polls every
 * `TICKET_REFRESH_MS` while mounted.
 */
export function useTicketLists(
  requests: TicketRequest[],
  settings: PluginSettings,
): Map<string, TicketList> {
  useSyncExternalStore(subscribe, () => version);
  const signature = requests.map((r) => listKey(r.sourceId, r.query)).join('|');
  useEffect(() => {
    const tick = () => {
      for (const r of requests) refreshTickets(r.sourceId, r.query, settings);
    };
    tick();
    const timer = setInterval(tick, TICKET_REFRESH_MS);
    return () => clearInterval(timer);
    // `signature` covers `requests`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, settings]);
  const out = new Map<string, TicketList>();
  for (const r of requests) {
    const key = listKey(r.sourceId, r.query);
    out.set(key, lists.get(key) ?? EMPTY);
  }
  return out;
}

export function ticketListKey(sourceId: string, query: string): string {
  return listKey(sourceId, query);
}

/** Test hook. */
export function resetTicketSources(): void {
  sources.clear();
  lists.clear();
  notify();
}
