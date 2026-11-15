import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { SettingsProvider } from '@axn-term/shell-ui';
import { resolveKnownServer, type DiscoveryEndpoint, type KnownServer } from '@axn-term/session-backend';
import { forEndpoint, setServerConfig } from '../app/serverConfig';
import { revokeSession } from '@axn-term/session-backend';
import { clearSession, storedRefreshToken } from './session';
import { DeviceAuthProvider } from './DeviceAuthProvider';
import { ConnectScreen, UnreachableScreen } from './ConnectScreen';
import { forgetServer, loadServer, saveServer } from './native';
import '../styles.css';

/**
 * Mobile app entry. The app is paired with one server (by its discovery
 * id, not an address). On every start — and whenever the network changes —
 * it picks whichever of the server's endpoints answers, LAN or tailnet,
 * and runs the regular web viewer against it. Sign-in and viewer identity
 * live in the app's one private storage, so switching networks is the
 * same device and the same session, just another route.
 */

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

function changeServer() {
  // End the session on the server too (best effort), then unpair.
  const config = currentIssuer;
  const stored = storedRefreshToken();
  if (config && stored?.refreshToken) void revokeSession(config, stored.clientId, stored.refreshToken);
  clearSession();
  forgetServer();
  window.location.replace(window.location.pathname);
}

let currentIssuer: string | undefined;

async function startViewer(server: KnownServer, endpoint: DiscoveryEndpoint) {
  const config = forEndpoint(server, endpoint);
  // Prefer a dedicated mobile client when the server names one.
  if (config.keycloak && server.clients.mobile) config.keycloak.clientId = server.clients.mobile;
  setServerConfig({ ...config, changeServer });
  currentIssuer = config.keycloak ? `${config.keycloak.url}/realms/${config.keycloak.realm}` : undefined;
  watchNetwork(endpoint.gateway);
  const { default: App } = await import('../app/App');
  // Device-code sign-in, keyed to this server's id (not an address).
  const Auth = ({ children }: { children: ReactNode }) => (
    <DeviceAuthProvider serverId={server.id}>{children}</DeviceAuthProvider>
  );
  root.render(
    <StrictMode>
      <SettingsProvider>
        <App AuthProvider={Auth} />
      </SettingsProvider>
    </StrictMode>,
  );
}

/**
 * Network changes (Wi-Fi ↔ mobile data, Tailscale on/off) show up as
 * 'online' events, the app coming back to the foreground, or simply the
 * endpoint in use going dark. Re-resolve then; when another endpoint is
 * the one that answers now, reload onto it — the stored session and
 * viewer id carry over, so the desktop sees the same phone return.
 */
function watchNetwork(currentGateway: string) {
  let checking = false;
  const check = async () => {
    const server = loadServer();
    if (!server || checking) return;
    checking = true;
    try {
      const r = await resolveKnownServer(server);
      if (r.endpoint) saveServer(r.server);
      if (r.endpoint && r.endpoint.gateway !== currentGateway) window.location.reload();
    } finally {
      checking = false;
    }
  };
  window.addEventListener('online', () => void check());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.setInterval(() => void check(), 20_000);
}

function Boot() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'connect' }
    | { kind: 'unreachable'; server: KnownServer; retrying: boolean }
  >(() => (loadServer() ? { kind: 'loading' } : { kind: 'connect' }));

  const resolve = (server: KnownServer) => {
    setState((s) => (s.kind === 'unreachable' ? { ...s, retrying: true } : s));
    void resolveKnownServer(server).then((r) => {
      saveServer(r.server);
      if (r.endpoint) void startViewer(r.server, r.endpoint);
      else setState({ kind: 'unreachable', server: r.server, retrying: false });
    });
  };

  useEffect(() => {
    const server = loadServer();
    if (server) resolve(server);
  }, []);

  // Unreachable: keep trying when the network changes.
  useEffect(() => {
    if (state.kind !== 'unreachable') return;
    const retry = () => resolve(state.server);
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [state.kind]);

  if (state.kind === 'connect')
    return (
      <ConnectScreen
        onPaired={(server) => {
          saveServer(server);
          resolve(server);
        }}
      />
    );
  if (state.kind === 'unreachable')
    return (
      <UnreachableScreen
        server={state.server}
        retrying={state.retrying}
        onRetry={() => resolve(state.server)}
        onChangeServer={changeServer}
      />
    );
  return (
    <div className="flex h-screen w-full items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-secondary)]">
      Connecting…
    </div>
  );
}

root.render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
