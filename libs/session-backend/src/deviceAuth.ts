/**
 * OAuth 2.0 device authorization (RFC 8628) against a Keycloak realm —
 * the sign-in for apps that must not depend on a web-view redirect: the
 * app shows a short code, the user approves in any browser, the app polls
 * the token endpoint. Every call goes to the issuer of the endpoint in use
 * right now, so a refresh works on whichever network answers (Keycloak's
 * backchannel endpoints serve any host; the issuer claim stays fixed).
 */

export interface DeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Verification URL with the code filled in — open this one. */
  verificationUriComplete?: string;
  /** Seconds between polls (server-chosen). */
  interval: number;
  expiresAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshExpiresAt?: number;
  idToken?: string;
}

// Plain fields, no parameter properties (strip-types loadable).
export class DeviceAuthError extends Error {
  /** OAuth error code (`invalid_grant`, `access_denied`, …). */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
  /** The stored sign-in is gone for good — sign in again. */
  get sessionEnded(): boolean {
    return this.code === 'invalid_grant' || this.code === 'invalid_token';
  }
}

const endpoint = (issuer: string, path: string) =>
  `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/${path}`;

async function postForm(
  url: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new DeviceAuthError(`cannot reach the sign-in server (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.error === 'string') {
    const code = typeof body.error === 'string' ? body.error : undefined;
    const description = typeof body.error_description === 'string' ? body.error_description : undefined;
    throw new DeviceAuthError(description ?? code ?? `HTTP ${res.status}`, code);
  }
  return body;
}

function tokenSet(body: Record<string, unknown>, now: number): TokenSet {
  if (typeof body.access_token !== 'string') throw new DeviceAuthError('no access token in response');
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    accessExpiresAt: now + Number(body.expires_in ?? 300) * 1000,
    refreshExpiresAt:
      typeof body.refresh_expires_in === 'number' && body.refresh_expires_in > 0
        ? now + body.refresh_expires_in * 1000
        : undefined,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
  };
}

export async function startDeviceAuth(
  issuer: string,
  clientId: string,
  { fetchImpl = fetch, now = Date.now(), scope = 'openid offline_access' } = {},
): Promise<DeviceAuthStart> {
  const body = await postForm(endpoint(issuer, 'auth/device'), { client_id: clientId, scope }, fetchImpl);
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete:
      typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
    interval: Math.max(1, Number(body.interval ?? 5)),
    expiresAt: now + Number(body.expires_in ?? 600) * 1000,
  };
}

/**
 * Poll until the user approves (resolves), denies, or the code expires
 * (rejects). `signal` cancels. Honors `slow_down`.
 */
export async function pollDeviceToken(
  issuer: string,
  clientId: string,
  start: DeviceAuthStart,
  {
    fetchImpl = fetch,
    signal,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  }: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TokenSet> {
  let interval = start.interval * 1000;
  while (now() < start.expiresAt) {
    await sleep(interval);
    if (signal?.aborted) throw new DeviceAuthError('sign-in cancelled', 'cancelled');
    try {
      const body = await postForm(
        endpoint(issuer, 'token'),
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: start.deviceCode,
          client_id: clientId,
        },
        fetchImpl,
      );
      return tokenSet(body, now());
    } catch (e) {
      if (!(e instanceof DeviceAuthError)) throw e;
      if (e.code === 'authorization_pending') continue;
      if (e.code === 'slow_down') {
        interval += 5000;
        continue;
      }
      // A network blip while waiting is not a failure — keep polling.
      if (e.code === undefined && e.message.startsWith('cannot reach')) continue;
      if (e.code === 'access_denied') throw new DeviceAuthError('sign-in was declined', e.code);
      if (e.code === 'expired_token') break;
      throw e;
    }
  }
  throw new DeviceAuthError('the sign-in code expired — start again', 'expired_token');
}

export async function refreshTokens(
  issuer: string,
  clientId: string,
  refreshToken: string,
  { fetchImpl = fetch, now = Date.now() } = {},
): Promise<TokenSet> {
  const body = await postForm(
    endpoint(issuer, 'token'),
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    fetchImpl,
  );
  const next = tokenSet(body, now);
  // Keycloak may omit a rotated refresh token — keep the old one then.
  return { ...next, refreshToken: next.refreshToken ?? refreshToken };
}

/** Best-effort server-side sign-out (ends the offline session). */
export async function revokeSession(
  issuer: string,
  clientId: string,
  refreshToken: string,
  { fetchImpl = fetch } = {},
): Promise<void> {
  await postForm(endpoint(issuer, 'logout'), { client_id: clientId, refresh_token: refreshToken }, fetchImpl).catch(
    () => undefined,
  );
}

/** A claim from a JWT payload, unverified (display only). */
export function tokenClaim(token: string | undefined, claim: string): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >;
    const v = payload[claim];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}
