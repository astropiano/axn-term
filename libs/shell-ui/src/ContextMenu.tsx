import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Row style for context-menu items. */
export const menuItemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]';

/** Horizontal rule between context-menu item groups. */
export const menuDividerClass = 'my-1 h-px bg-[var(--border)]';

/** Distance kept between a menu and the window edges. */
const EDGE = 4;

/**
 * Where a menu of the given size opens for a click at (x, y): at the click
 * point when it fits, flipped to open up/left of it near the bottom/right
 * window edge, and clamped inside the window when it fits neither way.
 */
export function placeMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const axis = (at: number, size: number, limit: number) => {
    const start = at + size <= limit - EDGE ? at : at - size;
    return Math.min(Math.max(start, EDGE), Math.max(limit - size - EDGE, EDGE));
  };
  return {
    x: axis(x, width, viewportWidth),
    y: axis(y, height, viewportHeight),
  };
}

/**
 * Shared context-menu shell: a fixed-position popup rendered into
 * `document.body` (so ancestor `zoom`/transforms/overflow cannot offset or
 * clip it), measured and placed with `placeMenu` — re-placed whenever its
 * content resizes (async rows, inline confirms) — capped to the window
 * height with scrolling, and closed on outside mousedown or Escape. Wraps
 * arbitrary content — item rows should use `menuItemClass`/`menuDividerClass`
 * for consistent styling.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
  widthClass = 'w-56',
  className = 'rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg',
}: {
  /** Client coordinates of the triggering contextmenu event. */
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  /** Tailwind width class for the popup (e.g. 'w-56', 'w-72'). */
  widthClass?: string;
  /** Surface styling (border, background, shadow, padding). */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Measure before paint so the menu never flashes at an off-screen spot,
  // and again whenever its content (or the window) changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () =>
      setPos(placeMenu(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [x, y]);

  useLayoutEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`fixed z-50 max-h-[calc(100vh-8px)] overflow-y-auto ${widthClass} ${className}`}
      style={{
        left: pos?.x ?? x,
        top: pos?.y ?? y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
