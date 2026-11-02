/**
 * Class names for one tab on the h-8 tab strips (SessionTabStrip and the
 * plugin-view strip in ShellApp), shared so every strip looks identical.
 *
 * 'tab' (the default) draws the active tab as a real tab: it takes the
 * content background (--bg — the same fill the workspaces panel and the
 * views below the strip use), rounds its top corners, and rides 1px over
 * the strip's bottom border so it visually connects to the view below. A
 * thin accent line on its top edge marks it as the selection. 'underline'
 * is the previous accent-tint pill, 'trapezoid' slants the sides via
 * clip-path — both kept for the Storybook comparison.
 */
export type TabStripTabVariant = 'tab' | 'underline' | 'trapezoid';

export function tabStripTabClasses(
  active: boolean,
  variant: TabStripTabVariant = 'tab',
): string {
  if (!active) {
    return 'h-6 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]';
  }
  switch (variant) {
    case 'underline':
      return "h-6 bg-[var(--accent)]/15 text-[var(--text-primary)] before:absolute before:inset-x-1.5 before:bottom-0 before:h-0.5 before:rounded-full before:bg-[var(--accent)] before:content-['']";
    case 'trapezoid':
      return "h-7 self-end -mb-px bg-[var(--bg)] text-[var(--text-primary)] [clip-path:polygon(6px_0,calc(100%-6px)_0,100%_100%,0_100%)] before:absolute before:top-0 before:inset-x-1.5 before:h-0.5 before:bg-[var(--accent)] before:content-['']";
    default:
      return "h-7 self-end -mb-px rounded-t-md border border-b-0 border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] before:absolute before:top-0 before:inset-x-0 before:h-0.5 before:rounded-t-md before:bg-[var(--accent)] before:content-['']";
  }
}
