import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useShellPlatform } from '../services';
import { fontStackAvailable } from '../themes';

/** Names that are (very likely) Nerd Font patched families. */
export function isNerdFontName(name: string): boolean {
  return /\bNerd Font\b|\bNF[MP]?\b|\bfor Powerline\b/i.test(name);
}

const MONO_HINT =
  /mono|code|nerd|\bNF\b|courier|menlo|monaco|consol|fira|jetbrains|hack|meslo|iosevka|cascadia|sauce|plex|terminal|typewriter|fixed|pragmata|inconsolata|andale|commit|berkeley|victor|hasklig|monaspace|geist|ubuntu mono|dejavu sans mono|liberation mono/i;

/**
 * Order the installed families for the picker: for a terminal font the
 * likely-monospace names come first (Nerd Fonts leading), then the rest;
 * for the interface font the list stays alphabetical. Hidden system
 * families (leading dot) are dropped.
 */
export function rankFonts(names: readonly string[], kind: 'mono' | 'ui'): string[] {
  const visible = names.filter((n) => n && !n.startsWith('.'));
  if (kind === 'ui') return [...visible];
  const score = (n: string) => (isNerdFontName(n) ? 0 : MONO_HINT.test(n) ? 1 : 2);
  return [...visible].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

const SAMPLE = {
  // Look-alikes, ligature pairs, then icon glyphs a Nerd Font would draw
  // (folder, branch, check, clock, lock) — tofu here means "no symbols".
  mono: '~/dev/axn-term main ❯ git status   0O 1lI  != => <= ->       ',
  ui: 'Sessions · Merge requests · Settings — 0123456789',
} as const;

/**
 * Font family field with a live preview and — where the platform can list
 * installed fonts (desktop) — a searchable list in which every family is
 * set in its own face.
 *
 * - Picking a row commits it. Free text still works (a comma-separated
 *   stack, a font the list does not know): it is committed on Enter/blur
 *   once it resolves to something real, and flagged while it does not.
 * - The first row clears the setting (`defaultLabel`, e.g. the built-in or
 *   system font).
 * - The preview line follows the highlighted row, so arrowing through the
 *   list is enough to compare faces.
 */
export function FontPicker({
  value,
  onCommit,
  placeholder,
  defaultLabel,
  kind,
}: {
  value: string;
  onCommit: (family: string) => void;
  placeholder: string;
  /** Label of the "no override" row. */
  defaultLabel: string;
  /** `mono`: terminal/code font (monospace first, code sample). `ui`: interface font. */
  kind: 'mono' | 'ui';
}) {
  const { t } = useLingui();
  const platform = useShellPlatform();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // External value changes (config file edits, other windows) update the field.
  useEffect(() => {
    setText(value);
    setMissing(false);
  }, [value]);

  const loadFonts = () => {
    if (fonts.length || !platform.listFonts) return;
    platform
      .listFonts()
      .then((names) => setFonts(rankFonts(names, kind)))
      .catch(() => {});
  };

  // Typing filters the list — but not while the field still shows the
  // committed value (opening the list should show everything).
  const query = text.trim() === value.trim() ? '' : text.trim().toLowerCase();
  const options = useMemo(
    () => (query ? fonts.filter((n) => n.toLowerCase().includes(query)) : fonts),
    [fonts, query],
  );
  // Row 0 is the "default" row; fonts follow.
  const rowCount = options.length + 1;

  const evaluate = (raw: string) => {
    const family = raw.trim();
    if (!family) {
      setMissing(false);
      if (value) onCommit('');
      return;
    }
    if (fontStackAvailable(family)) {
      setMissing(false);
      if (family !== value) onCommit(family);
    } else {
      // Not installed — keep showing what was typed but do NOT write it into
      // settings (the renderer keeps the last valid font).
      setMissing(true);
    }
  };

  const pick = (family: string) => {
    clearTimeout(debounceRef.current);
    setText(family);
    setMissing(false);
    setOpen(false);
    setActive(-1);
    if (family !== value) onCommit(family);
  };

  // Close on outside press.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const highlighted = open && active > 0 ? options[active - 1] : undefined;
  const previewFamily = highlighted ?? (missing ? value : text.trim()) ?? '';
  const sampleFallback = kind === 'mono' ? 'var(--font-mono)' : 'var(--font-ui)';

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          value={text}
          spellCheck={false}
          onFocus={() => {
            loadFonts();
            setOpen(true);
          }}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setText(v);
            setOpen(true);
            setActive(-1);
            clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => evaluate(v), 500);
          }}
          onBlur={(e) => {
            clearTimeout(debounceRef.current);
            evaluate(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => {
                const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
                return Math.max(0, Math.min(rowCount - 1, next));
              });
            } else if (e.key === 'Enter') {
              if (open && active >= 0) {
                e.preventDefault();
                pick(active === 0 ? '' : options[active - 1]);
              } else {
                clearTimeout(debounceRef.current);
                evaluate(e.currentTarget.value);
                setOpen(false);
              }
            } else if (e.key === 'Escape' && open) {
              // Only close the list — the settings dialog stays open.
              e.stopPropagation();
              setOpen(false);
              setActive(-1);
            }
          }}
          placeholder={placeholder}
          className={`w-full rounded border bg-[var(--bg)] py-1 pl-2 pr-7 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] ${
            missing ? 'border-[var(--orange)]' : 'border-[var(--border)]'
          }`}
        />
        <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
      </div>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          // Keep focus in the input while a row is pressed.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--elevated)] p-1 shadow-[var(--shadow-pop)]"
        >
          <FontRow
            row={0}
            label={defaultLabel}
            selected={!value}
            active={active === 0}
            onPick={() => pick('')}
            onHover={() => setActive(0)}
          />
          {options.map((name, i) => (
            <FontRow
              key={name}
              row={i + 1}
              label={name}
              fontFamily={`"${name}", ${sampleFallback}`}
              nerd={isNerdFontName(name)}
              selected={name === value}
              active={active === i + 1}
              onPick={() => pick(name)}
              onHover={() => setActive(i + 1)}
            />
          ))}
          {query && options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)]">
              <Trans>No matching font</Trans>
            </div>
          )}
        </div>
      )}

      <div
        aria-hidden
        className="mt-1.5 truncate rounded-[var(--radius-sm)] bg-[var(--bg)] px-2 py-1 text-[13px] leading-5 text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--hairline)]"
        style={{
          fontFamily: previewFamily ? `${previewFamily}, ${sampleFallback}` : sampleFallback,
          fontVariantLigatures: 'normal',
        }}
        data-tip={t`Preview`}
      >
        {SAMPLE[kind]}
      </div>
      {missing && (
        <p className="mt-0.5 text-[11px] text-[var(--orange)]">
          <Trans>Font not installed — keeping the previous font.</Trans>
        </p>
      )}
    </div>
  );
}

function FontRow({
  row,
  label,
  fontFamily,
  nerd,
  selected,
  active,
  onPick,
  onHover,
}: {
  row: number;
  label: string;
  fontFamily?: string;
  nerd?: boolean;
  selected: boolean;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      data-row={row}
      onClick={onPick}
      onMouseMove={onHover}
      className={`flex h-7 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 text-[13px] text-[var(--text-primary)] ${
        active ? 'bg-[var(--fill-accent)]' : ''
      }`}
    >
      <span className="flex w-3.5 shrink-0 text-[var(--accent)]">
        {selected && <Check className="h-3.5 w-3.5" style={{ strokeWidth: 2.4 }} />}
      </span>
      <span className="min-w-0 flex-1 truncate" style={fontFamily ? { fontFamily } : undefined}>
        {label}
      </span>
      {nerd && (
        <span className="shrink-0 rounded-[var(--radius-sm)] bg-[color-mix(in_srgb,var(--green)_18%,transparent)] px-1.5 text-[10px] font-semibold leading-[17px] text-[var(--green)]">
          Nerd Font
        </span>
      )}
    </div>
  );
}
