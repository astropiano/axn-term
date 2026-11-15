import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { renderSVG } from 'uqr';
import { createPortal } from 'react-dom';
import { shellPlatform } from '../../platform';
import { useShellPlatform } from '../../services';
import { useSettings } from '../../SettingsProvider';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronsLeftRightEllipsis, Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { RemoteIcon } from './remoteIcon';
import type { RemoteConsoleSnapshot } from '@axn-term/session-backend';
import type { SessionViewPlugin } from './plugin';
import type { AppSettings } from '../../themes';

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
/** Stable fallbacks — useSyncExternalStore compares getSnapshot results, so
 *  a fresh-object fallback re-renders forever (crashed the app on web,
 *  where remoteAuth is absent). */
const NO_SUBSCRIBE = () => () => {};
const SIGNED_OUT_AUTH: RemoteAuthSnap = { state: 'signedOut' };

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

type RemoteAuthSnap = {
  state: 'signedOut' | 'pending' | 'signedIn' | 'error';
  user?: string;
  userCode?: string;
  verificationUri?: string;
  error?: string;
};
type RemoteAuthActions = {
  signIn(opts?: { openBrowser?: boolean }): Promise<void>;
  signOut(): Promise<void>;
};

const authBtnCls =
  'rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-50';

/** Sign-in/out controls — one actionable button per auth state, so a
 *  failed browser hop (expired code, untrusted cert, closed tab) can
 *  never strand the user in a state with no way forward or back. */
