import { describe, it, expect } from 'vitest';
import { placeMenu } from './ContextMenu';

// 224×300 menu in a 1000×700 window.
const W = 224;
const H = 300;

describe('placeMenu', () => {
  it('opens at the click point when it fits', () => {
    expect(placeMenu(100, 100, W, H, 1000, 700)).toEqual({ x: 100, y: 100 });
  });

  it('opens upward near the bottom edge', () => {
    expect(placeMenu(100, 650, W, H, 1000, 700)).toEqual({ x: 100, y: 350 });
  });

  it('opens leftward near the right edge', () => {
    expect(placeMenu(950, 100, W, H, 1000, 700)).toEqual({ x: 726, y: 100 });
  });

  it('flips both ways in the bottom-right corner', () => {
    expect(placeMenu(950, 650, W, H, 1000, 700)).toEqual({ x: 726, y: 350 });
  });

  it('clamps inside the window when it fits neither way', () => {
    // Click near the top of a short window: below overflows, above goes negative.
    expect(placeMenu(100, 50, W, H, 1000, 320).y).toBe(4);
    // Menu taller than the window: pinned to the top edge (it scrolls).
    expect(placeMenu(100, 100, W, 900, 1000, 700).y).toBe(4);
  });
});
