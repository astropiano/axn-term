import { describe, expect, it } from 'vitest';
import { isNerdFontName, rankFonts } from './FontPicker';

describe('font picker ordering', () => {
  it('recognises Nerd Font family names', () => {
    expect(isNerdFontName('FiraCode Nerd Font Mono')).toBe(true);
    expect(isNerdFontName('JetBrainsMono Nerd Font')).toBe(true);
    expect(isNerdFontName('MesloLGS NF')).toBe(true);
    expect(isNerdFontName('Hack NFM')).toBe(true);
    expect(isNerdFontName('Fira Code')).toBe(false);
    expect(isNerdFontName('Helvetica Neue')).toBe(false);
  });

  it('puts Nerd Fonts first, then likely monospace fonts, for the terminal', () => {
    const ranked = rankFonts(
      ['Helvetica Neue', 'Menlo', 'FiraCode Nerd Font Mono', 'Arial', 'JetBrains Mono', '.SF NS'],
      'mono',
    );
    expect(ranked).toEqual(['FiraCode Nerd Font Mono', 'JetBrains Mono', 'Menlo', 'Arial', 'Helvetica Neue']);
  });

  it('keeps the given order for the interface font and drops hidden families', () => {
    expect(rankFonts(['Arial', '.SF NS', 'Inter'], 'ui')).toEqual(['Arial', 'Inter']);
  });
});
