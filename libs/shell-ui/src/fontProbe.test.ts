// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  defaultShellFontFamily,
  fontFamilyExists,
  fontStackAvailable,
  resetFontProbeCache,
  resolveShellFont,
} from './themes';

/**
 * A stand-in layout engine: an element's width depends on the first family
 * in its font-family that "exists" — an installed family, else the generic
 * fallback at the end of the stack (serif and monospace differ, as in a
 * real browser).
 */
const INSTALLED = new Set(['fira code', 'firacode nerd font mono']);
const GENERIC_WIDTH: Record<string, number> = { serif: 763.9, monospace: 561.7, 'sans-serif': 803.6 };

function widthFor(fontFamily: string): number {
  for (const raw of fontFamily.split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
    // Fira Code shares the 0.6em advance of the generic monospace font —
    // the case a single-baseline probe gets wrong.
    if (INSTALLED.has(name)) return 561.7;
    if (name in GENERIC_WIDTH) return GENERIC_WIDTH[name];
  }
  return GENERIC_WIDTH.serif;
}

describe('font existence probe', () => {
  beforeEach(() => {
    resetFontProbeCache();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { width: widthFor(this.style.fontFamily), height: 80 } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetFontProbeCache();
  });

  it('finds an installed font, even one as wide as the monospace fallback', () => {
    expect(fontFamilyExists('Fira Code')).toBe(true);
    expect(fontFamilyExists('"FiraCode Nerd Font Mono"')).toBe(true);
  });

  it('rejects names that resolve to nothing', () => {
    expect(fontFamilyExists('NoSuchFontXYZ')).toBe(false);
    // A font file name is neither a family nor a PostScript name.
    expect(fontFamilyExists('FiraCodeNerdFont-Retina')).toBe(false);
  });

  it('does not trust document.fonts.check(), which accepts any unknown name', () => {
    const check = vi.fn(() => true);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { check, ready: Promise.resolve(), [Symbol.iterator]: function* () {} },
    });
    try {
      expect(fontFamilyExists('NoSuchFontXYZ')).toBe(false);
      expect(check).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('accepts a web font registered with the document', () => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        [Symbol.iterator]: function* () {
          yield { family: '"Monaspace Neon"' };
        },
      },
    });
    try {
      expect(fontFamilyExists('Monaspace Neon')).toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('treats generic families and empty input as available', () => {
    expect(fontFamilyExists('monospace')).toBe(true);
    expect(fontFamilyExists('')).toBe(true);
  });

  it('a stack applies when one of its families exists', () => {
    expect(fontStackAvailable('NoSuchFontXYZ, AlsoMissing')).toBe(false);
    expect(fontStackAvailable('NoSuchFontXYZ, Fira Code')).toBe(true);
    expect(fontStackAvailable("'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', monospace")).toBe(true);
    expect(fontStackAvailable('')).toBe(false);
  });

  it('the terminal keeps the built-in stack for a font that does not exist', () => {
    expect(resolveShellFont({ ...defaultSettings, shellFontFamily: 'FiraCodeNerdFont-Retina' }).family).toBe(
      defaultShellFontFamily,
    );
    expect(resolveShellFont({ ...defaultSettings, shellFontFamily: 'Fira Code' }).family).toBe('Fira Code');
  });

  it('stays permissive without a layout engine', () => {
    vi.restoreAllMocks(); // happy-dom itself measures everything as 0
    resetFontProbeCache();
    expect(fontFamilyExists('NoSuchFontXYZ')).toBe(true);
  });
});
