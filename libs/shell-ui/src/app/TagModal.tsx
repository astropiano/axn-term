import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Pencil, Tag, Trash2 } from 'lucide-react';
import type { TagRequest } from './tagHost';
import { TagColorInput } from './session-plugins/TagColorInput';
import { cssColour } from './session-plugins/tint';
import {
  addTag,
  derivedTags,
  normalizeTag,
  removeTag,
  renameTag,
  tagColor,
  tagState,
  type TagColorOverrides,
  toggleTag,
} from './session-plugins/taggingModel';

/**
 * Edit the tags of one or more targets. Rows are tri-state across targets
 * (none / some / all carry the tag); Enter on typed text adds it to every
 * target, Enter on an empty box applies.
 */
export function TagModal({
  request,
  colors,
  onColor,
  onApply,
  onClose,
}: {
  request: TagRequest;
  /** Configured colours (plugins.yaml); unset names use the derived colour. */
  colors: TagColorOverrides;
  /** Saves a tag's colour right away — not part of Apply. */
  onColor: (name: string, hex: string) => void;
  onApply: (next: string[][]) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [current, setCurrent] = useState(request.targets);
  const [query, setQuery] = useState('');
  const [colouring, setColouring] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const known = derivedTags([...request.others, ...current]);
  const typed = normalizeTag(query);
  const needle = query.trim().toLowerCase();
  const shown = known.filter((name) => name.toLowerCase().includes(needle));
  const exists = typed !== null && known.some((name) => name.toLowerCase() === typed.toLowerCase());

  const addTyped = () => {
    if (!typed) return;
    setCurrent(current.map((tags) => addTag(tags, typed)));
    setQuery('');
  };

  const commitRename = () => {
    if (renaming) setCurrent(current.map((tags) => renameTag(tags, renaming.from, renaming.to)));
    setRenaming(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-[var(--radius-xl)] bg-[var(--elevated)] shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="border-b border-[var(--border)] px-3 py-2">
          <div className="mb-1.5 truncate text-xs text-[var(--text-secondary)]">{request.title}</div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (typed) addTyped();
              else if (query === '') onApply(current);
            }}
            placeholder={t`Type a tag…`}
            spellCheck={false}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {shown.length === 0 && !typed && (
            <div className="px-2 py-2 text-xs text-[var(--text-secondary)]">
              <Trans>No tags yet — type one above.</Trans>
            </div>
          )}
          {shown.map((name) => {
            const state = tagState(current, name);
            return (
              <div key={name} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--surface-hover)]">
                <input
                  type="checkbox"
                  aria-label={name}
                  checked={state === 'all'}
                  ref={(el) => {
                    if (el) el.indeterminate = state === 'some';
                  }}
                  onChange={() => setCurrent(toggleTag(current, name))}
                />
                <button
                  type="button"
                  aria-label={t`Change colour of ${name}`}
                  data-tip={t`Change colour`}
                  onClick={() => setColouring(colouring === name ? null : name)}
                  className="h-3 w-3 shrink-0 rounded-full ring-offset-1 ring-offset-[var(--elevated)] hover:ring-1 hover:ring-[var(--text-secondary)]"
                  style={{ backgroundColor: cssColour(tagColor(name, colors)) }}
                />
                {colouring === name && (
                  <TagColorInput
                    autoFocus
                    value={tagColor(name, colors)}
                    label={t`Colour of ${name}`}
                    onChange={(hex) => onColor(name, hex)}
                  />
                )}
                {renaming?.from === name ? (
                  <input
                    autoFocus
                    value={renaming.to}
                    aria-label={t`New name for ${name}`}
                    onChange={(e) => setRenaming({ from: name, to: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      else if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={commitRename}
                    className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-1 text-xs outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{name}</span>
                )}
                <button
                  type="button"
                  aria-label={t`Rename ${name}`}
                  onClick={() => setRenaming({ from: name, to: name })}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={t`Delete ${name}`}
                  onClick={() => setCurrent(current.map((tags) => removeTag(tags, name)))}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {typed && !exists && (
            <button
              type="button"
              onClick={addTyped}
              className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              <Tag className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1 truncate">
                <Trans>Add tag “{typed}”</Trans>
              </span>
            </button>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1 text-xs text-[var(--text-secondary)]">
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            onClick={() => onApply(current)}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs text-white"
          >
            <Trans>Apply</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
