import {
  DISCOVERY_PATH,
  normalizeServerUrl,
  parseServerDiscovery,
  pickEndpoint,
  type DiscoveryEndpoint,
  type PickEndpointOptions,
  type ServerDiscovery,
} from './serverDiscovery';

/**
 * A server a client has connected to before, remembered by its discovery
 * id — not by the address it was first reached on. The endpoint list is
 * cached so a client that leaves the network it learned the server on
 * (LAN → tailnet) can still find it: any endpoint's gateway serves the
 * discovery document, and the cached list alone is enough to pick one.
 */
export interface KnownServer {
  id: string;
  name: string;
  /** Address the user entered/scanned/discovered first. */
  url: string;
  endpoints: DiscoveryEndpoint[];
  clients: ServerDiscovery['clients'];
  features: ServerDiscovery['features'];
  /** Gateway of the endpoint used last — probed first next time. */
  lastGateway?: string;
}

export function knownServerFrom(url: string, doc: ServerDiscovery, previous?: KnownServer): KnownServer {
  return {
    id: doc.id,
    name: doc.name,
    url: previous?.url ?? normalizeServerUrl(url),
    endpoints: doc.endpoints,
    clients: doc.clients,
    features: doc.features,
    lastGateway: previous?.lastGateway,
  };
}

export interface ResolveOptions extends PickEndpointOptions {
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs?: number;
}

export interface ResolvedServer {
  server: KnownServer;
  /** Null when no endpoint answered — offline, or on a network that reaches none. */
  endpoint: DiscoveryEndpoint | null;
  /** Discovery document came from the network this time (else: cached). */
  refreshed: boolean;
}

/**
 * Refresh a known server's document from whichever of its addresses
 * answers (first success wins; a document with a different id is ignored
 * — that address now belongs to another server), then pick a reachable
 * endpoint. Works offline from the cache: a stale list still connects.
 */
