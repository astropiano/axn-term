import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../SettingsProvider';

const SHOW_DELAY_MS = 400;
const GAP = 6;
const EDGE = 4;

interface Anchor {
  text: string;
  rect: DOMRect;
}

/**
 * Shared tooltip host — mount once near the app root. Any element carrying a
 * `data-tip` attribute gets a styled bubble on hover (or focus), rendered in a
 * portal at `position: fixed` so it is never clipped by scroll containers.
 * Disabled controls swallow pointer events, so tip their wrapper instead.
 */
export function TooltipHost() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Element | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { settings } = useSettings();

  useEffect(() => {
    // Touch devices have no hover — a tap on a `data-tip` element would show
    // a sticky bubble until the next tap. Skip tooltips entirely there.
    const coarse = window.matchMedia('(pointer: coarse)');
    if (coarse.matches) return;
    const hide = () => {
      targetRef.current = null;
      clearTimeout(timerRef.current);
      setAnchor(null);
    };
    const schedule = (el: Element) => {
      targetRef.current = el;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (targetRef.current !== el || !el.isConnected) return;
        const text = el.getAttribute('data-tip');
        if (text) setAnchor({ text, rect: el.getBoundingClientRect() });
      }, SHOW_DELAY_MS);
    };
    const onOver = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el === targetRef.current) return;
      if (el) schedule(el);
      else hide();
    };
    const onFocusIn = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el) schedule(el);
    };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
      clearTimeout(timerRef.current);
    };
  }, []);

  // Center on the anchor, place above — flip below when there's no room —
  // and clamp horizontally into the viewport. Measured in a layout effect so
  // the bubble never paints at the wrong spot.
  useLayoutEffect(() => {
    setPos(null);
    if (!anchor || !bubbleRef.current) return;
    const bubble = bubbleRef.current.getBoundingClientRect();
    const rect = anchor.rect;
    const above = rect.top - bubble.height - GAP >= EDGE;
    setPos({
      top: above ? rect.top - bubble.height - GAP : rect.bottom + GAP,
      left: Math.max(
        EDGE,
        Math.min(rect.left + rect.width / 2 - bubble.width / 2, window.innerWidth - bubble.width - EDGE),
      ),
    });
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      className="pointer-events-none fixed z-[70] max-w-64 whitespace-pre-line break-words rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] leading-snug text-[var(--text-primary)] shadow-lg"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span className="block" style={{ zoom: settings.uiZoom ? settings.uiZoom / 100 : undefined }}>
        {anchor.text}
      </span>
    </div>,
    document.body,
  );
}
