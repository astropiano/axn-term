import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { parseHexColor } from './taggingModel';

/** `<input type="color">` only takes `#rrggbb`. */
const pickerValue = (hex: string) =>
  hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7);

/**
 * A colour swatch (native picker) plus a hex box that takes typed or pasted
 * `#abc` / `abc` / `#aabbcc`. Commits valid input on Enter, blur or paste.
 */
export function TagColorInput({
  value,
  label,
  onChange,
  autoFocus,
}: {
  value: string;
  label: string;
  onChange: (hex: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const parsed = parseHexColor(draft);

  const commit = (raw: string) => {
    const hex = parseHexColor(raw);
    if (hex && hex !== value) onChange(hex);
    if (hex) setDraft(hex);
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <input
        type="color"
        aria-label={label}
        value={pickerValue(value)}
        onChange={(e) => commit(e.currentTarget.value)}
        className="h-5 w-6 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
      />
      <input
        type="text"
        aria-label={t`${label} (hex)`}
        value={draft}
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
            setDraft(value);
          }
        }}
        onBlur={() => (parsed ? commit(draft) : setDraft(value))}
        className={`w-[76px] rounded border bg-[var(--bg)] px-1 font-mono text-[11px] text-[var(--text-primary)] outline-none ${
          parsed ? 'border-[var(--border)] focus:border-[var(--accent)]' : 'border-[var(--red)]'
        }`}
      />
    </span>
  );
}
