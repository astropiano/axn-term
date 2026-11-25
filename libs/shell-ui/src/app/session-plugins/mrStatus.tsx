import type { ReactNode } from 'react';
import { chipStyle } from './cardEnrichers';
import { shellServices } from '../../services';

/**
 * The header chip of a session's merge/pull request — one component for the
 * GitLab and GitHub plugins. The colour (`MrTone`) comes from the shared
 * `mrStatusTone` in glabMr.tsx, so both forges classify "your move" the same way.
 */

export type MrTone = 'red' | 'orange' | 'yellow' | 'green' | 'gray';

const SEVERITY: MrTone[] = ['red', 'orange', 'yellow', 'green', 'gray'];

/** The most urgent tone of several (red first). */
export function worstTone(tones: MrTone[]): MrTone {
  return SEVERITY.find((t) => tones.includes(t)) ?? 'gray';
}

export function MrStatusChip({
  tone,
  href,
  tip,
  icon,
  children,
}: {
  tone: MrTone;
  href: string;
  tip: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = shellServices()?.openExternal;
        if (open) open(href);
        else window.open(href, '_blank', 'noopener');
      }}
      onMouseDown={(e) => e.stopPropagation()}
      data-tip={tip}
      data-mr-tone={tone}
      style={chipStyle({ color: tone })}
      className="inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px font-mono text-[9px] font-medium leading-none hover:opacity-80"
    >
      {icon}
      {children}
    </a>
  );
}
