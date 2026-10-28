import { useCallback, useMemo } from 'react';
import { ShellApp } from '@axn-term/shell-ui';
import type { FileReader } from '@axn-term/session-backend';
import { browserServices, WsBackend } from '@axn-term/session-backend';
import { RemoteBackend, createMirrorStateStore } from '@axn-term/session-backend/remote';
import { KeycloakProvider, useKeycloak } from './KeycloakContext';
import { ConnectionGate } from './ConnectionGate';
import { browserPlatform } from './platform';

const wsUrlBase = import.meta.env.VITE_SHELL_WS_URL as string | undefined;
// "cloud" mode — drive terminals through the hosted session-host hub
// instead of per-PTY /ws sockets — e.g. wss://<gateway>/cloud (WS-only
// proxy) or http://<host>:7682/ramphastos (direct session host).
// VITE_RAMPHASTOS_URL kept as a deprecated alias.
// `||` not `??`: compose injects these as empty strings when unset, and ''
// must not win over a real fallback (or produce a falsy hub that silently
// lands on the local /ws backend).
const cloudUrl = ((import.meta.env.VITE_CLOUD_URL ||
  import.meta.env.VITE_RAMPHASTOS_URL) || undefined) as string | undefined;
// Client-authoritative mirror: attach to a desktop's mirrored session on the
// /remote hub. ?remote=<session-id> in the URL wins over the env so a mobile
// browser can pick a desktop without a rebuild.
const remoteHubUrl =
  new URLSearchParams(window.location.search).get('hub') ||
  (import.meta.env.VITE_REMOTE_URL as string | undefined) ||
  // Default: the mirror hub on the same gateway that serves /ws — /remote is
  // the authority/viewer endpoint, NOT /ramphastos (the hosted session host,
  // which would silently create a fresh container session).
  (wsUrlBase ? wsUrlBase.replace(/\/ws\/?$/, '/remote') : undefined);
const remoteSessionId =
  new URLSearchParams(window.location.search).get('remote') ||
  (import.meta.env.VITE_REMOTE_SESSION as string | undefined);

function AppContent() {
  const { authenticated, login, updateToken, username } = useKeycloak();

  // Mirror mode wins when a remote session id is present: attach to the
  // desktop-authoritative session on the /remote hub and render the
  // mirrored model instead of local browser sessions. Never fall back to
  // the cloud hub — that endpoint creates container PTYs, which is
  // exactly the wrong thing for a viewer.
  const hubUrl = remoteSessionId ? remoteHubUrl : cloudUrl;
  const backend = useMemo(
    () =>
      hubUrl
        ? new RemoteBackend({
            url: hubUrl,
            // ?remote=<id> attaches to a desktop's authority session; hosted
            // mode joins a fixed session so every device of this user shares
            // the host's model (per-user session host → no cross-user clash).
            sessionId: remoteSessionId ?? 'axn-shared',
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

  const platform = useMemo(() => {
    const p = browserPlatform(username);
    if (backend instanceof RemoteBackend) {
      // The session list is the authority's model (desktop via /remote, or
      // the session host's AxnHostVm in hosted mode), not browser state —
      // every attached device renders the same sessions.
      p.stateStore = createMirrorStateStore(() => backend.ramphastosSession(), {
        // Remote mode is attach-only: never synthesize/spawn sessions — the
        // desktop authority owns the model. Cloud mode keeps host-created
        // sessions, so the flag stays off there.
        attachOnly: Boolean(remoteSessionId),
      });
      // The remote console's viewer-side state — /viewportClaims + host
      // identity straight from the replicated model.
      p.remoteConsole = backend.remoteConsole;
    }
    return p;
  }, [username, backend]);

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
    const base =
      (import.meta.env.VITE_TASKS_WS_URL as string | undefined) ??
      wsUrlBase?.replace(/\/ws$/, '');
    if (!base) return null;
    const token = await updateToken(30);
    const url = `${base}/tasks`;
    return token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
  }, [updateToken]);

  if (authenticated === null) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--bg)] text-[var(--text-primary)]">
        Loading...
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-[var(--bg)] text-[var(--text-primary)]">
        <h1 className="text-xl font-semibold">Axn Term</h1>
        <button
          type="button"
          onClick={login}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Log in with Keycloak
        </button>
      </div>
    );
  }

  return (
    <ConnectionGate endpoints={[hubUrl ?? wsUrlBase]}>
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

export default function App() {
  return (
    <KeycloakProvider>
      <AppContent />
    </KeycloakProvider>
  );
}
