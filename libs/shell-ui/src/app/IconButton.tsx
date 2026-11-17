import type { MouseEvent, ReactNode } from 'react';

const sizeClass = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
  lg: 'h-8 w-8',
  /** Content-sized — for icon+label actions. */
  auto: 'h-6 w-auto gap-1 bg-[var(--fill-1)] px-2 text-[var(--text-primary)]',
} as const;

/**
 * Borderless icon button for toolbars (session-panel header, settings rows).
 * It is quiet at rest and gets a neutral fill on hover — no outline, no
 * accent swap. `size` picks the box edge (icons size themselves via their
 * own className). `danger` hovers red (destructive actions).
 */
export function IconButton({
  title,
  onClick,
  size = 'md',
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  size?: keyof typeof sizeClass;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-tip={title}
      aria-label={title}
      disabled={disabled}
      className={`flex ${sizeClass[size]} shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)] active:bg-[var(--fill-2)] disabled:opacity-40 ${
        danger ? 'hover:text-[var(--red)]' : 'hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
  // disabled buttons swallow pointer events — carry the tip on the wrapper
  return disabled ? (
    <span className="inline-flex shrink-0" data-tip={title}>
      {button}
    </span>
  ) : (
    button
  );
}
