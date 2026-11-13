import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import type { ShellSession } from '../types';
import { SESSION_SUMMARY_MAX } from './hiddenCommands';

/** Rough cap for the auto-growing textarea — about a dozen lines. */
const MAX_AREA_HEIGHT = 240;

/**
 * "Edit summary…" from the session context menu: edits the session's
 * summary annotation (ShellSession.summary — the panel renders it
 * `line-clamp-3`). The editing column is sized to the session row's width,
 * so line wraps match the panel: a hidden mirror of the panel's summary
 * element decides when the text runs past three lines and the "will be
 * shortened" warning shows.
 */
export function EditSessionSummaryModal({
  session,
  width,
  onSave,
  onCancel,
}: {
  session: ShellSession;
  /** Session row width in px — the textarea column matches it. */
  width?: number;
  /** Trimmed text; '' clears the summary. */
  onSave: (summary: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(session.summary);
  const [clamped, setClamped] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const columnWidth = width ?? 256;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Auto-grow the textarea with the content (capped, then scrolls).
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_AREA_HEIGHT)}px`;
  }, [text]);

  // The mirror reproduces the panel's summary element exactly — same
  // classes and width — so scrollHeight > clientHeight means the
  // line-clamp-3 cuts text off in the panel.
  useLayoutEffect(() => {
    const el = mirrorRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, columnWidth]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const save = () => onSave(text.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative w-max max-w-[95vw] rounded-[var(--radius-xl)] bg-[var(--elevated)] p-5 shadow-[var(--shadow-pop)]">
        <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">
          <Trans>Session summary</Trans>
        </h2>
        <div style={{ width: columnWidth }}>
          <textarea
            ref={areaRef}
            rows={3}
            maxLength={SESSION_SUMMARY_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
            className="w-full resize-none overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            style={{ fontFamily: 'inherit' }}
          />
          {clamped && (
            <p className="mt-2 text-[11px] text-[var(--orange)]">
              <Trans>
                This text is longer than three lines — it will be shortened in the session list.
              </Trans>
            </p>
          )}
          {/* Off-flow copy of the panel's summary element — measured to
              detect the three-line clamp. */}
          <div
            ref={mirrorRef}
            aria-hidden
            className="invisible absolute left-0 top-0 line-clamp-3 whitespace-pre-line break-words px-2 pb-1.5 text-xs"
            style={{ width: columnWidth }}
          >
            {text}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-secondary)]">
            {text.length}/{SESSION_SUMMARY_MAX}
          </span>
          <div className="flex gap-2">
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
    </div>
  );
}
