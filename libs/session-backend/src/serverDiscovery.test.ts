import { describe, expect, it } from 'vitest';
import {
  endpointUrls,
  fetchServerDiscovery,
  normalizeServerUrl,
  parseServerDiscovery,
  pickEndpoint,
  splitKeycloakIssuer,
  type DiscoveryEndpoint,
  type ServerDiscovery,
} from './serverDiscovery';

const lan: DiscoveryEndpoint = {
  label: 'lan',
  gateway: 'https://fedora.local:18094',
  issuer: 'https://fedora.local:18093/realms/axn-term',
};
const tailnet: DiscoveryEndpoint = {
  label: 'tailnet',
  gateway: 'https://fedora.tail1234.ts.net:8443',
  issuer: 'https://fedora.tail1234.ts.net/realms/axn-term',
};
const doc: ServerDiscovery = {
  service: 'axn-term',
  version: 1,
  id: 'srv-1',
  name: 'home',
  endpoints: [lan, tailnet],
  clients: { web: 'axn-term', mobile: 'axn-term-mobile' },
  features: { remote: true, cloud: false },
};

describe('normalizeServerUrl', () => {
  it('defaults to https and keeps only the origin', () => {
    expect(normalizeServerUrl(' fedora.local:18092 ')).toBe('https://fedora.local:18092');
    expect(normalizeServerUrl('http://10.0.0.2:8080/some/path?q=1')).toBe('http://10.0.0.2:8080');
    expect(normalizeServerUrl('https://term.example.com/')).toBe('https://term.example.com');
  });

  it('rejects empty and non-http addresses', () => {
    expect(() => normalizeServerUrl('  ')).toThrow();
    expect(() => normalizeServerUrl('ftp://host')).toThrow();
  });
});

describe('fetchServerDiscovery', () => {
  it('fetches the well-known path of the normalized origin', async () => {
    let asked = '';
    const got = await fetchServerDiscovery('fedora.local:18092/x', {
      fetchImpl: (async (url: string) => {
        asked = url;
        return new Response(JSON.stringify(doc), { status: 200 });
      }) as typeof fetch,
    });
    expect(asked).toBe('https://fedora.local:18092/.well-known/axn-term');
    expect(got).toEqual(doc);
  });

  it('rejects an html fallback page and http errors', async () => {
    const html = (async () => new Response('<!doctype html>', { status: 200 })) as typeof fetch;
    await expect(fetchServerDiscovery('h', { fetchImpl: html })).rejects.toThrow('not an axn-term server');
    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(fetchServerDiscovery('h', { fetchImpl: missing })).rejects.toThrow('HTTP 404');
  });
});

describe('parseServerDiscovery', () => {
  it('drops incomplete endpoints and fills defaults', () => {
    expect(
      parseServerDiscovery({
        service: 'axn-term',
        version: 1,
        endpoints: [{ gateway: 'https://g', issuer: 'https://i' }, { gateway: 'https://only' }],
      }),
    ).toEqual({
      service: 'axn-term',
      version: 1,
      id: 'https://g',
      name: 'axn-term',
      endpoints: [{ label: 'default', gateway: 'https://g', issuer: 'https://i' }],
      clients: {},
      features: { remote: true, cloud: true },
    });
    expect(parseServerDiscovery({ service: 'other', version: 1, endpoints: [] })).toBeNull();
  });
});

describe('pickEndpoint', () => {
  it('prefers the earlier endpoint when both answer', async () => {
    const picked = await pickEndpoint(doc, { probe: async () => true });
    expect(picked).toBe(lan);
  });

  it('falls through to the tailnet when the LAN name is unreachable', async () => {
    const picked = await pickEndpoint(doc, {
      probe: async (e) => {
        if (e === lan) throw new Error('ENOTFOUND');
        return true;
      },
    });
    expect(picked).toBe(tailnet);
  });

  it('gives up after the timeout', async () => {
    const hang = (_e: DiscoveryEndpoint, signal: AbortSignal) =>
      new Promise<boolean>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))));
    expect(await pickEndpoint(doc, { probe: hang, timeoutMs: 10 })).toBeNull();
  });
});

describe('endpointUrls / splitKeycloakIssuer', () => {
  it('derives hub urls from the gateway', () => {
    expect(endpointUrls({ ...lan, gateway: 'https://gw:1/' })).toEqual({
      http: 'https://gw:1',
      ws: 'wss://gw:1',
      remoteHub: 'wss://gw:1/remote',
      shellWs: 'wss://gw:1/ws',
      cloudHub: 'wss://gw:1/cloud',
    });
    expect(endpointUrls({ ...lan, gateway: 'http://gw' }).remoteHub).toBe('ws://gw/remote');
  });

  it('splits keycloak issuers', () => {
    expect(splitKeycloakIssuer('https://kc:8443/realms/axn-term/')).toEqual({
      url: 'https://kc:8443',
      realm: 'axn-term',
    });
    expect(splitKeycloakIssuer('https://accounts.example.com')).toBeNull();
  });
});

import { describeRemoteStatus } from './remoteScope';

describe('describeRemoteStatus', () => {
  const now = Date.parse('2026-11-12T20:00:00Z');
  const base = { account: { sub: 's', user: 'demo' }, sessions: [], attempts: [] };

  it('explains what to do when nothing ever connected', () => {
    const s = describeRemoteStatus(base, now);
    expect(s.kind).toBe('waiting');
    expect(s.title).toBe('No desktop is publishing for demo yet');
  });

  it('surfaces why the desktop was refused', () => {
    const s = describeRemoteStatus(
      {
        ...base,
        attempts: [{ at: '2026-11-12T19:58:00Z', role: 'Authority', accepted: false, reason: 'sign-in expired — sign in again' }],
      },
      now,
    );
    expect(s.kind).toBe('denied');
    expect(s.detail).toContain('2 min ago: sign-in expired — sign in again');
  });

  it('tells offline from never-seen, and online wins', () => {
    expect(describeRemoteStatus({ ...base, sessions: [{ id: 's/h', online: false }] }, now).kind).toBe('offline');
    expect(
      describeRemoteStatus(
        {
          ...base,
          sessions: [{ id: 's/h', online: true }],
          attempts: [{ at: '2026-11-12T19:00:00Z', role: 'Authority', accepted: false, reason: 'x' }],
        },
        now,
      ).kind,
    ).toBe('online');
  });
});
