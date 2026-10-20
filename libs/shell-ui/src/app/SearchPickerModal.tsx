import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, FolderPlus, Layers, Search } from 'lucide-react';

/** One row of a `SearchPickerModal`. */
export interface PickerItem {
  key: string;
  label: string;
  /** Secondary text after the label (description, cli · model, …). */
  detail?: string;
  /** Rows sharing a group render under one header, in first-seen order. */
  group?: string;
  /** Shown but not pickable — e.g. the session's current workspace. */
  disabled?: boolean;
  /** Short trailing marker, e.g. "current". */
  badge?: ReactNode;
}

/** Case-insensitive match on label, detail or group. */
export function filterPickerItems(items: PickerItem[], query: string): PickerItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) =>
    [it.label, it.detail, it.group].some((field) => field?.toLowerCase().includes(q)),
  );
}

/**
 * Searchable list picker — the shared modal behind "Move to workspace…",
 * "New session with agent…" and "Start workflow…". Rows can be grouped
 * (headers), disabled and badged; an optional create row offers the typed
 * text as a new entry. ↑/↓ move, Enter picks, Esc or a backdrop click closes.
 */
export function SearchPickerModal({
  title,
  placeholder,
  items,
  onPick,
  onClose,
  createLabel,
  onCreate,
}: {
  title: ReactNode;
  placeholder?: string;
  items: PickerItem[];
  onPick: (item: PickerItem) => void;
  onClose: () => void;
  /** Label of the create row for the typed text; null hides the row. */
  createLabel?: (query: string) => ReactNode | null;
  onCreate?: (query: string) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = filterPickerItems(items, query);
  const trimmed = query.trim();
  const createRow = trimmed && onCreate ? createLabel?.(trimmed) ?? null : null;
  const rowCount = matches.length + (createRow ? 1 : 0);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  const choose = (index: number) => {
    if (index < matches.length) {
      if (!matches[index].disabled) onPick(matches[index]);
    } else if (createRow) {
      onCreate?.(trimmed);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rowCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[420px] max-w-[92vw] flex-col rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-[var(--border)] px-3 py-2">
          <div className="mb-1.5 truncate text-[11px] text-[var(--text-secondary)]">{title}</div>
          <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 focus-within:border-[var(--accent)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder ?? t`Search…`}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent py-1 text-xs text-[var(--text-primary)] outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {rowCount === 0 && (
            <div className="px-2 py-2 text-[11px] text-[var(--text-secondary)]">
              <Trans>No matches.</Trans>
            </div>
          )}
          {matches.map((item, i) => {
            const header = item.group !== undefined && item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && (
                  <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
                    <Layers className="h-3 w-3" />
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  disabled={item.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
                    active === i ? 'bg-[var(--surface-hover)]' : ''
                  } ${item.disabled ? 'cursor-default text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}
                >
                  {item.disabled ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-secondary)]">
                      {item.detail}
                    </span>
                  )}
                  {!item.detail && <span className="flex-1" />}
                  {item.badge && <span className="shrink-0 text-[10px]">{item.badge}</span>}
                </button>
              </div>
            );
          })}
          {createRow && (
            <button
              type="button"
              onMouseEnter={() => setActive(matches.length)}
              onClick={() => choose(matches.length)}
              className={`mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] ${
                active === matches.length ? 'bg-[var(--surface-hover)]' : ''
              }`}
            >
              <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 truncate">{createRow}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
