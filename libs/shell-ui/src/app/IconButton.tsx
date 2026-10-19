import type { ReactNode } from 'react';

const sizeClass = {
  sm: 'h-5 w-5',
  md: 'h-6 w-6',
  lg: 'h-7 w-7',
  /** Content-sized — for icon+label actions. */
  auto: 'h-5 w-auto px-1',
} as const;

/**
 * Square bordered icon button, matching the session-panel header buttons.
 * `size` picks the box edge (icons size themselves via their own className).
 * `danger` hovers red instead of accent (destructive actions).
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
  onClick: () => void;
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
      className={`flex ${sizeClass[size]} shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] transition hover:bg-[var(--surface-hover)] disabled:opacity-40 ${
        danger
          ? 'text-[var(--text-primary)] hover:text-[var(--red)]'
          : 'text-[var(--text-primary)] hover:text-[var(--accent)]'
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
