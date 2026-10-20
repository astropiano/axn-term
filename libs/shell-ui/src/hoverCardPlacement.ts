/** Gap between the pointer and a card shown below it (clears the cursor). */
const BELOW_OFFSET = 14;
/** Gap between a card flipped above the pointer and the hovered line. */
const ABOVE_GAP = 8;
/** Minimum distance kept from the container edges. */
const MARGIN = 4;

export interface HoverCardPlacementInput {
  /** Pointer position relative to the container. */
  anchorX: number;
  anchorY: number;
  /** Measured card size. */
  width: number;
  height: number;
  containerWidth: number;
  containerHeight: number;
}

/**
 * Where to put a link hover card so it stays fully visible: below and to the
 * right of the pointer by default, flipped above the pointer when it does not
 * fit below (a link on the bottom rows), and to the pointer's left when it
 * does not fit to the right. A card larger than the container is clamped to
 * its top/left edge.
 */
export function placeHoverCard({
  anchorX,
  anchorY,
  width,
  height,
  containerWidth,
  containerHeight,
}: HoverCardPlacementInput): { left: number; top: number } {
  const clamp = (v: number, size: number, limit: number) =>
    Math.min(Math.max(v, MARGIN), Math.max(limit - size - MARGIN, MARGIN));

  const fitsRight = anchorX + width <= containerWidth - MARGIN;
  const left = clamp(fitsRight ? anchorX : anchorX - width, width, containerWidth);

  const fitsBelow = anchorY + BELOW_OFFSET + height <= containerHeight - MARGIN;
  const top = clamp(
    fitsBelow ? anchorY + BELOW_OFFSET : anchorY - ABOVE_GAP - height,
    height,
    containerHeight,
  );
  return { left, top };
}
