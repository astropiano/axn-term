import { describe, it, expect } from 'vitest';
import { placeHoverCard } from './hoverCardPlacement';

const box = { width: 384, height: 200, containerWidth: 1000, containerHeight: 600 };

describe('placeHoverCard', () => {
  it('sits below and right of the pointer when it fits', () => {
    expect(placeHoverCard({ ...box, anchorX: 100, anchorY: 100 })).toEqual({ left: 100, top: 114 });
  });

  it('flips above the pointer near the bottom edge', () => {
    // Below would end at 580 + 14 + 200 = 794 > 596.
    expect(placeHoverCard({ ...box, anchorX: 100, anchorY: 580 })).toEqual({ left: 100, top: 372 });
  });

  it('flips left of the pointer near the right edge', () => {
    // Right would end at 900 + 384 = 1284 > 996 → card's right edge at the pointer.
    expect(placeHoverCard({ ...box, anchorX: 900, anchorY: 100 })).toEqual({ left: 516, top: 114 });
  });

  it('flips both ways in the bottom-right corner', () => {
    expect(placeHoverCard({ ...box, anchorX: 900, anchorY: 580 })).toEqual({ left: 516, top: 372 });
  });

  it('clamps a card that fits neither side to the container', () => {
    // Narrow container, pointer at the left: flipping left would go negative.
    expect(
      placeHoverCard({ ...box, containerWidth: 300, anchorX: 50, anchorY: 100 }).left,
    ).toBe(4);
    // Short container: neither above nor below fits → pinned to the top.
    expect(
      placeHoverCard({ ...box, containerHeight: 150, anchorX: 100, anchorY: 100 }).top,
    ).toBe(4);
  });
});
