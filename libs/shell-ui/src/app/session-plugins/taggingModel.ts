/** Plugin id and state key of the tagging plugin — session and workspace slices. */
export const TAGGING = { id: 'tagging', stateKey: 'tags' } as const;

/** Colours a tag name hashes into; readable as a tint in light and dark themes. */
export const TAG_PALETTE: readonly string[] = [
  '#e5484d',
  '#f76b15',
  '#ffb224',
  '#46a758',
  '#12a594',
  '#0091ff',
  '#6e56cf',
  '#d6409f',
];

export type TagState = 'none' | 'some' | 'all';

const key = (name: string) => name.trim().toLowerCase();

export function normalizeTag(raw: string): string | null {
  const name = raw.trim();
  return name === '' ? null : name;
}

export function tagColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of key(name)) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
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
