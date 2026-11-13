import { useEffect } from 'react';
import { MemoryStick } from 'lucide-react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention } from '../../types';
import { useMemoryStats } from '../useMemoryStats';

function formatKbParts(kb: number): { value: string; unit: string } {
  if (kb >= 1024 * 1024) return { value: (kb / 1024 / 1024).toFixed(1), unit: 'GB' };
  if (kb >= 1024) return { value: `${Math.round(kb / 1024)}`, unit: 'MB' };
  return { value: `${kb}`, unit: 'KB' };
}

function formatKb(kb: number): string {
  const { value, unit } = formatKbParts(kb);
  return `${value} ${unit}`;
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

/**
 * One strip of a rail pressure gauge. The percentage is written into the
 * bar itself: the label renders once in track color across the strip and
 * again in inverted color clipped to the fill's width, so glyphs flip color
 * where the fill passes under them.
 */
export function BarStrip({ pct, color, tip }: { pct: number; color: string; tip: string }) {
  const text =
    'pointer-events-none absolute inset-y-0 left-0 flex w-7 items-center justify-center text-[8px] font-bold leading-none';
  return (
    <div className="relative h-3 w-7 bg-[var(--surface)]" data-tip={tip}>
      <div
        className="absolute inset-y-0 left-0 transition-all duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
      <span className={`${text} text-[var(--text-secondary)]`}>{pct}%</span>
      <div
        className="absolute inset-y-0 left-0 overflow-hidden transition-all duration-500"
        style={{ width: `${pct}%` }}
      >
        <span className={`${text} text-[var(--text-inverted)]`}>{pct}%</span>
      </div>
    </div>
  );
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
  const free = formatKbParts(stats.availableKb);
  const used = formatKbParts(usedKb);
  return (
    <div data-tip={title} className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-0.5">
        <div className="flex flex-col items-center gap-0.5">
          <span
            className="select-none text-[7px] font-bold leading-none"
            style={{ color }}
          >
            {free.value}
          </span>
          <span className="select-none text-[7px] font-bold leading-none text-[var(--text-primary)]">
            {used.value}
          </span>
        </div>
        <MemoryStick className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
      </div>
      <div className="mt-0.5 overflow-hidden rounded-sm border border-[var(--border)]">
        <BarStrip pct={usedPct} color={color} tip={title} />
      </div>
    </div>
  );
}

export const ramPlugin: SessionViewPlugin = {
  id: 'ram',
  title: 'RAM usage',
  version: '0.1.0',
  defaultEnabled: false,
  needsMemoryStats: true,
  sessionFields: [
    {
      id: 'memory',
      label: 'Session memory',
      kind: 'block',
      zone: 'selected',
      value: (ctx) => <RamSessionView sessionId={ctx.session.id} />,
    },
  ],
  renderRail: ({ setAppAttention }) => <RamRailView setAppAttention={setAppAttention} />,
};