export async function resolveKnownServer(
  server: KnownServer,
  { fetchImpl = fetch, discoveryTimeoutMs = 4_000, ...pick }: ResolveOptions = {},
): Promise<ResolvedServer> {
  const sources = unique([
    server.lastGateway,
    ...server.endpoints.map((e) => e.gateway),
    server.url,
  ]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
  let doc: ServerDiscovery | null = null;
  try {
    // Bounded by the timer even when the fetch ignores the abort signal.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), discoveryTimeoutMs),
    );
    doc = await firstOf(
      sources.map(async (source) => {
        const res = await fetchImpl(`${source}${DISCOVERY_PATH}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const parsed = res.ok ? parseServerDiscovery(await res.json().catch(() => null)) : null;
        if (!parsed || parsed.id !== server.id) throw new Error('no match');
        return parsed;
      }).map((p) => Promise.race([p, deadline])),
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  const current = doc ? knownServerFrom(server.url, doc, server) : server;
  // The last-used endpoint first: on the same network it answers fastest
  // and keeps the client where it was.
  const ordered = [...current.endpoints].sort(
    (a, b) => Number(b.gateway === current.lastGateway) - Number(a.gateway === current.lastGateway),
  );
  const endpoint = await pickEndpoint({ ...asDiscovery(current), endpoints: ordered }, { fetchImpl, ...pick });
  return {
    server: endpoint ? { ...current, lastGateway: endpoint.gateway } : current,
    endpoint,
    refreshed: doc !== null,
  };
}

function asDiscovery(s: KnownServer): ServerDiscovery {
  return {
    service: 'axn-term',
    version: 1,
    id: s.id,
    name: s.name,
    endpoints: s.endpoints,
    clients: s.clients,
    features: s.features,
  };
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v).map((v) => v.replace(/\/+$/, '')))];
}

/** First promise to resolve; null when all reject. */
function firstOf<T>(promises: Promise<T>[]): Promise<T | null> {
  if (!promises.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = promises.length;
    for (const p of promises) {
      p.then(resolve, () => {
        if (--pending === 0) resolve(null);
      });
    }
  });
}

/* ── Pairing links ─────────────────────────────────────────────────────
 * `axnterm://connect?server=<url>&sid=<server id>&name=<label>` — what the
 * desktop's "Connect a phone" QR code carries and what local-network
 * announcements describe. It holds no secret: anyone who reads it learns
 * the server address and nothing else; signing in is still required.
 */

export const CONNECT_SCHEME = 'axnterm:';

export interface ConnectTarget {
  server: string;
  /**
   * More addresses of the same server (its other endpoints). A phone may
   * reach only some of them — `.local` names don't resolve on Android or
   * over a tailnet — so a pairing tries all of them.
   */
  alternates?: string[];
  /** Expected server id — a mismatch means the address points elsewhere. */
  serverId?: string;
  /** Human label (desktop or server name). */
  name?: string;
}

export function buildConnectLink(target: ConnectTarget): string {
  const q = new URLSearchParams({ server: normalizeServerUrl(target.server) });
  for (const alt of target.alternates ?? []) {
    const url = normalizeServerUrl(alt);
    if (url !== q.get('server') && !q.getAll('alt').includes(url)) q.append('alt', url);
  }
  if (target.serverId) q.set('sid', target.serverId);
  if (target.name) q.set('name', target.name);
  return `axnterm://connect?${q.toString()}`;
}

/** Accepts a connect link or a plain server address (typed or scanned). */
export function parseConnectInput(input: string): ConnectTarget | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    if (raw.toLowerCase().startsWith(CONNECT_SCHEME)) {
      const url = new URL(raw);
      const server = url.searchParams.get('server');
      if (!server) return null;
      const alternates = url.searchParams
        .getAll('alt')
        .flatMap((a) => {
          try {
            return [normalizeServerUrl(a)];
          } catch {
            return [];
          }
        });
      return {
        server: normalizeServerUrl(server),
        ...(alternates.length ? { alternates } : {}),
        serverId: url.searchParams.get('sid') || undefined,
        name: url.searchParams.get('name') || undefined,
      };
    }
    return { server: normalizeServerUrl(raw) };
  } catch {
    return null;
  }
}

/* ── Local-network announcements ───────────────────────────────────────
 * Desktops announce `_axn-term._tcp` over mDNS while remote is enabled.
 * TXT keys: v=1, server=<url>, alt=<space-separated other addresses>,
 * sid=<server id>, did=<desktop id>, name=<desktop name>. An announcement only *finds* a desktop — anyone on
 * the LAN can send one — trust still comes from TLS + sign-in.
 */

export const MDNS_SERVICE_TYPE = '_axn-term._tcp';

export interface AnnouncedDesktop extends ConnectTarget {
  desktopId?: string;
}

export function parseAnnouncement(
  txt: Record<string, string | undefined>,
  /** Address the announcement came from — stands in for `.local` hosts. */
  resolvedHost?: string,
): AnnouncedDesktop | null {
  if (txt.v !== '1' || !txt.server) return null;
  try {
    const server = normalizeServerUrl(txt.server);
    const alternates = (txt.alt ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((a) => {
        try {
          return [normalizeServerUrl(a)];
        } catch {
          return [];
        }
      });
    // Android can't resolve the desktop's own `.local` name, but NSD hands
    // us the address the announcement came from.
    for (const url of [server, ...alternates]) {
      const u = new URL(url);
      if (resolvedHost && u.hostname.endsWith('.local')) {
        u.hostname = resolvedHost.includes(':') ? `[${resolvedHost}]` : resolvedHost;
        if (!alternates.includes(u.origin)) alternates.push(u.origin);
      }
    }
    return {
      server,
      ...(alternates.length ? { alternates } : {}),
      serverId: txt.sid || undefined,
      desktopId: txt.did || undefined,
      name: txt.name || undefined,
    };
  } catch {
    return null;
  }
}

/** Every address of a target, primary first. */
export function targetAddresses(target: ConnectTarget): string[] {
  return [...new Set([target.server, ...(target.alternates ?? [])])];
}

/**
 * Addresses to hand a phone for this server: the one in use first, then
 * the rest — the phone keeps whichever it can reach.
 */
export function serverAddresses(server: KnownServer): { server: string; alternates: string[] } {
  const all = [...new Set([server.lastGateway, ...server.endpoints.map((e) => e.gateway)].filter(
    (v): v is string => !!v,
  ))];
  return { server: all[0] ?? server.url, alternates: all.slice(1) };
}
