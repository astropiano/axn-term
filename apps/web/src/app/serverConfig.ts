import {
  endpointUrls,
  type DiscoveryEndpoint,
  type KnownServer,
  fetchServerDiscovery,
  pickEndpoint,
  splitKeycloakIssuer,
  type ServerDiscovery,
} from '@axn-term/session-backend';

/**
 * Everything the web shell needs to reach its server. Resolved once at
 * startup (main.tsx awaits it before importing the app) from the server's
 * `/.well-known/axn-term` document — so one build serves any deployment —
 * with the VITE_* build env as the fallback for setups without it.
 */
export interface WebServerConfig {
  source: 'discovery' | 'env';
  keycloak?: { url: string; realm: string; clientId: string };
  /** Hosted per-PTY socket (`…/ws`). */
  shellWsUrl?: string;
  /** Desktop-mirror hub (`…/remote`). */
  remoteHubUrl?: string;
  /** Hosted multiplexed hub — opt-in transport, env only. */
  cloudUrl?: string;
  /** ws(s) gateway base for `/tasks`. */
  tasksWsBase?: string;
  /** No hosted sessions — mirrored desktops only. */
  remoteOnly: boolean;
  /** Back to the server picker (mobile app); absent in the browser. */
  changeServer?: () => void;
  /** Display name of the server in use. */
  serverName?: string;
}

// `||` not `??`: compose injects unset vars as '' and '' must not win.
const env = (key: string) => (import.meta.env[key] as string | undefined) || undefined;
const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? '');

function fromEnv(): WebServerConfig {
  const url = env('VITE_KEYCLOAK_URL');
  const realm = env('VITE_KEYCLOAK_REALM');
  const clientId = env('VITE_KEYCLOAK_CLIENT_ID');
  const shellWsUrl = env('VITE_SHELL_WS_URL');
  return {
    source: 'env',
    keycloak: url && realm && clientId ? { url, realm, clientId } : undefined,
    shellWsUrl,
    // Default: the mirror hub on the same gateway that serves /ws — NOT
    // /ramphastos, which would silently create a container session.
    remoteHubUrl: env('VITE_REMOTE_URL') ?? shellWsUrl?.replace(/\/ws\/?$/, '/remote'),
    cloudUrl: env('VITE_CLOUD_URL') ?? env('VITE_RAMPHASTOS_URL'),
    tasksWsBase: env('VITE_TASKS_WS_URL') ?? shellWsUrl?.replace(/\/ws\/?$/, ''),
    remoteOnly: truthy(env('VITE_REMOTE_ONLY')),
  };
}

export async function fromDiscovery(doc: ServerDiscovery): Promise<WebServerConfig | null> {
  const endpoint = await pickEndpoint(doc);
  return endpoint ? forEndpoint(doc, endpoint) : null;
}

/** Config for one already-chosen endpoint of a server. */
export function forEndpoint(
  doc: Pick<ServerDiscovery, 'clients' | 'features' | 'name'> | KnownServer,
  endpoint: DiscoveryEndpoint,
): WebServerConfig {
  const urls = endpointUrls(endpoint);
  const kc = splitKeycloakIssuer(endpoint.issuer);
  const clientId = doc.clients.web;
  return {
    source: 'discovery',
    keycloak: kc && clientId ? { ...kc, clientId } : undefined,
    shellWsUrl: doc.features.cloud ? urls.shellWs : undefined,
    remoteHubUrl: doc.features.remote ? urls.remoteHub : undefined,
    cloudUrl: doc.features.cloud ? (env('VITE_CLOUD_URL') ?? env('VITE_RAMPHASTOS_URL')) : undefined,
    // /tasks lives on the session host — a remote-only gateway does not map it.
    tasksWsBase: doc.features.cloud ? urls.ws : undefined,
    remoteOnly: !doc.features.cloud || truthy(env('VITE_REMOTE_ONLY')),
    serverName: doc.name,
  };
}

let current: WebServerConfig | null = null;

/**
 * `?server=<origin>` points this shell at another server; otherwise the
 * page's own origin is asked (the proxy routes the well-known path to the
 * gateway). No document → the build env, exactly as before.
 */
export async function loadServerConfig(): Promise<WebServerConfig> {
  const server = new URLSearchParams(window.location.search).get('server') || window.location.origin;
  try {
    current = (await fromDiscovery(await fetchServerDiscovery(server))) ?? fromEnv();
  } catch {
    current = fromEnv();
  }
  return current;
}

/** Set by hosts that pick the server themselves (the mobile app). */
export function setServerConfig(config: WebServerConfig): void {
  current = config;
}

export function serverConfig(): WebServerConfig {
  return (current ??= fromEnv());
}
