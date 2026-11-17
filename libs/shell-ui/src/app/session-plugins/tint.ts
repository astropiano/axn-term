import type { CSSProperties } from 'react';
import { isTagSlot, type TagSlot } from '../../themes';

/**
 * Percentage of a colour mixed into the session panel's surface, per tinted
 * part — one colour, four shades: the workspace block, a session card, the
 * selected session card, and the selected card's title row. Mixed with
 * `--chrome`, not `transparent`, so each shade is solid: a tinted card hides
 * its workspace's tint instead of blending with it.
 */
export const TINT_INTENSITY = { workspace: 20, card: 32, selectedCard: 50, selectedTitle: 100 } as const;

export type TintIntensity = keyof typeof TINT_INTENSITY;

const MAX_BANDS = 4;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SURFACE = 'var(--chrome)';

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/**
 * A plugin colour: a hex value, or a theme tag slot name (`blue`) drawn in
 * the active theme's shade of it.
 */
export function isColourToken(value: unknown): value is string {
  return isHexColor(value) || isTagSlot(value);
}

/** Hex of a colour token in the given theme palette; undefined when invalid. */
export function resolveColour(token: unknown, palette: Readonly<Record<TagSlot, string>>): string | undefined {
  if (isHexColor(token)) return token;
  return isTagSlot(token) ? palette[token] : undefined;
}

/** CSS colour of a token — a slot follows the theme via `--tag-<slot>`. */
export function cssColour(token: string): string | undefined {
  if (isHexColor(token)) return token;
  return isTagSlot(token) ? `var(--tag-${token})` : undefined;
}

/** Distinct valid hex colours, in order, at most {@link MAX_BANDS}. */
function bandsOf(colours: readonly string[]): string[] {
  const seen = new Set<string>();
  const bands: string[] = [];
  for (const colour of colours) {
    if (!isHexColor(colour) || seen.has(colour.toLowerCase())) continue;
    seen.add(colour.toLowerCase());
    bands.push(colour);
    if (bands.length === MAX_BANDS) break;
  }
  return bands;
}

/**
 * CSS `background-image` of equal left-to-right solid bands, one per distinct
 * valid hex colour (first {@link MAX_BANDS}); `undefined` when none is valid.
 */
export function resolveTint(colours: readonly string[], intensity: TintIntensity): string | undefined {
  const bands = bandsOf(colours);
  if (bands.length === 0) return undefined;
  const pct = TINT_INTENSITY[intensity];
  const edge = (i: number) => Math.round((i * 10000) / bands.length) / 100;
  const stops = bands.map(
    (c, i) => `color-mix(in srgb, ${c} ${pct}%, ${SURFACE}) ${edge(i)}% ${edge(i + 1)}%`,
  );
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * Inline style carrying a tint as the `--tint` custom property; the element
 * paints it with {@link TINT_CLASS} (a class, so `:hover` can layer over it —
 * an inline `background-image` would beat any hover rule). A custom property
 * also survives DOM implementations that reject `var()` in
 * `background-image` (happy-dom).
 */
export function tintStyle(tint: string | undefined): CSSProperties | undefined {
  return tint ? ({ '--tint': tint } as CSSProperties) : undefined;
}

/** Paints `--tint`. Only on an element that sets it — the property inherits. */
export const TINT_CLASS = '[background-image:var(--tint)]';

/** Hover feedback on a tinted element: the theme's hover fill over the tint. */
export const TINT_HOVER_CLASS = 'hover:[background-image:linear-gradient(var(--fill-1),var(--fill-1)),var(--tint)]';

function luminance(hex: string): number {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Text-colour variables for content on a full-strength tint: dark text on
 * light colours, light text on dark ones (WCAG contrast against black vs
 * white, averaged over the bands). Overriding the variables recolours every
 * child that uses them. `undefined` when no colour is valid.
 */
export function tintTextVars(colours: readonly string[]): CSSProperties | undefined {
  const bands = bandsOf(colours);
  if (bands.length === 0) return undefined;
  const l = bands.reduce((sum, c) => sum + luminance(c), 0) / bands.length;
  const dark = (l + 0.05) / 0.05 >= 1.05 / (l + 0.05);
  const [primary, secondary, tertiary] = dark
    ? ['#111111', 'rgba(0, 0, 0, 0.68)', 'rgba(0, 0, 0, 0.5)']
    : ['#ffffff', 'rgba(255, 255, 255, 0.8)', 'rgba(255, 255, 255, 0.6)'];
  return {
    '--text-primary': primary,
    '--text-secondary': secondary,
    '--text-tertiary': tertiary,
  } as CSSProperties;
}
