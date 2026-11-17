import type { MouseEvent, ReactNode } from 'react';
import { ghostButtonActiveClass, ghostButtonClass, stripClass } from './chromeStyles';

/**
 * Header strip of a full-area view (plugin views): icon, sentence-case
 * title, an optional `meta` slot right after it (a host chip, "updated 12s
 * ago") and whatever the view puts into `children` — typically a flexible
 * spacer or search field followed by `PanelHeaderButton`s.
 *
 * It is a window drag region (direct clicks on the strip only), so a view
 * that covers the session area still moves the window.
 */
export function PanelHeader({
  icon,
  title,
  meta,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`${stripClass} gap-2 pl-3.5 pr-1.5`} data-tauri-drag-region>
      {icon && (
        <span className="pointer-events-none flex shrink-0 text-[var(--text-secondary)] [&>*]:h-[15px] [&>*]:w-[15px]">
          {icon}
        </span>
      )}
      <span className="pointer-events-none shrink-0 text-[13px] font-semibold text-[var(--text-primary)]">
        {title}
      </span>
      {meta}
      {children}
    </div>
  );
}

/** Flexible gap between the title side and the actions of a `PanelHeader`. */
export function PanelHeaderSpacer() {
  return <div className="pointer-events-none min-w-0 flex-1" />;
}

/** 28px icon action in a `PanelHeader`; `active` marks a toggled option. */
export function PanelHeaderButton({
  title,
  onClick,
  active,
  pressed,
  children,
}: {
  title: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Render in the "on" state. */
  active?: boolean;
  /** Sets `aria-pressed` — pass for toggles. */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tip={title}
      aria-label={title}
      aria-pressed={pressed}
      className={active ? ghostButtonActiveClass : ghostButtonClass}
    >
      {children}
    </button>
  );
}

/** Small monospace chip for a `PanelHeader`'s meta slot (a host, a path). */
export function PanelHeaderChip({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span
      data-tip={title}
      className="inline-flex h-5 min-w-0 shrink items-center gap-1 truncate rounded-full bg-[var(--fill-1)] px-2 font-mono text-[11px] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--hairline)]"
    >
      {children}
    </span>
  );
}
