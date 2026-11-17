import { useEffect } from 'react';
import { Trans } from '@lingui/react/macro';
import type { ShellSession, Workspace } from '../types';

const MAX_LISTED_PROCESSES = 5;

/**
 * "Delete workspace" confirmation — deleting kills every session the
 * workspace hosts, so the dialog says how many close and how many still
 * have a running process (same predicate as the window-close confirm:
 * `status === 'running' || process`). Escape cancels, Enter confirms.
 */
export function DeleteWorkspaceModal({
  workspace,
  sessions,
  onCancel,
  onConfirm,
}: {
  workspace: Workspace;
  /** The workspace's sessions — the ones the delete terminates. */
  sessions: ShellSession[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onConfirm]);

  const running = sessions.filter((s) => s.status === 'running' || !!s.process);
  const processNames = [
    ...new Set(running.map((s) => s.process).filter((p): p is string => !!p)),
  ];
  const listed = processNames.slice(0, MAX_LISTED_PROCESSES);
  const overflow = processNames.length - listed.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-80 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]">
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          <Trans>Delete workspace “{workspace.name}”?</Trans>
        </h2>
        <p className="mb-3 text-[13px] text-[var(--text-secondary)]">
          {sessions.length === 0 ? (
            <Trans>No sessions inside.</Trans>
          ) : (
            <Trans>
              This closes {sessions.length}{' '}
              {sessions.length === 1 ? 'session' : 'sessions'} inside it.
            </Trans>
          )}
        </p>
        {running.length > 0 && (
          <p className="mb-3 text-[13px] text-[var(--orange)]">
            <Trans>
              {running.length} running {running.length === 1 ? 'process' : 'processes'} will be
              terminated
            </Trans>
            {listed.length > 0 && (
              <>
                : {listed.join(', ')}
                {overflow > 0 ? `, +${overflow}` : ''}
              </>
            )}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-[var(--red)] px-3 py-1.5 text-[13px] text-[var(--text-inverted)] hover:opacity-90"
          >
            <Trans>Delete workspace</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
