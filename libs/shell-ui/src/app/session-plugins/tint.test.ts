import { describe, expect, it } from 'vitest';
import { isHexColor, resolveTint } from './tint';

describe('isHexColor', () => {
  it.each(['#abc', '#aabbcc', '#aabbccdd', '#ABC'])('accepts %s', (v) => {
    expect(isHexColor(v)).toBe(true);
  });
  it.each(['red', '#12', 'url(x)', '', '#ggg', 12, null, undefined])('rejects %s', (v) => {
    expect(isHexColor(v)).toBe(false);
  });
});

describe('resolveTint', () => {
  it('returns undefined without a valid colour', () => {
    expect(resolveTint([], 'idle')).toBeUndefined();
    expect(resolveTint(['red', 'url(x)'], 'idle')).toBeUndefined();
  });

  it('paints one colour across the full width', () => {
    expect(resolveTint(['#abc'], 'idle')).toBe(
      'linear-gradient(90deg, color-mix(in srgb, #abc 12%, transparent) 0% 100%)',
    );
  });

  it('splits two colours into equal bands, first colour on the left', () => {
    const css = resolveTint(['#ff0000', '#00ff00'], 'idle')!;
    expect(css).toContain('color-mix(in srgb, #ff0000 12%, transparent) 0% 50%');
    expect(css).toContain('color-mix(in srgb, #00ff00 12%, transparent) 50% 100%');
    expect(css.indexOf('#ff0000')).toBeLessThan(css.indexOf('#00ff00'));
  });

  it('shows a repeated colour once, case-insensitively', () => {
    const css = resolveTint(['#abc', '#ABC'], 'idle')!;
    expect(css.match(/color-mix/g)).toHaveLength(1);
  });

  it('caps at four bands and drops invalid entries before counting', () => {
    const css = resolveTint(['#111', 'red', '#222', '#333', '#444', '#555'], 'idle')!;
    expect(css.match(/color-mix/g)).toHaveLength(4);
    expect(css).not.toContain('#555');
  });

  it('uses the stronger intensity for a selected card and the faint one for a workspace', () => {
    expect(resolveTint(['#abc'], 'selected')).toContain('abc 30%');
    expect(resolveTint(['#abc'], 'workspace')).toContain('abc 12%');
  });
});
