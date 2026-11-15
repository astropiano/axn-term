import { invoke } from '@tauri-apps/api/core';
import {
  buildConnectLink,
  endpointUrls,
  fetchServerDiscovery,
  knownServerFrom,
  parseConnectInput,
  resolveKnownServer,
  serverAddresses,
  type DiscoveryEndpoint,
  type KnownServer,
} from '@axn-term/session-backend';
import type { AppSettings } from '@axn-term/shell-ui';

/**
 * Desktop side of "connect by server address": the user enters one URL
 * (or nothing changes for existing hub/issuer configs); discovery fills in
 * hub, issuer and client id, re-checks them when the network changes
 * (LAN ↔ tailnet), and the desktop announces itself on the local network
 * so a phone on the same Wi-Fi finds it.
 */

/**
 * fetch over the `remote_fetch` Tauri command (reqwest + native-tls): the
 * webview refuses self-signed/unknown CAs without a diagnosable error,
 * while the command goes through the platform TLS — login keychain on
 * macOS, Schannel on Windows, the system store on Linux. (Previously
 * curl via plugin_exec: a login-shell PATH picks whichever curl comes
 * first — MacPorts/Homebrew OpenSSL ignores the OS trust store — and
 * Windows has no curl.)
 */
export const remoteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const extra = new Headers(init?.headers);
  extra.set('Accept', 'application/json');
  let res: { status: number; body: string };
  try {
    res = await invoke<{ status: number; body: string }>('remote_fetch', {
      url,
      headers: [...extra.entries()],
      // Abort signals can't reach the call; a hard cap keeps probes short.
      timeoutMs: 4_000,
    });
  } catch (e) {
    throw new TypeError(String(e));
  }
  if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (!res.status) throw new TypeError('unreachable');
  return new Response(res.body, { status: res.status });
}) as typeof fetch;

/** Settings that follow from a server + the endpoint in use. */
export function settingsFor(server: KnownServer, endpoint: DiscoveryEndpoint): Partial<AppSettings> {
  return {
    remoteServer: server,
    remoteAuthorityUrl: endpointUrls(endpoint).remoteHub,
    remoteAuthIssuer: endpoint.issuer,
    // The desktop signs in with the device flow — its own client when the
    // server names one, else the built-in default.
    remoteAuthClientId: server.clients.desktop ?? undefined,
  };
}

/** Connect to a typed/pasted address: fetch discovery, pick an endpoint. */
export async function connectServer(input: string): Promise<Partial<AppSettings>> {
  const target = parseConnectInput(input);
  if (!target) throw new Error('Enter a server address, e.g. https://term.example.com');
  const doc = await fetchServerDiscovery(target.server, { fetchImpl: remoteFetch });
  if (!doc.features.remote) throw new Error('This server has remote access turned off');
  const resolved = await resolveKnownServer(knownServerFrom(target.server, doc), { fetchImpl: remoteFetch });
  if (!resolved.endpoint) throw new Error('Server found, but none of its addresses answer from here');
  return { ...settingsFor(resolved.server, resolved.endpoint), remoteEnabled: true };
}

/**
 * Re-resolve a known server (startup, network change). Returns the
 * settings patch when something changed — new endpoint, new endpoint list
 * — or null to leave settings alone (also when nothing answers: the
 * authority's own retry keeps going against the last endpoint).
 */
export async function refreshServer(
  current: Pick<AppSettings, 'remoteServer' | 'remoteAuthorityUrl' | 'remoteAuthIssuer'>,
): Promise<Partial<AppSettings> | null> {
  const known = current.remoteServer;
  if (!known) return null;
  const resolved = await resolveKnownServer(known, { fetchImpl: remoteFetch });
  if (!resolved.endpoint) return null;
  const next = settingsFor(resolved.server, resolved.endpoint);
  const changed =
    next.remoteAuthorityUrl !== current.remoteAuthorityUrl ||
    next.remoteAuthIssuer !== current.remoteAuthIssuer ||
    JSON.stringify(resolved.server) !== JSON.stringify(known);
  return changed ? next : null;
}

/** The QR/pairing link a phone scans; null until a server is connected. */
export function pairingLink(server: KnownServer | undefined): string | null {
  if (!server) return null;
  // Every endpoint's gateway (each serves discovery directly), the one in
  // use first — the phone keeps whichever it can reach (.local names don't
  // resolve on Android or over a tailnet).
  return buildConnectLink({ ...serverAddresses(server), serverId: server.id, name: server.name });
}

/** Announce (or stop announcing) this desktop on the local network. */
export function announce(server: KnownServer | undefined, desktopId: string, enabled: boolean): void {
  const announcement =
    enabled && server
      ? { ...serverAddresses(server), serverId: server.id, desktopId }
      : null;
  void invoke('remote_announce', { announcement }).catch((e) =>
    console.warn('[remote] local-network announcement failed', e),
  );
}

/** The gateway's view of this account (sessions + denied hellos), via remote_fetch. */
export async function serverStatus(hubUrl: string, getToken: () => Promise<string | undefined>) {
  const { fetchRemoteStatus } = await import('@axn-term/session-backend/remote');
  return fetchRemoteStatus(hubUrl, await getToken(), remoteFetch);
}
