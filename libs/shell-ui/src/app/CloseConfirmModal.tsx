import { useEffect } from 'react';

interface CloseConfirmModalProps {
  sessionCount: number;
  runningCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CloseConfirmModal({ sessionCount, runningCount, onCancel, onConfirm }: CloseConfirmModalProps) {
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
        </p>
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
