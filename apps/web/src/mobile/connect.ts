import {
  fetchServerDiscovery,
  knownServerFrom,
  resolveKnownServer,
  targetAddresses,
  type ConnectTarget,
  type KnownServer,
} from '@axn-term/session-backend';

/**
 * Pair with a server from a typed address, a scanned code or a desktop
 * found on the Wi-Fi. A scanned/announced server id must match what the
 * address serves — otherwise the address now belongs to someone else.
 */
export async function pairWith(target: ConnectTarget): Promise<KnownServer> {
  // Try every address at once; the first that answers with this server's
  // document wins (a `.local` name or LAN IP fails fast off the LAN).
  const addresses = targetAddresses(target);
  const attempts = addresses.map(async (address) => {
    const doc = await fetchServerDiscovery(address);
    if (target.serverId && doc.id !== target.serverId) throw new Error('other server');
    return { address, doc };
  });
  const found = await Promise.any(attempts).catch(() => null);
  if (!found) {
    const firstError = await attempts[0].then(() => null, (e: unknown) => e);
    throw new Error(explainFetchError(addresses.join(', '), firstError));
  }
  const { address, doc } = found;
  if (!doc.features.remote) throw new Error('This server has remote access turned off.');
  const resolved = await resolveKnownServer(knownServerFrom(address, doc));
  if (!resolved.endpoint)
    throw new Error(`Found ${doc.name}, but none of its addresses answer from this network.`);
  return resolved.server;
}

/**
 * A WebView fetch failure carries no reason; on a LAN the usual one is a
 * self-signed certificate the phone doesn't trust yet.
 */
export function explainFetchError(server: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not an axn-term server|HTTP \d+/.test(msg)) return `${server} is not an axn-term server (${msg}).`;
  return (
    `Couldn't reach ${server}. Check that the phone is on the same network. ` +
    `If the server uses its own (self-signed) certificate, install that certificate on this phone ` +
    `under Settings → Security → Install certificate — or connect over Tailscale.`
  );
}
