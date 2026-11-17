import { useEffect } from 'react';
import { MemoryStick } from 'lucide-react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention } from '../../types';
import { useMemoryStats, type MemoryStats } from '../useMemoryStats';
import { publishPanelStatus, type StatusGroup, type StatusLevel } from '../panelStatus';
import { RailItem } from '../RailItem';

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
  return ['var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)'][
    pressureLevel(usedPct, swapUsedKb)
  ];
}

/** The same thresholds as a level: 0 fine, 1 getting tight, 2 near the limit, 3 critical. */
export function pressureLevel(usedPct: number, swapUsedKb: number): StatusLevel {
  if (usedPct >= 90 || swapUsedKb > 2 * 1024 * 1024) return 3;
  if (usedPct >= 80) return 2;
  if (usedPct >= 65 || swapUsedKb > 512 * 1024) return 1;
  return 0;
}

/** Share of RAM in use, 0–100 (0 without a total). */
function usedPercent(stats: Pick<MemoryStats, 'totalKb' | 'availableKb'>): number {
  return stats.totalKb > 0
    ? Math.min(100, Math.round(((stats.totalKb - stats.availableKb) / stats.totalKb) * 100))
    : 0;
}

/**
 * The memory meters for the session panel's "System" accordion: RAM (percent
 * used, absolute numbers, the app's own share) and — when the machine has
 * swap — the swap in use. Colours and levels follow `pressureColor`; swap
 * is judged on its own thresholds. `null` while there are no stats.
 */
export function ramStatusGroup(
  stats: Pick<
    MemoryStats,
    'totalKb' | 'availableKb' | 'swapTotalKb' | 'swapFreeKb' | 'appRssKb'
  > | null,
): StatusGroup | null {
  if (!stats || stats.totalKb === 0) return null;
  const usedPct = usedPercent(stats);
  const usedKb = stats.totalKb - stats.availableKb;
  const swapUsedKb = stats.swapTotalKb - stats.swapFreeKb;
  const meters: StatusGroup['meters'] = [
    {
      label: 'RAM',
      value: `${usedPct}%`,
      detail: `${formatKb(usedKb)} of ${formatKb(stats.totalKb)} · axn-term ${formatKb(stats.appRssKb)}`,
      pct: usedPct,
      color: pressureColor(usedPct, 0),
      level: pressureLevel(usedPct, 0),
      tip: `RAM ${usedPct}% used (${formatKb(usedKb)} of ${formatKb(stats.totalKb)})\naxn-term itself uses ${formatKb(stats.appRssKb)}`,
    },
  ];
  if (stats.swapTotalKb > 0) {
    meters.push({
      label: 'Swap',
      value: formatKb(swapUsedKb),
      detail: `${formatKb(swapUsedKb)} of ${formatKb(stats.swapTotalKb)}`,
      pct: Math.min(100, Math.round((swapUsedKb / stats.swapTotalKb) * 100)),
      color: pressureColor(0, swapUsedKb),
      level: pressureLevel(0, swapUsedKb),
      tip: `Swap in use: ${formatKb(swapUsedKb)} of ${formatKb(stats.swapTotalKb)}`,
    });
  }
  // Machine-level: shown in the panel's "System" accordion.
  return { title: 'Memory', system: true, meters };
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

/**
 * The detailed rail item: free/used absolute numbers, the memory-stick icon
 * and the pressure strip — the rail counterpart of the System accordion.
 * Renders nothing until stats arrive.
 */
function RamRailDetail() {
  const stats = useMemoryStats();
  if (!stats || stats.totalKb === 0) return null;
  const usedPct = usedPercent(stats);
  const usedKb = stats.totalKb - stats.availableKb;
  const swapUsedKb = stats.swapTotalKb - stats.swapFreeKb;
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
            className="select-none text-[8px] font-bold leading-none"
            style={{ color }}
          >
            {free.value}
          </span>
          <span className="select-none text-[8px] font-bold leading-none text-[var(--text-primary)]">
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

/** The plain rail item — passive icon with the current usage as status. */
function RamRail() {
  const stats = useMemoryStats();
  const usedPct = stats ? usedPercent(stats) : 0;
  const swapUsedKb = stats ? stats.swapTotalKb - stats.swapFreeKb : 0;
  const level = pressureLevel(usedPct, swapUsedKb);
  return (
    <RailItem
      title="RAM usage"
      status={stats && stats.totalKb > 0 ? `${usedPct}% used` : undefined}
      pip={level >= 3 ? 'attention' : level === 2 ? 'warning' : undefined}
    >
      <MemoryStick />
    </RailItem>
  );
}

function RamSessionView({ sessionId }: { sessionId: string }) {
  const stats = useMemoryStats();
  const entry = stats?.sessions.find((s) => s.sessionId === sessionId);
  if (!entry || entry.rssKb === 0) return null;
  return (
    <div
      className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]"
      data-tip="Approximate RSS of this session's process tree"
    >
      <span>RAM</span>
      <span className="text-[var(--text-primary)]">{formatKb(entry.rssKb)}</span>
    </div>
  );
}

/**
 * Headless status source: publishes the memory meters to the session
 * panel's "System" accordion and raises the app attention flag under pressure.
 * Mounted by the app while the plugin is enabled (the panel may be hidden),
 * renders nothing.
 */
function RamStatus({
  setAppAttention,
}: {
  setAppAttention: (attention: SessionAttention | null) => void;
}) {
  const stats = useMemoryStats();
  const usedPct = stats ? usedPercent(stats) : 0;
  const swapUsedKb = stats ? stats.swapTotalKb - stats.swapFreeKb : 0;

  // High memory pressure is worth an app-level "needs attention" flag.
  useEffect(() => {
    setAppAttention(stats && stats.totalKb > 0 ? pressureAttention(usedPct, swapUsedKb) : null);
  }, [setAppAttention, stats, usedPct, swapUsedKb]);

  useEffect(() => {
    publishPanelStatus(ramPlugin.id, ramStatusGroup(stats));
  }, [stats]);
  // Withdraw the meters when the plugin is turned off.
  useEffect(() => () => publishPanelStatus(ramPlugin.id, null), []);

  return null;
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
  panelStatus: ({ setAppAttention }) => <RamStatus setAppAttention={setAppAttention} />,
  renderRail: () => <RamRail />,
  renderRailDetail: () => <RamRailDetail />,
};
