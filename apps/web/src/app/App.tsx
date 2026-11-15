import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ShellApp } from '@axn-term/shell-ui';
import type { FileReader } from '@axn-term/session-backend';
import { browserServices, WsBackend } from '@axn-term/session-backend';
import { RemoteBackend, createMirrorStateStore, listRemoteSessions } from '@axn-term/session-backend/remote';
import { KeycloakProvider, useKeycloak } from './KeycloakContext';
import { ConnectionGate } from './ConnectionGate';
import { RemoteWaiting } from './RemoteWaiting';
import { LoginScreen } from './LoginScreen';
import { browserPlatform } from './platform';
import { serverConfig } from './serverConfig';

// Server addresses come from the server's discovery document (or the
// VITE_* build env as fallback) — see serverConfig.ts.
const config = serverConfig();
const wsUrlBase = config.shellWsUrl;
// "cloud" mode — drive terminals through the hosted session-host hub
// instead of per-PTY /ws sockets — e.g. wss://<gateway>/cloud (WS-only
// proxy) or http://<host>:7682/ramphastos (direct session host).
const cloudUrl = config.cloudUrl;
// Client-authoritative mirror: attach to a desktop's mirrored session on the
// /remote hub. ?hub= in the URL wins so a mobile browser can pick a hub
// without a rebuild.
const remoteHubUrl = new URLSearchParams(window.location.search).get('hub') || config.remoteHubUrl;
const remoteParam = new URLSearchParams(window.location.search).get('remote');
const remoteSessionId =
  remoteParam || (import.meta.env.VITE_REMOTE_SESSION as string | undefined);
// `?remote` with no value still selects mirror mode — the name was never
// load-bearing, only the account's session list is. Discovery attaches the
// single owned session; several → the remote panel's picker chooses.
// Remote-only deployments (VITE_REMOTE_ONLY): the cloud/hosted session
// path does not exist for this build — the account's mirrored desktops
// are the only sessions. Backend retries keep rediscovering, so a
// desktop appearing later attaches on its own.
const remoteOnly = config.remoteOnly;
const mirrorModeParam = remoteParam !== null || remoteSessionId !== undefined;

