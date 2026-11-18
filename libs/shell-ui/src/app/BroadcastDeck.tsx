/**
 * Broadcast deck (`editors[].kind === 'broadcast'`, and the right-side
 * split while ≥2 sessions are selected): a labeled fan-out prompt on
 * top — styled like a shell line (prompt glyph, shell font, terminal
 * surface); Enter writes the buffer to every broadcast session via the
 * same `backend.write` path as `axn-broadcast <line>`, Shift+Enter adds
 * a newline that goes out as a bracketed paste, Escape clears — above
 * columns
 * of real read-only terminals, one per selected session. Tiles replay the
 * retained output buffer then subscribe to `backend.onOutput`, so they
 * render the actual session (colors, cursor, scrollback), not a text
 * tail; input is disabled — click a tile to jump to the real session.
 * When the deck is too narrow for columns a "broadcasting to" name list
 * takes over.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Eye, MoveRight, OctagonAlert, Radio, SendHorizonal, TriangleAlert } from 'lucide-react';
import type { SessionBackend } from '@axn-term/session-backend';
import { activeTabAcceptsInput, ptyIdOf, sessionDisplayName, type ShellSession } from '../types';
import { useBroadcastSet } from './broadcastSet';
import { useSettings } from '../SettingsProvider';
import { resolveShellFont } from '../themes';
import { dangerCheck, type DangerHit } from './broadcastDanger';
import { registerViewFocus } from './viewFocus';

/**
 * Tile = the session's REAL current view (rendered by `renderView` — the
 * same component ShellApp mounts in the main area, single mount: the
 * below view is suppressed for broadcast sessions). A covering overlay
 * blocks all input — tiles are view-only — and hover raises a
 * 'go to session' button that unmarks and focuses the session.
 */
