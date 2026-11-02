import { useEffect } from 'react';
import { MemoryStick } from 'lucide-react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention } from '../../types';
import { useMemoryStats } from '../useMemoryStats';

function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

/**
 * Green → yellow → orange → red as the system runs out of memory.
 * Notable swap usage counts as pressure on its own: once the OS starts
 * paging heavily it is effectively at the RAM limit even if MemAvailable
 * still looks acceptable.
 */
export function pressureColor(usedPct: number, swapUsedKb: number): string {
  if (usedPct >= 90 || swapUsedKb > 2 * 1024 * 1024) return 'var(--red)';
  if (usedPct >= 80) return 'var(--orange)';
  if (usedPct >= 65 || swapUsedKb > 512 * 1024) return 'var(--yellow)';
  return 'var(--green)';
}

/** Attention flag matching the pressure thresholds in pressureColor. */
function pressureAttention(usedPct: number, swapUsedKb: number): SessionAttention | null {
  if (usedPct >= 90 || swapUsedKb > 2 * 1024 * 1024) {
    return { level: 'critical', message: `memory pressure — RAM ${usedPct}% used` };
  }
  if (usedPct >= 80) {
    return { level: 'warning', message: `RAM ${usedPct}% used` };
  }
  return null;
}

function RamSessionView({ sessionId }: { sessionId: string }) {
  const stats = useMemoryStats();
  const entry = stats?.sessions.find((s) => s.sessionId === sessionId);
  if (!entry || entry.rssKb === 0) return null;
  return (
    <div
      className="mb-2 flex items-center gap-1 text-[10px] text-[var(--text-secondary)]"
      data-tip="Approximate RSS of this session's process tree"
    >
      <span className="uppercase tracking-wide">ram</span>
      <span className="text-[var(--text-primary)]">{formatKb(entry.rssKb)}</span>
    </div>
  );
}

function RamRailView({
  setAppAttention,
}: {
  setAppAttention: (attention: SessionAttention | null) => void;
}) {
  const stats = useMemoryStats();
  const usedPct =
    stats && stats.totalKb > 0
      ? Math.min(100, Math.round(((stats.totalKb - stats.availableKb) / stats.totalKb) * 100))
      : 0;
  const swapUsedKb = stats ? stats.swapTotalKb - stats.swapFreeKb : 0;

  // High memory pressure is worth an app-level "needs attention" flag.
  useEffect(() => {
    setAppAttention(stats && stats.totalKb > 0 ? pressureAttention(usedPct, swapUsedKb) : null);
  }, [setAppAttention, stats, usedPct, swapUsedKb]);

  if (!stats || stats.totalKb === 0) return null;
  const usedKb = stats.totalKb - stats.availableKb;
  const color = pressureColor(usedPct, swapUsedKb);
  const title = [
    `RAM ${usedPct}% used (${formatKb(usedKb)} / ${formatKb(stats.totalKb)})`,
    `axn-term ${formatKb(stats.appRssKb)}`,
    stats.swapTotalKb > 0 ? `swap ${formatKb(swapUsedKb)} / ${formatKb(stats.swapTotalKb)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div data-tip={title} className="flex flex-col items-center gap-0.5">
      <MemoryStick className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
      <div className="flex h-3 w-7 items-center overflow-hidden rounded-sm border border-[var(--border)] bg-[var(--surface)]">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${usedPct}%`, background: color }}
        />
      </div>
      <span className="select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]">
        {formatKb(usedKb)}
      </span>
    </div>
  );
}

export const ramPlugin: SessionViewPlugin = {
  id: 'ram',
  title: 'RAM usage',
  version: '0.1.0',
  defaultEnabled: false,
  needsMemoryStats: true,
  render: (ctx) => <RamSessionView sessionId={ctx.session.id} />,
  renderRail: ({ setAppAttention }) => <RamRailView setAppAttention={setAppAttention} />,
};
