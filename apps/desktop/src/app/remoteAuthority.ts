import { RemoteAuthority, type PublishedPty } from '@axn-term/session-backend/remote';
import { tauriBackend } from '@axn-term/session-backend/tauri';
import { ptyIdOf, type ShellSession } from '@axn-term/shell-ui';
import { desktopPlatform } from './platform';

const authorityUrl = import.meta.env.VITE_REMOTE_AUTHORITY_URL as string | undefined;
const authoritySession = import.meta.env.VITE_REMOTE_SESSION as string | undefined;
// A user JWT (dev convenience) — the gateway binds the mirrored session to
// its `sub`; viewers authenticating as the same account can attach. The
// real flow is a Keycloak login in settings ("link remote server") storing
// a refresh token — env var stays for development/CI.
const authorityToken = import.meta.env.VITE_REMOTE_TOKEN as string | undefined;
const authorityWsOnly = import.meta.env.VITE_REMOTE_WS_ONLY === 'true';

/**
 * Opt-in remote authority: when VITE_REMOTE_AUTHORITY_URL is set the app
 * connects outbound to a client-authoritative Ramphastos hub (e.g. the
 * gateway's /remote endpoint) and publishes this window's terminals —
 * remote viewers/controllers attach to the mirrored session and drive the
 * desktop's real PTYs through tunneled pty:<id> streams.
 */
export function createRemoteAuthority(): RemoteAuthority | undefined {
  if (!authorityUrl) return undefined;
  const authority = new RemoteAuthority({
    url: authorityUrl,
    sessionId: authoritySession,
    getToken: () => authorityToken,
    webSocketOnly: authorityWsOnly,
    backend: tauriBackend,
    meta: { kind: 'desktop', window: desktopPlatform.window?.id ?? 'main' },
  });
  authority.start().catch((e: unknown) => console.error('remote authority connect failed', e));

  // Publish the already-restored session list immediately — the first save
  // may lag (state saves only on change).
  void desktopPlatform.stateStore
    .load(desktopPlatform.window?.id ?? 'main')
    .then((state) => state && authority.reflectPtys(ptysFromWindowState(state)))
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
    stateStore: {
      ...inner,
      save: async (windowId, state) => {
        try {
          authority.reflectPtys(ptysFromWindowState(state));
        } catch {
          // model reflection must never block a save
        }
        return inner.save(windowId, state);
      },
    },
  };
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
