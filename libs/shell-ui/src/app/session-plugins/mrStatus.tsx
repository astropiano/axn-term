import type { ReactNode } from 'react';
import { StatusChip } from '../StatusChip';

/**
 * The header chip of a session's merge/pull request — the shared
 * `StatusChip` coloured by `MrTone`, which the GitLab and GitHub plugins get
 * from the one `mrStatusTone` rule in glabMr.tsx.
 */

export type MrTone = 'red' | 'orange' | 'yellow' | 'green' | 'violet' | 'gray';

const SEVERITY: MrTone[] = ['red', 'orange', 'yellow', 'green', 'violet', 'gray'];

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
    <StatusChip color={tone} href={href} tip={tip} icon={icon}>
      {children}
    </StatusChip>
  );
}
