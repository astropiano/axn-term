import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { shellPlatform } from '../../platform';
import { useShellPlatform } from '../../services';
import { useSettings } from '../../SettingsProvider';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronsLeftRightEllipsis } from 'lucide-react';
import type { RemoteConsoleSnapshot } from '@axn-term/session-backend';
import type { SessionViewPlugin } from './plugin';

/**
 * Remote console: rail entry + full view over the shared viewport claims.
 * Shows who is connected to the remote session, which sessions each client
 * views, and which device pins the smallest width (the effective PTY size).
 * On the desktop the state comes from the RemoteAuthority (role
 * 'authority' — this machine is the host); on web/phone from the mirrored
 * replica (role 'viewer'). Pinned to the top of the rail.
 */

const IDLE_SNAPSHOT: RemoteConsoleSnapshot = {
  role: 'authority', state: 'idle', ptys: [], claims: {},
};

/** Connected clients — the /viewers roster when present (clients that
 *  announced themselves), falling back to ids seen holding a claim. */
function viewerIds(snap: RemoteConsoleSnapshot): string[] {
  const roster = Object.keys(snap.viewers ?? {});
  if (roster.length) return roster;
  const ids = new Set<string>();
  for (const m of Object.values(snap.claims)) for (const id of Object.keys(m)) ids.add(id);
  return [...ids];
}

function viewerLabel(id: string, snap: RemoteConsoleSnapshot, t: (literals: TemplateStringsArray, ...p: unknown[]) => string): string {
  if (id === snap.selfViewerId) return t`This device`;
  return snap.viewers?.[id]?.name ?? `device ${id.slice(0, 8)}`;
}

function stateLabel(snap: RemoteConsoleSnapshot): string {
  if (snap.role === 'authority') {
    if (snap.state === 'ready' || snap.state === 'connected') return 'Publishing';
    if (snap.state === 'connecting' || snap.state === 'reconnecting') return 'Connecting…';
    if (snap.state === 'failed') return 'Failed';
    return 'Idle';
  }
  if (snap.state === 'ready' || snap.state === 'connected') return 'Connected';
  if (snap.state === 'connecting' || snap.state === 'reconnecting') return 'Connecting…';
  if (snap.state === 'closed') return 'Disconnected';
  return snap.state;
}

/**
 * Full-window "connection lost" overlay for remote viewers. Fades in when
 * the hub transport has been down for a moment (avoids flashing on blips),
 * shows classified failure + retry. Portalled to <body> — the rail's zoom
 * would otherwise offset position:fixed.
 */
