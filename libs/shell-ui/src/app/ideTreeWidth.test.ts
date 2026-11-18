import { describe, expect, it } from 'vitest';
import { IDE_TREE_DEFAULT_WIDTH, clampTreeWidth } from './ideTreeWidth';

describe('clampTreeWidth', () => {
  it('keeps a width inside the view', () => {
    expect(clampTreeWidth(400, 1200)).toBe(400);
  });

  it('never goes below the minimum', () => {
    expect(clampTreeWidth(20, 1200)).toBe(160);
  });

  it('leaves the editor at least 240px', () => {
    expect(clampTreeWidth(1100, 1200)).toBe(960);
  });

  it('applies only the minimum when the view width is unknown', () => {
    expect(clampTreeWidth(2000, 0)).toBe(2000);
    expect(clampTreeWidth(10, 0)).toBe(160);
  });

  it('defaults to the previous fixed width', () => {
    expect(IDE_TREE_DEFAULT_WIDTH).toBe(224);
  });
});
