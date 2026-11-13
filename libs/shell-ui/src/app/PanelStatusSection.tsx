import { useEffect, useId, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import {
  publishPanelStatus,
  splitPanelStatus,
  statusLevelColor,
  usePanelStatus,
  worstStatusLevel,
  type PublishedStatus,
  type StatusGroup,
  type StatusMeter,
} from './panelStatus';

/**
 * Headless helper for plugins: publishes `group` to the panel's status slot
 * while mounted (pass `null` when there is nothing to show) and withdraws
 * it on unmount. Render it next to the plugin's rail item.
 */
export function PublishPanelStatus({
  source,
  group,
}: {
  source: string;
  group: StatusGroup | null;
}) {
  const json = JSON.stringify(group);
  useEffect(() => {
    publishPanelStatus(source, group);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, json]);
  useEffect(() => () => publishPanelStatus(source, null), [source]);
  return null;
}

/** Whether a meter asks for attention (its value is tinted). */
const warns = (meter: StatusMeter) => (meter.level ?? 0) >= 2;

/**
 * "label value" pairs — an accordion's one-line summary. Meters that ask
 * for attention come first: the line shows only the pairs that fit.
 */
function MeterSummary({ meters }: { meters: readonly StatusMeter[] }) {
  // Array.sort is stable: within both halves the publisher's order stays.
  const ordered = [...meters].sort((a, b) => Number(warns(b)) - Number(warns(a)));
  return (
    <>
      {ordered.map((meter, i) => (
        <span key={i} className="whitespace-nowrap">
          <span className="text-[var(--text-tertiary)]">{meter.summaryLabel ?? meter.label}</span>{' '}
          <span
            className={warns(meter) ? 'font-semibold' : undefined}
            style={warns(meter) ? { color: meter.color ?? statusLevelColor(meter.level ?? 0) } : undefined}
          >
            {meter.value}
          </span>
        </span>
      ))}
    </>
  );
}

/** The meters of one group, one row each: bar or explanation, value, details. */
function MeterRows({ meters }: { meters: readonly StatusMeter[] }) {
  return (
    <>
      {meters.map((meter, i) => (
        <div
          key={i}
          data-tip={meter.tip}
          className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1"
        >
          <span className="truncate text-[11px] text-[var(--text-secondary)]">{meter.label}</span>
          {meter.pct !== undefined ? (
            <span className="h-1.5 overflow-hidden rounded-full bg-[var(--fill-2)]">
              <span
                className="block h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.max(0, Math.min(100, meter.pct))}%`,
                  backgroundColor: meter.color ?? 'var(--text-secondary)',
                }}
              />
            </span>
          ) : (
            // A plain number: its explanation takes the bar's place.
            <span className="truncate text-[11px] text-[var(--text-tertiary)]" data-tip={meter.detail}>
              {meter.detail}
            </span>
          )}
          <span
            className={`min-w-10 text-right text-[11px] tabular-nums ${
              warns(meter) ? 'font-semibold' : 'text-[var(--text-primary)]'
            }`}
            style={warns(meter) ? { color: meter.color ?? statusLevelColor(meter.level ?? 0) } : undefined}
          >
            {meter.value}
          </span>
          {meter.pct !== undefined && meter.detail && (
            <span className="col-span-2 col-start-2 break-words text-[10px] leading-4 tabular-nums text-[var(--text-tertiary)]">
              {meter.detail}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * One top-level accordion of the stack: a header (chevron, icon, name and —
 * while collapsed — the one-line `summary`) and the details below it. The
 * header is a real button (Enter/Space, `aria-expanded`) and always one
 * line: the summary is a wrapping row clipped to its first line, so it
 * shows as many whole pairs as fit beside the name and never half a one.
 */
function StatusAccordion({
  icon,
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className="shadow-[inset_0_1px_0_var(--hairline)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex h-8 w-full items-center gap-1.5 px-3 text-left text-[11px] leading-4 transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
        )}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
          {icon}
        </span>
        <span className="shrink-0 font-semibold text-[var(--text-secondary)]">{title}</span>
        {!expanded && (
          <span className="flex h-4 min-w-0 flex-1 flex-wrap content-start items-center justify-end gap-x-2.5 gap-y-2 overflow-hidden tabular-nums text-[var(--text-secondary)]">
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div id={bodyId} className="pb-2 pl-8 pr-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The status stack at the bottom of the session panel, above its footer:
 * what plugins publish to the status slot (`publishPanelStatus`), as
 * separate top-level accordions.
 *
 * - One accordion per tool with statistics, in rail order (`sourceOrder`):
 *   icon, name and — collapsed, the default — one line with its key numbers
 *   as "label value" pairs; expanded, each meter with a bar or its
 *   explanation, the value and the absolute numbers.
 * - "System" last: the machine's own metrics (the groups published with
 *   `system: true`), with a dot in the colour of the worst one.
 *
 * Every accordion keeps its own state (`expandedGroups`, `systemExpanded`).
 * The stack never takes more than about 40% of the panel: beyond that it
 * scrolls on its own, so the session list above keeps its room. Renders
 * nothing while nothing is published.
 */
export function PanelStatusSection({
  systemExpanded,
  onToggleSystem,
  expandedGroups = [],
  onToggleGroup,
  sourceOrder = [],
  renderIcon,
}: {
  /** The "System" accordion. */
  systemExpanded: boolean;
  onToggleSystem: () => void;
  /** Sources whose tool accordion is expanded. */
  expandedGroups?: readonly string[];
  onToggleGroup?: (source: string) => void;
  /** Plugin ids in rail order. */
  sourceOrder?: readonly string[];
  /** Icon of a tool accordion; without it nothing is drawn. */
  renderIcon?: (status: PublishedStatus) => ReactNode;
}) {
  const { t } = useLingui();
  const published = usePanelStatus();
  if (published.length === 0) return null;

  const { tools, system } = splitPanelStatus(published, sourceOrder);
  const systemMeters = system.flatMap(({ group }) => group.meters);

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto" data-panel-status>
      {tools.map((status) => (
        <StatusAccordion
          key={status.source}
          icon={renderIcon?.(status)}
          title={status.group.title}
          summary={<MeterSummary meters={status.group.meters} />}
          expanded={expandedGroups.includes(status.source)}
          onToggle={() => onToggleGroup?.(status.source)}
        >
          <MeterRows meters={status.group.meters} />
        </StatusAccordion>
      ))}
      {system.length > 0 && (
        <StatusAccordion
          icon={<Activity className="h-3.5 w-3.5" />}
          title={t`System`}
          summary={
            <>
              <span
                className="-mr-1 h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ backgroundColor: statusLevelColor(worstStatusLevel(system)) }}
              />
              <MeterSummary meters={systemMeters} />
            </>
          }
          expanded={systemExpanded}
          onToggle={onToggleSystem}
        >
          <MeterRows meters={systemMeters} />
        </StatusAccordion>
      )}
    </div>
  );
}
