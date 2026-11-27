import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { useOptionalPluginSettings } from '../PluginSettingsProvider';
import type { PluginSettings } from '../pluginSettings';
import { StatusChip } from '../StatusChip';
import type { MrRef } from './mrActions';
import { TargetHover } from '../TargetHover';
import type { TextTarget } from '../textTargets';

/**
 * Card enrichers — a cross-plugin capability: any plugin can add context
 * (chips + namespaced fields) to the cards other plugins render: MR/PR rows
 * in the forge views, dev-workflow kanban cards. The Jira plugin is the first
 * enricher (issue key in an MR title/branch → status, summary, assignee).
 *
 * Contract: `match` is cheap and synchronous (subject → lookup key, or
 * nothing — no key, no enrichment); `enrich` is batched — every key visible
 * at once goes to one call, cached per enricher for `ttlMs`. Results are
 * data, not components, so every card renders chips the same way.
 */

/** What a card is about. Every member is optional; enrichers use what they find. */
export interface CardSubject {
  mr?: Pick<MrRef, 'title' | 'sourceBranch' | 'url'>;
  session?: { name?: string; cwd?: string; branch?: string };
  /** The workflow binding's vars. */
  vars?: Record<string, string>;
}

export type ChipTone = 'neutral' | 'info' | 'progress' | 'done' | 'warn';

export interface CardChip {
  label: string;
  tip?: string;
  href?: string;
  tone?: ChipTone;
  /**
   * Explicit color, winning over `tone`: a named theme color (`gray`,
   * `blue`, `cyan`, `green`, `yellow`, `orange`, `red`, `violet`/`purple`,
   * `magenta`, `accent`) or a hex color (`#rgb`, `#rrggbb`, `#rrggbbaa`).
   * Anything else is ignored.
   */
  color?: string;
  /** What the chip stands for — gives it the target's hover card (`app/textTargets.ts`). */
  target?: TextTarget;
}

export interface CardEnrichment {
  chips?: CardChip[];
  /** Namespaced by the enricher, e.g. `jira.status`. */
  fields?: Record<string, string>;
}

export interface CardEnricher {
  id: string;
  /** Whether the enricher is active under the current plugins.yaml. */
  enabled(settings: PluginSettings): boolean;
  match(subject: CardSubject, settings: PluginSettings): string | undefined;
  enrich(keys: string[], settings: PluginSettings): Promise<Record<string, CardEnrichment>>;
  /** Cache lifetime per key (default 5 min). */
  ttlMs?: number;
  /**
   * Fingerprint of the settings the results depend on (e.g. a color map):
   * cached results made under a different fingerprint are refetched, so a
   * settings change shows without waiting for the TTL.
   */
  settingsKey?: (settings: PluginSettings) => string;
}

const DEFAULT_TTL_MS = 5 * 60_000;
/** Collect keys requested in the same render pass into one `enrich` call. */
const BATCH_DELAY_MS = 30;

const enrichers = new Map<string, CardEnricher>();
/** Outside a settings provider every enricher reads as disabled. */
const NO_SETTINGS: PluginSettings = {};

/** Module-level registration; a duplicate id replaces the earlier one. */
export function registerCardEnricher(enricher: CardEnricher): void {
  enrichers.set(enricher.id, enricher);
}

export function cardEnrichers(): CardEnricher[] {
  return [...enrichers.values()];
}

// ---------------------------------------------------------------------------
// Cache + batching
// ---------------------------------------------------------------------------

interface Entry {
  data?: CardEnrichment;
  /** `settingsKey` the data was fetched under. */
  sk?: string;
  /** The last batch failed (network/auth) — absence says nothing then. */
  failed?: boolean;
  /** When `data` (or a miss) was fetched; 0 = never. */
  at: number;
  pending: boolean;
}

const cache = new Map<string, Entry>();
const queued = new Map<string, Set<string>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let version = 0;

