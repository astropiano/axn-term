import { createContext, useContext, type ReactNode } from 'react';

export type RailTone = 'neutral' | 'accent' | 'success' | 'warning' | 'attention';

const badgeTone: Record<RailTone, string> = {
  neutral: 'bg-[var(--elevated)] text-[var(--text-primary)]',
  accent: 'bg-[var(--accent)] text-[var(--text-inverted)]',
  success: 'bg-[var(--green)] text-[var(--text-inverted)]',
  warning: 'bg-[var(--orange)] text-[var(--text-inverted)]',
  attention: 'bg-[var(--attention)] text-white',
};

const pipTone: Record<Exclude<RailTone, 'neutral'> | 'setup', string> = {
  accent: 'bg-[var(--accent)]',
  success: 'bg-[var(--green)]',
  warning: 'bg-[var(--orange)]',
  attention: 'bg-[var(--attention)]',
  // hollow ring: "not set up yet"
  setup: 'bg-[var(--chrome)] shadow-[0_0_0_2px_var(--chrome),inset_0_0_0_1.5px_var(--yellow)]',
};

/**
 * Keyboard shortcut of the rail slot being rendered (`⌘3`, plus the
 * `aria-keyshortcuts` form) — provided by the rail host around each plugin's
 * `renderRail`, so the slot's clickable item can show it in its tooltip
 * without every plugin knowing its position.
 */
export const RailShortcutContext = createContext<{ label: string; aria?: string } | undefined>(
  undefined,
);

/**
 * One slot of the left rail: a 36px target with an 18px icon, shared by the
 * built-in rail controls and by plugins (`renderRail`) so every item has
 * the same size and the same hover / active treatment.
 *
 * - `active` marks the item whose view is open (accent fill + indicator)
 * - `badge` is a small count pill, `pip` a state dot; both sit top-right
 * - without `onClick` the item is a passive indicator (no hover state)
 *
 * The tooltip is short and appears to the right of the item: `title` is the
 * tool's name, a clickable item adds its slot's keyboard shortcut
 * (RailShortcutContext) after it — "Docker (⌘3)" — and `status` is at most
 * one short line that matters right now ("2 waiting for you", "daemon not
 * running"). Numbers and details belong in the tool's accordion at the
 * bottom of the session panel (`PublishPanelStatus`), not in the tooltip.
 */
export function RailItem({
  title,
  status,
  onClick,
  active,
  muted,
  badge,
  badgeTone: tone = 'neutral',
  pip,
  children,
}: {
  /** The tool's name — the tooltip's first line and the accessible name. */
  title: string;
  /** One short status line under the name. */
  status?: string;
  onClick?: () => void;
  active?: boolean;
  /** Dim the icon (e.g. a view that is not set up yet). */
  muted?: boolean;
  badge?: ReactNode;
  badgeTone?: RailTone;
  pip?: keyof typeof pipTone;
  children: ReactNode;
}) {
  const interactive = onClick !== undefined;
  const shortcut = useContext(RailShortcutContext);
  const tip =
    (interactive && shortcut ? `${title} (${shortcut.label})` : title) + (status ? `\n${status}` : '');
  const className = `relative flex h-9 w-9 items-center justify-center rounded-[9px] transition-colors duration-[var(--dur-1)] [&>svg]:h-[18px] [&>svg]:w-[18px] [&>span>svg]:h-[18px] [&>span>svg]:w-[18px] ${
    active
      ? "bg-[var(--fill-accent)] text-[var(--accent)] before:absolute before:-left-2 before:bottom-2.5 before:top-2.5 before:w-[3px] before:rounded-r-full before:bg-[var(--accent)] before:content-['']"
      : interactive
        ? 'text-[var(--text-secondary)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)] active:bg-[var(--fill-2)]'
        : 'text-[var(--text-secondary)]'
  }${muted && !active ? ' [&>svg]:opacity-60 [&>span>svg]:opacity-60' : ''}`;
  const content = (
    <>
      {children}
      {badge !== undefined && badge !== null && badge !== false && (
        <span
          className={`pointer-events-none absolute right-0 top-px min-w-4 select-none rounded-full px-1 text-center text-[10px] font-semibold leading-4 tabular-nums shadow-[0_0_0_2px_var(--chrome)] ${badgeTone[tone]}`}
        >
          {badge}
        </span>
      )}
      {pip && (
        <span
          className={`pointer-events-none absolute right-[5px] top-[5px] h-2 w-2 rounded-full ${
            pip === 'setup' ? pipTone.setup : `${pipTone[pip]} shadow-[0_0_0_2px_var(--chrome)]`
          }`}
        />
      )}
    </>
  );
  return interactive ? (
    <button
      type="button"
      onClick={onClick}
      data-tip={tip}
      data-tip-side="right"
      aria-label={title}
      aria-pressed={active}
      aria-keyshortcuts={shortcut?.aria}
      className={className}
    >
      {content}
    </button>
  ) : (
    <div data-tip={tip} data-tip-side="right" className={className}>
      {content}
    </div>
  );
}
