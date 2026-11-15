/**
 * Client side of the gateway's `/.well-known/axn-term` document. Clients
 * are configured with nothing but a server address (typed, scanned, or
 * found on the local network); gateway, issuer and client ids come from
 * here. A server can list several endpoints — e.g. its LAN name and its
 * tailnet name — and the client uses the first one that answers.
 */

export const DISCOVERY_PATH = '/.well-known/axn-term';

export interface DiscoveryEndpoint {
  /** Free-form network name: `lan`, `tailnet`, `public`, … */
  label: string;
  /** Gateway base URL (http/https); hubs live at `/remote`, `/ws`, `/cloud`. */
  gateway: string;
  /** OIDC issuer, e.g. `https://host/realms/axn-term`. */
  issuer: string;
  /** Browser URL of the web shell on this network, when it has one. */
  web?: string | null;
}

export interface ServerDiscovery {
  service: 'axn-term';
  version: number;
  /**
   * Stable server identity — identical on every endpoint. Clients key what
   * they remember (endpoints, sign-in, desktops) by it, so LAN and tailnet
   * are one server, not two.
   */
  id: string;
  name: string;
  endpoints: DiscoveryEndpoint[];
  clients: { web?: string | null; desktop?: string | null; mobile?: string | null };
  features: { remote: boolean; cloud: boolean };
}

/** `fedora.local:18092` → `https://fedora.local:18092`; drops path/query. */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('empty server address');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`unsupported scheme ${url.protocol}`);
  return url.origin;
}

export interface FetchDiscoveryOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch and validate a server's discovery document. Rejects anything that
 * isn't one — a dev server answering every path with index.html must not
 * be mistaken for a configured gateway.
 */
export async function fetchServerDiscovery(
  serverUrl: string,
  { signal, fetchImpl = fetch }: FetchDiscoveryOptions = {},
): Promise<ServerDiscovery> {
  const res = await fetchImpl(`${normalizeServerUrl(serverUrl)}${DISCOVERY_PATH}`, {
    signal: signal ?? AbortSignal.timeout(5_000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = parseServerDiscovery(await res.json().catch(() => null));
  if (!doc) throw new Error('not an axn-term server');
  return doc;
}

export function parseServerDiscovery(value: unknown): ServerDiscovery | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ServerDiscovery>;
  if (v.service !== 'axn-term' || typeof v.version !== 'number' || !Array.isArray(v.endpoints))
    return null;
  const endpoints = v.endpoints.filter(
    (e): e is DiscoveryEndpoint =>
      !!e && typeof e.gateway === 'string' && typeof e.issuer === 'string' && !!e.gateway && !!e.issuer,
  );
  return {
    service: 'axn-term',
    version: v.version,
    // Pre-id servers: fall back to the first gateway so a client still has
    // one key per server (loses LAN/tailnet merging, nothing else).
    id: typeof v.id === 'string' && v.id ? v.id : (endpoints[0]?.gateway ?? ''),
    name: typeof v.name === 'string' && v.name ? v.name : 'axn-term',
    endpoints: endpoints.map((e) => ({ ...e, label: e.label || 'default' })),
    clients: v.clients ?? {},
    features: { remote: v.features?.remote ?? true, cloud: v.features?.cloud ?? true },
  };
}

export interface PickEndpointOptions {
  timeoutMs?: number;
  /** Override reachability check (tests, native transports). */
  probe?: (endpoint: DiscoveryEndpoint, signal: AbortSignal) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

/**
 * The first endpoint, in the server's order, whose gateway answers
 * `/healthz`. Probes run in parallel, so an unreachable LAN name costs at
 * most one timeout before the tailnet name wins.
 */
export async function pickEndpoint(
  doc: ServerDiscovery,
  { timeoutMs = 3_000, probe, fetchImpl = fetch }: PickEndpointOptions = {},
): Promise<DiscoveryEndpoint | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const check =
    probe ??
    (async (e: DiscoveryEndpoint, signal: AbortSignal) =>
      (await fetchImpl(`${e.gateway.replace(/\/+$/, '')}/healthz`, { signal })).ok);
  // Raced against the timer too: native HTTP layers (Capacitor) ignore
  // abort signals, and one dead address must not stall the choice.
  const deadline = new Promise<false>((r) => setTimeout(() => r(false), timeoutMs));
  const results = doc.endpoints.map((e) =>
    Promise.race([check(e, controller.signal).catch(() => false), deadline]),
  );
  try {
    for (let i = 0; i < results.length; i++) {
      if (await results[i]) return doc.endpoints[i];
    }
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface EndpointUrls {
  /** https gateway base — REST (`/remote/sessions` lives under the hub). */
  http: string;
  /** ws(s) gateway base — `/tasks` etc. */
  ws: string;
  /** Desktop-mirror hub (authority + viewers). */
  remoteHub: string;
  /** Hosted per-PTY socket. */
  shellWs: string;
  /** Hosted multiplexed hub. */
  cloudHub: string;
}

export function endpointUrls(endpoint: DiscoveryEndpoint): EndpointUrls {
  const http = endpoint.gateway.replace(/\/+$/, '');
  const ws = http.replace(/^http/, 'ws');
  return { http, ws, remoteHub: `${ws}/remote`, shellWs: `${ws}/ws`, cloudHub: `${ws}/cloud` };
}

/** Keycloak issuer `https://kc/realms/axn` → `{ url: 'https://kc', realm: 'axn' }`. */
export function splitKeycloakIssuer(issuer: string): { url: string; realm: string } | null {
  const m = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer.trim());
  return m ? { url: m[1], realm: decodeURIComponent(m[2]) } : null;
}
