import { useEffect } from 'react';
import { AlertOctagon, AlertTriangle, ChevronRight } from 'lucide-react';
import type { RailFlag } from './attention';

interface AttentionModalProps {
  /** Every raised flag — session flags offer a "Go to session" button. */
  flags: RailFlag[];
  onClose: () => void;
  /** Navigate to the session a flag belongs to. */
  onNavigate?: (sessionId: string) => void;
  /** Run a declared attention action (`goto-session:<id>` handled by caller). */
  onAction?: (flag: RailFlag, actionId: string) => void;
}

/**
 * Modal listing every raised "needs attention" flag — opened from the
 * warning button in the session panel's toolbar. Esc or clicking the
 * backdrop closes it.
 * Session-bound flags are clickable and jump to that session.
 */
export function AttentionModal({ flags, onClose, onNavigate, onAction }: AttentionModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-96 max-w-[90vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Needs attention
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            esc
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {flags.map((flag) => {
            const critical = flag.attention.level !== 'warning';
            const icon = critical ? (
              <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--red)]" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--orange)]" />
            );
            const body = (
              <>
                {icon}
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--text-primary)]">{flag.source}</div>
                  {flag.attention.message && (
                    <div className="text-[var(--text-secondary)]">{flag.attention.message}</div>
                  )}
                </div>
              </>
            );
            // Buttons only — a flag with no declared action and no
            // session/app binding is inert (no implicit navigation).
            const buttons: { key: string; label: string; run: () => void }[] = [];
            if (flag.sessionId && onNavigate) {
              buttons.push({
                key: 'goto',
                label: `Go to ${flag.sessionName ?? 'session'}`,
                run: () => onNavigate(flag.sessionId!),
              });
            }
            for (const a of flag.attention.actions ?? []) {
              buttons.push({
                key: `a:${a.id}`,
                label: a.label,
                run: () => onAction?.(flag, a.id),
              });
            }
            if (flag.onClick) {
              buttons.push({ key: 'app', label: 'Open', run: flag.onClick });
            }
            return (
              <li key={flag.source}>
                <div className="flex items-start gap-2 px-1.5 py-1 text-[13px]">
                  {body}
                </div>
                {buttons.length > 0 && (
                  <div className="mb-1 ml-7 flex flex-wrap gap-1">
                    {buttons.map((b) => (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => {
                          b.run();
                          onClose();
                        }}
                        className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--accent)] transition hover:bg-[var(--surface-hover)]"
                      >
                        {b.label}
                        <ChevronRight className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