const cacheKey = (enricherId: string, key: string) => `${enricherId}\u0000${key}`;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Queue `key` unless it is fresh or already in flight. */
function request(enricher: CardEnricher, key: string, settings: PluginSettings): void {
  const ck = cacheKey(enricher.id, key);
  const entry = cache.get(ck);
  const ttl = enricher.ttlMs ?? DEFAULT_TTL_MS;
  const sk = enricher.settingsKey?.(settings) ?? '';
  if (entry && (entry.pending || (Date.now() - entry.at < ttl && entry.sk === sk))) return;
  cache.set(ck, { data: entry?.data, at: entry?.at ?? 0, sk: entry?.sk, pending: true });
  let set = queued.get(enricher.id);
  if (!set) queued.set(enricher.id, (set = new Set()));
  set.add(key);
  if (timers.has(enricher.id)) return;
  timers.set(
    enricher.id,
    setTimeout(() => void flush(enricher, settings), BATCH_DELAY_MS),
  );
}

async function flush(enricher: CardEnricher, settings: PluginSettings): Promise<void> {
  timers.delete(enricher.id);
  const keys = [...(queued.get(enricher.id) ?? [])];
  queued.delete(enricher.id);
  if (keys.length === 0) return;
  let result: Record<string, CardEnrichment> = {};
  let failed = false;
  try {
    result = await enricher.enrich(keys, settings);
  } catch {
    failed = true;
    // A failed batch keeps stale data and retries after the TTL — the
    // enricher reports its own failure (e.g. an attention flag).
  }
  const now = Date.now();
  const sk = enricher.settingsKey?.(settings) ?? '';
  for (const key of keys) {
    const ck = cacheKey(enricher.id, key);
    const prev = cache.get(ck);
    cache.set(ck, { data: result[key] ?? prev?.data, at: now, sk, pending: false, failed });
  }
  notify();
}

/** Test hook: forget every registration and cached result. */
export function resetCardEnrichers(): void {
  enrichers.clear();
  cache.clear();
  queued.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  notify();
}

// ---------------------------------------------------------------------------
// React surface
// ---------------------------------------------------------------------------

