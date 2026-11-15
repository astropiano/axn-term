import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DeviceAuthError,
  pollDeviceToken,
  refreshTokens,
  revokeSession,
  startDeviceAuth,
  tokenClaim,
  type TokenSet,
} from '@axn-term/session-backend';
import { KeycloakContext, type KeycloakContextValue } from '../app/KeycloakContext';
import { serverConfig } from '../app/serverConfig';
import { clearSession, loadSession, saveSession } from './session';

/**
 * Device-code sign-in for the mobile app (same flow as the desktop). No
 * redirect inside the web view: the app shows a code, the system browser
 * approves it, the app polls the token endpoint of the endpoint in use.
 * Refreshes go to whichever endpoint answers now; only Keycloak saying the
 * session ended signs out — a network blip never does.
 */
export function DeviceAuthProvider({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const kc = serverConfig().keycloak;
  const issuer = kc ? `${kc.url.replace(/\/+$/, '')}/realms/${kc.realm}` : '';
  const clientId = kc?.clientId ?? '';

  const [tokens, setTokens] = useState<TokenSet | null>(() => (kc ? loadSession(serverId, clientId) : null));
  const tokensRef = useRef(tokens);
  const [pending, setPending] = useState<KeycloakContextValue['pending']>();
  const [authError, setAuthError] = useState<string | null>(
    kc ? null : 'This server does not offer a sign-in for apps.',
  );
  const abort = useRef<AbortController | null>(null);
  const refreshing = useRef<Promise<string | undefined> | null>(null);

  const store = useCallback(
    (next: TokenSet | null, error: string | null = null) => {
      tokensRef.current = next;
      setTokens(next);
      if (next) saveSession(serverId, clientId, next);
      else clearSession();
      setAuthError(error);
    },
    [serverId, clientId],
  );

  const updateToken = useCallback(
    async (minValidity = 30): Promise<string | undefined> => {
      const t = tokensRef.current;
      if (!t) return undefined;
      if (t.accessExpiresAt - Date.now() > minValidity * 1000) return t.accessToken;
      if (!t.refreshToken) {
        store(null, 'Your sign-in expired — sign in again.');
        return undefined;
      }
      refreshing.current ??= refreshTokens(issuer, clientId, t.refreshToken)
        .then((next) => {
          store(next);
          return next.accessToken;
        })
        .catch((e: unknown) => {
          if (e instanceof DeviceAuthError && e.sessionEnded) {
            store(null, 'Your sign-in ended on the server — sign in again.');
          }
          // Unreachable right now: keep the session; callers retry later.
          return undefined;
        })
        .finally(() => {
          refreshing.current = null;
        });
      return refreshing.current;
    },
    [issuer, clientId, store],
  );

  // Validate a stored session once at start (refreshes if expired).
  useEffect(() => {
    if (tokensRef.current) void updateToken(60);
  }, [updateToken]);

  const openBrowser = useCallback(async (url: string) => {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url }).catch(() => {
      window.open(url, '_blank');
    });
  }, []);

  const login = useCallback(() => {
    if (!kc) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAuthError(null);
    void (async () => {
      try {
        // Offline token first (survives days of idle); a server that does
        // not allow it for this account gets one more round as a regular
        // session instead of a dead end.
        let next: TokenSet | undefined;
        for (const scope of ['openid offline_access', 'openid']) {
          const start = await startDeviceAuth(issuer, clientId, { scope });
          const url = start.verificationUriComplete ?? start.verificationUri;
          setPending({ userCode: start.userCode, verificationUri: start.verificationUri, open: () => void openBrowser(url) });
          void openBrowser(url);
          try {
            next = await pollDeviceToken(issuer, clientId, start, { signal: controller.signal });
            break;
          } catch (e) {
            if (!(e instanceof DeviceAuthError && e.code === 'not_allowed') || scope === 'openid') throw e;
            setAuthError('This server does not allow staying signed in — approve once more for a regular session.');
          }
        }
        if (!next) throw new DeviceAuthError('sign-in failed');
        store(next);
        void import('@capacitor/browser').then(({ Browser }) => Browser.close()).catch(() => {});
      } catch (e) {
        if (!(e instanceof DeviceAuthError && e.code === 'cancelled')) {
          setAuthError(
            e instanceof Error ? `Sign-in failed: ${e.message}` : 'Sign-in failed.',
          );
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        setPending(undefined);
      }
    })();
  }, [kc, issuer, clientId, store, openBrowser]);

  const cancelLogin = useCallback(() => abort.current?.abort(), []);

  const logout = useCallback(() => {
    const refresh = tokensRef.current?.refreshToken;
    if (refresh) void revokeSession(issuer, clientId, refresh);
    store(null);
  }, [issuer, clientId, store]);

  const value = useMemo<KeycloakContextValue>(
    () => ({
      authenticated: tokens !== null,
      token: tokens?.accessToken ?? null,
      username: tokenClaim(tokens?.accessToken, 'preferred_username') ?? null,
      login,
      logout,
      updateToken,
      pending,
      cancelLogin,
      authError,
      loginLabel: 'Sign in',
    }),
    [tokens, login, logout, updateToken, pending, cancelLogin, authError],
  );

  return <KeycloakContext.Provider value={value}>{children}</KeycloakContext.Provider>;
}