function RemoteConnectionOverlay({
  snap,
  retryNow,
}: {
  snap: RemoteConsoleSnapshot;
  retryNow?: () => void;
}) {
  const { t } = useLingui();
  const lost = snap.role === 'viewer' &&
    (snap.state === 'reconnecting' || snap.state === 'closed' || snap.state === 'failed');
  const [show, setShow] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!lost) { setShow(false); return; }
    const timer = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(timer);
  }, [lost]);
  useEffect(() => {
    if (!show) { setVisible(false); return; }
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [show]);
  if (!show || typeof document === 'undefined') return null;
  const detail =
    snap.errorKind === 'unreachable'
      ? t`The remote host is unreachable — is it running?`
      : snap.errorKind === 'ws-broken'
        ? t`The server is reachable, but the remote channel failed.`
        : snap.error;
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-xl">
        <ChevronsLeftRightEllipsis className="h-8 w-8 text-[var(--error,#e5534b)]" />
        <div className="text-sm font-semibold text-[var(--text-primary)]">
          <Trans>Connection lost</Trans>
        </div>
        {detail && (
          <div className="text-xs text-[var(--text-secondary)]">{detail}</div>
        )}
        {snap.retrying && (
          <div className="text-xs text-[var(--text-secondary)]">
            <Trans>Retrying…</Trans>
          </div>
        )}
        {retryNow && (
          <button
            type="button"
            onClick={retryNow}
            className="rounded border border-[var(--border)] bg-[var(--accent)]/15 px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/25"
          >
            <Trans>Retry now</Trans>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

function RemoteRailItem({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  const { settings } = useSettings();
  const console_ = shellPlatform()?.remoteConsole;
  // Icon shows when remote is enabled (explicit toggle, or a configured
  // URL), or whenever a remote console already exists (web viewer).
  const enabled =
    settings.remoteEnabled ?? Boolean(settings.remoteAuthorityUrl);
  const show = console_ != null || enabled === true;
  const snap = useSyncExternalStore(
    console_?.subscribe ?? (() => () => {}),
    console_?.get ?? (() => IDLE_SNAPSHOT),
  );
  if (!show) return null;
  const count = viewerIds(snap).length;
  const live = snap.state === 'ready' || snap.state === 'connected';
  return (
    <>
      <RemoteConnectionOverlay snap={snap} retryNow={console_?.retryNow} />
      <button
        type="button"
        onClick={onToggle}
      data-tip={t`Remote — ${snap.role === 'authority' ? 'host' : `viewing ${snap.hostName ?? 'host'}`} · ${stateLabel(snap)} · ${count} client(s)`}
      aria-label={t`Remote console`}
      aria-pressed={active}
      className={`relative flex h-8 w-7 flex-col items-center justify-center gap-px rounded border transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
          : live
            ? 'border-transparent text-[var(--accent)] hover:bg-[var(--surface-hover)]'
            : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      <ChevronsLeftRightEllipsis className="h-4 w-4" />
      <span
        className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${
          live
            ? 'bg-green-500'
            : active
              ? 'bg-[var(--accent)]'
              : 'bg-[var(--text-secondary)]'
        }`}
      />
      <span
        className={`select-none text-[8px] font-bold leading-none ${
          active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
        }`}
      >
        {count}
      </span>
      </button>
    </>
  );
}

function RemoteConsoleView() {
  const console_ = shellPlatform()?.remoteConsole;
  const snap = useSyncExternalStore(
    console_?.subscribe ?? (() => () => {}),
    console_?.get ?? (() => IDLE_SNAPSHOT),
  );
  const paused = snap.paused === true;
  const viewers = viewerIds(snap);
  const live = snap.state === 'ready' || snap.state === 'connected';
  const { t } = useLingui();
  const { settings, updateSettings } = useSettings();
  const platform = useShellPlatform();
  const remoteAuth = platform.remoteAuth;
  const auth = useSyncExternalStore(
    remoteAuth?.subscribe ?? (() => () => {}),
    remoteAuth?.get ?? (() => ({ state: 'signedOut' as const })),
  );

  const inputCls =
    'flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none';
  const rowCls = 'flex items-center gap-2';
  const labelCls = 'w-28 shrink-0 text-xs text-[var(--text-secondary)]';

  const configSection = (
    <div className="mt-5">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        <Trans>Connection</Trans>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className={rowCls}>
          <span className={labelCls}><Trans>Hub URL</Trans></span>
          <input
            type="text"
            value={settings.remoteAuthorityUrl ?? ''}
            onChange={(e) =>
              updateSettings({ remoteAuthorityUrl: e.currentTarget.value || undefined })
            }
            placeholder="ws://<gateway>:<port>/remote"
            className={inputCls}
          />
        </div>
        <div className={rowCls}>
          <span className={labelCls}><Trans>Session name</Trans></span>
          <input
            type="text"
            value={settings.remoteAuthoritySession ?? ''}
            onChange={(e) =>
              updateSettings({ remoteAuthoritySession: e.currentTarget.value || undefined })
            }
            placeholder="optional"
            className={inputCls}
          />
        </div>
        <div className={rowCls}>
          <span className={labelCls}><Trans>User token</Trans></span>
          <input
            type="text"
            value={settings.remoteAuthorityToken ?? ''}
            onChange={(e) =>
              updateSettings({ remoteAuthorityToken: e.currentTarget.value || undefined })
            }
            placeholder="optional"
            className={inputCls}
          />
        </div>
        <div className={rowCls}>
          <span className={labelCls}><Trans>OIDC issuer</Trans></span>
          <input
            type="text"
            value={settings.remoteAuthIssuer ?? ''}
            onChange={(e) =>
              updateSettings({ remoteAuthIssuer: e.currentTarget.value || undefined })
            }
            placeholder="https://<host>:<port>/realms/axn-term"
            className={inputCls}
          />
        </div>
        <div className={rowCls}>
          <span className={labelCls}><Trans>OIDC client</Trans></span>
          <input
            type="text"
            value={settings.remoteAuthClientId ?? ''}
            onChange={(e) =>
              updateSettings({ remoteAuthClientId: e.currentTarget.value || undefined })
            }
            placeholder="axn-term-desktop (default)"
            className={inputCls}
          />
        </div>
        {remoteAuth ? (
          <div className="mt-1">
            {auth.state === 'signedIn' ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-secondary)]">
                  <Trans>Signed in as {auth.user ?? ''}</Trans>
                </span>
                <button
                  type="button"
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface-hover)]"
                  onClick={() => void remoteAuth.signOut()}
                >
                  <Trans>Sign out</Trans>
                </button>
              </div>
            ) : auth.state === 'pending' ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-[var(--text-secondary)]">
                  <Trans>Enter code {auth.userCode ?? ''} in the browser to finish sign-in.</Trans>
                </span>
                {auth.verificationUri ? (
                  <span className="select-all break-all text-[10px] text-[var(--text-secondary)]">
                    {auth.verificationUri}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  disabled={!settings.remoteAuthIssuer}
                  onClick={() => void remoteAuth.signIn()}
                >
                  <Trans>Sign in…</Trans>
                </button>
                {auth.state === 'error' ? (
                  <span className="text-xs text-[var(--error,#e05)]">{auth.error}</span>
                ) : settings.remoteAuthIssuer ? (
                  <span className="text-xs text-[var(--text-secondary)]"><Trans>Not signed in</Trans></span>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--bg)] p-4 text-[var(--text-primary)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">
            {snap.role === 'authority' ? t`Remote — this machine is the host` : t`Remote — viewing`}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {snap.hostName && <span>{snap.hostDevice ? `${snap.hostDevice} · ` : ''}{snap.hostName} · </span>}
            {stateLabel(snap)}
            {snap.error && <span className="text-[var(--error,#e5534b)]"> — {snap.error}</span>}
          </div>
        </div>
        {snap.role === 'viewer' && console_?.setViewportPaused && (
          <button
            type="button"
            onClick={() => console_?.setViewportPaused?.(!paused)}
            className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface-hover)]"
          >
            {paused ? <Trans>Resume viewport</Trans> : <Trans>Pause viewport</Trans>}
          </button>
        )}
      </div>

      {/* Mirrored sessions this account owns — pick one when several
          desktops publish (viewer only). */}
      {snap.role === 'viewer' && snap.sessions && snap.sessions.length > 1 && (
        <>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
            <Trans>Sessions ({snap.sessions.length})</Trans>
          </div>
          <div className="mb-5 flex flex-wrap gap-1.5">
            {snap.sessions.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => console_?.chooseSession?.(id)}
                className={`rounded border px-2 py-0.5 text-xs ${
                  id === snap.sessionId
                    ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {id.includes('/') ? id.slice(id.indexOf('/') + 1) : id}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        <Trans>Clients: {viewers.length}</Trans>
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {snap.role === 'authority' && (
          <span className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]">
            <Trans>This machine is the host</Trans>
          </span>
        )}
        {viewers.map((id) => (
          <span
            key={id}
            className={`rounded border px-2 py-0.5 text-xs ${
              id === snap.selfViewerId
                ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-secondary)]'
            }`}
          >
            {viewerLabel(id, snap, t)}
          </span>
        ))}
        {viewers.length === 0 && snap.role === 'viewer' && (
          <span className="text-xs text-[var(--text-secondary)]">
            {live ? <Trans>only this device, not viewing a session</Trans> : <Trans>no clients</Trans>}
          </span>
        )}
      </div>

      {/* Host-side connection config — the hub/auth fields that used to
          live in the Settings modal. */}
      {configSection}
    </div>
  );
}

export const remoteLinkPlugin: SessionViewPlugin = {
  id: 'remote-link',
  title: 'Remote',
  version: '0.2.0',
  defaultEnabled: true,
  pinned: true,
  renderRail: ({ viewActive, toggleView }) => (
    <RemoteRailItem active={viewActive} onToggle={toggleView} />
  ),
  renderView: () => <RemoteConsoleView />,
};