function AppContent() {
  const { authenticated, login, logout, updateToken, username, pending, cancelLogin, authError, loginLabel } =
    useKeycloak();

  // Mode is account state, not a URL: when the signed-in account owns a
  // mirrored desktop session (gateway /remote/sessions), this device is a
  // remote viewer — otherwise it rides the cloud hub. `?remote` remains
  // the explicit deep-link for tests and pinning.
  const [mirrorDiscovered, setMirrorDiscovered] = useState(false);
  useEffect(() => {
    if (!authenticated || mirrorModeParam || mirrorDiscovered || !remoteHubUrl)
      return;
    let alive = true;
    void updateToken(30)
      .then((t) => listRemoteSessions(remoteHubUrl, t))
      .then((s) => {
        if (alive && s.length) setMirrorDiscovered(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [authenticated, mirrorDiscovered, updateToken]);
  const mirrorMode = remoteOnly || mirrorModeParam || mirrorDiscovered;

  // Mirror mode wins when a remote session id is present: attach to the
  // desktop-authoritative session on the /remote hub and render the
  // mirrored model instead of local browser sessions. Never fall back to
  // the cloud hub — that endpoint creates container PTYs, which is
  // exactly the wrong thing for a viewer.
  const hubUrl = mirrorMode ? remoteHubUrl : cloudUrl;
  const backend = useMemo(
    () =>
      hubUrl
        ? new RemoteBackend({
            url: hubUrl,
            // ?remote=<id> pins a desktop's authority session; `?remote`
            // bare leaves it undefined → discovery resolves the account's
            // session. Hosted mode joins a fixed session so every device of
            // this user shares the host's model (per-user session host →
            // no cross-user clash).
            sessionId: mirrorMode ? remoteSessionId || undefined : 'axn-shared',
            getToken: () => updateToken(30),
            // The gateway proxies raw WS only — no negotiate POST.
            webSocketOnly: true,
          })
        : new WsBackend({
            url: wsUrlBase ?? '',
            getToken: () => updateToken(30),
          }),
    [hubUrl, updateToken],
  );
  // A replaced RemoteBackend (discovery switched the hub) must drop its hub
  // connection and heartbeat. disconnect() leaves it lazily reusable, so the
  // StrictMode re-mount still works.
  useEffect(
    () => () => {
      if (backend instanceof RemoteBackend) void backend.disconnect().catch(() => {});
    },
    [backend],
  );

  const platform = useMemo(() => {
    const p = browserPlatform(username, logout);
    if (backend instanceof RemoteBackend) {
      // The session list is the authority's model (desktop via /remote, or
      // the session host's AxnHostVm in hosted mode), not browser state —
      // every attached device renders the same sessions.
      p.stateStore = createMirrorStateStore(() => backend.ramphastosSession(), {
        // Remote mode is attach-only: never synthesize/spawn sessions — the
        // desktop authority owns the model. Cloud mode keeps host-created
        // sessions, so the flag stays off there.
        attachOnly: mirrorMode,
      });
      // The remote console's viewer-side state — /viewportClaims + host
      // identity straight from the replicated model.
      p.remoteConsole = backend.remoteConsole;
      // Shared-state writes ride the same generic plane as pluginData —
      // the authority applies them into its own config.
      p.publishSharedState = (key, data) => {
        void backend
          .ramphastosSession()
          .then((sess) => sess.invoke('/vm/setPluginState', [key, data]))
          .catch(() => {});
      };
    }
    return p;
  }, [username, logout, backend]);

  // Web fileReader routes through the owning session's WS connection.
  const fileReader = useCallback(
    (sessionId?: string): FileReader | undefined => {
      if (!sessionId || !backend.readFile || !backend.writeFile) return undefined;
      return {
        readText: async (path) => {
          const res = await backend.readFile!(sessionId, path);
          if (!res.ok) throw new Error(res.error ?? `cannot read ${res.resolved ?? path}`);
          return res.contents ?? '';
        },
        writeText: async (path, contents) => {
          const res = await backend.writeFile!(sessionId, path, contents);
          if (!res.ok) throw new Error(res.error ?? 'write failed');
        },
        readBytes: backend.readBytes
          ? (path) => backend.readBytes!(sessionId, path)
          : undefined,
      };
    },
    [backend],
  );

  // The /tasks stream needs a bearer token too (gateway authenticates it).
  const tasksWsUrl = useCallback(async () => {
    const base = config.tasksWsBase;
    if (!base) return null;
    const token = await updateToken(30);
    const url = `${base}/tasks`;
    return token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
  }, [updateToken]);

  const tokenForStatus = useCallback(() => updateToken(30), [updateToken]);
  // A desktop just came online: attach now instead of after the backoff.
  const retryAttach = useCallback(() => {
    if (backend instanceof RemoteBackend) backend.remoteConsole?.retryNow?.();
  }, [backend]);

  if (authenticated === null) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--bg)] text-[var(--text-primary)]">
        Loading...
      </div>
    );
  }

  if (!authenticated) {
    return (
      <LoginScreen
        onLogin={login}
        loginLabel={loginLabel}
        pending={pending}
        onCancel={cancelLogin}
        authError={authError}
        serverName={config.serverName}
        onChangeServer={config.changeServer}
      />
    );
  }

  return (
    <ConnectionGate endpoints={[hubUrl ?? wsUrlBase]}>
      {mirrorMode && hubUrl ? (
        <RemoteWaiting
          hubUrl={hubUrl}
          getToken={tokenForStatus}
          onDesktopOnline={retryAttach}
          onSignOut={logout}
        />
      ) : null}
      <ShellApp
        backend={backend}
        services={browserServices}
        platform={platform}
        fileReader={fileReader}
        tasksWsUrl={tasksWsUrl}
      />
    </ConnectionGate>
  );
}

/** `AuthProvider` swaps the sign-in (the mobile app passes its device-code
 *  provider); the browser uses Keycloak's redirect login. */
export default function App({
  AuthProvider = KeycloakProvider,
}: {
  AuthProvider?: (props: { children: ReactNode }) => ReactNode;
}) {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
