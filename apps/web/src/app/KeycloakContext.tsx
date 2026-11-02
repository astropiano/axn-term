import Keycloak from 'keycloak-js';
import { ConnectionGate } from './ConnectionGate';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface KeycloakContextValue {
  authenticated: boolean | null;
  token: string | null;
  /** Keycloak preferred_username — used for the remote home dir (`/home/<u>`). */
  username: string | null;
  login: () => void;
  /** Ends the IdP session and redirects back here — the remote viewer
   *  panel's sign-out. */
  logout?: () => void;
  updateToken: (minValidity?: number) => Promise<string | undefined>;
}

const KeycloakContext = createContext<KeycloakContextValue>({
  authenticated: null,
  token: null,
  username: null,
  login: () => {},
  updateToken: () => Promise.resolve(undefined),
});

const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL as string | undefined;
const keycloakRealm = import.meta.env.VITE_KEYCLOAK_REALM as string | undefined;
const keycloakClientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID as string | undefined;

const keycloak =
  keycloakUrl && keycloakRealm && keycloakClientId
    ? new Keycloak({
        url: keycloakUrl,
        realm: keycloakRealm,
        clientId: keycloakClientId,
      })
    : null;

let keycloakInitPromise: Promise<boolean> | null = null;

export function KeycloakProvider({ children }: { children: ReactNode }) {
  const anonymous = new URLSearchParams(window.location.search).has('anonymous');
  return (
    <ConnectionGate endpoints={[anonymous ? null : keycloakUrl]}>
      <KeycloakProviderInner>{children}</KeycloakProviderInner>
    </ConnectionGate>
  );
}

function KeycloakProviderInner({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    // ?anonymous=1 skips the IdP — remote-control attaches against a
    // hub/gateway with AllowAnonymous must not bounce through keycloak
    // (its cert/origin may not be trusted on the device → white screen).
    const skip =
      !keycloak ||
      new URLSearchParams(window.location.search).has('anonymous');
    if (skip) {
      setAuthenticated(true);
      return;
    }

    keycloakInitPromise ??= keycloak.init({
      onLoad: 'check-sso',
      // The login-status iframe hangs forever on mobile Safari (third-party
      // cookie blocking → init promise never resolves → eternal "Loading…").
      // We only need explicit login + updateToken, not SSO session watching.
      checkLoginIframe: false,
    });

    keycloakInitPromise
      .then((auth) => {
        setAuthenticated(auth);
        setToken(auth ? keycloak.token ?? null : null);
        setUsername(auth ? (keycloak.tokenParsed?.preferred_username as string) ?? null : null);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Keycloak init failed', err);
        setAuthenticated(false);
      });

    // Backstop: if init never settles (hung iframe/network), show the
    // login button instead of "Loading…" forever.
    const timeout = setTimeout(
      () => setAuthenticated((a) => (a === null ? false : a)),
      10000,
    );
    return () => clearTimeout(timeout);
  }, []);

  const login = useCallback(() => {
    keycloak?.login();
  }, []);

  const updateToken = useCallback(async (minValidity = 30) => {
    if (!keycloak) return undefined;
    try {
      await keycloak.updateToken(minValidity);
    } catch {
      // Refresh token dead (revoked/expired SSO session) — flip back to
      // the login screen instead of retrying 401s forever.
      setToken(null);
      setAuthenticated(false);
      return undefined;
    }
    const refreshed = keycloak.token ?? undefined;
    setToken(refreshed ?? null);
    return refreshed;
  }, []);

  const logout = keycloak
    // Keep the query string — `?remote` selects mirror mode and must
    // survive the sign-out → sign-in round trip.
    ? () => keycloak.logout({ redirectUri: window.location.href })
    : undefined;

  return (
    <KeycloakContext.Provider value={{ authenticated, token, username, login, logout, updateToken }}>
      {children}
    </KeycloakContext.Provider>
  );
}

export function useKeycloak() {
  return useContext(KeycloakContext);
}
