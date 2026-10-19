import Keycloak from 'keycloak-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface KeycloakContextValue {
  authenticated: boolean | null;
  token: string | null;
  /** Keycloak preferred_username — used for the remote home dir (`/home/<u>`). */
  username: string | null;
  login: () => void;
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
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    if (!keycloak) {
      // No IdP configured — dev mode: run authenticated without a token so
      // LAN/dev testing works (server side must allow anonymous hellos).
      setAuthenticated(true);
      return;
    }

    keycloakInitPromise ??= keycloak.init({ onLoad: 'check-sso' });

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
  }, []);

  const login = useCallback(() => {
    keycloak?.login();
  }, []);

  const updateToken = useCallback(async (minValidity = 30) => {
    if (!keycloak) return undefined;
    await keycloak.updateToken(minValidity);
    const refreshed = keycloak.token ?? undefined;
    setToken(refreshed ?? null);
    return refreshed;
  }, []);

  return (
    <KeycloakContext.Provider value={{ authenticated, token, username, login, updateToken }}>
      {children}
    </KeycloakContext.Provider>
  );
}

export function useKeycloak() {
  return useContext(KeycloakContext);
}
