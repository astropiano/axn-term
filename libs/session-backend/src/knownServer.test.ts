import { describe, expect, it } from 'vitest';
import {
  buildConnectLink,
  knownServerFrom,
  parseAnnouncement,
  parseConnectInput,
  resolveKnownServer,
  serverAddresses,
  targetAddresses,
  type KnownServer,
} from './knownServer';
import type { DiscoveryEndpoint, ServerDiscovery } from './serverDiscovery';

const lan: DiscoveryEndpoint = { label: 'lan', gateway: 'https://fedora.local:18094', issuer: 'https://fedora.local:18093/realms/axn-term' };
const tailnet: DiscoveryEndpoint = { label: 'tailnet', gateway: 'https://fedora.ts.net:18094', issuer: 'https://fedora.ts.net:18093/realms/axn-term' };
const doc: ServerDiscovery = {
  service: 'axn-term',
  version: 1,
  id: 'srv-1',
  name: 'home',
  endpoints: [lan, tailnet],
  clients: { web: 'axn-term' },
  features: { remote: true, cloud: false },
};
const known: KnownServer = knownServerFrom('fedora.local:18092', doc);

/** fetch stub: `reachable` hosts answer /healthz and the discovery path. */
function network(reachable: string[], served: ServerDiscovery = doc): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (!reachable.includes(url.host)) throw new TypeError('network unreachable');
    if (url.pathname === '/healthz') return new Response('', { status: 200 });
    if (url.pathname === '/.well-known/axn-term') return new Response(JSON.stringify(served));
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

describe('resolveKnownServer', () => {
  it('uses the LAN endpoint at home', async () => {
    const r = await resolveKnownServer(known, { fetchImpl: network(['fedora.local:18092', 'fedora.local:18094']) });
    expect(r.endpoint).toEqual(lan);
    expect(r.refreshed).toBe(true);
    expect(r.server.lastGateway).toBe(lan.gateway);
  });

  it('finds the same server over the tailnet once away — same id, no re-pairing', async () => {
    const r = await resolveKnownServer(
      { ...known, lastGateway: lan.gateway },
      { fetchImpl: network(['fedora.ts.net:18094']) },
    );
    expect(r.endpoint).toEqual(tailnet);
    expect(r.server.id).toBe('srv-1');
    expect(r.server.lastGateway).toBe(tailnet.gateway);
  });

  it('prefers the last-used endpoint when both answer', async () => {
    const r = await resolveKnownServer(
      { ...known, lastGateway: tailnet.gateway },
      { fetchImpl: network(['fedora.local:18094', 'fedora.ts.net:18094']) },
    );
    expect(r.endpoint).toEqual(tailnet);
  });

  it('ignores an address that now serves a different server', async () => {
    const r = await resolveKnownServer(known, {
      fetchImpl: network(['fedora.local:18094'], { ...doc, id: 'other', endpoints: [] }),
    });
    expect(r.refreshed).toBe(false);
    // Cached endpoints still probe: the gateway answers /healthz.
    expect(r.endpoint).toEqual(lan);
  });

  it('picks up endpoints the server added since', async () => {
    const extra = { label: 'public', gateway: 'https://term.example.com', issuer: 'https://kc.example.com/realms/a' };
    const r = await resolveKnownServer(known, {
      fetchImpl: network(['fedora.local:18094'], { ...doc, endpoints: [lan, tailnet, extra] }),
    });
    expect(r.server.endpoints).toHaveLength(3);
  });

  it('reports no endpoint when offline', async () => {
    const r = await resolveKnownServer(known, { fetchImpl: network([]), timeoutMs: 50 });
    expect(r.endpoint).toBeNull();
    expect(r.server).toEqual(known);
  });
});

describe('connect links', () => {
  it('round-trips through the QR link format', () => {
    const link = buildConnectLink({ server: 'fedora.local:18092', serverId: 'srv-1', name: 'fedora' });
    expect(link).toBe('axnterm://connect?server=https%3A%2F%2Ffedora.local%3A18092&sid=srv-1&name=fedora');
    expect(parseConnectInput(link)).toEqual({ server: 'https://fedora.local:18092', serverId: 'srv-1', name: 'fedora' });
  });

  it('carries every address of the server, the one in use first', () => {
    const addrs = serverAddresses({ ...known, lastGateway: tailnet.gateway });
    expect(addrs).toEqual({ server: tailnet.gateway, alternates: [lan.gateway] });
    const link = buildConnectLink({ ...addrs, serverId: 'srv-1' });
    const parsed = parseConnectInput(link)!;
    expect(targetAddresses(parsed)).toEqual([tailnet.gateway, lan.gateway]);
  });

  it('accepts a plain typed address', () => {
    expect(parseConnectInput(' term.example.com ')).toEqual({ server: 'https://term.example.com' });
    expect(parseConnectInput('axnterm://connect')).toBeNull();
    expect(parseConnectInput('')).toBeNull();
  });
});

describe('parseAnnouncement', () => {
  it('reads the desktop TXT record', () => {
    expect(parseAnnouncement({ v: '1', server: 'https://fedora.local:18092', sid: 'srv-1', did: 'd1', name: 'fedora' })).toEqual({
      server: 'https://fedora.local:18092',
      serverId: 'srv-1',
      desktopId: 'd1',
      name: 'fedora',
    });
    expect(parseAnnouncement({ v: '2', server: 'https://x' })).toBeNull();
    expect(parseAnnouncement({ v: '1' })).toBeNull();
  });


  it('replaces .local hosts with the address NSD resolved (Android cannot resolve .local)', () => {
    const d = parseAnnouncement(
      { v: '1', server: 'https://fedora.local:18094', alt: 'https://fedora.ts.net:18094' },
      '192.168.1.41',
    )!;
    expect(targetAddresses(d)).toEqual([
      'https://fedora.local:18094',
      'https://fedora.ts.net:18094',
      'https://192.168.1.41:18094',
    ]);
  });
});

describe('timeouts with a fetch that ignores abort (native HTTP)', () => {
  it('still picks the reachable endpoint when another one hangs forever', async () => {
    const hanging = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.host === 'fedora.local:18094') return new Promise<Response>(() => {});
      if (url.pathname === '/healthz') return new Response('', { status: 200 });
      return new Response(JSON.stringify(doc));
    }) as typeof fetch;
    const r = await resolveKnownServer(known, { fetchImpl: hanging, timeoutMs: 50, discoveryTimeoutMs: 50 });
    expect(r.endpoint).toEqual(tailnet);
  });
});
