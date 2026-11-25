import { useEffect, useMemo, useState } from 'react';
import { primaryButtonClass, quietButtonClass } from './chromeStyles';
import { Dropdown } from './Dropdown';
import { CLEANUP_AGES, olderThan, type DraftEntry } from './session-plugins/scratchpadDrafts';

/**
 * Scratchpad cleanup: pick how old a draft has to be and see, live, how many
 * would be moved to the trash. Drafts of unknown age are never picked.
 * Escape cancels.
 */
export function ScratchpadCleanupModal({
  entries,
  scope,
  onCancel,
  onConfirm,
  now = Date.now(),
}: {
  /** The drafts in scope (already limited to the selected repo). */
  entries: DraftEntry[];
  /** Where they come from, for the sentence: "all repos" or a repo name. */
  scope: string;
  onCancel: () => void;
  /** Move the picked drafts to the trash; rejects with a message to show. */
  onConfirm: (picked: DraftEntry[]) => Promise<void>;
  now?: number;
}) {
  const [ageIndex, setAgeIndex] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const age = CLEANUP_AGES[ageIndex];
  const picked = useMemo(() => olderThan(entries, age.ms, now), [entries, age.ms, now]);
  const unknown = entries.filter((e) => e.modifiedAt === undefined).length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, busy]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-label="Clean up drafts"
        className="w-96 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Clean up drafts</h2>
        <div className="mb-3 flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
          Older than
          <Dropdown
            ariaLabel="Older than"
            value={String(ageIndex)}
            onChange={(v) => !busy && setAgeIndex(Number(v))}
            options={CLEANUP_AGES.map((a, i) => ({ value: String(i), label: a.label }))}
            widthClass="w-36"
            className="w-28"
          />
        </div>
        <p className="mb-1 text-[13px] text-[var(--text-primary)]" data-testid="cleanup-count">
          {picked.length === 0
            ? `No drafts older than ${age.label} in ${scope}.`
            : `${picked.length} draft${picked.length === 1 ? '' : 's'} older than ${age.label} in ${scope} will be moved to the trash.`}
        </p>
        {unknown > 0 && (
          <p className="mb-1 text-[11px] text-[var(--text-tertiary)]">
            {unknown} draft{unknown === 1 ? '' : 's'} of unknown age {unknown === 1 ? 'is' : 'are'} kept.
          </p>
        )}
        {error && <p className="mb-1 text-[13px] text-[var(--red)]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={quietButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || picked.length === 0}
            className={primaryButtonClass}
          >
            {busy ? 'Moving…' : picked.length === 0 ? 'Move to trash' : `Move ${picked.length} to trash`}
          </button>
        </div>
      </div>
    </div>
  );
}
