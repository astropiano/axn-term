import { describe, it, expect } from 'vitest';
import { defaultSettings, resolveTheme, themeDefinitions, themeMap } from './themes';

describe('themes', () => {
  it('defaults to the axn dark theme', () => {
    const theme = resolveTheme(defaultSettings);
    expect(theme.id).toBe('axn-dark');
    expect(theme.mode).toBe('dark');
    expect(themeMap.has('axn-dark')).toBe(true);
  });

  it('falls back to the same mode when a stored theme no longer ships', () => {
    expect(resolveTheme({ ...defaultSettings, theme: 'light', lightTheme: 'gone' }).id).toBe('axn-light');
    expect(resolveTheme({ ...defaultSettings, theme: 'dark', darkTheme: 'gone' }).id).toBe('axn-dark');
  });

  it('keeps a chosen theme that exists', () => {
    expect(resolveTheme({ ...defaultSettings, theme: 'dark', darkTheme: 'dracula' }).id).toBe('dracula');
  });
});

// WCAG contrast ratio of two #rrggbb colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const TEXT = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;
const BRIGHT = ['brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'] as const;

describe('bundled themes stay legible', () => {
  it('ships every theme with a full ui block and unique ids', () => {
    expect(themeDefinitions.length).toBeGreaterThanOrEqual(21);
    expect(new Set(themeDefinitions.map((t) => t.id)).size).toBe(themeDefinitions.length);
    for (const t of themeDefinitions) {
      for (const k of ['bg', 'surface', 'surfaceHover', 'text', 'textSecondary', 'border', 'accent'] as const) {
        expect(t.ui?.[k], `${t.id} ui.${k}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  for (const t of themeDefinitions) {
    it(`${t.id}: text colours meet their contrast targets`, () => {
      const c = t.colors;
      const bg = c.background;
      const at = (k: keyof typeof c, min: number) =>
        expect(contrast(c[k] as string, bg), `${t.id} ${String(k)}`).toBeGreaterThanOrEqual(min);
      at('foreground', t.id.startsWith('solarized') ? 6 : 7);
      for (const k of TEXT) at(k, 4.5);
      for (const k of BRIGHT) at(k, t.mode === 'dark' ? 4.5 : 3);
      at('brightBlack', 3.5);
      if (t.mode === 'dark') at('white', 4.5);
      expect(contrast(c.foreground, c.selectionBackground!), `${t.id} selection`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.ui!.textSecondary!, t.ui!.bg!), `${t.id} ui.textSecondary`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.ui!.accent!, t.ui!.bg!), `${t.id} ui.accent`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
