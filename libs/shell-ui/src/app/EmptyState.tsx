import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

/**
 * Empty / onboarding state for a view: an icon tile, a title that says what
 * the view will show, a short explanation and the next step(s) in
 * `children`. Left-aligned in a readable column, centred in wide views.
 */
export function EmptyState({
  icon,
  title,
  children,
  description,
  footer,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col px-2 pb-4 pt-6">
      {icon && (
        <span className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-[11px] bg-[var(--fill-accent)] text-[var(--accent)] [&>*]:h-5 [&>*]:w-5">
          {icon}
        </span>
      )}
      <h3 className="text-base font-semibold leading-snug tracking-[-0.01em] text-[var(--text-primary)]">
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)] [&_b]:font-semibold [&_b]:text-[var(--text-primary)]">
          {description}
        </p>
      )}
      {children}
      {footer && <div className="mt-4 text-xs text-[var(--text-tertiary)]">{footer}</div>}
    </div>
  );
}

/** Card that holds the `SetupStep`s of an onboarding state. */
export function SetupSteps({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 divide-y divide-[var(--hairline)] rounded-[var(--radius-lg)] bg-[var(--raised)] shadow-[0_0_0_1px_var(--hairline)]">
      {children}
    </div>
  );
}

/**
 * One numbered step: `done` shows a check, `current` is the step to act on
 * now, `todo` is waiting for an earlier one.
 */
export function SetupStep({
  index,
  state,
  title,
  children,
}: {
  index: number;
  state: 'done' | 'current' | 'todo';
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 px-3.5 py-3.5">
      <span
        className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
          state === 'done'
            ? 'bg-[color-mix(in_srgb,var(--green)_20%,transparent)] text-[var(--green)]'
            : state === 'current'
              ? 'bg-[var(--accent)] text-[var(--text-inverted)]'
              : 'text-[var(--text-tertiary)] shadow-[inset_0_0_0_1.5px_var(--hairline-strong)]'
        }`}
      >
        {state === 'done' ? <Check className="h-3 w-3" style={{ strokeWidth: 2.6 }} /> : index}
      </span>
      <div className="min-w-0">
        <div
          className={`text-[13px] font-semibold leading-[22px] ${
            state === 'todo' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'
          }`}
        >
          {title}
        </div>
        {children && (
          <div className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{children}</div>
        )}
      </div>
    </div>
  );
}
