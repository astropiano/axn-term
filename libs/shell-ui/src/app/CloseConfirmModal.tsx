import { useEffect, useState } from 'react';

const AUTO_CLOSE_SECONDS = 10;

interface CloseConfirmModalProps {
  sessionCount: number;
  runningCount: number;
  /** Other app windows currently open — >0 adds the close-all choice. */
  otherWindowCount?: number;
  onCancel: () => void;
  /**
   * Close just this window and end its sessions without saving them —
   * rendered only while other windows are open.
   */
  onCloseThisWindow?: () => void;
  /**
   * Save the session state in every window and close them all (with a
   * single window that is just this one). Timed default of the countdown
   * and Enter.
   */
  onConfirm: () => void;
}

export function CloseConfirmModal({
  sessionCount,
  runningCount,
  otherWindowCount = 0,
  onCancel,
  onCloseThisWindow,
  onConfirm,
}: CloseConfirmModalProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_CLOSE_SECONDS);
  const multiWindow = otherWindowCount > 0 && onCloseThisWindow != null;

  useEffect(() => {
    // Clamped at 0: the modal can stay mounted while the real close runs.
    const timer = setInterval(
      () => setSecondsLeft((s) => Math.max(0, s - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) onConfirm();
  }, [secondsLeft, onConfirm]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-80 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          Close window?
        </h2>
        <p className="mb-1 text-xs text-[var(--text-primary)]">
          {sessionCount} open session{sessionCount === 1 ? '' : 's'}
          {multiWindow ? ' in this window' : ''}
        </p>
        {multiWindow && (
          <p className="mb-1 text-xs text-[var(--text-primary)]">
            {otherWindowCount} other window{otherWindowCount === 1 ? '' : 's'} open
          </p>
        )}
        <p className="mb-3 text-xs text-[var(--text-secondary)]">
          {runningCount > 0
            ? `${runningCount} ${runningCount === 1 ? 'session has' : 'sessions have'} a running process`
            : 'All sessions are idle'}
        </p>
        {runningCount > 0 && (
          <p className="mb-3 text-xs text-[var(--orange)]">
            Running processes will be terminated.
          </p>
        )}
        {multiWindow ? (
          <>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Closing this window ends its sessions for good. Closing all
              windows saves every window's sessions for the next launch.
            </p>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Closing all windows automatically in {secondsLeft}s — Cancel
              keeps the windows open.
            </p>
          </>
        ) : (
          <p className="mb-3 text-xs text-[var(--text-secondary)]">
            Closing automatically in {secondsLeft}s — Cancel keeps the window open.
          </p>
        )}
        {multiWindow ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="w-full rounded bg-[var(--red)] px-3 py-1.5 text-xs text-[var(--text-inverted)] hover:opacity-90"
            >
              Close all windows &amp; save ({secondsLeft}s)
            </button>
            <button
              type="button"
              onClick={onCloseThisWindow}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              Close this window only
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="w-full rounded px-3 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-[var(--red)] px-3 py-1.5 text-xs text-[var(--text-inverted)] hover:opacity-90"
            >
              Close ({secondsLeft}s)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