export function RemoteAuthRow({
  auth,
  remoteAuth,
  canSignIn,
}: {
  auth: RemoteAuthSnap;
  remoteAuth: RemoteAuthActions;
  canSignIn: boolean;
}) {
  if (auth.state === 'signedIn') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">
          <Trans>Signed in as {auth.user ?? ''}</Trans>
        </span>
        <button
          type="button"
          className={authBtnCls}
          onClick={() => void remoteAuth.signOut()}
        >
          <Trans>Sign out</Trans>
        </button>
      </div>
    );
  }
  if (auth.state === 'pending') {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs text-[var(--text-secondary)]">
          <Trans>Confirm this code in the browser to finish signing in:</Trans>
        </span>
        <code className="self-start select-all rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-mono text-base tracking-widest text-[var(--text-primary)]">
          {auth.userCode ?? ''}
        </code>
        {auth.verificationUri ? (
          <span className="select-all break-all text-[10px] text-[var(--text-secondary)]">
            {auth.verificationUri}
          </span>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={authBtnCls}
            disabled={!canSignIn}
            onClick={() => void remoteAuth.signIn()}
          >
            <Trans>Sign in…</Trans>
          </button>
          <button
            type="button"
            className={authBtnCls}
            onClick={() => void remoteAuth.signOut()}
          >
            <Trans>Cancel</Trans>
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={authBtnCls}
        disabled={!canSignIn}
        onClick={() => void remoteAuth.signIn()}
      >
        <Trans>Sign in…</Trans>
      </button>
      {auth.state === 'error' ? (
        <span className="text-xs text-[var(--error,#e05)]">{auth.error}</span>
      ) : canSignIn ? (
        <span className="text-xs text-[var(--text-secondary)]"><Trans>Not signed in</Trans></span>
      ) : null}
    </div>
  );
}

function stateLabel(snap: RemoteConsoleSnapshot): string {
  // A retry in flight is 'connecting', not a failure — the authority's
  // token/backoff gap otherwise flashes 'Failed' before going green.
  if (snap.retrying) return 'Connecting…';
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
  signOut,
}: {
  snap: RemoteConsoleSnapshot;
  retryNow?: () => void;
  signOut?: () => void;
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
        {signOut && (
          <button
            type="button"
            onClick={signOut}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <Trans>Sign out</Trans>
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
  const connecting =
    !live &&
    (snap.retrying ||
      snap.state === 'connecting' ||
      snap.state === 'reconnecting');
  const iconState = snap.state === 'failed'
    ? 'error'
    : live
      ? 'connected'
      : connecting
        ? 'connecting'
        : 'idle';
  return (
    <>
      <RemoteConnectionOverlay snap={snap} retryNow={console_?.retryNow} signOut={shellPlatform()?.signOut} />
      <button
        type="button"
        onClick={onToggle}
      data-tip={t`Remote — ${snap.role === 'authority' ? 'host' : `viewing ${snap.hostName ?? 'host'}`} · ${stateLabel(snap)} · ${count} client(s)`}
      aria-label={t`Remote console`}
      aria-pressed={active}
      className={`flex h-8 w-7 flex-col items-center justify-center gap-px rounded border transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
          : live
            ? 'border-transparent text-[var(--accent)] hover:bg-[var(--surface-hover)]'
            : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      <RemoteIcon state={iconState} className="h-4 w-4" />
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

type StepState = 'done' | 'busy' | 'failed' | 'todo';

/** Status mark for a setup step — drawn icons, colored by meaning only. */
function StepIcon({ state }: { state: StepState }) {
  const cls = 'h-4 w-4 shrink-0';
  if (state === 'done') return <CircleCheck aria-hidden className={`${cls} text-[var(--accent)]`} />;
  if (state === 'failed') return <CircleX aria-hidden className={`${cls} text-[var(--error,#e5534b)]`} />;
  if (state === 'busy')
    return <LoaderCircle aria-hidden className={`${cls} animate-spin text-[var(--text-secondary)]`} />;
  return <Circle aria-hidden className={`${cls} text-[var(--text-secondary)] opacity-60`} />;
}

/**
 * One setup step: status mark and a hairline to the next step on the left,
 * title and controls stacked on the right — stacked so long labels and
 * narrow panels never clip the controls.
 */
function Step({
  state,
  title,
  last,
  children,
}: {
  state: StepState;
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useLingui();
  const stateText =
    state === 'done' ? t`done` : state === 'busy' ? t`in progress` : state === 'failed' ? t`needs attention` : t`to do`;
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center pt-px">
        <StepIcon state={state} />
        {last ? null : <span aria-hidden className="mt-1 w-px flex-1 bg-[var(--border)]" />}
      </div>
      <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${last ? '' : 'pb-4'}`}>
        <span className="text-xs font-medium text-[var(--text-primary)]">
          {title}
          <span className="sr-only"> — {stateText}</span>
        </span>
        {children}
      </div>
    </li>
  );
}

/**
 * One address in, everything else from the server's discovery document.
 * Shows which server/network is in use so a LAN → tailnet switch is
 * visible rather than magic.
 */
function ServerConnectRow({
  connect,
  inputCls,
}: {
  connect: (input: string) => Promise<Partial<AppSettings>>;
  inputCls: string;
}) {
  const { t } = useLingui();
  const { settings, updateSettings } = useSettings();
  const server = settings.remoteServer;
  const [draft, setDraft] = useState(server?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (server?.url) setDraft(server.url);
  }, [server?.url]);

  const submit = () => {
    setBusy(true);
    setError(null);
    connect(draft)
      .then((patch) => updateSettings(patch))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const endpoint = server?.endpoints.find((e) => e.gateway === server.lastGateway);

  return (
    <>
      <form
        className="flex min-w-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !busy) submit();
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="https://term.example.com"
          spellCheck={false}
          autoCapitalize="none"
          className={`${inputCls} min-w-0`}
          aria-label={t`Server address`}
        />
        <button type="submit" className={`${authBtnCls} shrink-0`} disabled={!draft.trim() || busy}>
          {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-[var(--error,#e5534b)]">{error}</p>
      ) : server ? (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-xs text-[var(--text-secondary)]">
          <span className="min-w-0 break-words">
            {endpoint ? t`${server.name} · via ${endpoint.label}` : server.name}
          </span>
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)] hover:decoration-solid"
            onClick={() =>
              updateSettings({
                remoteServer: undefined,
                remoteAuthorityUrl: undefined,
                remoteAuthIssuer: undefined,
                remoteAuthClientId: undefined,
              })
            }
          >
            <Trans>Forget</Trans>
          </button>
        </p>
      ) : null}
    </>
  );
}

/**
 * Server → account → publishing as one list of steps, each with its state
 * and the control that moves it forward; the publishing step carries the
 * server's own reason when it refused this desktop.
 */
function SetupSteps({
  auth,
  remoteAuth,
  inputCls,
}: {
  auth: RemoteAuthSnap;
  remoteAuth?: RemoteAuthActions;
  inputCls: string;
}) {
  const { t } = useLingui();
  const { settings } = useSettings();
  const platform = useShellPlatform();
  const statusStore = platform.remoteAuthorityStatus;
  // Call through the store — its methods must not be detached from it.
  const subscribePublish = useCallback(
    (cb: () => void) => statusStore?.subscribe(cb) ?? (() => {}),
    [statusStore],
  );
  const getPublish = useCallback(() => statusStore?.get() ?? IDLE_PUBLISH, [statusStore]);
  const publish = useSyncExternalStore(subscribePublish, getPublish);
  const server = settings.remoteServer;
  const hub = settings.remoteAuthorityUrl;
  const signedIn = auth.state === 'signedIn';
  const [lastDenied, setLastDenied] = useState<string | null>(null);

  // Ask the server about this account while signed in but not publishing:
  // a refused hello carries its reason there (issuer, expiry, client…).
  const statusFn = platform.remoteServer?.status;
  useEffect(() => {
    if (!statusFn || !hub || !signedIn || publish.state === 'connected') {
      setLastDenied(null);
      return;
    }
    let alive = true;
    const poll = () =>
      statusFn(hub)
        .then((s) => {
          const last = s.attempts.find((a) => a.role.toLowerCase() === 'authority');
          if (alive) setLastDenied(last && !last.accepted ? (last.reason ?? null) : null);
        })
        .catch((e: unknown) => {
          if (alive) setLastDenied(e instanceof Error ? e.message : String(e));
        });
    poll();
    const timer = window.setInterval(poll, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [statusFn, hub, signedIn, publish.state]);

  // Is the configured hub address real? The status endpoint doubles as the
  // probe: any HTTP answer (401 while signed out counts) means it answers;
  // a transport failure means the saved address is stale/garbage — gate the
  // sign-in on that so credentials can't be run against nonsense.
  const [hubReachable, setHubReachable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!statusFn || !hub) {
      setHubReachable(null);
      return;
    }
    let alive = true;
    const probe = () =>
      statusFn(hub)
        .then(() => {
          if (alive) setHubReachable(true);
        })
        .catch((e: unknown) => {
          if (alive) setHubReachable(typeof (e as { status?: number }).status === 'number');
        });
    probe();
    const timer = window.setInterval(probe, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [statusFn, hub]);

  const connect = platform.remoteServer?.connect;
  const serverState: StepState =
    !(server || hub) ? 'todo' : hubReachable === false ? 'failed' : 'done';
  const authState: StepState =
    auth.state === 'signedIn' ? 'done' : auth.state === 'pending' ? 'busy' : auth.state === 'error' ? 'failed' : 'todo';
  const publishState: StepState =
    publish.state === 'connected'
      ? 'done'
      : publish.state === 'connecting'
        ? 'busy'
        : publish.state === 'failed' || lastDenied
          ? 'failed'
          : 'todo';
  const publishDetail =
    publish.state === 'connected'
      ? t`phones and browsers signed in as the same account can attach`
      : publish.state === 'connecting'
        ? t`connecting…`
        : (publish.error ?? (publish.state === 'failed' ? t`failed` : t`not yet`));

  return (
    <ol className="flex flex-col">
      <Step state={serverState} title={t`Server`}>
        {connect ? (
          <ServerConnectRow connect={connect} inputCls={inputCls} />
        ) : (
          <p className="break-all text-xs text-[var(--text-secondary)]">
            {hub ?? t`not connected — enter the server address above`}
          </p>
        )}
        {hubReachable === false ? (
          <p role="alert" className="text-xs text-[var(--error,#e5534b)]">
            <Trans>The saved server is not answering — connect again</Trans>
          </p>
        ) : null}
      </Step>
      {remoteAuth ? (
        <Step state={authState} title={t`Signed in`}>
          <RemoteAuthRow
            auth={auth}
            remoteAuth={remoteAuth}
            canSignIn={Boolean(settings.remoteAuthIssuer) && hubReachable !== false}
          />
        </Step>
      ) : null}
      <Step state={publishState} title={t`Publishing`} last>
        {/* The server's reason replaces the client's generic error. */}
        {lastDenied ? null : <p className="break-words text-xs text-[var(--text-secondary)]">{publishDetail}</p>}
        {lastDenied ? (
          <p role="alert" className="break-words text-xs text-[var(--error,#e5534b)]">
            <Trans>The server refused this desktop: {lastDenied}</Trans>
          </p>
        ) : null}
      </Step>
    </ol>
  );
}

const IDLE_PUBLISH: { state: 'idle' | 'connecting' | 'connected' | 'failed'; error?: string } = { state: 'idle' };

/**
 * QR + wording for the phone. The code carries only the server address
 * and id — never a token — so it is safe to show on screen.
 */
function PhonePairing({ link }: { link: string | null }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const svg = useMemo(() => {
    if (!link) return null;
    try {
      return renderSVG(link, { border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
    } catch {
      return null;
    }
  }, [link]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!link) return null;
  const copy = () =>
    void navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => {},
    );
  return (
    <div className="mt-6">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        <Trans>Connect a phone</Trans>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {svg ? (
          <div
            role="img"
            aria-label={t`Pairing code for the axn-term app`}
            className="h-32 w-32 shrink-0 overflow-hidden rounded bg-white p-1"
            // uqr returns a self-contained <svg>; the link is the only input.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : null}
        <div className="flex min-w-[12rem] flex-1 flex-col gap-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          <p>
            <Trans>
              On the same Wi-Fi, the axn-term app finds this desktop by itself. Anywhere else,
              scan this code in the app.
            </Trans>
          </p>
          <p>
            <Trans>
              Away from home? Put the phone and this computer on the same Tailscale network —
              the app switches between Wi-Fi and Tailscale and stays the same device.
            </Trans>
          </p>
          <div className="flex min-w-0 items-center gap-2">
            <code title={link} className="min-w-0 flex-1 truncate text-[10px] opacity-70">
              {link}
            </code>
            <button type="button" className={`${authBtnCls} shrink-0`} onClick={copy}>
              {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </button>
          </div>
        </div>
      </div>
    </div>
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
    remoteAuth?.subscribe ?? NO_SUBSCRIBE,
    remoteAuth?.get ?? (() => SIGNED_OUT_AUTH),
  );

  const inputCls =
    'flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none';
  const rowCls = 'flex items-center gap-2';
  const labelCls = 'w-28 shrink-0 text-xs text-[var(--text-secondary)]';

  const remoteServer = platform.remoteServer;
  const configSection = (
    <div className="mt-5">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        <Trans>Connection</Trans>
      </div>
      <SetupSteps auth={auth} remoteAuth={remoteAuth} inputCls={inputCls} />
      <div className="mt-4 flex flex-col gap-1.5">
        <details
          className="mt-1"
          // Hand-configured setups (no discovery server) keep their fields
          // in view; with a server they are derived and tucked away.
          open={!remoteServer || (!settings.remoteServer && Boolean(settings.remoteAuthorityUrl))}
        >
          <summary className="cursor-pointer select-none text-xs text-[var(--text-secondary)]">
            <Trans>Advanced</Trans>
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
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
          </div>
        </details>
      </div>
      {remoteServer && settings.remoteServer ? (
        <PhonePairing link={remoteServer.pairingLink(settings.remoteServer)} />
      ) : null}
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

      {snap.role === 'viewer' ? (
        // Client view: where this device is attached to + account sign-out.
        // The host config form is meaningless here (it configures publishing).
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
            <Trans>Connected to</Trans>
          </div>
          <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
            {snap.authorityUrl && (
              <div className="select-all break-all">{snap.authorityUrl}</div>
            )}
            {snap.hostName && (
              <div>
                {snap.hostDevice ? `${snap.hostDevice} · ` : ''}{snap.hostName}
              </div>
            )}
            {snap.sessionId && (
              <div>
                <Trans>Session: {snap.sessionId.includes('/') ? snap.sessionId.slice(snap.sessionId.indexOf('/') + 1) : snap.sessionId}</Trans>
              </div>
            )}
            {platform.signOut && (
              <div className="mt-1">
                <button
                  type="button"
                  className={authBtnCls}
                  onClick={() => platform.signOut?.()}
                >
                  <Trans>Sign out</Trans>
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        // Host-side connection config — the hub/auth fields that used to
        // live in the Settings modal.
        configSection
      )}
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
