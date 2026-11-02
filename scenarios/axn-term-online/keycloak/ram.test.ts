import { describe, expect, it } from 'vitest';
import { pressureColor } from './ram';

const MB = 1024;
const GB = 1024 * MB;

describe('pressureColor', () => {
  it('is green below the warning threshold with no swap', () => {
    expect(pressureColor(50, 0)).toBe('var(--green)');
    expect(pressureColor(64, 0)).toBe('var(--green)');
  });

  it('turns yellow once memory is getting tight', () => {
    expect(pressureColor(65, 0)).toBe('var(--yellow)');
    expect(pressureColor(79, 0)).toBe('var(--yellow)');
  });

  it('turns yellow on moderate swap usage even with low RAM usage', () => {
    expect(pressureColor(40, 600 * MB)).toBe('var(--yellow)');
  });

  it('turns orange near the limit', () => {
    expect(pressureColor(80, 0)).toBe('var(--orange)');
    expect(pressureColor(89, 0)).toBe('var(--orange)');
  });

  it('turns red at critical usage or heavy swap', () => {
    expect(pressureColor(90, 0)).toBe('var(--red)');
    expect(pressureColor(95, 0)).toBe('var(--red)');
    expect(pressureColor(40, 3 * GB)).toBe('var(--red)');
  });
});
