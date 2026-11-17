import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useSettings } from '../../SettingsProvider';
import { TAG_SLOTS, themeTagPalette } from '../../themes';
import { parseHexColor } from './taggingModel';
import { isHexColor, resolveColour } from './tint';

/** `<input type="color">` only takes `#rrggbb`. */
const pickerValue = (hex: string) =>
  hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7);

/**
 * Pick a tag colour: one of the active theme's eight tag colours (stored by
 * slot name, so it follows the theme), or any raw hex via the native picker
 * or a hex box that takes typed or pasted `#abc` / `abc` / `#aabbcc`.
 */
export function TagColorInput({
  value,
  label,
  onChange,
  autoFocus,
}: {
  /** A theme slot name or a hex value. */
  value: string;
  label: string;
  onChange: (token: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useLingui();
  const { activeTheme } = useSettings();
  const palette = themeTagPalette(activeTheme);
  const hex = resolveColour(value, palette) ?? palette.blue;
  const raw = isHexColor(value) ? value.toLowerCase() : null;
  const [draft, setDraft] = useState(raw ?? '');
  useEffect(() => setDraft(raw ?? ''), [raw]);
  const parsed = draft === '' ? null : parseHexColor(draft);
  const invalid = draft !== '' && parsed === null;

  const commit = (input: string) => {
    const next = parseHexColor(input);
    if (next && next !== value) onChange(next);
    if (next) setDraft(next);
  };

  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-1">
      {TAG_SLOTS.map((slot) => (
        <button
          key={slot}
          type="button"
          aria-label={t`${label}: theme ${slot}`}
          aria-pressed={value === slot}
          title={slot}
          onClick={() => value !== slot && onChange(slot)}
          className={`h-4 w-4 shrink-0 rounded-full ring-offset-1 ring-offset-[var(--elevated)] ${
            value === slot ? 'ring-2 ring-[var(--text-primary)]' : 'hover:ring-1 hover:ring-[var(--text-secondary)]'
          }`}
          style={{ backgroundColor: `var(--tag-${slot}, ${palette[slot]})` }}
        />
      ))}
      <input
        type="color"
        aria-label={label}
        value={pickerValue(hex)}
        onChange={(e) => commit(e.currentTarget.value)}
        className={`ml-1 h-5 w-6 cursor-pointer rounded border bg-transparent p-0 ${
          raw ? 'border-[var(--text-primary)]' : 'border-[var(--border)]'
        }`}
      />
      <input
        type="text"
        aria-label={t`${label} (hex)`}
        value={draft}
        placeholder={hex}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (parseHexColor(pasted)) {
            e.preventDefault();
            commit(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(raw ?? '');
          }
        }}
        onBlur={() => (parsed ? commit(draft) : setDraft(raw ?? ''))}
        className={`w-[76px] rounded border bg-[var(--bg)] px-1 font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] ${
          invalid ? 'border-[var(--red)]' : 'border-[var(--border)] focus:border-[var(--accent)]'
        }`}
      />
    </span>
  );
}