/** Enrichments for one card, in enricher registration order. */
export function useCardEnrichment(subject: CardSubject): CardEnrichment[] {
  const pluginSettings = useOptionalPluginSettings()?.pluginSettings ?? NO_SETTINGS;
  useSyncExternalStore(subscribe, () => version);
  const matches: { enricher: CardEnricher; key: string }[] = [];
  for (const enricher of enrichers.values()) {
    if (!enricher.enabled(pluginSettings)) continue;
    const key = enricher.match(subject, pluginSettings);
    if (key) matches.push({ enricher, key });
  }
  const signature = matches.map((m) => cacheKey(m.enricher.id, m.key)).join('|');
  useEffect(() => {
    for (const { enricher, key } of matches) request(enricher, key, pluginSettings);
    // `signature` covers `matches`; settings changes re-request through TTL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, pluginSettings]);
  return matches
    .map(({ enricher, key }) => cache.get(cacheKey(enricher.id, key))?.data)
    .filter((d): d is CardEnrichment => !!d);
}

/**
 * Enrichments for explicit keys of one enricher — for surfaces that already
 * know their keys (the jira session line lists several tickets per session).
 * Same batching and cache as `useCardEnrichment`. Per key: the enrichment;
 * `null` once the enricher answered successfully without it (an unknown
 * key — e.g. `ACCELERATOR-1` from a folder name); `undefined` while pending,
 * after a failed request, or when the enricher is inactive.
 */
export function useEnrichedKeys(
  enricherId: string,
  keys: string[],
): Record<string, CardEnrichment | null | undefined> {
  const pluginSettings = useOptionalPluginSettings()?.pluginSettings ?? NO_SETTINGS;
  useSyncExternalStore(subscribe, () => version);
  const enricher = enrichers.get(enricherId);
  const active = !!enricher && enricher.enabled(pluginSettings);
  const signature = active ? keys.join('|') : '';
  useEffect(() => {
    if (!enricher || !active) return;
    for (const key of keys) request(enricher, key, pluginSettings);
    // `signature` covers `keys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, pluginSettings]);
  const out: Record<string, CardEnrichment | null | undefined> = {};
  for (const key of keys) {
    const entry = active ? cache.get(cacheKey(enricherId, key)) : undefined;
    out[key] = entry?.data ?? (entry && entry.at > 0 && !entry.pending && !entry.failed ? null : undefined);
  }
  return out;
}

/** Named chip colors → theme variables, so they follow light/dark themes. */
export const NAMED_CHIP_COLORS: Record<string, string> = {
  gray: 'var(--text-secondary)',
  grey: 'var(--text-secondary)',
  blue: 'var(--blue)',
  cyan: 'var(--cyan)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  orange: 'var(--orange)',
  red: 'var(--red)',
  violet: 'var(--violet)',
  purple: 'var(--violet)',
  magenta: 'var(--magenta)',
  accent: 'var(--accent)',
};

/**
 * A cached enrichment without subscribing or fetching — for synchronous
 * readers like the panel filter's search. Same semantics as
 * `useEnrichedKeys`: `null` = answered without the key (unknown),
 * `undefined` = not fetched yet / failed.
 */
export function peekEnrichment(enricherId: string, key: string): CardEnrichment | null | undefined {
  const entry = cache.get(cacheKey(enricherId, key));
  return entry?.data ?? (entry && entry.at > 0 && !entry.pending && !entry.failed ? null : undefined);
}

const TONE_COLOR: Record<ChipTone, string> = {
  neutral: NAMED_CHIP_COLORS.gray,
  info: NAMED_CHIP_COLORS.accent,
  progress: NAMED_CHIP_COLORS.yellow,
  done: NAMED_CHIP_COLORS.green,
  warn: NAMED_CHIP_COLORS.red,
};

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A user/plugin color value → a CSS color, or undefined when it is neither a
 * named chip color nor a hex color (so nothing else ever reaches a style).
 */
export function resolveChipColor(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (HEX_COLOR.test(v)) return v;
  return NAMED_CHIP_COLORS[v];
}

/**
 * A chip's inline style: tinted fill, full-strength border, and text mixed
 * toward the theme's text color — readable on light and dark themes alike
 * (a colored border + colored 9px text alone washed out on light themes).
 */
export function chipStyle(chip: Pick<CardChip, 'tone' | 'color'>): CSSProperties {
  const c = resolveChipColor(chip.color) ?? TONE_COLOR[chip.tone ?? 'neutral'];
  return {
    borderColor: c,
    background: `color-mix(in srgb, ${c} 22%, transparent)`,
    color: `color-mix(in srgb, ${c} 55%, var(--text-primary))`,
  };
}


/** Chips every enabled enricher contributes for `subject`; nothing when none apply. */
export function CardChips({ subject, className }: { subject: CardSubject; className?: string }) {
  const enrichments = useCardEnrichment(subject);
  const chips = enrichments.flatMap((e) => e.chips ?? []);
  if (chips.length === 0) return null;
  return (
    <span className={`flex flex-wrap items-center gap-1 ${className ?? ''}`}>
      {chips.map((chip, i) => (
        <ChipView key={i} chip={chip} />
      ))}
    </span>
  );
}

/**
 * One chip — a link when it carries `href` (opened externally). A chip with a
 * `target` also opens the target's hover card when plugins offer actions on
 * it (`app/textTargets.ts`); `originSessionId` is the session the card acts
 * for (default: the selected one).
 */
export function ChipView({ chip, originSessionId }: { chip: CardChip; originSessionId?: string }) {
  const view = (
    <StatusChip color={chip.color} tone={chip.tone} href={chip.href} tip={chip.tip}>
      <span className="truncate">{chip.label}</span>
    </StatusChip>
  );
  return chip.target ? (
    <TargetHover target={chip.target} originSessionId={originSessionId}>
      {view}
    </TargetHover>
  ) : (
    view
  );
}
