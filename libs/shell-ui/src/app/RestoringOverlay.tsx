import { useEffect, useRef } from 'react';
import { Loader2, X } from 'lucide-react';

/**
 * Blocking overlay over a session's shell terminal while a plugin drives a
 * restore (`pendingRestore` → `ctx.setRestoring`). Covers the terminal so
 * clicks cannot reach it, and grabs focus on mount so keystrokes cannot
 * reach xterm either — input typed during a restore would race the
 * injected restore command. The × button dismisses the overlay manually in
 * case the restore hangs.
 */
export function RestoringOverlay({
  labels,
  onDismiss,
}: {
  labels: string[];
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Steal keyboard focus from xterm's hidden textarea.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg)]/85 outline-none backdrop-blur-[1px]"
    >
      <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
      <div className="px-6 text-center text-xs text-[var(--text-primary)]">
        {labels.map((label, i) => (
          <div key={i}>Restoring {label}…</div>
        ))}
      </div>
      <div className="text-[10px] text-[var(--text-secondary)]">
        input is locked until the restore finishes
      </div>
      <button
        type="button"
        onClick={onDismiss}
        data-tip="Dismiss restore overlay"
        aria-label="Dismiss restore overlay"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
