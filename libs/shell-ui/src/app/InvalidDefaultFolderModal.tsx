import { useEffect } from 'react';
import { Trans } from '@lingui/react/macro';
import type { Workspace } from '../types';

/**
 * Shown when a session is opened in a workspace whose defaultFolder does not
 * resolve to a directory — the path is checked only at session-creation time,
 * never when it is set. Offers to fix the path or open in the home folder.
 */
export function InvalidDefaultFolderModal({
  workspace,
  onCancel,
  onFix,
  onOpenHome,
}: {
  workspace: Workspace;
  onCancel: () => void;
  /** Opens the SetDefaultFolderModal for this workspace. */
  onFix: () => void;
  /** Opens the session without a cwd — the shell's home directory. */
  onOpenHome: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]">
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          <Trans>Invalid default folder</Trans>
        </h2>
        <p className="mb-1 text-[13px] text-[var(--text-primary)]">
          <Trans>The default folder of “{workspace.name}” does not exist:</Trans>
        </p>
        <p className="mb-3 break-all font-mono text-[13px] text-[var(--orange)]">
          {workspace.defaultFolder}
        </p>
        <p className="mb-3 text-[13px] text-[var(--text-secondary)]">
          <Trans>Fix the path or open the session in your home folder.</Trans>
        </p>
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
            onClick={onFix}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <Trans>Set default folder…</Trans>
          </button>
          <button
            type="button"
            onClick={onOpenHome}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-[13px] text-[var(--text-inverted)] hover:opacity-90"
          >
            <Trans>Open in home folder</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
