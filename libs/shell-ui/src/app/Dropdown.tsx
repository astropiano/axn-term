import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { ContextMenu, menuItemClass } from '../ContextMenu';

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * The app's dropdown — a trigger button plus the shared `ContextMenu` popup,
 * never the browser's `<select>` (whose popup ignores the theme). Arrow keys
 * move through the options, Enter picks, Escape and an outside click close it;
 * the popup is portalled, so panel zoom and overflow cannot clip it.
 */
export function Dropdown<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  widthClass = 'w-56',
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Tailwind width of the popup. */
  widthClass?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  const open = () => {
    const r = trigger.current?.getBoundingClientRect();
    setAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
  };
  const close = () => {
    setAt(null);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={at !== null}
        // The popup closes on an outside mousedown; the trigger toggles it itself.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => (at ? close() : open())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open();
          }
        }}
        className={`flex h-7 min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--bg)] pl-2 pr-1.5 text-xs text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--hairline-strong)] outline-none transition-shadow duration-[var(--dur-1)] hover:bg-[var(--fill-1)] focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--ring)] ${className}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-secondary)]" />
      </button>
      {at && (
        <ContextMenu x={at.x} y={at.y} onClose={close} widthClass={widthClass}>
          <OptionList
            options={options}
            value={value}
            onPick={(v) => {
              onChange(v);
              close();
            }}
          />
        </ContextMenu>
      )}
    </>
  );
}

function OptionList<T extends string>({
  options,
  value,
  onPick,
}: {
  options: DropdownOption<T>[];
  value: T;
  onPick: (value: T) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const current = [...(buttons ?? [])].find((b) => b.getAttribute('aria-selected') === 'true');
    (current ?? buttons?.[0])?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div ref={list} role="listbox" onKeyDown={onKeyDown} className="p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="option"
          aria-selected={o.value === value}
          onClick={() => onPick(o.value)}
          className={menuItemClass}
        >
          <Check className={`h-3 w-3 shrink-0 ${o.value === value ? '' : 'invisible'}`} />
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
