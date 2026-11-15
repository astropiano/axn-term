import { describe, expect, it } from 'vitest';
import { DeviceAuthError, pollDeviceToken, refreshTokens, startDeviceAuth, tokenClaim } from './deviceAuth';

const issuer = 'https://host:18092/auth/realms/axn-term';

/** Scripted token endpoint: each call shifts the next response. */
function server(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
    const next = responses.shift();
    if (!next) throw new TypeError('network down');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async () => {};

describe('device authorization', () => {
  it('starts at the issuer of the endpoint in use', async () => {
    const s = server([
      {
        status: 200,
        body: {
          device_code: 'dc',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://host:18092/auth/realms/axn-term/device',
          verification_uri_complete: 'https://host:18092/auth/realms/axn-term/device?user_code=ABCD-EFGH',
          interval: 5,
          expires_in: 600,
        },
      },
    ]);
    const start = await startDeviceAuth(issuer, 'axn-term-mobile', { fetchImpl: s.fetchImpl, now: 0 });
    expect(s.calls[0].url).toBe(`${issuer}/protocol/openid-connect/auth/device`);
    expect(s.calls[0].body.get('client_id')).toBe('axn-term-mobile');
    expect(s.calls[0].body.get('scope')).toContain('offline_access');
    expect(start).toMatchObject({ userCode: 'ABCD-EFGH', interval: 5, expiresAt: 600_000 });
  });

  it('polls through pending, slow_down and network blips until approved', async () => {
    const s = server([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
    ]);
    // third call: network down (no scripted response) → keeps polling
    const responses = s.calls;
    let t = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (responses.length === 2) {
        responses.push({ url, body: new URLSearchParams() });
        throw new TypeError('offline');
      }
      if (responses.length === 3) {
        responses.push({ url, body: new URLSearchParams(String(init?.body)) });
        return new Response(
          JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', expires_in: 300 }),
          { status: 200 },
        );
      }
      return s.fetchImpl(url, init);
    }) as typeof fetch;
    const tokens = await pollDeviceToken(
      issuer,
      'axn-term-mobile',
      { deviceCode: 'dc', userCode: 'X', verificationUri: 'u', interval: 1, expiresAt: Number.MAX_SAFE_INTEGER },
      { fetchImpl, sleep: noSleep, now: () => t++ },
    );
    expect(tokens.accessToken).toBe('a.b.c');
    expect(tokens.refreshToken).toBe('r');
    expect(responses[3].body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('reports a declined sign-in and an expired code', async () => {
    const denied = server([{ status: 400, body: { error: 'access_denied' } }]);
    await expect(
      pollDeviceToken(issuer, 'c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', interval: 1, expiresAt: Number.MAX_SAFE_INTEGER }, {
        fetchImpl: denied.fetchImpl,
        sleep: noSleep,
      }),
    ).rejects.toThrow('sign-in was declined');
    await expect(
      pollDeviceToken(issuer, 'c', { deviceCode: 'd', userCode: 'u', verificationUri: 'v', interval: 1, expiresAt: 0 }, {
        sleep: noSleep,
      }),
    ).rejects.toThrow('expired');
  });

  it('refreshes, keeping the old refresh token when none is rotated in', async () => {
    const s = server([{ status: 200, body: { access_token: 'new', expires_in: 60 } }]);
    const t = await refreshTokens(issuer, 'c', 'old-refresh', { fetchImpl: s.fetchImpl, now: 1000 });
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'old-refresh', accessExpiresAt: 61_000 });
    expect(s.calls[0].body.get('grant_type')).toBe('refresh_token');
  });

  it('marks an ended session distinctly from a network error', async () => {
    const s = server([{ status: 400, body: { error: 'invalid_grant', error_description: 'Session not active' } }]);
    const err = await refreshTokens(issuer, 'c', 'r', { fetchImpl: s.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).sessionEnded).toBe(true);
    const offline = await refreshTokens(issuer, 'c', 'r', { fetchImpl: server([]).fetchImpl }).catch((e: unknown) => e);
    expect((offline as DeviceAuthError).sessionEnded).toBe(false);
  });

  it('reads display claims', () => {
    const payload = btoa(JSON.stringify({ preferred_username: 'demo' })).replace(/=+$/, '');
    expect(tokenClaim(`h.${payload}.s`, 'preferred_username')).toBe('demo');
    expect(tokenClaim('garbage', 'x')).toBeUndefined();
  });
});
