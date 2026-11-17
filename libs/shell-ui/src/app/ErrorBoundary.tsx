import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { axnLog } from './log';

interface ErrorBoundaryProps {
  /** Where the error happened — shown in the panel and the log line. */
  scope: string;
  /**
   * `view` (default): only this subtree is replaced, with a "Reload view"
   * button that remounts it. `app`: the last-resort root boundary — its
   * button reloads the window, which keeps the backend PTYs alive (a page
   * reload runs no React cleanup) so sessions reattach.
   */
  kind?: 'view' | 'app';
  /** Extra action next to the reload button, e.g. closing the broken tab. */
  extraAction?: { label: ReactNode; onClick: () => void };
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a render/effect error to the subtree it wraps. Without one, any
 * uncaught React error unmounts the whole app and leaves an empty window.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    axnLog(
      'error',
      'error-boundary',
      `${this.props.scope}: ${error.stack ?? error.message}${info.componentStack ?? ''}`,
    );
  }

  private reload = () => {
    if (this.props.kind === 'app') window.location.reload();
    else this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { kind = 'view', scope, extraAction } = this.props;
    const button =
      'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-primary)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]';
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--terminal-bg)] p-4">
        <div className="flex max-w-lg flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-xs text-[var(--text-primary)]">
          <div className="flex items-center gap-2 font-semibold text-[var(--red)]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {kind === 'app' ? (
              <Trans>axn-term hit an unexpected error</Trans>
            ) : (
              <Trans>This view hit an unexpected error</Trans>
            )}
          </div>
          <div className="text-[var(--text-secondary)]">{scope}</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button type="button" className={button} onClick={this.reload}>
              {kind === 'app' ? <Trans>Reload window</Trans> : <Trans>Reload view</Trans>}
            </button>
            {extraAction && (
              <button type="button" className={button} onClick={extraAction.onClick}>
                {extraAction.label}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
