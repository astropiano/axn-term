import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../SettingsProvider';
import { placeTooltip, type TooltipSide } from './tooltipPlacement';

const SHOW_DELAY_MS = 400;

interface Anchor {
  text: string;
  rect: DOMRect;
  side: TooltipSide;
}

/** The strip the macOS overlay title bar occupies (0 without one). */
function titlebarInset(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h');
  const px = parseFloat(value);
  return Number.isFinite(px) ? px : 0;
}

/**
 * Shared tooltip host — mount once near the app root. Any element carrying a
 * `data-tip` attribute gets a styled bubble on hover (or focus), rendered in a
 * portal at `position: fixed` so it is never clipped by scroll containers.
 * Disabled controls swallow pointer events, so tip their wrapper instead.
 *
 * `data-tip-side="right"` on the same element puts the bubble beside it,
 * vertically centred — used by the rail, where a bubble above or below
 * would cover the neighbouring items. Either way the bubble stays inside
 * the window and out of the title bar strip (see `placeTooltip`).
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
        if (text) {
          setAnchor({
            text,
            rect: el.getBoundingClientRect(),
            side: el.getAttribute('data-tip-side') === 'right' ? 'right' : 'top',
          });
        }
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

  // Measured in a layout effect so the bubble never paints at the wrong
  // spot. (getBoundingClientRect reports on-screen coordinates also inside
  // a CSS-zoomed ancestor such as the rail, so no zoom correction is needed.)
  useLayoutEffect(() => {
    setPos(null);
    if (!anchor || !bubbleRef.current) return;
    const bubble = bubbleRef.current.getBoundingClientRect();
    setPos(
      placeTooltip({
        anchor: anchor.rect,
        width: bubble.width,
        height: bubble.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        side: anchor.side,
        topInset: titlebarInset(),
      }),
    );
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      className={`pointer-events-none fixed z-[70] whitespace-pre-line break-words rounded-[var(--radius-md)] bg-[var(--elevated)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--text-primary)] shadow-[var(--shadow-pop)] ${
        anchor.side === 'right' ? 'max-w-56' : 'max-w-72'
      }`}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span className="block" style={{ zoom: settings.uiZoom ? settings.uiZoom / 100 : undefined }}>
        {anchor.text}
      </span>
    </div>,
    document.body,
  );
}