function SessionTile({
  session,
  view,
  blocked,
  onFocus,
}: {
  session: ShellSession;
  view: ReactNode;
  blocked: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      className="group relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden rounded border border-[var(--border)] bg-[var(--surface)] text-left"
      style={{ minWidth: 200 }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1">
        <Radio className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        <span className="truncate text-[11px] font-semibold text-[var(--text-primary)]">
          {sessionDisplayName(session)}
        </span>
        {session.process && (
          <span className="truncate text-[10px] text-[var(--text-secondary)]">
            {session.process}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 rounded bg-[var(--bg)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          <Eye className="h-2.5 w-2.5" />
          view only
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {view}
        {/* input shield — nothing reaches the real view; hover raises the
            go-to-session overlay (z-10 keeps it above the terminal's own
            absolutely-positioned layers, which would otherwise eat the
            pointer and show a text cursor) */}
        <div className="absolute inset-0 z-[5]" />
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/60 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={onFocus}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] shadow-lg hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <MoveRight className="h-3.5 w-3.5" />
            go to session
          </button>
        </div>
      </div>
      {blocked && (
        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--orange)]">
          <OctagonAlert className="h-3 w-3" />
          this view takes no input
        </div>
      )}

    </div>
  );
}

export function BroadcastDeck({
  backend,
  sessions,
  targetSessions,
  renderView,
  onFocusSession,
  focusId,
}: {
  backend: SessionBackend;
  /** Sessions rendered as tiles (excludes the focused session — its real
   * view is in the main area). Defaults to all broadcast targets. */
  sessions: ShellSession[];
  /** Broadcast fan-out targets — all selected sessions, incl. focused. */
  targetSessions?: ShellSession[];
  /** Mounts the session's real current view inside a tile (single mount —
   * ShellApp suppresses the below view for broadcast sessions). */
  renderView?: (session: ShellSession) => ReactNode;
  onFocusSession: (sessionId: string) => void;
  /** Register the broadcast input as the tab's focus target. */
  focusId?: string;
}) {
  const markedIds = useBroadcastSet();
  const { settings } = useSettings();
  // Same font the terminals use — resolves family fallback, default size
  // and uiZoom; raw settings fall back to the page's 16px when unset.
  const shellFont = resolveShellFont(settings);
  const [text, setText] = useState('');
  /** Set while a dangerous buffer awaits the confirm dialog. */
  const [danger, setDanger] = useState<DangerHit | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The tab's focus target for app navigation — typing goes to the
  // broadcast input, which fans out to every target session.
  useEffect(() => {
    if (!focusId) return;
    return registerViewFocus(focusId, () => inputRef.current?.focus());
  }, [focusId]);
  /** Fan-out targets — every selected session, including the one focused
   * below (broadcast reaches it even though it has no tile). */
  const targets = useMemo(
    () =>
      markedIds
        .map((id) => (targetSessions ?? sessions).find((s) => s.id === id))
        .filter((s): s is ShellSession => !!s),
    [markedIds, sessions, targetSessions],
  );
  /** Tile sessions — selected sessions minus the focused one. */
  const tiles = useMemo(
    () =>
      markedIds
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is ShellSession => !!s),
    [markedIds, sessions],
  );
  const marked = targets;
  const blocked = useMemo(
    () => targets.filter((s) => !activeTabAcceptsInput(s)),
    [targets],
  );
  const canSend = targets.length > 0 && blocked.length === 0;

  const fanOut = (value: string) => {
    // A multi-line buffer goes out wrapped as a bracketed paste: shells
    // insert it as literal text instead of running each line — the same
    // trick Shift+Enter uses inside ShellTerminal — then \r submits.
    const payload = value.includes('\n')
      ? `\x1b[200~${value}\x1b[201~\r`
      : `${value}\r`;
    for (const s of marked) void backend.write(ptyIdOf(s), payload);
    setText('');
    const el = inputRef.current;
    if (el) {
      el.style.height = '0';
      el.focus();
    }
  };

  const send = () => {
    const value = text;
    if (!value.trim() || !canSend) return;
    // Danger gate — a broadcast mistake lands on every session at once.
    // Built-in rules + the user's broadcastDangerPatterns from config.yaml.
    const hit = dangerCheck(value, settings.broadcastDangerPatterns);
    if (hit) {
      setDanger(hit);
      return;
    }
    fanOut(value);
  };

  const confirmDanger = () => {
    setDanger(null);
    fanOut(text);
  };

  /** Grow the prompt with its content (shell prompt, not a fixed field). */
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--bg)]" style={{ containerType: 'inline-size' }}>
      <style>{`@container (max-width: 420px) {
        .axn-broadcast-tiles { display: none; }
        .axn-broadcast-names { display: flex; }
      }
      @container (max-width: 560px) {
        .axn-broadcast-hint { display: none; }
      }`}</style>
      {/* Info + fan-out input row — the label lives outside the field. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
          <Radio className="h-3.5 w-3.5 text-[var(--accent)]" />
          Broadcast to:
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
          {marked.length
            ? marked.map(sessionDisplayName).join(', ')
            : 'no sessions selected'}
        </span>
      </div>
      {blocked.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--orange)]/10 px-3 py-1.5 text-[11px] text-[var(--orange)]">
          <OctagonAlert className="h-3.5 w-3.5 shrink-0" />
          {`${blocked.map(sessionDisplayName).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} on a view that takes no input — broadcast paused`}
        </div>
      )}
      {/* The prompt — styled like a shell line on the terminal surface,
          not a boxed form field: accent prompt glyph, shell font, borderless.
          Enter submits to every target; Shift+Enter inserts a newline
          (delivered as a bracketed paste); Escape clears the buffer. */}
      <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1.5">
        <label
          htmlFor="axn-broadcast-input"
          className="shrink-0 select-none py-0.5 font-mono text-[var(--accent)]"
          style={{ fontSize: shellFont.size, lineHeight: shellFont.lineHeight }}
        >
          {'❯'}
        </label>
        <textarea
          id="axn-broadcast-input"
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setText('');
              e.currentTarget.style.height = '0';
            }
          }}
          placeholder={
            targets.length
              ? `type once — Enter runs it on ${targets.length} ${targets.length === 1 ? 'session' : 'sessions'}`
              : 'select sessions to broadcast to'
          }
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          disabled={!canSend}
          style={{
            fontFamily: shellFont.family,
            fontSize: shellFont.size,
            lineHeight: shellFont.lineHeight,
            maxHeight: '10em',
            caretColor: 'var(--accent)',
          }}
          className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-0.5 font-mono text-[var(--text-primary)] outline-none placeholder:italic placeholder:text-[var(--text-secondary)] disabled:opacity-50"
        />
        <span className="axn-broadcast-hint shrink-0 select-none py-0.5 text-[10px] text-[var(--text-secondary)]">
          ↵ send · ⇧↵ newline · esc clear
        </span>
        <button
          type="button"
          onClick={send}
          disabled={!canSend || !text.trim()}
          className="shrink-0 py-0.5 text-[var(--accent)] disabled:text-[var(--text-secondary)]"
          data-tip="send to every selected session"
        >
          <SendHorizonal className="h-4 w-4" />
        </button>
      </div>
      {/* Session columns — real read-only terminals; name list when narrow. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="axn-broadcast-names hidden flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          broadcasting to:{' '}
          {marked.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onFocusSession(s.id)}
              className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-primary)] hover:border-[var(--accent)]"
            >
              {sessionDisplayName(s)}
            </button>
          ))}
          {!marked.length && 'no sessions selected'}
        </div>
        <div className="axn-broadcast-tiles flex h-full min-h-0 gap-2 overflow-x-auto">
          {tiles.map((s) => (
            <SessionTile
              key={s.id}
              session={s}
              view={renderView?.(s)}
              blocked={!activeTabAcceptsInput(s)}
              onFocus={() => onFocusSession(s.id)}
            />
          ))}
          {!marked.length && (
            <div className="w-full py-10 text-center text-sm text-[var(--text-secondary)]">
              nothing selected — Shift/Cmd-click sessions in the panel, or
              axn-broadcast-add
            </div>
          )}
        </div>
      </div>
      {danger && (
        <DangerModal
          hit={danger}
          targetCount={marked.length}
          onCancel={() => {
            setDanger(null);
            inputRef.current?.focus();
          }}
          onConfirm={confirmDanger}
        />
      )}
    </div>
  );
}

/** Danger gate — Enter/Escape cancel (the user just pressed Enter to
 * send, so Enter must never confirm); only the button sends. */
function DangerModal({
  hit,
  targetCount,
  onCancel,
  onConfirm,
}: {
  hit: DangerHit;
  targetCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 max-w-[90vw] rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[var(--orange)]">
          <TriangleAlert className="h-4 w-4" />
          dangerous command
        </h2>
        <p className="mb-1 text-xs text-[var(--text-secondary)]">
          This looks like it {hit.rule} — and it will run on{' '}
          <span className="font-semibold text-[var(--text-primary)]">
            {targetCount} session{targetCount === 1 ? '' : 's'}
          </span>{' '}
          at once:
        </p>
        <pre className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
          {hit.line}
        </pre>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded border border-[var(--orange)] bg-[var(--orange)]/15 px-3 py-1 text-xs font-semibold text-[var(--orange)] hover:bg-[var(--orange)]/25"
          >
            Send to {targetCount} session{targetCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
