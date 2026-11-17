import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * The 40px strip every tab row sits in. Tabs that do not fit scroll
 * horizontally behind chevron buttons and the mouse wheel; the native
 * scrollbar is hidden because the strip doubles as the window's drag
 * region, so grabbing a scrollbar there would move the window instead.
 * Children carrying `data-tab-id === activeTab` are scrolled into view.
 * The bottom divider is an inset shadow: a real border shrinks the content
 * box and a full-height tab would then overflow vertically.
 */
export function TabStrip({
  activeTab,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { activeTab: string }) {
  const { t } = useLingui();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Tabs come and go without the scroller resizing — re-measure every render.
  useLayoutEffect(measure);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const overflowing = edges.left || edges.right;

  // Re-run once the arrows appear: they narrow the scroller after the first pass.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const tab = Array.from(el.children).find(
      (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.tabId === activeTab,
    );
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, overflowing]);

  const scrollBy = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  const arrowClass =
    'flex h-7 w-6 shrink-0 items-center justify-center self-center rounded-[var(--radius-md)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-30';

  return (
    <div
      {...rest}
      className="flex h-10 shrink-0 items-center shadow-[inset_0_-1px_0_var(--hairline)]"
      data-tauri-drag-region
    >
      {overflowing && (
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          disabled={!edges.left}
          aria-label={t`Scroll tabs left`}
          className={`ml-1 ${arrowClass}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      <div
        ref={scrollerRef}
        onScroll={measure}
        onWheel={(e) => {
          if (e.deltaX === 0 && e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-tauri-drag-region
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => scrollBy(1)}
          disabled={!edges.right}
          aria-label={t`Scroll tabs right`}
          className={`mr-1 ${arrowClass}`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
