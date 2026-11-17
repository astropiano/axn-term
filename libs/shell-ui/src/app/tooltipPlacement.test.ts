import { describe, expect, it } from 'vitest';
import { placeTooltip } from './tooltipPlacement';

const viewport = { viewportWidth: 1200, viewportHeight: 800 };
const bubble = { width: 120, height: 40 };

describe('placeTooltip — default (above / below)', () => {
  it('centres above the anchor', () => {
    expect(
      placeTooltip({ anchor: { left: 500, top: 300, width: 40, height: 20 }, ...bubble, ...viewport }),
    ).toEqual({ left: 460, top: 254 });
  });

  it('flips below when there is no room above', () => {
    expect(
      placeTooltip({ anchor: { left: 500, top: 20, width: 40, height: 20 }, ...bubble, ...viewport }),
    ).toEqual({ left: 460, top: 46 });
  });

  it('never goes into the title bar strip', () => {
    // Fits above the anchor by pixels, but that spot is under the title bar.
    const pos = placeTooltip({
      anchor: { left: 500, top: 60, width: 40, height: 20 },
      ...bubble,
      ...viewport,
      topInset: 40,
    });
    expect(pos.top).toBe(86); // below the anchor instead
  });

  it('clamps horizontally into the viewport', () => {
    expect(
      placeTooltip({ anchor: { left: 2, top: 300, width: 20, height: 20 }, ...bubble, ...viewport }).left,
    ).toBe(4);
    expect(
      placeTooltip({ anchor: { left: 1180, top: 300, width: 20, height: 20 }, ...bubble, ...viewport }).left,
    ).toBe(1076);
  });
});

describe('placeTooltip — right (rail items)', () => {
  const railItem = (top: number) => ({ left: 8, top, width: 36, height: 36 });

  it('sits to the right of the anchor, vertically centred', () => {
    expect(placeTooltip({ anchor: railItem(300), ...bubble, ...viewport, side: 'right' })).toEqual({
      left: 50,
      top: 298,
    });
  });

  it('stays below the title bar for the first rail item', () => {
    // First item right under the traffic lights: centred would be fine by
    // pixels here, a taller bubble would reach into the strip.
    const tall = { width: 120, height: 90 };
    const pos = placeTooltip({ anchor: railItem(44), ...tall, ...viewport, side: 'right', topInset: 40 });
    expect(pos).toEqual({ left: 50, top: 44 });
  });

  it('is clamped at the bottom of the window', () => {
    const pos = placeTooltip({ anchor: railItem(780), ...bubble, ...viewport, side: 'right' });
    expect(pos.top).toBe(756);
  });

  it('goes to the left when the right side has no room', () => {
    const pos = placeTooltip({
      anchor: { left: 1150, top: 300, width: 36, height: 36 },
      ...bubble,
      ...viewport,
      side: 'right',
    });
    expect(pos.left).toBe(1024);
  });
});
