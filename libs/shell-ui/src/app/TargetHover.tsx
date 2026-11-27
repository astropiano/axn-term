import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeHoverCard } from '../hoverCardPlacement';
import { TargetCard } from './TargetCard';
import { textTargetActions, type TargetAction, type TextTarget } from './textTargets';

const SHOW_DELAY_MS = 450;
const HIDE_DELAY_MS = 250;

/**
 * Wraps an inline element (a chip) that stands for a text target: resting on
 * it opens the target's card as a fixed popover. Only when some plugin
 * offers an action — a target nobody acts on keeps the element as it was
 * (its click and tooltip), so chips don't grow a card that only repeats
 * them.
 */
export function TargetHover({
  target,
  originSessionId,
  children,
}: {
  target: TextTarget;
  originSessionId?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState<{ actions: TargetAction[]; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const clear = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = hideTimer.current = null;
  };
  useEffect(() => clear, []);

  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (open || showTimer.current) return;
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      const el = anchorRef.current;
      if (!el) return;
      const actions = textTargetActions(target, originSessionId);
      if (actions.length === 0) return;
      setOpen({ actions, rect: el.getBoundingClientRect() });
    }, SHOW_DELAY_MS);
  };
  const hide = () => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (cardRef.current?.matches(':hover')) return;
      setOpen(null);
    }, HIDE_DELAY_MS);
  };

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!open || !el) {
      setPos(null);
      return;
    }
    setPos(
      placeHoverCard({
        anchorX: open.rect.left,
        anchorY: open.rect.bottom - 8,
        width: el.offsetWidth,
        height: el.offsetHeight,
        containerWidth: window.innerWidth,
        containerHeight: window.innerHeight,
      }),
    );
  }, [open]);

  return (
    <span ref={anchorRef} className="inline-flex min-w-0" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open &&
        createPortal(
          <div
            ref={cardRef}
            className="fixed z-[1000] w-80 max-w-[calc(100vw-16px)] rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-xl"
            style={{ left: pos?.left ?? open.rect.left, top: pos?.top ?? open.rect.bottom, visibility: pos ? 'visible' : 'hidden' }}
            onMouseEnter={show}
            onMouseLeave={hide}
            // The chip sits inside a session row / kanban card: a click in
            // the card must not select or drag what is underneath.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <TargetCard target={target} actions={open.actions} onDismiss={() => setOpen(null)} />
          </div>,
          document.body,
        )}
    </span>
  );
}
