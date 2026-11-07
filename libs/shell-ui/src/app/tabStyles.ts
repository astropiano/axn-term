/**
 * Class names for one tab on the h-8 tab strips (SessionTabStrip and the
 * plugin-view strip in ShellApp), shared so every strip looks identical.
 *
 * Every item is a real tab, selected or not: all tabs self-stretch to the
 * strip's full height (reaching the top edge), so their labels always sit
 * at the same centered position — selection changes styling, never
 * geometry. Inactive tabs are transparent with a softened outline so the
 * strip's divider line runs under them (brightens on hover).
 *
 * The strips draw their bottom divider as an inset shadow, not a border —
 * a real border shrinks the strip's content box, and a full-height tab
 * plus the -mb-px merge trick then overflows one pixel, which
 * overflow-x-auto turns into a vertical scrollbar.
 *
 * 'tab' (the default) draws the ACTIVE tab as the connected one: it takes
 * the content background (--bg — the same fill the workspaces panel and
 * the views below the strip use), rounds its top corners, and rides 1px
 * over the strip's bottom border so it visually connects to the view
 * below. An accent band on its top edge marks it as the selection — drawn
 * as an inset shadow (top border traded for 1px padding, like the
 * selected session row's left band) so its ends curve along the rounded
 * corners instead of stopping flat at the side borders. 'underline' is
 * the previous accent-tint pill, 'trapezoid' slants the sides via
 * clip-path — both kept for the Storybook comparison.
 */
export type TabStripTabVariant = 'tab' | 'underline' | 'trapezoid';

export function tabStripTabClasses(
  active: boolean,
  variant: TabStripTabVariant = 'tab',
): string {
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
