import { useEffect, useRef, useState } from 'react';
import { CircleX, MonitorOff, MonitorSmartphone, WifiOff } from 'lucide-react';
import {
  describeRemoteStatus,
  fetchRemoteStatus,
  RemoteStatusError,
  type RemoteStatusSummary,
} from '@axn-term/session-backend/remote';

/**
 * Shown over the viewer while no desktop of this account is online —
 * instead of an endless "loading sessions…", say why (nothing published
 * yet / the desktop was refused and the reason / it went offline) and what
 * to do. Polls the gateway's /remote/status; when a desktop comes online it
 * nudges the backend to attach right away rather than wait out its backoff.
 */
export function RemoteWaiting({
  hubUrl,
  getToken,
  onDesktopOnline,
  onSignOut,
}: {
  hubUrl: string;
  getToken: () => Promise<string | undefined>;
  onDesktopOnline?: () => void;
  onSignOut?: () => void;
}) {
  const [summary, setSummary] = useState<RemoteStatusSummary | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasOnline = useRef(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const status = await fetchRemoteStatus(hubUrl, await getToken());
        if (!alive) return;
        const next = describeRemoteStatus(status);
        setSummary(next);
        setUser(status.account.user ?? null);
        setError(null);
        if (next.kind === 'online' && !wasOnline.current) onDesktopOnline?.();
        wasOnline.current = next.kind === 'online';
      } catch (e) {
        if (!alive) return;
        setError(
          e instanceof RemoteStatusError && e.status === 401
            ? `This server did not accept your sign-in: ${e.message}`
            : `Cannot reach the server's remote hub (${e instanceof Error ? e.message : String(e)}).`,
        );
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [hubUrl, getToken, onDesktopOnline]);

  if (!error && (!summary || summary.kind === 'online')) return null;
  return <RemoteWaitingView summary={summary} error={error} user={user} onSignOut={onSignOut} />;
}

/** The waiting screen itself — stateless, so every state can be rendered. */
export function RemoteWaitingView({
  summary,
  error,
  user,
  onSignOut,
}: {
  summary: RemoteStatusSummary | null;
  error?: string | null;
  user?: string | null;
  onSignOut?: () => void;
}) {
  const kind = error ? 'error' : (summary?.kind ?? 'waiting');
  const Icon =
    kind === 'denied' ? CircleX : kind === 'offline' ? MonitorOff : kind === 'error' ? WifiOff : MonitorSmartphone;
  const title = error ? 'Not connected' : (summary?.title ?? 'Looking for your desktop');

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[var(--bg)] px-6 py-10 text-[var(--text-primary)]"
    >
      <div className="flex w-full max-w-sm flex-col gap-5">
        <Icon
          aria-hidden
          strokeWidth={1.5}
          className={`h-8 w-8 ${kind === 'denied' || kind === 'error' ? 'text-[var(--error,#e5534b)]' : 'text-[var(--text-secondary)]'}`}
        />
        <div className="flex flex-col gap-2">
          <h1 className="text-balance text-base font-semibold">{title}</h1>
          {kind === 'waiting' ? (
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-[var(--text-secondary)] marker:text-[var(--text-secondary)]">
              <li>On your computer, open axn-term and click Remote (the globe icon).</li>
              <li>Under Server, enter this server's address and click Connect.</li>
              <li>Click Sign in and use {user ? <strong className="font-medium text-[var(--text-primary)]">{user}</strong> : 'the same account as here'}.</li>
            </ol>
          ) : (
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{error ?? summary?.detail}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-secondary)]">
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span aria-hidden className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
            </span>
            Checking every few seconds
          </span>
          {onSignOut ? (
            <button type="button" onClick={onSignOut} className="whitespace-nowrap underline underline-offset-2 hover:text-[var(--text-primary)]">
              Use another account
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
