import { useEffect, useState, type ReactNode } from 'react';

/**
 * Startup reachability gate: browsers report self-signed-certificate
 * failures on fetch/WebSocket as opaque network errors, which otherwise
 * leaves the app on a silent white/loading screen. Probe the endpoints
 * the app depends on first; on failure show which origin is unreachable
 * and offer a direct link — opening it lets the user accept the
 * certificate, then reload.
 */

/** ws/wss → http/https so the link is openable in a plain tab. */
function acceptUrl(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function reachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // no-cors: the gateway doesn't emit CORS headers and doesn't need to —
    // WebSocket has no same-origin rule. An opaque response means the
    // endpoint is reachable; cert errors and dead hosts still reject.
    await fetch(acceptUrl(url), { signal: ctrl.signal, cache: 'no-store', mode: 'no-cors' });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

export function ConnectionGate({ endpoints, children }: { endpoints: (string | undefined | null)[]; children: ReactNode }) {
  const urls = endpoints.filter((u): u is string => !!u);
  const [failed, setFailed] = useState<string[] | null>(urls.length ? null : []);

  const check = () => {
    if (!urls.length) {
      setFailed([]);
      return;
    }
    setFailed(null);
    Promise.all(urls.map((u) => reachable(u))).then((results) => {
      setFailed(urls.filter((_, i) => !results[i]));
    });
  };

  useEffect(check, [urls.join('|')]);

  if (failed === null) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--bg)] text-[var(--text-primary)]">
        Connecting…
      </div>
    );
  }

  if (failed.length > 0) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-[var(--bg)] px-6 text-center text-[var(--text-primary)]">
        <h1 className="text-xl font-semibold">Cannot reach the server</h1>
        <p className="max-w-md text-sm text-[var(--text-secondary)]">
          If this server uses a self-signed certificate, open{' '}
          {failed.length > 1 ? 'these addresses' : 'this address'} in a new
          tab, accept the certificate, then come back.
        </p>
        {failed.map((u) => (
          <a
            key={u}
            href={acceptUrl(u)}
            target="_blank"
            rel="noreferrer"
            className="break-all rounded bg-[var(--surface)] px-3 py-2 text-sm text-[var(--accent)] underline"
          >
            {acceptUrl(u)}
          </a>
        ))}
        <button
          type="button"
          onClick={check}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
