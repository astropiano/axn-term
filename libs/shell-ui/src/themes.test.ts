import { describe, it, expect } from 'vitest';
import { defaultSettings, mixHex, resolveTheme, resolveUiFont, themeDefinitions, themeMap } from './themes';

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
    expect(themeDefinitions.length).toBeGreaterThanOrEqual(33);
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

describe('bundled themes credit their source palette', () => {
  const raw = import.meta.glob('../themes/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('names the upstream source and licence in every ported theme', () => {
    const ported = Object.entries(raw).filter(([path]) => !/\/axn-[^/]+\.yaml$/.test(path));
    expect(ported.length).toBeGreaterThan(0);
    for (const [path, text] of ported) {
      expect(text, path).toMatch(/^# Palette: .+ <https?:\/\/[^>]+>, .+\.$/m);
    }
  });
});

// The chrome tokens in styles.css are derived with color-mix, so no theme
// file lists them — these floors keep every bundled theme usable with them.
describe('derived chrome tokens', () => {
  it('mixHex matches CSS color-mix(in srgb)', () => {
    expect(mixHex('#141110', '#E9E5E2', 0.94)).toBe('#211e1d');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('rgb(0 0 0)', '#ffffff', 0.5)).toBeUndefined();
    expect(mixHex(undefined, '#ffffff', 0.5)).toBeUndefined();
  });

  for (const t of themeDefinitions) {
    it(`${t.id}: text stays readable on the derived chrome`, () => {
      const ui = t.ui!;
      // Same shares as styles.css: --chrome, --text-tertiary.
      const chrome = ui.chrome ?? mixHex(ui.bg, ui.text, 0.94)!;
      const tertiary = mixHex(ui.textSecondary, ui.bg, 0.86)!;
      expect(contrast(ui.text!, chrome), `${t.id} text on chrome`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ui.textSecondary!, chrome), `${t.id} secondary on chrome`).toBeGreaterThanOrEqual(3.9);
      // Tertiary only carries decoration (counts, placeholders) — large-text floor.
      expect(contrast(tertiary, chrome), `${t.id} tertiary on chrome`).toBeGreaterThanOrEqual(3);
      expect(contrast(ui.accent!, chrome), `${t.id} accent on chrome`).toBeGreaterThanOrEqual(3.5);
    });
  }
});

describe('interface font', () => {
  it('is unset by default — the stylesheet system stack applies', () => {
    expect(resolveUiFont(defaultSettings)).toBeUndefined();
    expect(resolveUiFont({ ...defaultSettings, uiFontFamily: '   ' })).toBeUndefined();
  });

  it('appends a generic fallback to a configured family', () => {
    // No layout engine here: the probe stays permissive, the stack is kept.
    expect(resolveUiFont({ ...defaultSettings, uiFontFamily: 'Inter' })).toBe('Inter, system-ui, sans-serif');
    expect(resolveUiFont({ ...defaultSettings, uiFontFamily: 'Inter, sans-serif' })).toBe('Inter, sans-serif');
  });
});
