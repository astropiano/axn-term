/** Percentage of a colour mixed into the surface, per tint target. */
export const TINT_INTENSITY = { selected: 30, idle: 12, workspace: 12 } as const;

export type TintIntensity = keyof typeof TINT_INTENSITY;

const MAX_BANDS = 4;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/**
 * CSS `background-image` of equal left-to-right bands, one per distinct valid
 * hex colour (first {@link MAX_BANDS}); `undefined` when none is valid.
 */
export function resolveTint(colours: readonly string[], intensity: TintIntensity): string | undefined {
  const seen = new Set<string>();
  const bands: string[] = [];
  for (const colour of colours) {
    if (!isHexColor(colour) || seen.has(colour.toLowerCase())) continue;
    seen.add(colour.toLowerCase());
    bands.push(colour);
    if (bands.length === MAX_BANDS) break;
  }
  if (bands.length === 0) return undefined;
  const pct = TINT_INTENSITY[intensity];
  const edge = (i: number) => Math.round((i * 10000) / bands.length) / 100;
  const stops = bands.map(
    (c, i) => `color-mix(in srgb, ${c} ${pct}%, transparent) ${edge(i)}% ${edge(i + 1)}%`,
  );
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
