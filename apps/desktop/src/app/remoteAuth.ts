import { invoke } from '@tauri-apps/api/core';
import { tauriServices } from '@axn-term/session-backend/tauri';

/**
 * OIDC device-flow sign-in for remote publishing (RFC 8628).
 *
 * Settings → Remote → Server URL + Client ID, then "Sign in…" starts a
 * device authorization: the hub's Keycloak hands back a user code and a
 * verification URL; the user authorizes in the system browser while the
 * app polls the token endpoint. On success the refresh token goes to the
 * OS keychain (`secure_set`/`secure_get`); access tokens live in memory
 * and are refreshed transparently by getAccessToken().
 *
 * The authority sends the access token with its hello — the gateway binds
 * the mirrored session to the JWT `sub`, so only same-account viewers can
 * attach (real multi-user isolation, unlike the anonymous dev mode).
 */

export type RemoteAuthState = {
  state: 'signedOut' | 'pending' | 'signedIn' | 'error';
  user?: string;
  error?: string;
  userCode?: string;
  verificationUri?: string;
};

type DeviceAuthResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

const REFRESH_KEY = 'remote-refresh-token';
const DEFAULT_CLIENT_ID = 'axn-term-desktop';

const secureGet = (key: string) => invoke<string | null>('secure_get', { key });
const secureSet = (key: string, value: string | null) =>
  invoke<void>('secure_set', { key, value });

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json) as Record<string, unknown>;
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenResponse> {
  // Routed through Rust (plugin_exec → curl): the Tauri webview blocks plain
  // http:// and wss:// to self-signed/unknown origins alike, which makes the
  // device-flow hop undiagnosable. curl sees the host network stack.
  const body = new URLSearchParams(params).toString();
  const cmd = [
    'curl', '-sS', '--max-time', '15', '-X', 'POST',
    "-H 'Content-Type: application/x-www-form-urlencoded'",
    '-d', `'${body.replace(/'/g, `'\\''`)}'`,
    `'${url.replace(/'/g, `'\\''`)}'`,
  ].join(' ');
  const out = await invoke<string>('plugin_exec', { command: cmd });
  return JSON.parse(out) as TokenResponse;
}

export type RemoteAuth = {
  get(): RemoteAuthState;
  subscribe(cb: () => void): () => void;
  signIn(opts?: { openBrowser?: boolean }): Promise<void>;
  signOut(): Promise<void>;
  /** Fresh access token for the authority hello; undefined when signed out. */
  getAccessToken(): Promise<string | undefined>;
};

export function createRemoteAuth(
  getConfig: () => Promise<{ issuer?: string; clientId?: string }>,
): RemoteAuth {
  let snapshot: RemoteAuthState = { state: 'signedOut' };
  const cbs = new Set<() => void>();
  const set = (s: RemoteAuthState) => {
    snapshot = s;
    cbs.forEach((cb) => cb());
  };

  let accessToken: string | undefined;
  let accessExp = 0;
  let pollAbort: AbortController | undefined;

  const clientId = (cfg: { clientId?: string }) => cfg.clientId?.trim() || DEFAULT_CLIENT_ID;

  const endpoints = async () => {
    const issuer = (await getConfig()).issuer?.trim().replace(/\/$/, '');
    if (!issuer) return undefined;
    return {
      device: `${issuer}/protocol/openid-connect/auth/device`,
      token: `${issuer}/protocol/openid-connect/token`,
    };
  };

  const adoptTokens = (tok: TokenResponse) => {
    if (!tok.access_token) throw new Error(tok.error_description ?? tok.error ?? 'no access_token');
    accessToken = tok.access_token;
    const exp = (decodeJwtPayload(accessToken).exp as number | undefined) ?? 0;
    accessExp = exp > 0 ? exp : Math.floor(Date.now() / 1000) + (tok.expires_in ?? 300);
    if (tok.refresh_token) void secureSet(REFRESH_KEY, tok.refresh_token).catch(() => {});
    const user =
      (decodeJwtPayload(accessToken).preferred_username as string | undefined) ??
      (decodeJwtPayload(accessToken).sub as string | undefined);
    set({ state: 'signedIn', user });
  };

  const refresh = async (): Promise<boolean> => {
    const ep = await endpoints();
    const refreshToken = await secureGet(REFRESH_KEY).catch(() => null);
    if (!ep || !refreshToken) return false;
    const tok = await postForm(ep.token, {
      grant_type: 'refresh_token',
      client_id: clientId(await getConfig()),
      refresh_token: refreshToken,
    });
    if (!tok.access_token) {
      // refresh token invalid/expired → drop it so we don't loop
      await secureSet(REFRESH_KEY, null).catch(() => {});
      set({ state: 'signedOut' });
      return false;
    }
    adoptTokens(tok);
    return true;
  };

  const api: RemoteAuth = {
    get: () => snapshot,
    subscribe: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },

    async signIn(opts?: { openBrowser?: boolean }) {
      const ep = await endpoints();
      if (!ep) {
        set({ state: 'error', error: 'Set the Server URL first' });
        return;
      }
      const client = clientId(await getConfig());
      try {
        const dev = (await postForm(ep.device, { client_id: client })) as unknown as DeviceAuthResponse;
        if (!dev.device_code) {
          const err = dev as unknown as TokenResponse;
          throw new Error(err.error_description ?? err.error ?? 'device flow not enabled');
        }
        pollAbort = new AbortController();
        const verificationUri = dev.verification_uri_complete ?? dev.verification_uri;
        set({ state: 'pending', userCode: dev.user_code, verificationUri });
        // Open the system browser straight to the code-entry page — skipped
        // for remote-control-triggered sign-ins (flow tests approve headlessly).
        if (opts?.openBrowser !== false) tauriServices.openExternal(verificationUri);
        // Poll until the user completes (or the code expires).
        const interval = Math.max(dev.interval ?? 5, 2) * 1000;
        const deadline = Date.now() + (dev.expires_in ?? 600) * 1000;
        while (Date.now() < deadline && !pollAbort.signal.aborted) {
          await new Promise((r) => setTimeout(r, interval));
          if (pollAbort.signal.aborted) return;
          const tok = await postForm(ep.token, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: client,
            device_code: dev.device_code,
          });
          if (tok.access_token) {
            adoptTokens(tok);
            return;
          }
          if (tok.error === 'slow_down') {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          if (tok.error !== 'authorization_pending') {
            throw new Error(tok.error_description ?? tok.error ?? 'device flow failed');
          }
        }
        if (!pollAbort.signal.aborted) set({ state: 'error', error: 'Sign-in expired — try again' });
      } catch (e) {
        set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    },

    async signOut() {
      pollAbort?.abort();
      accessToken = undefined;
      accessExp = 0;
      await secureSet(REFRESH_KEY, null).catch(() => {});
      set({ state: 'signedOut' });
    },

    async getAccessToken() {
      if (accessToken && accessExp - 30 > Math.floor(Date.now() / 1000)) return accessToken;
      if (await refresh()) return accessToken;
      return undefined;
    },
  };

  // Resume a previous session: keychain refresh token → fresh access token.
  // Deferred to a microtask — getConfig may dereference module state still
  // being initialized when this module is imported eagerly.
  queueMicrotask(() => {
    void (async () => {
      try {
        if (await refresh()) return;
      } catch {
        // offline or hub down — show error only when we actually had a token
        if (await secureGet(REFRESH_KEY).catch(() => null)) {
          set({ state: 'error', error: 'Token refresh failed — sign in again' });
        }
      }
    })();
  });

  return api;
}
