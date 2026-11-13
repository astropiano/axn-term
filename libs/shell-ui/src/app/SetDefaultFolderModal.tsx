import { useEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { Workspace } from '../types';

/**
 * "Set default folder…" from the workspace context menu: a plain path input
 * seeded with the workspace's current defaultFolder. The path is deliberately
 * not validated here — a bad path surfaces only when a session is opened in
 * the workspace (InvalidDefaultFolderModal).
 */
export function SetDefaultFolderModal({
  workspace,
  onSave,
  onCancel,
}: {
  workspace: Workspace;
  /** Trimmed input; '' clears the default folder (sessions open in $HOME). */
  onSave: (path: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState(workspace.defaultFolder ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const save = () => onSave(path.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]">
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          <Trans>Default folder</Trans>
        </h2>
        <p className="mb-3 text-[13px] text-[var(--text-secondary)]">
          <Trans>
            New sessions in “{workspace.name}” start in this folder. Leave empty for your home
            directory.
          </Trans>
        </p>
        <input
          ref={inputRef}
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="~/projects"
          className="mb-3 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
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
            onClick={save}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-[13px] text-[var(--text-inverted)] hover:opacity-90"
          >
            <Trans>Save</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
