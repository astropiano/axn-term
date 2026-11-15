import { ExternalLink, LoaderCircle } from 'lucide-react';
import type { KeycloakContextValue } from './KeycloakContext';

/**
 * Sign-in screen for the web viewer and the mobile app. The browser signs
 * in by redirect; the app shows a device code while the system browser
 * approves it. Either way the screen says which server it is for and how
 * to switch, and states a failed attempt in words.
 */
export function LoginScreen({
  onLogin,
  loginLabel = 'Log in with Keycloak',
  pending,
  onCancel,
  authError,
  serverName,
  onChangeServer,
}: {
  onLogin: () => void;
  loginLabel?: string;
  pending?: KeycloakContextValue['pending'];
  onCancel?: () => void;
  authError?: string | null;
  serverName?: string;
  onChangeServer?: () => void;
}) {
  return (
    <main
      className="flex min-h-screen w-full items-center justify-center bg-[var(--bg)] px-6 text-[var(--text-primary)]"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex w-full max-w-xs flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-balance text-lg font-semibold tracking-tight">axn-term</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {pending ? 'Finish signing in in the browser.' : 'Sign in to reach the terminals on your desktop.'}
          </p>
        </header>

        {pending ? (
          <section className="flex flex-col gap-3" aria-live="polite">
            <p className="text-sm text-[var(--text-secondary)]">If the page asks for a code, enter:</p>
            <code className="select-all self-start rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-2xl tracking-[0.2em]">
              {pending.userCode}
            </code>
            <button
              type="button"
              onClick={pending.open}
              className="flex items-center justify-center gap-2 rounded bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--text-inverted)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <ExternalLink aria-hidden className="h-4 w-4" />
              Open sign-in page
            </button>
            <p className="break-all text-xs text-[var(--text-secondary)]">{pending.verificationUri}</p>
            <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <span className="flex items-center gap-2">
                <LoaderCircle aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />
                Waiting for approval…
              </span>
              {onCancel ? (
                <button type="button" onClick={onCancel} className="underline underline-offset-2 hover:text-[var(--text-primary)]">
                  Cancel
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <button
            type="button"
            onClick={onLogin}
            className="rounded bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--text-inverted)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            {loginLabel}
          </button>
        )}

        {authError ? (
          <p role="alert" className="rounded border border-[var(--error,#e5534b)]/40 px-3 py-2 text-sm text-[var(--error,#e5534b)]">
            {authError}
          </p>
        ) : null}

        {onChangeServer ? (
          <footer className="flex items-baseline justify-between gap-3 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-secondary)]">
            <span className="min-w-0 truncate">{serverName ?? 'Server'}</span>
            <button type="button" onClick={onChangeServer} className="shrink-0 underline underline-offset-2 hover:text-[var(--text-primary)]">
              Change server
            </button>
          </footer>
        ) : null}
      </div>
    </main>
  );
}
