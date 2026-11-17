/**
 * Class names shared by the app chrome (rail, session panel, strips, plugin
 * view headers), kept in one place so every surface uses the same metrics
 * and states. They only reference the design tokens from styles.css:
 *
 * - hover is a neutral fill (`--fill-1`), pressed `--fill-2`, selection
 *   `--fill-accent` — no accent colour swap, no borders
 * - regions are separated by a hairline, drawn as an inset shadow so the
 *   strip's content box keeps its full height
 */

/** A 40px top strip: tab strips, plugin view headers. */
export const stripClass =
  'flex h-10 shrink-0 items-center shadow-[inset_0_-1px_0_var(--hairline)]';

/** Borderless icon button (28px) for toolbars and view headers. */
export const ghostButtonClass =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)] active:bg-[var(--fill-2)] disabled:pointer-events-none disabled:opacity-40';

/** Same button in its "on" state (a toggled view option). */
export const ghostButtonActiveClass =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--fill-2)] text-[var(--text-primary)] transition-colors duration-[var(--dur-1)]';

/** Filled text button — the one primary action of a view. */
export const primaryButtonClass =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--text-inverted)] transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40';

/** Neutral text button. */
export const secondaryButtonClass =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--fill-2)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--hairline-strong)] disabled:pointer-events-none disabled:opacity-40';

/** Text button without a fill. */
export const quietButtonClass =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40';

/** Single-line text field. */
export const fieldClass =
  'h-7 min-w-0 rounded-[var(--radius-md)] bg-[var(--bg)] px-2 text-xs text-[var(--text-primary)] outline-none shadow-[inset_0_0_0_1px_var(--hairline-strong)] placeholder:text-[var(--text-tertiary)] focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--ring)]';
