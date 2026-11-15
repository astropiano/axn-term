import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Monitor, QrCode, RefreshCw } from 'lucide-react';
import { parseConnectInput, type AnnouncedDesktop, type KnownServer } from '@axn-term/session-backend';
import { discoverDesktops, isNative, scanPairingCode } from './native';
import { pairWith } from './connect';

/**
 * First-run (and "Change server") screen. Three ways in, most automatic
 * first: a desktop announcing itself on this Wi-Fi, the desktop's QR code,
 * or a typed address. Tailscale is explained, not required.
 */
export function ConnectScreen({
  onPaired,
  discover = discoverDesktops,
  native = isNative,
}: {
  onPaired: (server: KnownServer) => void;
  /** Local-network scan (overridable for previews). */
  discover?: () => Promise<AnnouncedDesktop[]>;
  /** Native-only affordances (QR scan, Wi-Fi discovery). */
  native?: boolean;
}) {
  const [desktops, setDesktops] = useState<AnnouncedDesktop[]>([]);
  const [scanning, setScanning] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scanWifi = useCallback(() => {
    setScanning(true);
    discover()
      .then(setDesktops)
      .catch(() => setDesktops([]))
      .finally(() => setScanning(false));
  }, [discover]);
  useEffect(scanWifi, [scanWifi]);

  const pair = (input: string, label: string) => {
    const target = parseConnectInput(input);
    if (!target) {
      setError('Enter a server address, e.g. https://term.example.com');
      return;
    }
    setBusy(label);
    setError(null);
    pairWith(target)
      .then(onPaired)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const scanCode = () => {
    setError(null);
    scanPairingCode()
      .then((code) => {
        if (code) pair(code, 'qr');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Screen>
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Connect to your desktop</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Turn on Remote in axn-term on your computer, then pick it here.
        </p>
      </header>

      <Section
        title="On this Wi-Fi"
        action={
          <button
            type="button"
            onClick={scanWifi}
            disabled={scanning}
            className="flex items-center gap-1.5 text-xs text-[var(--accent)] disabled:opacity-60"
          >
            <RefreshCw aria-hidden className={`h-3.5 w-3.5 ${scanning ? 'motion-safe:animate-spin' : ''}`} />
            {scanning ? 'Looking…' : 'Look again'}
          </button>
        }
      >
        {desktops.length ? (
          <ul className="flex flex-col gap-2">
            {desktops.map((d) => (
              <li key={d.desktopId ?? d.server}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => pair(d.server, d.desktopId ?? d.server)}
                  className="flex w-full items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-left hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] disabled:opacity-60"
                >
                  <Monitor aria-hidden strokeWidth={1.5} className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{d.name ?? 'Desktop'}</span>
                    <span className="truncate text-xs text-[var(--text-secondary)]">{new URL(d.server).host}</span>
                  </span>
                  {busy === (d.desktopId ?? d.server) ? (
                    <span className="text-xs text-[var(--text-secondary)]">Connecting…</span>
                  ) : (
                    <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            {scanning
              ? 'Looking for desktops…'
              : native
                ? 'No desktop found on this Wi-Fi. Check that Remote is on and both devices use the same network.'
                : 'Finding desktops on the Wi-Fi works in the app only.'}
          </p>
        )}
      </Section>

      {native ? (
        <Section title="Scan the code">
          <p className="mb-2 text-sm text-[var(--text-secondary)]">
            In axn-term on your computer: Remote → Connect a phone.
          </p>
          <button
            type="button"
            onClick={scanCode}
            disabled={busy !== null}
            className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium disabled:opacity-60 ${
              // Primary only when the Wi-Fi found nothing to tap.
              desktops.length
                ? 'border border-[var(--border)] hover:bg-[var(--surface-hover)]'
                : 'bg-[var(--accent)] text-[var(--text-inverted)] hover:opacity-90'
            }`}
          >
            <QrCode aria-hidden className="h-4 w-4" />
            {busy === 'qr' ? 'Connecting…' : 'Scan QR code'}
          </button>
        </Section>
      ) : null}

      <Section title="Enter an address">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            pair(address, 'address');
          }}
        >
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            placeholder="https://term.example.com"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={!address.trim() || busy !== null}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-60"
          >
            {busy === 'address' ? '…' : 'Connect'}
          </button>
        </form>
      </Section>

      {error ? (
        <p role="alert" className="rounded-lg border border-[var(--error,#e5534b)]/40 px-3 py-2 text-sm text-[var(--error,#e5534b)]">
          {error}
        </p>
      ) : null}

      <TailscaleHint />
    </Screen>
  );
}

/** Shown when a paired server can't be reached from the current network. */
export function UnreachableScreen({
  server,
  retrying,
  onRetry,
  onChangeServer,
}: {
  server: KnownServer;
  retrying: boolean;
  onRetry: () => void;
  onChangeServer: () => void;
}) {
  return (
    <Screen>
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Can't reach {server.name}</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          None of its addresses answer from this network:
        </p>
        <ul className="mt-1 text-xs text-[var(--text-secondary)]">
          {server.endpoints.map((e) => (
            <li key={e.gateway}>
              {e.label} · {new URL(e.gateway).host}
            </li>
          ))}
        </ul>
      </header>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-medium text-[var(--text-inverted)] disabled:opacity-60"
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
        <button type="button" onClick={onChangeServer} className="rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm">
          Change server
        </button>
      </div>
      <TailscaleHint />
    </Screen>
  );
}

function TailscaleHint() {
  return (
    <aside className="rounded-lg border border-[var(--border)] px-3 py-3 text-sm text-[var(--text-secondary)]">
      <p className="mb-1 font-medium text-[var(--text-primary)]">Not on the same network?</p>
      <p>
        Install Tailscale on this phone and on your computer and sign in to the same account. Connect
        once at home — after that the app switches between Wi-Fi and Tailscale by itself and stays the
        same device.
      </p>
    </aside>
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 bg-[var(--bg)] px-4 text-[var(--text-primary)]"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
      }}
    >
      {children}
    </main>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
