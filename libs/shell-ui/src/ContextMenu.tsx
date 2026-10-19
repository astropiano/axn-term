import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Row style for context-menu items. */
export const menuItemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]';

/** Horizontal rule between context-menu item groups. */
export const menuDividerClass = 'my-1 h-px bg-[var(--border)]';

/**
 * Shared context-menu shell: a fixed-position popup that clamps itself to
 * the viewport (measured, so menus never open off-screen) and closes on
 * outside mousedown or Escape. Wraps arbitrary content — item rows should
 * use `menuItemClass`/`menuDividerClass` for consistent styling.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
  widthClass = 'w-56',
}: {
  /** Client coordinates of the triggering contextmenu event. */
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  /** Tailwind width class for the popup (e.g. 'w-56', 'w-72'). */
  widthClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Measure before paint so the menu never flashes at an off-screen spot.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    const handleClick = (e: MouseEvent) => {
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [x, y, onClose]);

  return (
    <div
      ref={ref}
      className={`fixed z-50 ${widthClass} rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg`}
      style={{
        left: pos?.x ?? x,
        top: pos?.y ?? y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}
