import { TAG_SLOTS } from '../../themes';
import { isColourToken, isHexColor } from './tint';

/** Plugin id and state key of the tagging plugin — session and workspace slices. */
export const TAGGING = { id: 'tagging', stateKey: 'tags' } as const;

export type TagState = 'none' | 'some' | 'all';

const key = (name: string) => name.trim().toLowerCase();

export function normalizeTag(raw: string): string | null {
  const name = raw.trim();
  return name === '' ? null : name;
}

/**
 * Per-tag colours, keyed by lower-cased name (plugins.yaml `colors`): a theme
 * slot name (`blue`, follows the theme) or a raw hex (fixed).
 */
export type TagColorOverrides = Readonly<Record<string, string>>;

export function tagColorOverrides(settings: unknown): TagColorOverrides {
  const raw = (settings as { colors?: unknown } | null | undefined)?.colors;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, colour] of Object.entries(raw)) {
    if (isColourToken(colour) && key(name) !== '') out[key(name)] = colour;
  }
  return out;
}

/** The tag's colour token: its configured one, else a theme slot hashed from the name. */
export function tagColor(name: string, overrides: TagColorOverrides = {}): string {
  const override = overrides[key(name)];
  if (override) return override;
  let hash = 0x811c9dc5;
  for (const ch of key(name)) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return TAG_SLOTS[hash % TAG_SLOTS.length];
}

/** A typed or pasted hex colour (`#abc`, `abc`, `#aabbcc`, `#aabbccdd`), lower-cased with `#`; null when invalid. */
export function parseHexColor(raw: string): string | null {
  const value = `#${raw.trim().replace(/^#/, '')}`.toLowerCase();
  return isHexColor(value) ? value : null;
}

export function setTagColor(overrides: TagColorOverrides, raw: string, colour: string): TagColorOverrides {
  const name = normalizeTag(raw);
  if (!name || !isColourToken(colour)) return overrides;
  return { ...overrides, [key(name)]: colour };
}

export function clearTagColor(overrides: TagColorOverrides, name: string): TagColorOverrides {
  const { [key(name)]: _dropped, ...rest } = overrides;
  return rest;
}

export function addTag(tags: readonly string[], raw: string): string[] {
  const name = normalizeTag(raw);
  if (!name || tags.some((t) => key(t) === key(name))) return [...tags];
  return [...tags, name];
}

export function removeTag(tags: readonly string[], name: string): string[] {
  return tags.filter((t) => key(t) !== key(name));
}

export function renameTag(tags: readonly string[], from: string, to: string): string[] {
  const next = normalizeTag(to);
  if (!next) return [...tags];
  if (tags.some((t) => key(t) === key(next) && key(t) !== key(from))) return removeTag(tags, from);
  return tags.map((t) => (key(t) === key(from) ? next : t));
}

export function tagState(targets: readonly (readonly string[])[], name: string): TagState {
  const have = targets.filter((tags) => tags.some((t) => key(t) === key(name))).length;
  if (have === 0) return 'none';
  return have === targets.length ? 'all' : 'some';
}

export function derivedTags(carriers: readonly (readonly string[])[]): string[] {
  const byKey = new Map<string, string>();
  for (const tags of carriers) for (const t of tags) if (!byKey.has(key(t))) byKey.set(key(t), t);
  return [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

export function toggleTag(targets: readonly (readonly string[])[], name: string): string[][] {
  const remove = tagState(targets, name) === 'all';
  return targets.map((tags) => (remove ? removeTag(tags, name) : addTag(tags, name)));
}
