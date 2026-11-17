/** Gap between a tooltip and its anchor. */
const GAP = 6;
/** Minimum distance kept from the viewport edges. */
const EDGE = 4;

export type TooltipSide = 'top' | 'right';

export interface TooltipPlacementInput {
  /** The anchor's box in viewport coordinates (`getBoundingClientRect`). */
  anchor: { left: number; top: number; width: number; height: number };
  /** Measured tooltip size. */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * `top` (default): centred above the anchor, below it when there is no
   * room. `right`: beside the anchor, vertically centred — for items in a
   * narrow column such as the rail, where a bubble above or below would
   * cover the neighbours.
   */
  side?: TooltipSide;
  /**
   * Height of a strip at the top of the window that must stay clear — the
   * macOS overlay title bar, whose traffic lights are drawn over the page.
   */
  topInset?: number;
}

/**
 * Where a tooltip goes so that it is fully visible: always inside the
 * viewport and never in the `topInset` strip.
 *
 * - `top`: above the anchor when it fits below the strip, otherwise below
 *   the anchor; horizontally centred and clamped.
 * - `right`: to the right of the anchor (to its left when the right side
 *   has no room), vertically centred on it and clamped.
 */
export function placeTooltip({
  anchor,
  width,
  height,
  viewportWidth,
  viewportHeight,
  side = 'top',
  topInset = 0,
}: TooltipPlacementInput): { left: number; top: number } {
  const minTop = Math.max(EDGE, topInset + EDGE);
  const clampTop = (top: number) => Math.max(minTop, Math.min(top, viewportHeight - height - EDGE));
  const clampLeft = (left: number) => Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE));

  if (side === 'right') {
    const right = anchor.left + anchor.width + GAP;
    const fitsRight = right + width <= viewportWidth - EDGE;
    const left = fitsRight ? right : anchor.left - GAP - width;
    return {
      left: clampLeft(left),
      top: clampTop(anchor.top + anchor.height / 2 - height / 2),
    };
  }

  const above = anchor.top - height - GAP;
  return {
    left: clampLeft(anchor.left + anchor.width / 2 - width / 2),
    top: clampTop(above >= minTop ? above : anchor.top + anchor.height + GAP),
  };
}
