import { useEffect } from 'react';
import { AlertOctagon, AlertTriangle, ChevronRight } from 'lucide-react';
import type { RailFlag } from './attention';

interface AttentionModalProps {
  /** Every raised flag — session flags navigate on click. */
  flags: RailFlag[];
  onClose: () => void;
  /** Navigate to the session a flag belongs to. */
  onNavigate?: (sessionId: string) => void;
}

/**
 * Modal listing every raised "needs attention" flag — opened by clicking the
 * pulsing indicator in the left rail. Esc or clicking the backdrop closes it.
 * Session-bound flags are clickable and jump to that session.
 */
export function AttentionModal({ flags, onClose, onNavigate }: AttentionModalProps) {
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
        className="w-96 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-primary)]">
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
            const activate = flag.onClick
              ? () => {
                  flag.onClick!();
                  onClose();
                }
              : flag.sessionId && onNavigate
                ? () => onNavigate(flag.sessionId!)
                : undefined;
            return (
              <li key={flag.source}>
                {activate ? (
                  <button
                    type="button"
                    onClick={activate}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition hover:bg-[var(--surface-hover)]"
                  >
                    {body}
                    <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-1.5 py-1 text-xs">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
