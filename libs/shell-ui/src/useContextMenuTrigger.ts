import { useCallback, useRef } from 'react';

export const LONG_PRESS_MS = 600;

/** Finger travel that still counts as a press rather than a scroll. */
const MOVE_TOLERANCE_PX = 10;

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Right-click + long-press menu trigger. Returns handlers to spread onto the
 * target element plus `wrapClick`, which suppresses the click that follows a
 * fired long-press so the row's default action doesn't also run. Touch moves
 * past MOVE_TOLERANCE_PX cancel the press so list scrolling never opens a menu.
 */
export function useContextMenuTrigger(onOpen: (pos: MenuPosition) => void) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const touchOrigin = useRef<MenuPosition | null>(null);

  const startLongPress = useCallback(
    (x: number, y: number) => {
      didLongPress.current = false;
      longPressTimer.current = setTimeout(() => {
        didLongPress.current = true;
        onOpen({ x, y });
      }, LONG_PRESS_MS);
    },
    [onOpen],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchOrigin.current = null;
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onOpen({ x: e.clientX, y: e.clientY });
    },
    [onOpen],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      startLongPress(e.clientX, e.clientY);
    },
    [startLongPress],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const x = touch?.clientX ?? 0;
      const y = touch?.clientY ?? 0;
      touchOrigin.current = { x, y };
      startLongPress(x, y);
    },
    [startLongPress],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const origin = touchOrigin.current;
      if (!origin || !longPressTimer.current) return;
      const touch = e.touches[0];
      if (
        Math.abs((touch?.clientX ?? 0) - origin.x) > MOVE_TOLERANCE_PX ||
        Math.abs((touch?.clientY ?? 0) - origin.y) > MOVE_TOLERANCE_PX
      ) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  const wrapClick = useCallback(
    <T extends React.MouseEvent>(handler?: (e: T) => void) =>
      (e: T) => {
        if (didLongPress.current) {
          didLongPress.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        handler?.(e);
      },
    [],
  );

  return {
    onContextMenu: handleContextMenu,
    onMouseDown: handleMouseDown,
    onMouseUp: cancelLongPress,
    onMouseLeave: cancelLongPress,
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: cancelLongPress,
    onTouchCancel: cancelLongPress,
    cancelLongPress,
    wrapClick,
  };
}
