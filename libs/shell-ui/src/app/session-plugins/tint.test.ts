import { describe, expect, it } from 'vitest';
import { isHexColor, resolveTint, tintStyle, tintTextVars } from './tint';

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
    expect(resolveTint([], 'card')).toBeUndefined();
    expect(resolveTint(['red', 'url(x)'], 'card')).toBeUndefined();
  });

  it('paints one colour across the full width', () => {
    expect(resolveTint(['#abc'], 'card')).toBe(
      'linear-gradient(90deg, color-mix(in srgb, #abc var(--tint-card, 32%), var(--chrome)) 0% 100%)',
    );
  });

  it('splits two colours into equal bands, first colour on the left', () => {
    const css = resolveTint(['#ff0000', '#00ff00'], 'card')!;
    expect(css).toContain('color-mix(in srgb, #ff0000 var(--tint-card, 32%), var(--chrome)) 0% 50%');
    expect(css).toContain('color-mix(in srgb, #00ff00 var(--tint-card, 32%), var(--chrome)) 50% 100%');
    expect(css.indexOf('#ff0000')).toBeLessThan(css.indexOf('#00ff00'));
  });

  it('shows a repeated colour once, case-insensitively', () => {
    const css = resolveTint(['#abc', '#ABC'], 'card')!;
    expect(css.match(/color-mix/g)).toHaveLength(1);
  });

  it('caps at four bands and drops invalid entries before counting', () => {
    const css = resolveTint(['#111', 'red', '#222', '#333', '#444', '#555'], 'card')!;
    expect(css.match(/color-mix/g)).toHaveLength(4);
    expect(css).not.toContain('#555');
  });

  it('derives four solid shades of one colour: workspace < card < expanded body < selected title', () => {
    expect(resolveTint(['#abc'], 'workspace')).toContain('#abc var(--tint-workspace, 20%), var(--chrome)');
    expect(resolveTint(['#abc'], 'card')).toContain('#abc var(--tint-card, 32%), var(--chrome)');
    expect(resolveTint(['#abc'], 'selectedCard')).toContain('#abc var(--tint-selected-card, 50%), var(--chrome)');
    expect(resolveTint(['#abc'], 'selectedTitle')).toContain('#abc var(--tint-selected-title, 100%), var(--chrome)');
  });

  it('never mixes with transparent, so stacked tints do not blend', () => {
    for (const level of ['workspace', 'card', 'selectedCard', 'selectedTitle'] as const) {
      expect(resolveTint(['#abc', '#123'], level)).not.toContain('transparent');
    }
  });
});

describe('tintTextVars', () => {
  it('uses dark text on a light colour and light text on a dark one', () => {
    expect(tintTextVars(['#ffb224'])).toMatchObject({ '--text-primary': '#111111' });
    expect(tintTextVars(['#ffffff'])).toMatchObject({ '--text-primary': '#111111' });
    expect(tintTextVars(['#6e56cf'])).toMatchObject({ '--text-primary': '#ffffff' });
    expect(tintTextVars(['#000'])).toMatchObject({ '--text-primary': '#ffffff' });
  });

  it('sets secondary and tertiary text too, and nothing without a valid colour', () => {
    expect(Object.keys(tintTextVars(['#000'])!)).toEqual(['--text-primary', '--text-secondary', '--text-tertiary']);
    expect(tintTextVars(['red'])).toBeUndefined();
  });
});

describe('tintStyle', () => {
  it('carries the tint only as --tint, so a hover class can still repaint it', () => {
    expect(tintStyle('linear-gradient(red, red)')).toEqual({ '--tint': 'linear-gradient(red, red)' });
    expect(tintStyle(undefined)).toBeUndefined();
  });
});
