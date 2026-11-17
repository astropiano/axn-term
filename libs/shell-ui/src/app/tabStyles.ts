/**
 * Class names for one tab on the tab strips (SessionTabStrip and the
 * plugin-view strip in ShellApp), shared so every strip looks identical.
 *
 * 'pill' (the default): every tab is a 28px rounded pill centred in the
 * 40px strip. Inactive tabs carry a quiet fill and hairline outline so they
 * read as tabs, not loose labels; the active tab gets the accent selection
 * fill, an accent outline, medium weight and a 2px accent band on its left
 * edge — the same mark the selected session card wears. Selection changes
 * fill and outline, never the geometry, so labels do not move.
 *
 * The earlier looks are kept for the Storybook comparison: 'tab' draws the
 * active tab as the connected one (content background, rounded top corners,
 * accent band on its top edge, riding 1px over the strip's divider),
 * 'underline' is an accent-tint pill with an underline, 'trapezoid' slants
 * the sides via clip-path. Their inactive tabs are transparent with a
 * softened outline.
 *
 * The strip itself is `TabStrip`.
 */
export type TabStripTabVariant = 'pill' | 'tab' | 'underline' | 'trapezoid';

export function tabStripTabClasses(
  active: boolean,
  variant: TabStripTabVariant = 'pill',
): string {
  if (variant === 'pill') {
    return active
      ? 'h-7 self-center rounded-[var(--radius-md)] bg-[var(--fill-accent)] font-medium text-[var(--text-primary)] shadow-[inset_2px_0_0_0_var(--accent),inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,transparent)]'
      : 'h-7 self-center rounded-[var(--radius-md)] bg-[var(--fill-1)] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]';
  }
  if (!active) {
    return 'self-stretch rounded-t-md border border-b-0 border-[var(--border)]/60 bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]';
  }
  switch (variant) {
    case 'underline':
      return "h-6 self-center rounded bg-[var(--accent)]/15 text-[var(--text-primary)] before:absolute before:inset-x-1.5 before:bottom-0 before:h-0.5 before:rounded-full before:bg-[var(--accent)] before:content-['']";
    case 'trapezoid':
      return "h-7 self-end -mb-px bg-[var(--bg)] text-[var(--text-primary)] [clip-path:polygon(6px_0,calc(100%-6px)_0,100%_100%,0_100%)] before:absolute before:top-0 before:inset-x-1.5 before:h-0.5 before:bg-[var(--accent)] before:content-['']";
    default:
      return 'self-stretch rounded-t-md border border-b-0 border-[var(--border)] bg-[var(--bg)] pt-px text-[var(--text-primary)] shadow-[inset_0_3px_0_var(--accent)]';
  }
}
