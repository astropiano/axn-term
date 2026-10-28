import { RemoteAuthority, type PublishedPty } from '@axn-term/session-backend/remote';
import { tauriBackend } from '@axn-term/session-backend/tauri';
import { ptyIdOf, serializeTerminal, terminalSize, type ShellSession } from '@axn-term/shell-ui';
import { desktopPlatform } from './platform';

const authorityUrl = import.meta.env.VITE_REMOTE_AUTHORITY_URL as string | undefined;
const authoritySession = import.meta.env.VITE_REMOTE_SESSION as string | undefined;
// A user JWT (dev convenience) — the gateway binds the mirrored session to
// its `sub`; viewers authenticating as the same account can attach. The
// real flow is a Keycloak login in settings ("link remote server") storing
// a refresh token — env var stays for development/CI.
const authorityToken = import.meta.env.VITE_REMOTE_TOKEN as string | undefined;

export type AuthorityStatus = { state: 'idle' | 'connecting' | 'connected' | 'failed'; error?: string };

/** Module-level publish-status store — surfaces connect failures the console hides. */
export const authorityStatus = {
  _state: 'idle' as AuthorityStatus['state'],
  _error: undefined as string | undefined,
  // useSyncExternalStore requires a STABLE snapshot — a fresh object per
  // get() makes React re-render forever, so set() rebuilds _snapshot.
  _snapshot: { state: 'idle', error: undefined } as AuthorityStatus,
  _cbs: new Set<() => void>(),
  get(): AuthorityStatus {
    return this._snapshot;
  },
  set(state: AuthorityStatus['state'], error?: string) {
    this._state = state;
    this._error = error;
    this._snapshot = { state, error };
    this._cbs.forEach((cb) => cb());
  },
  subscribe(cb: () => void): () => void {
    this._cbs.add(cb);
    return () => this._cbs.delete(cb);
  },
};
const authorityWsOnly = import.meta.env.VITE_REMOTE_WS_ONLY === 'true';

/**
 * Opt-in remote authority: when VITE_REMOTE_AUTHORITY_URL is set the app
 * connects outbound to a client-authoritative Ramphastos hub (e.g. the
 * gateway's /remote endpoint) and publishes this window's terminals —
 * remote viewers/controllers attach to the mirrored session and drive the
 * desktop's real PTYs through tunneled pty:<id> streams.
 */
export function createRemoteAuthority(opts?: {
  url?: string;
  session?: string;
  token?: string;
  getToken?: () => Promise<string | undefined> | string | undefined;
  webSocketOnly?: boolean;
}): RemoteAuthority | undefined {
  const url = (opts?.url ?? authorityUrl)?.trim();
  if (!url) return undefined;
  const authority = new RemoteAuthority({
    url,
    sessionId: opts?.session ?? authoritySession,
    getToken: opts?.getToken ?? (() => opts?.token ?? authorityToken),
    // Raw WS only — the gateway proxies WS directly (no negotiate POST),
    // and a fetch hop would fail in the webview for plain ws:// LAN hubs.
    webSocketOnly: opts?.webSocketOnly ?? authorityWsOnly,
    backend: tauriBackend,
    // Viewers replay scrollback on attach — pull it from the live xterm
    // buffer (the PTY itself has no retained history).
    getScrollback: (ptyId) => serializeTerminal(ptyId),
      getPtySize: (ptyId) => terminalSize(ptyId),
    meta: { kind: 'desktop', window: desktopPlatform.window?.id ?? 'main' },
  });
  authorityStatus.set('connecting');
  authority
    .start()
    .then(() => authorityStatus.set('connected'))
    .catch((e: unknown) => {
      console.error('remote authority connect failed', e);
      authorityStatus.set('failed', e instanceof Error ? e.message : String(e));
    });
  // Keep the status honest across reconnects — a dropped transport now
  // triggers a full reconnect with a fresh token; surface that as
  // 'connecting' instead of leaving a stale 'connected' up.
  authority.onStateChange?.((state) => {
    if (state === 'ready') authorityStatus.set('connected');
    else if (state === 'closed' || state === 'reconnecting') authorityStatus.set('connecting');
    else if (state.startsWith('reconnect-failed:')) {
      authorityStatus.set('failed', state.slice('reconnect-failed:'.length));
    }
  });

  // Publish the already-restored session list immediately — the first save
  // may lag (state saves only on change).
  void desktopPlatform.stateStore
    .load(desktopPlatform.window?.id ?? 'main')
    .then(
      (state) =>
        state && authority.reflectPtys(ptysFromWindowState(state), workspacesFromWindowState(state)),
    )
    .catch(() => {});
  return authority;
}

/**
 * stateStore decorator: every persisted WindowState is mirrored into the
 * authority's replica (structural changes save eagerly, so the replica
 * tracks adds/closes/renames in near-real-time).
 */
export function withAuthorityReflect(
  authority: RemoteAuthority,
  platform: typeof desktopPlatform,
): typeof desktopPlatform {
  const inner = platform.stateStore;
  return {
    ...platform,
    remoteAuthorityStatus: authorityStatus,
    remoteConsole: authority.remoteConsole,
    stateStore: {
      ...inner,
      save: async (windowId, state) => {
        try {
          authority.reflectPtys(ptysFromWindowState(state), workspacesFromWindowState(state));
        } catch {
          // model reflection must never block a save
        }
        return inner.save(windowId, state);
      },
    },
  };
}

/** WindowState → the published workspace list (id + display name). */
function workspacesFromWindowState(state: unknown): { id: string; name?: string }[] {
  return (state as { workspaces?: { id: string; name?: string }[] })?.workspaces ?? [];
}

/** WindowState → the published terminal list (main PTYs + sub-shell tabs). */
function ptysFromWindowState(state: unknown): PublishedPty[] {
  const sessions = (state as { sessions?: ShellSession[] })?.sessions ?? [];
  const out: PublishedPty[] = [];
  for (const s of sessions) {
    out.push({
      id: ptyIdOf(s),
      name: s.customName ?? s.name,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
      sessionId: s.id,
      kind: 'session',
      appStatus: s.status,
      process: s.process,
    });
    for (const tab of s.editors ?? []) {
      if (tab.kind !== 'shell') continue;
      out.push({
        id: tab.id,
        name: tab.label ?? tab.command ?? 'shell',
        command: tab.resumeCommand ?? tab.command,
        cwd: tab.cwd ?? s.cwd,
        workspaceId: s.workspaceId,
        sessionId: s.id,
        kind: 'subshell',
      });
    }
  }
  return out;
}
