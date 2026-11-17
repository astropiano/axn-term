import { useSyncExternalStore } from 'react';

/**
 * The status slot at the bottom of the session panel: a stack of accordions
 * for numbers that are read, not clicked.
 *
 * - One accordion per rail tool that has statistics (docker with its VM,
 *   open merge requests, running scenarios, …) — what used to be packed
 *   into rail tooltips. They follow the rail order.
 * - Below them, last, the "System" accordion with the machine's own metrics
 *   (memory, swap): the groups published with `system: true`.
 *
 * Plugins contribute data, the panel draws it: a plugin publishes one group
 * under its id with `publishPanelStatus` (from any component it keeps
 * mounted — its rail item, the `PublishPanelStatus` helper, or the headless
 * `panelStatus` hook of `SessionViewPlugin`) and withdraws it with `null`.
 * Collapsed, an accordion is one line with the group's key numbers;
 * expanded, it lists its meters with details. Nothing published, nothing
 * shown.
 */

/** How loud a meter is: 0 fine, 1 elevated, 2 warning, 3 critical. */
export type StatusLevel = 0 | 1 | 2 | 3;

export interface StatusMeter {
  /** Row label in the expanded section: "RAM", "Swap", "CPU". */
  label: string;
  /** Label in the collapsed line when `label` is too long or unclear there ("Mem", "Running"). */
  summaryLabel?: string;
  /** Short value, shown in both states: "55%", "1.2 GB". */
  value: string;
  /** Absolute numbers under the bar: "17.6 GB of 32.0 GB". */
  detail?: string;
  /** Bar fill, 0–100. Omit for a plain number (a count) — no bar is drawn. */
  pct?: number;
  /** Bar colour (a CSS colour — typically the plugin's pressure colour). */
  color?: string;
  /** Severity — drives the summary dot and tints the value from `2` up. */
  level?: StatusLevel;
  /** Full tooltip of the expanded row. */
  tip?: string;
}

export interface StatusGroup {
  /** The accordion's name: "Docker", "Merge requests" (a heading inside System). */
  title: string;
  /**
   * Machine-level metrics (memory, swap, load): shown in the shared "System"
   * accordion at the bottom instead of an accordion of their own.
   */
  system?: boolean;
  /**
   * Icon of the accordion header — a Lucide icon name ("Bot"). Plugins that
   * declare a `logo` do not need it: the panel uses the plugin's icon.
   */
  icon?: string;
  /**
   * Position among groups the panel has no order for, lower first (default
   * 0); ties keep publish order. Groups of rail tools follow the rail order
   * instead (see `splitPanelStatus`).
   */
  order?: number;
  meters: StatusMeter[];
}

export interface PublishedStatus {
  /** The publisher — a plugin id. */
  source: string;
  group: StatusGroup;
}

let published: PublishedStatus[] = [];
const serialized = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Publish (or, with `null`, withdraw) one source's group. Groups are listed
 * by their `order`, then by when their source first published; an unchanged
 * group is a no-op, so calling this from an effect on every poll is fine. A
 * group without meters counts as withdrawn.
 */
export function publishPanelStatus(source: string, group: StatusGroup | null): void {
  const next = group && group.meters.length > 0 ? group : null;
  const json = next ? JSON.stringify(next) : undefined;
  if (serialized.get(source) === json) return;
  if (next && json !== undefined) {
    serialized.set(source, json);
    const list = published.some((p) => p.source === source)
      ? published.map((p) => (p.source === source ? { source, group: next } : p))
      : [...published, { source, group: next }];
    // Array.sort is stable: equal orders keep their publish order.
    published = list.sort((a, b) => (a.group.order ?? 0) - (b.group.order ?? 0));
  } else {
    serialized.delete(source);
    published = published.filter((p) => p.source !== source);
  }
  emit();
}

/** Everything published right now (stable reference between changes). */
export function currentPanelStatus(): PublishedStatus[] {
  return published;
}

/** Test hook: drop all published groups. */
export function resetPanelStatus(): void {
  published = [];
  serialized.clear();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The published groups, re-rendering on change. */
export function usePanelStatus(): PublishedStatus[] {
  return useSyncExternalStore(subscribe, currentPanelStatus, currentPanelStatus);
}

/** The highest level among the meters of `groups` (0 when there are none). */
export function worstStatusLevel(groups: readonly PublishedStatus[]): StatusLevel {
  let worst: StatusLevel = 0;
  for (const { group } of groups) {
    for (const meter of group.meters) {
      if ((meter.level ?? 0) > worst) worst = meter.level ?? 0;
    }
  }
  return worst;
}

/** Theme colour of a level — the same green → yellow → orange → red the meters use. */
export function statusLevelColor(level: StatusLevel): string {
  return ['var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)'][level];
}

/**
 * The published groups as the panel shows them: `tools` — one accordion
 * each, the rail tools in the order of the rail (`sourceOrder`, plugin ids),
 * followed by tool groups without a rail slot — and `system`, the groups
 * that share the "System" accordion.
 */
export function splitPanelStatus(
  groups: readonly PublishedStatus[],
  sourceOrder: readonly string[],
): { tools: PublishedStatus[]; system: PublishedStatus[] } {
  const rank = new Map(sourceOrder.map((id, i) => [id, i]));
  const unranked = sourceOrder.length;
  return {
    // Array.sort is stable: unranked tools keep the store's order.
    tools: groups
      .filter((p) => !p.group.system)
      .sort((a, b) => (rank.get(a.source) ?? unranked) - (rank.get(b.source) ?? unranked)),
    system: groups.filter((p) => p.group.system),
  };
}

/** Where the panel keeps its own UI state in window state (`pluginData`). */
export const PANEL_UI_KEY = 'axn-panel';

interface StoredPanelUi {
  systemExpanded?: unknown;
  expandedGroups?: unknown;
}

/** Whether the "System" accordion is expanded (default: expanded). */
export function storedSystemExpanded(pluginData: Record<string, unknown>): boolean {
  return (pluginData[PANEL_UI_KEY] as StoredPanelUi | undefined)?.systemExpanded !== false;
}

/** Sources whose tool accordion is expanded (default: none — each is one line). */
export function storedExpandedGroups(pluginData: Record<string, unknown>): string[] {
  const stored = (pluginData[PANEL_UI_KEY] as StoredPanelUi | undefined)?.expandedGroups;
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
}

/** `expandedGroups` after toggling one source. */
export function toggleExpandedGroup(expanded: readonly string[], source: string): string[] {
  return expanded.includes(source) ? expanded.filter((id) => id !== source) : [...expanded, source];
}

/**
 * Where a plugin's status shows (`statusDisplay` in its plugins.yaml
 * section): `panel` — its accordion in the session panel's status stack;
 * `rail` — the rail only: its detailed rail item (`renderRailDetail`) when it
 * has one, else just its plain rail icon, and no accordion either way (the
 * plugin keeps publishing, the panel drops the group). `auto`/unset means
 * the rail on touch devices for plugins with a detailed rail item, the
 * panel otherwise.
 */
export type StatusDisplay = 'panel' | 'rail';

export function resolveStatusDisplay(
  setting: unknown,
  hasRailDetail: boolean,
  coarsePointer: boolean,
): StatusDisplay {
  const v = typeof setting === 'string' ? setting.trim().toLowerCase() : '';
  if (v === 'panel' || v === 'rail') return v;
  return hasRailDetail && coarsePointer ? 'rail' : 'panel';
}
